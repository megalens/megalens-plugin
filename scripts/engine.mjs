#!/usr/bin/env node
// Front end for MegaLens reviews, used by /megalens:review, /megalens:status, /megalens:result.
//   engine.mjs review [deep] (standard default; double exists but is off: DOUBLE_TIER_ENABLED)
//              [--quiet] [--first-review FILE] [--base REF --head REF] [--runner app|github|local] [--wait|--no-wait]
//   engine.mjs status [review-id]      engine.mjs result [review-id]
//   engine.mjs first-review-write      (reads the host's review JSON on stdin, writes a clean 0600 file in a private folder, prints its path)
// Prints text for the user. Never prints credentials.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, lstatSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { secretPath } from './lib/safety.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scrubExact, chooseRoute, shouldFallBack, isSandboxPrecheckDoc, isRunnerId, isAppId,
  detectRemoteRunner, hasDispatchWorkflow, appReview, appStatus, appResult,
  runnerReview, runnerStatus, runnerResult, findLatestRemoteReview, realExec, MSG,
} from './lib/gh-runner.mjs';
import { DOUBLE_TIER_ENABLED, DOUBLE_OFF_MESSAGE, UsageError, parseReviewArgs, assertReviewId, chooseAuth, childEnv, scrub, normalizeFirstReview, renderResult } from './lib/engine-core.mjs';
import { resolveRepoKey, saveLatestReview, loadLatestReview } from './lib/latest-review.mjs';
import { DEFAULT_POLL_MS, DEFAULT_PROGRESS_MS, DEFAULT_WAIT_MS, STILL_RUNNING_LINE, defaultSleep, formatElapsed, raceWithDeadline, waitForReview } from './lib/wait-loop.mjs';

const MAX_OUT = 1 << 22; // bytes we keep from the engine's output streams
const MAX_FIRST_REVIEW = 1 << 20;
const FIRST_REVIEW_NAME = 'first-review.json';
const STATES = ['running', 'complete', 'partial', 'failed', 'cancelled'];
const flat = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ').trim().slice(0, n);
async function readStdin() { let b = ''; process.stdin.setEncoding('utf8'); for await (const c of process.stdin) { b += c; if (b.length > MAX_FIRST_REVIEW * 2) break; } return b; }

/**
 * Delete the host's first-review file, and its folder, only when it is exactly what `first-review-write` makes:
 * <tmpdir>/megalens-XXXXXX/first-review.json, a regular file, in a real folder owned by us with mode 0700 that holds
 * nothing else. Never recursive: a repository that happens to sit at a look-alike path is never touched.
 */
export function cleanupFirstReview(p) {
  try {
    const dir = path.dirname(p);
    if (path.basename(p) !== FIRST_REVIEW_NAME || path.dirname(dir) !== tmpdir() || !/^megalens-[A-Za-z0-9_-]{6,}$/.test(path.basename(dir))) return false;
    const ds = lstatSync(dir);
    if (!ds.isDirectory() || ds.isSymbolicLink() || (ds.mode & 0o777) !== 0o700 || (typeof process.getuid === 'function' && ds.uid !== process.getuid())) return false;
    if (!lstatSync(p).isFile()) return false;
    const names = readdirSync(dir); if (names.length !== 1 || names[0] !== FIRST_REVIEW_NAME) return false;
    unlinkSync(p); rmdirSync(dir); return true;
  } catch { return false; }
}

const GIT_CAP = 400_000;
function runGit(args, cwd) {
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
    const c = spawn('git', ['--no-pager', '-c', 'core.quotepath=off', '-c', 'diff.external=', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let truncated = false;
    c.stdout.on('data', (d) => { if (out.length < GIT_CAP) out += d; else truncated = true; });
    c.stderr.resume(); c.on('error', () => resolve({ code: 127, out: '', truncated })); c.on('close', (code) => resolve({ code: code ?? 4, out, truncated }));
  });
}

/** What the engine will review, from fixed git commands only. Lets /megalens:review pre-approve this script and no raw git. */
async function showChange(rest, cwd, say) {
  const o = parseReviewArgs(['standard', ...rest]);
  const cap = (r) => r.out + (r.truncated ? '\n[output cut at 400 KB]\n' : '');
  if (o.base === null) {
    const st = await runGit(['status', '--short'], cwd);
    if (st.code !== 0) { say('Not a git repository, or git failed. Nothing to show.\n'); return 4; }
    const df = await runGit(['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], cwd);
    if (df.code !== 0) { say('git diff HEAD failed (a repository with no commits yet?). Nothing to show.\n'); return 4; }
    const un = await runGit(['ls-files', '--others', '--exclude-standard'], cwd);
    const names = un.out.split('\n').filter(Boolean); const safe = names.filter((n) => !secretPath(n)); const hidden = names.length - safe.length;
    const stLines = st.out.split('\n').filter(Boolean); const stSafe = stLines.filter((l) => !secretPath(l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '')));
    say(`=== git status --short ===\n${stSafe.join('\n')}${stLines.length > stSafe.length ? `\n[${stLines.length - stSafe.length} credential-like path(s) not shown]` : ''}\n\n=== git diff HEAD (staged and unstaged) ===\n${cap(df)}\n=== untracked files (read these yourself; never secret files) ===\n${safe.join('\n')}\n${hidden ? `[${hidden} untracked file(s) with credential-like names are not listed and must not be read]\n` : ''}`);
    return 0;
  }
  const mb = await runGit(['merge-base', '--', o.base, o.head], cwd);
  const sha = mb.out.trim();
  if (mb.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) { say('Could not find a merge base for that range.\n'); return 4; }
  const df = await runGit(['diff', '--no-ext-diff', '--no-textconv', `${sha}..${o.head}`, '--'], cwd);
  say(`=== git diff ${sha}..${o.head} (merge-base of the two refs to the head ref) ===\n${cap(df)}\nUntracked files are not part of a range review.\n`);
  return df.code === 0 ? 0 : 4;
}

const FAST_KILL_GRACE_MS = 150;
const LOCAL_CANCEL_GRACE_MS = 10_000;

function killChildTree(child, sig) {
  if (process.platform !== 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
    try { process.kill(-child.pid, sig); } catch { /* process group may already be gone */ }
  }
  try { child.kill(sig); } catch { /* ignore */ }
}

function runBin(bin, args, { env, cwd, signal = null, graceMs = FAST_KILL_GRACE_MS, waitForExitOnAbort = false }) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ code: 4, stdout: '', stderr: '', aborted: true, finalized: true });
    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (e) { return resolve({ code: 127, stdout: '', stderr: String(e.message), aborted: false, finalized: true }); }
    let stdout = ''; let stderr = ''; let settled = false; let exited = false; let aborted = false; let forceKilled = false; let killTimer = null;
    const clearKillTimer = () => {
      if (killTimer !== null) { clearTimeout(killTimer); killTimer = null; }
    };
    const finish = (res) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(res);
    };
    const onAbort = () => {
      aborted = true;
      if (!exited) {
        if (waitForExitOnAbort) {
          // Signal the engine process directly first so engine-v2 catches SIGTERM, sets cancelled=true,
          // stops Codex cleanly, closes the gateway review (`POST /complete`), and removes its workspace.
          try { child.kill('SIGTERM'); } catch { /* ignore */ }
        } else {
          killChildTree(child, 'SIGTERM');
        }
        // Keep killTimer ref'd until the child actually exits so SIGKILL always fires even if the parent is exiting.
        killTimer = setTimeout(() => {
          killTimer = null;
          if (!exited) {
            forceKilled = true;
            killChildTree(child, 'SIGKILL');
          }
          child.unref?.();
          if (waitForExitOnAbort) {
            child.stdout?.destroy();
            child.stderr?.destroy();
            finish({ code: 4, stdout, stderr, aborted: true, finalized: false });
          }
        }, graceMs);
      } else if (waitForExitOnAbort) {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({ code: 4, stdout, stderr, aborted: true, finalized: !forceKilled });
        return;
      }
      if (!waitForExitOnAbort) {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({ code: 4, stdout, stderr, aborted: true, finalized: false });
      }
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (c) => { if (stdout.length < MAX_OUT) stdout += c; });
    child.stderr.on('data', (c) => { if (stderr.length < MAX_OUT) stderr += c; });
    child.on('error', (e) => {
      exited = true;
      clearKillTimer();
      finish({ code: e.code === 'ENOENT' ? 127 : 4, stdout, stderr: e.code === 'ENOENT' ? 'engine binary not found' : String(e.message), aborted, finalized: !forceKilled });
    });
    child.on('exit', () => {
      exited = true;
      clearKillTimer();
      if (aborted && waitForExitOnAbort) {
        // Engine exited cleanly (closed gateway review & cleaned workspace); reap any stray descendants and settle.
        killChildTree(child, 'SIGKILL');
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({ code: 4, stdout, stderr, aborted: true, finalized: !forceKilled });
      }
    });
    child.on('close', (code, sig) => {
      exited = true;
      clearKillTimer();
      if (aborted) {
        finish({ code: 4, stdout, stderr, aborted: true, finalized: !forceKilled });
      } else {
        finish({ code: code ?? (sig ? 4 : 0), stdout, stderr, aborted: false, finalized: true });
      }
    });
  });
}

/** Pick the newer review between the local bookmark (`saved`) and live remote lookup (`remote`). */
export function pickNewerReview(saved, remote) {
  if (!saved) return remote ?? null;
  if (!remote) return saved;
  if (saved.id === remote.id) return remote;
  const sTs = Number(saved.startedAt) || 0;
  const rTs = Number(remote.startedAt) || 0;
  const sameRemoteSource = saved.runner === remote.runner
    && (saved.runner === 'github' || saved.runner === 'app')
    && (!saved.nwo || !remote.nwo || saved.nwo === remote.nwo);
  if (rTs > 0 && sTs > 0) {
    // Compare GitHub timestamps at 1-second resolution for same-source reviews so local Date.now() milliseconds
    // cannot outrank a newer GitHub ISO-8601 timestamp from the same second.
    const sCmp = sameRemoteSource ? Math.floor(sTs / 1000) : sTs;
    const rCmp = sameRemoteSource ? Math.floor(rTs / 1000) : rTs;
    if (rCmp > sCmp) return remote;
    if (sCmp > rCmp) return saved;
    // Equal-second timestamps: fall through to numeric ID tie-breaker.
  }
  if (rTs > 0 && sTs === 0) return remote;
  if (sameRemoteSource) {
    const sNum = Number(String(saved.id).split(':')[1]);
    const rNum = Number(String(remote.id).split(':')[1]);
    if (Number.isFinite(sNum) && Number.isFinite(rNum) && rNum !== sNum) return rNum > sNum ? remote : saved;
  }
  return saved;
}

const privateDir = () => mkdtempSync(path.join(tmpdir(), 'megalens-'), { mode: 0o700 });

export async function main(argv, {
  env = process.env,
  cwd = process.cwd(),
  out = (s) => process.stdout.write(s),
  err = (s) => process.stderr.write(s),
  stdin = () => readStdin(),
  flags = {},
  exec = realExec,
  platform = process.platform,
  probe = null,
  signal = null,
} = {}) {
  const [cmd, ...rest0] = argv;
  let rest = rest0; let runnerFlag = null;
  if (cmd === 'review') {
    const i = rest0.indexOf('--runner');
    if (i !== -1) {
      runnerFlag = rest0[i + 1];
      if (runnerFlag !== 'app' && runnerFlag !== 'github' && runnerFlag !== 'local') { out('--runner needs app, github or local.\n'); return 4; }
      rest = [...rest0.slice(0, i), ...rest0.slice(i + 2)];
    }
  }
  const say = (t) => out(scrub(t, env));
  const sayExact = (t) => out(scrubExact(t, env));
  const timing = flags.runnerTiming ?? {};
  const nowFn = timing.now ?? (() => Date.now());
  const sleepFn = timing.sleep ?? defaultSleep;
  const repoKeyPromise = (useExec = true) => useExec
    ? resolveRepoKey({ exec, cwd, env })
    : resolveRepoKey({ exec: async (_cmd, args) => { const r = await runGit(args, cwd); return { code: r.code, stdout: r.out, stderr: '' }; }, cwd, env });
  const recordLatest = async ({ id, runner, nwo = null, tier = 'standard', startedAt = null }, useExec = true) => {
    const repoKey = await repoKeyPromise(useExec);
    saveLatestReview({ env, repoKey, id, runner, nwo, tier, startedAt, now: nowFn });
  };

  try {
    if (cmd === 'first-review-write') {
      const raw = await stdin();
      if (Buffer.byteLength(raw) > MAX_FIRST_REVIEW) throw new UsageError('the first review is over 1 MB');
      const clean = normalizeFirstReview(raw, env); // throws before any file exists
      const d = privateDir(); const p = path.join(d, FIRST_REVIEW_NAME);
      writeFileSync(p, JSON.stringify(clean), { mode: 0o600 });
      say(p + '\n'); return 0;
    }
    if (cmd === 'show-change') return await showChange(rest, cwd, say);
    if (cmd === 'install' || cmd === 'verify') {
      const r = await runBin(env.MEGALENS_REVIEW_BIN || 'megalens-review', [cmd], { env: childEnv(env, 'none'), cwd, signal });
      if (r.code === 127) { say(missingBin()); return 4; }
      say(`${cmd === 'install' ? 'Engine install' : 'Engine verify'} ${r.code === 0 ? 'finished' : `FAILED (exit ${r.code})`}.\n${firstLine(r.stderr) ? `Engine said: ${firstLine(r.stderr)}\n` : ''}${r.code === 0 ? '' : 'The pinned Codex CLI is not verified, so reviews will not run.\n'}`);
      return r.code;
    }
    if (!['review', 'status', 'result'].includes(cmd)) throw new UsageError('usage: engine.mjs review|status|result|show-change|install|verify ...');

    if (cmd === 'review' && rest.some((a, i) => a === 'double' && !['--base', '--head', '--first-review'].includes(rest[i - 1])) && !(flags.double ?? DOUBLE_TIER_ENABLED)) { say(DOUBLE_OFF_MESSAGE + '\n'); return 4; }

    // ---- status / result (with optional id; no id -> newest review for this repo across bookmark & GitHub) ----
    if (cmd === 'status' || cmd === 'result') {
      if (rest.length > 1) throw new UsageError('give at most one review id (or none to use the latest review for this repo)');
      const explicitId = rest.length === 1;
      let targetId = rest[0];
      if (!explicitId) {
        const repoKey = await repoKeyPromise(false);
        const saved = loadLatestReview({ env, repoKey }) || loadLatestReview({ env, repoKey: await repoKeyPromise(true) });
        const remote = await findLatestRemoteReview({ exec, cwd, env, signal });
        const latest = pickNewerReview(saved, remote);
        if (!latest) {
          say('No recent MegaLens review found for this repository. Run /megalens:review to start one.\n');
          return 4;
        }
        targetId = latest.id;
      }
      if (/^app:/.test(targetId)) {
        if (!isAppId(targetId)) throw new UsageError('that is not a MegaLens App review id (they look like app:123456789)');
        const r = await (cmd === 'status' ? appStatus : appResult)({ exec, cwd, env, signal }, targetId, { showId: explicitId });
        sayExact(r.text); return r.code;
      }
      if (/^gh:/.test(targetId)) {
        if (!isRunnerId(targetId)) throw new UsageError('that is not a GitHub review id (they look like gh:123456789)');
        const r = await (cmd === 'status' ? runnerStatus : runnerResult)({ exec, cwd, env, signal }, targetId, { showId: explicitId });
        sayExact(r.text); return r.code;
      }
      const id = assertReviewId(targetId);
      const auth = chooseAuth(env, flags);
      if (auth.error) { say(`MegaLens engine not started: ${auth.error}\n`); return 4; }
      const bin = env.MEGALENS_REVIEW_BIN || 'megalens-review';
      const base = { env: childEnv(env, auth.mode), cwd, signal };
      if (cmd === 'status') return await localStatus(bin, id, base, say, probe, { showId: explicitId });
      return await fetchAndRender(bin, ['result', id], base, say, env, probe, { showId: explicitId });
    }

    // ---- review ----
    const o = parseReviewArgs(rest, flags);
    const route = chooseRoute({ platform, runner: runnerFlag });

    const runViaApp = async (preRepo = null, { allowNoCheckFallback = false } = {}) => {
      const repoKey = await repoKeyPromise();
      let streamed = false;
      const r = await appReview({
        exec, cwd, env, tier: o.tier, base: o.base, head: o.head, wait: o.wait,
        ...timing, signal, preRepo, allowNoCheckFallback,
        onLine: (s) => { streamed = true; sayExact(s); },
        saveLatest: (rec) => saveLatestReview({ env, repoKey, ...rec, now: nowFn }),
      });
      if (r.safeToFallback && allowNoCheckFallback) return { code: r.code, safeToFallback: true };
      if (!streamed) sayExact(r.text);
      return { code: r.code, safeToFallback: false };
    };

    const runViaGithub = async (note = '') => {
      const repoKey = await repoKeyPromise();
      let streamed = false;
      const r = await runnerReview({
        exec, cwd, env, tier: o.tier, base: o.base, head: o.head, wait: o.wait,
        ...timing, signal,
        onLine: (s) => {
          if (!streamed && note) sayExact(note);
          streamed = true;
          sayExact(s);
        },
        saveLatest: (rec) => saveLatestReview({ env, repoKey, ...rec, now: nowFn }),
      });
      if (!streamed) sayExact(note + r.text);
      return r.code;
    };

    const runAutoRemote = async ({ allowLocalFallback = false } = {}) => {
      const detected = await detectRemoteRunner({ exec, cwd, env, signal });
      if (signal?.aborted) return 4;
      if (detected.runner === 'app') {
        const hasWf = detected.hasWorkflow ?? await hasDispatchWorkflow({ exec, cwd, env, nwo: detected.nwo, defaultBranch: detected.defaultBranch, signal });
        if (o.tier === 'deep') {
          if (hasWf) return await runViaGithub();
          sayExact(`${MSG.appDeepUnsupported}\n`);
          return 4;
        }
        if (o.base !== null) {
          if (hasWf) return await runViaGithub();
          sayExact(`${MSG.appRangeUnsupported}\n`);
          return 4;
        }
        const appRes = await runViaApp({ nwo: detected.nwo, defaultBranch: detected.defaultBranch }, { allowNoCheckFallback: hasWf });
        if (appRes.safeToFallback && hasWf) return await runViaGithub();
        return appRes.code;
      }
      if (detected.runner === 'github') {
        return await runViaGithub();
      }
      // Neither GitHub App nor dispatch workflow is configured.
      // On Linux only, if local credentials are configured, fall back to the local engine.
      const hasLocalCreds = Boolean(env.MEGALENS_TOKEN || String(env.MEGALENS_BYO ?? '').trim());
      if (allowLocalFallback && hasLocalCreds) {
        let buf = ''; const sig = { setup: false };
        const code = await main(['review', ...rest, '--runner', 'local'], { env, cwd, out: (t) => { buf += t; }, err, stdin, flags, exec, platform, probe: sig, signal });
        if (sig.setup && detected.reason === 'not_setup') {
          sayExact(`${detected.message}\n`);
          return 4;
        }
        out(buf);
        return code;
      }
      // Print ONLY the one setup line (never append a local-engine explanation when no local credentials are set).
      sayExact(`${detected.message}\n`);
      return 4;
    };

    if (route.route === 'app') return (await runViaApp()).code;
    if (route.route === 'github') return await runViaGithub();
    if (route.route === 'auto') return await runAutoRemote({ allowLocalFallback: route.fallbackAllowed });

    // ---- local engine route (explicit --runner local, or Linux fallback when no remote runner is configured) ----
    const auth = chooseAuth(env, flags);
    if (auth.error) { say(`MegaLens engine not started: ${auth.error}\n`); return 4; }
    const bin = env.MEGALENS_REVIEW_BIN || 'megalens-review';
    const base = { env: childEnv(env, auth.mode), cwd, signal };
    const args = ['run', '--tier', o.tier];
    if (o.base !== null) args.push('--target', 'range', '--base', o.base, '--head', o.head);
    if (o.quiet) args.push('--quiet');

    let tmpDirs = []; const p = o.firstReview !== null ? path.resolve(cwd, o.firstReview) : null;
    try {
      if (o.firstReview !== null) {
        const st = lstatSync(p);
        if (!st.isFile()) throw new UsageError('the first review path must be a regular file, not a link or folder');
        if (st.size > MAX_FIRST_REVIEW) throw new UsageError('the first review file is over 1 MB');
        const clean = normalizeFirstReview(readFileSync(p, 'utf8'), env);
        const d = privateDir(); tmpDirs.push(d);
        const np = path.join(d, 'first-review.json'); writeFileSync(np, JSON.stringify(clean), { mode: 0o600 });
        args.push('--first-review', np);
        say(`Using your own review (${clean.findings.length} finding${clean.findings.length === 1 ? '' : 's'}) as context for the engine.\n`);
      } else if (o.tier === 'double') {
        say('Note: no review of your own was supplied, so the engine runs its own cheap first pass instead.\n');
      }
      const waitMs = timing.waitMs ?? DEFAULT_WAIT_MS;
      const pollMs = timing.pollMs ?? DEFAULT_POLL_MS;
      const progressMs = timing.progressMs ?? DEFAULT_PROGRESS_MS;
      const cancelGraceMs = timing.cancelGraceMs ?? LOCAL_CANCEL_GRACE_MS;

      if (o.tier === 'deep') {
        args.push('--background');
        const t0 = nowFn();
        const startAc = new AbortController();
        let startInterrupted = null;
        const onStartAbort = () => { if (!startInterrupted) { startInterrupted = 'aborted'; startAc.abort(); } };
        if (signal) {
          if (signal.aborted) onStartAbort();
          else signal.addEventListener('abort', onStartAbort, { once: true });
        }
        let startTimer = null;
        if (o.wait && Number.isFinite(waitMs) && waitMs > 0 && !startInterrupted) {
          startTimer = setTimeout(() => { if (!startInterrupted) { startInterrupted = 'timeout'; startAc.abort(); } }, waitMs);
        } else if (o.wait && waitMs <= 0 && !startInterrupted) {
          startInterrupted = 'timeout'; startAc.abort();
        }
        let r;
        try {
          r = await runBin(bin, args, { ...base, signal: startAc.signal, graceMs: cancelGraceMs, waitForExitOnAbort: true });
        } finally {
          if (startTimer !== null) clearTimeout(startTimer);
          if (signal) signal.removeEventListener('abort', onStartAbort);
        }
        if (r.code === 127) { if (probe) probe.setup = true; say(missingBin()); return 4; }
        let j; try { j = JSON.parse(r.stdout); } catch { j = null; }
        if (j && REVIEW_ID(j.review_id)) {
          await recordLatest({ id: j.review_id, runner: 'local', tier: 'deep' }, false);
          if (r.aborted || startInterrupted || signal?.aborted) {
            say(`${STILL_RUNNING_LINE}\n`);
            return 0;
          }
        }
        if (r.aborted || startInterrupted || signal?.aborted) {
          say(`## MegaLens deep review: ${startInterrupted === 'timeout' ? 'NOT COMPLETED' : 'CANCELLED'}\n\n${startInterrupted === 'timeout' ? 'Timed out' : 'Interrupted'} while starting the local deep review. This is not a clean review.\n`);
          return 4;
        }
        if (r.code !== 0 || !j || !REVIEW_ID(j.review_id)) return await finishNoDoc(r, say, env, probe);
        if (!o.wait) {
          say(`Review started\n${STILL_RUNNING_LINE}\n`);
          return 0;
        }
        const w = await waitForReview({
          poll: async (callSignal) => {
            const st = await runBin(bin, ['status', j.review_id], { ...base, signal: callSignal });
            if (st.aborted || callSignal?.aborted) return { state: 'aborted' };
            let sj; try { sj = JSON.parse(st.stdout); } catch { sj = null; }
            if (st.code !== 0 || !sj || !STATES.includes(sj.state)) return { state: 'error', text: `Could not read the status of ${j.review_id}: ${firstLine(st.stderr) || 'no usable answer from the engine'}. This is not a finished review.\n` };
            return { state: sj.state === 'complete' ? 'done' : sj.state };
          },
          onLine: say,
          startedLine: 'Review started',
          queuedLine: null,
          runningLine: 'Running locally...',
          waitMs,
          pollMs,
          progressMs,
          now: nowFn,
          t0,
          sleep: sleepFn,
          signal,
        });
        if (w.finished && w.last?.state === 'error') { say(w.last.text); return 4; }
        if (w.finished) {
          const remainingMs = Math.max(0, waitMs - Math.max(0, nowFn() - t0));
          const fetched = await raceWithDeadline(
            (callSignal) => fetchAndRender(bin, ['result', j.review_id], { ...base, signal: callSignal }, say, env, probe, { showId: false }),
            { signal, remainingMs, now: nowFn, t0, waitMs },
          );
          if (fetched.interrupted) {
            say(`${STILL_RUNNING_LINE}\n`);
            return 0;
          }
          return fetched.value;
        }
        return 0;
      }

      // Local Standard (or Double): enforce wait cap, abort handling, and elapsed progress updates,
      // and wait for engine-v2's SIGTERM finalization (gateway POST /complete + workspace cleanup) before printing CANCELLED.
      const t0 = nowFn();
      const callAc = new AbortController();
      let interruptKind = null;
      const triggerInterrupt = (kind) => {
        if (interruptKind) return;
        interruptKind = kind;
        callAc.abort();
      };
      const onUserAbort = () => triggerInterrupt('aborted');
      if (signal) {
        if (signal.aborted) onUserAbort();
        else signal.addEventListener('abort', onUserAbort, { once: true });
      }
      let deadlineTimer = null;
      if (Number.isFinite(waitMs) && waitMs > 0 && !interruptKind) {
        deadlineTimer = setTimeout(() => triggerInterrupt('timeout'), waitMs);
      } else if (waitMs <= 0 && !interruptKind) {
        triggerInterrupt('timeout');
      }
      let progressTimer = null;
      let lastBucket = 0;
      if (Number.isFinite(progressMs) && progressMs > 0 && progressMs < waitMs) {
        progressTimer = setInterval(() => {
          if (interruptKind || signal?.aborted) return;
          const elapsed = Math.max(0, nowFn() - t0);
          const bucket = Math.floor(elapsed / progressMs);
          if (bucket > lastBucket) {
            lastBucket = bucket;
            say(`${formatElapsed(elapsed)}\n`);
          }
        }, progressMs);
        progressTimer.unref?.();
      }
      try {
        // Local Standard/Double runs in the foreground (engine-v2 rejects --background for non-deep tiers
        // and does not persist status/result state on disk). Interrupting or hitting the wait cap sends SIGTERM,
        // waits up to cancelGraceMs for engine-v2 to close the gateway review and remove its workspace, then
        // reports CANCELLED / NOT COMPLETED (exit 4) instead of claiming it is still running.
        const meta = { aborted: false, finalized: true };
        const isOvertime = () => Boolean(interruptKind) || (Number.isFinite(waitMs) && Math.max(0, nowFn() - t0) >= waitMs);
        const code = await fetchAndRender(
          bin,
          args,
          { ...base, signal: callAc.signal, graceMs: cancelGraceMs, waitForExitOnAbort: true },
          say,
          env,
          probe,
          { showId: false, meta, shouldSuppress: isOvertime },
        );
        if (!interruptKind && isOvertime()) interruptKind = 'timeout';
        if (interruptKind || meta.aborted) {
          const kind = interruptKind || 'aborted';
          if (kind === 'aborted') {
            const detail = meta.finalized
              ? 'The local review was interrupted and stopped. This is not a clean review. Run /megalens:review to start a new review.'
              : 'The local review did not shut down within the grace period and was force-stopped. If a gateway review was still open, wait a moment before retrying. This is not a clean review.';
            say(`## MegaLens ${o.tier} review: CANCELLED\n\n${detail}\n`);
          } else {
            const detail = meta.finalized
              ? 'The local review hit the wait limit and was stopped. This is not a clean review. Run /megalens:review to try again.'
              : 'The local review hit the wait limit, did not shut down within the grace period, and was force-stopped. If a gateway review was still open, wait a moment before retrying. This is not a clean review.';
            say(`## MegaLens ${o.tier} review: NOT COMPLETED\n\n${detail}\n`);
          }
          return 4;
        }
        return code;
      } finally {
        if (deadlineTimer !== null) clearTimeout(deadlineTimer);
        if (progressTimer !== null) clearInterval(progressTimer);
        if (signal) signal.removeEventListener('abort', onUserAbort);
      }
    } finally {
      for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
      if (p !== null) cleanupFirstReview(p);
    }
  } catch (e) {
    if (e instanceof UsageError) { say(`${e.message}\n`); return 4; }
    err(scrub(`megalens engine front end error: ${String(e?.message ?? e).slice(0, 200)}\n`, env)); return 4;
  }
}

async function localStatus(bin, id, base, say, probe, { showId = true } = {}) {
  const r = await runBin(bin, ['status', id], base);
  if (r.code === 127) { if (probe) probe.setup = true; say(missingBin()); return 4; }
  let j; try { j = JSON.parse(r.stdout); } catch { j = null; }
  if (r.code !== 0 || !j || typeof j.state !== 'string' || !STATES.includes(j.state)) {
    say(`Could not read the status of ${id}: ${firstLine(r.stderr) || 'no usable answer from the engine'}. This is not a finished review.\n`);
    return 4;
  }
  if (!showId && (j.state === 'running' || j.state === 'complete')) {
    say(j.state === 'running' ? `${STILL_RUNNING_LINE}\n` : 'Finished. Run /megalens:result to see it.\n');
    return 0;
  }
  const tier = flat(j.tier ?? 'unknown tier', 20); const reason = j.reason ? ` Reason: ${flat(j.reason, 100)}.` : '';
  const msg = {
    running: `Still running. Check again with /megalens:status ${id}.`,
    complete: `Finished. Fetch it with /megalens:result ${id}.`,
    partial: `PARTIAL: part of the review did not finish, so it is not a clean review.${reason} Fetch what exists with /megalens:result ${id}.`,
    failed: `FAILED: the review did not complete, so it is not a clean review and says nothing about your change.${reason} /megalens:result ${id} shows what the engine recorded.`,
    cancelled: `CANCELLED: the review did not complete, so it says nothing about your change.${reason}`,
  }[j.state];
  say(`Review ${id} (${tier}): ${j.state}. ${msg}\n`);
  return 0;
}

const REVIEW_ID = (s) => typeof s === 'string' && /^rv_[A-Za-z0-9_-]{6,64}$/.test(s);
const firstLine = (s) => String(s ?? '').split('\n').map((x) => x.trim()).filter(Boolean).slice(-1)[0]?.slice(0, 300) ?? '';
const missingBin = () => 'The engine is not installed: `megalens-review` was not found on PATH (set MEGALENS_REVIEW_BIN to its path). Once it is, run `node scripts/engine.mjs install` once (it downloads the pinned Codex CLI and checks its hashes). No review ran. /megalens:megalens-review (the bundle route) still works with a token.\n';

async function finishNoDoc(r, say, env, probe = null) {
  if (r.code === 127) { if (probe) probe.setup = true; say(missingBin()); return 4; }
  if (probe && shouldFallBack({ code: r.code, stderr: r.stderr })) probe.setup = true;
  say(renderResult(null, { exit: r.code, stderrText: scrub(firstLine(r.stderr), env) })); return r.code === 0 ? 4 : r.code;
}

async function fetchAndRender(bin, args, base, say, env, probe = null, { showId = false, onDoc = null, meta = null, shouldSuppress = null } = {}) {
  const d = privateDir();
  try {
    const outFile = path.join(d, 'findings.json');
    const r = await runBin(bin, [...args, '--out', outFile], base);
    if (meta) {
      meta.aborted = Boolean(r.aborted || base.signal?.aborted);
      meta.finalized = r.finalized !== false;
    }
    if (r.aborted || base.signal?.aborted || shouldSuppress?.()) return 0;
    if (r.code === 127) { if (probe) probe.setup = true; say(missingBin()); return 4; }
    let doc = null;
    try { if (statSync(outFile).size <= MAX_OUT) doc = JSON.parse(readFileSync(outFile, 'utf8')); } catch { doc = null; }
    if (probe && (doc ? isSandboxPrecheckDoc(doc, r.code) : shouldFallBack({ code: r.code, stderr: r.stderr }))) probe.setup = true;
    if (!doc && /still running/i.test(r.stderr)) {
      say(showId ? 'That review is still running, so there is no result yet. Nothing has been found or ruled out. Check with /megalens:status.\n' : `${STILL_RUNNING_LINE}\n`);
      return 4;
    }
    if (!doc && /unknown review id/i.test(r.stderr)) { say('The engine does not know that review id (wrong id, or it was cleaned up). No result.\n'); return 4; }
    if (doc && onDoc) await onDoc(doc);
    say(renderResult(doc, { exit: r.code, stderrText: scrub(firstLine(r.stderr), env), showId }));
    return r.code !== 0 ? r.code : (!doc || doc.status === 'failed' || !doc.passes?.some?.((x) => x?.status === 'ok' && x.name !== 'first-review') ? 4 : 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const ac = new AbortController();
  const stop = () => { ac.abort(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.exitCode = await main(process.argv.slice(2), { signal: ac.signal });
}
