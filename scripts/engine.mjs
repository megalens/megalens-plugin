#!/usr/bin/env node
// Front end for the engine v2 CLI (`megalens-review`), used by /megalens:review, /megalens:status, /megalens:result.
//   engine.mjs review [standard|deep]   (double exists but is off: DOUBLE_TIER_ENABLED) [--quiet] [--first-review FILE] [--base REF --head REF] [--wait]
//   engine.mjs status <review-id>      engine.mjs result <review-id>
//   engine.mjs first-review-write      (reads the host's review JSON on stdin, writes a clean 0600 file in a private folder, prints its path)
// Prints text for the user. Never prints credentials. Needs the engine binary: MEGALENS_REVIEW_BIN, else `megalens-review` on PATH.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, lstatSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { secretPath } from './lib/safety.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubExact, chooseRoute, isRunnerId, runnerReview, runnerStatus, runnerResult, realExec, SetupError } from './lib/gh-runner.mjs';
import { DOUBLE_TIER_ENABLED, DOUBLE_OFF_MESSAGE, REF_RE, UsageError, parseReviewArgs, assertReviewId, chooseAuth, childEnv, scrub, normalizeFirstReview, renderResult } from './lib/engine-core.mjs';

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

function runBin(bin, args, { env, cwd }) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return resolve({ code: 127, stdout: '', stderr: String(e.message) }); }
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { if (stdout.length < MAX_OUT) stdout += c; });
    child.stderr.on('data', (c) => { if (stderr.length < MAX_OUT) stderr += c; });
    child.on('error', (e) => resolve({ code: e.code === 'ENOENT' ? 127 : 4, stdout, stderr: e.code === 'ENOENT' ? 'engine binary not found' : String(e.message) }));
    child.on('close', (code, sig) => resolve({ code: code ?? (sig ? 4 : 0), stdout, stderr }));
  });
}

const privateDir = () => mkdtempSync(path.join(tmpdir(), 'megalens-'), { mode: 0o700 });

export async function main(argv, { env = process.env, cwd = process.cwd(), out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s), stdin = () => readStdin(), flags = {}, exec = realExec, platform = process.platform } = {}) {
  const [cmd, ...rest0] = argv;
  let rest = rest0; let runnerFlag = null;
  if (cmd === 'review') {
    const i = rest0.indexOf('--runner');
    if (i !== -1) {
      runnerFlag = rest0[i + 1];
      if (runnerFlag !== 'github' && runnerFlag !== 'local') { out('--runner needs github or local.\n'); return 4; }
      rest = [...rest0.slice(0, i), ...rest0.slice(i + 2)];
    }
  }
  const say = (t) => out(scrub(t, env));
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
      // The engine's own commands: `install` is the only thing that downloads (the pinned Codex CLI, hash-checked). No credentials involved.
      const r = await runBin(env.MEGALENS_REVIEW_BIN || 'megalens-review', [cmd], { env: childEnv(env, 'none'), cwd });
      if (r.code === 127) { say(missingBin()); return 4; }
      say(`${cmd === 'install' ? 'Engine install' : 'Engine verify'} ${r.code === 0 ? 'finished' : `FAILED (exit ${r.code})`}.\n${firstLine(r.stderr) ? `Engine said: ${firstLine(r.stderr)}\n` : ''}${r.code === 0 ? '' : 'The pinned Codex CLI is not verified, so reviews will not run.\n'}`);
      return r.code;
    }
    if (!['review', 'status', 'result'].includes(cmd)) throw new UsageError('usage: engine.mjs review|status|result|show-change|install|verify ...');

    if (cmd === 'review' && rest.some((a, i) => a === 'double' && !['--base', '--head', '--first-review'].includes(rest[i - 1])) && !(flags.double ?? DOUBLE_TIER_ENABLED)) { say(DOUBLE_OFF_MESSAGE + '\n'); return 4; } // before auth: nothing else is touched
    if ((cmd === 'status' || cmd === 'result') && rest[0] !== undefined && /^gh:/.test(rest[0])) {
      if (!isRunnerId(rest[0]) || rest.length !== 1) throw new UsageError('that is not a GitHub review id (they look like gh:123456789)');
      const r = await (cmd === 'status' ? runnerStatus : runnerResult)({ exec, cwd, env }, rest[0]);
      out(scrubExact(r.text, env)); return r.code;
    }
    if (cmd === 'review') {
      const route = chooseRoute({ platform, runner: runnerFlag });
      const viaRunner = async (note = '', localText = '') => {
        const o = parseReviewArgs(rest, flags);
        const r = await runnerReview({ exec, cwd, env, tier: o.tier, base: o.base, head: o.head, wait: o.wait, ...(flags.runnerTiming ?? {}) });
        // When the runner cannot start either, the user also needs to hear why the local engine did not run.
        out(scrubExact(note + r.text, env) + (r.setup && localText ? scrub(`\nThe local engine said:\n${localText}`, env) : ''));
        return r.code;
      };
      if (route.route === 'github') return await viaRunner();
      if (route.fallbackAllowed) {
        let buf = '';
        const code = await main(['review', ...rest, '--runner', 'local'], { env, cwd, out: (t) => { buf += t; }, err, stdin, flags, exec, platform });
        if ((code === 4 || code === 127) && (buf.includes(missingBin()) || /blocks nested sandboxes/i.test(buf) || /No MegaLens credentials\./.test(buf))) return await viaRunner('The local engine cannot run here (missing, no sandbox, or no local token), so the review runs on your GitHub runner instead.\n', buf);
        out(buf); return code;
      }
    }
    const auth = chooseAuth(env, flags);
    if (auth.error) { say(`MegaLens engine not started: ${auth.error}\n`); return 4; }
    const bin = env.MEGALENS_REVIEW_BIN || 'megalens-review';
    const base = { env: childEnv(env, auth.mode), cwd };

    if (cmd === 'status') {
      const id = assertReviewId(rest[0]);
      const r = await runBin(bin, ['status', id], base);
      if (r.code === 127) { say(missingBin()); return 4; }
      let j; try { j = JSON.parse(r.stdout); } catch { j = null; }
      if (r.code !== 0 || !j || typeof j.state !== 'string' || !STATES.includes(j.state)) { say(`Could not read the status of ${id}: ${firstLine(r.stderr) || 'no usable answer from the engine'}. This is not a finished review.\n`); return 4; }
      const tier = flat(j.tier ?? 'unknown tier', 20); const reason = j.reason ? ` Reason: ${flat(j.reason, 100)}.` : '';
      const msg = {
        running: `Still running. Check again with /megalens:status ${id}.`,
        complete: `Finished. Fetch it with /megalens:result ${id}.`,
        partial: `PARTIAL: part of the review did not finish, so it is not a clean review.${reason} Fetch what exists with /megalens:result ${id}.`,
        failed: `FAILED: the review did not complete, so it is not a clean review and says nothing about your change.${reason} /megalens:result ${id} shows what the engine recorded.`,
        cancelled: `CANCELLED: the review did not complete, so it says nothing about your change.${reason}`,
      }[j.state];
      say(`Review ${id} (${tier}): ${j.state}. ${msg}\n`); return 0;
    }

    if (cmd === 'result') {
      const id = assertReviewId(rest[0]);
      return await fetchAndRender(bin, ['result', id], base, say, env);
    }

    const o = parseReviewArgs(rest, flags);
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
      if (o.tier === 'deep' && !o.wait) {
        args.push('--background');
        const r = await runBin(bin, args, base);
        if (r.code === 127) { say(missingBin()); return 4; }
        let j; try { j = JSON.parse(r.stdout); } catch { j = null; }
        if (r.code !== 0 || !j || !REVIEW_ID(j.review_id)) return await finishNoDoc(r, say, env);
        say(`Deep review started in the background: ${j.review_id}\nIt can take about 20 minutes. Check with /megalens:status ${j.review_id}, then fetch with /megalens:result ${j.review_id}. Nothing has been reviewed yet.\n`);
        return 0;
      }
      return await fetchAndRender(bin, args, base, say, env);
    } finally {
      for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
      // the host's file is deleted whether or not it validated, but only if it is exactly the file first-review-write made, and never recursively
      if (p !== null) cleanupFirstReview(p);
    }
  } catch (e) {
    if (e instanceof UsageError) { say(`${e.message}\n`); return 4; }
    err(scrub(`megalens engine front end error: ${String(e?.message ?? e).slice(0, 200)}\n`, env)); return 4;
  }
}

const REVIEW_ID = (s) => typeof s === 'string' && /^rv_[A-Za-z0-9_-]{6,64}$/.test(s);
const firstLine = (s) => String(s ?? '').split('\n').map((x) => x.trim()).filter(Boolean).slice(-1)[0]?.slice(0, 300) ?? '';
const missingBin = () => 'The engine is not installed: `megalens-review` was not found on PATH (set MEGALENS_REVIEW_BIN to its path). Once it is, run `node scripts/engine.mjs install` once (it downloads the pinned Codex CLI and checks its hashes). No review ran. /megalens:megalens-review (the bundle route) still works with a token.\n';

async function finishNoDoc(r, say, env) {
  if (r.code === 127) { say(missingBin()); return 4; }
  say(renderResult(null, { exit: r.code, stderrText: scrub(firstLine(r.stderr), env) })); return r.code === 0 ? 4 : r.code;
}

async function fetchAndRender(bin, args, base, say, env) {
  const d = privateDir();
  try {
    const outFile = path.join(d, 'findings.json');
    const r = await runBin(bin, [...args, '--out', outFile], base);
    if (r.code === 127) { say(missingBin()); return 4; }
    let doc = null;
    try { if (statSync(outFile).size <= MAX_OUT) doc = JSON.parse(readFileSync(outFile, 'utf8')); } catch { doc = null; }
    if (!doc && /still running/i.test(r.stderr)) { say('That review is still running, so there is no result yet. Nothing has been found or ruled out. Check with /megalens:status.\n'); return 4; }
    if (!doc && /unknown review id/i.test(r.stderr)) { say('The engine does not know that review id (wrong id, or it was cleaned up). No result.\n'); return 4; }
    say(renderResult(doc, { exit: r.code, stderrText: scrub(firstLine(r.stderr), env) }));
    return r.code !== 0 ? r.code : (!doc || doc.status === 'failed' || !doc.passes?.some?.((x) => x?.status === 'ok' && x.name !== 'first-review') ? 4 : 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
