#!/usr/bin/env node
// Front end for the engine v2 CLI (`megalens-review`), used by /megalens:review, /megalens:status, /megalens:result.
//   engine.mjs review [standard|double|deep] [--quiet] [--first-review FILE] [--base REF --head REF] [--wait]
//   engine.mjs status <review-id>      engine.mjs result <review-id>
//   engine.mjs first-review-write      (reads the host's review JSON on stdin, writes a clean 0600 file in a private folder, prints its path)
// Prints text for the user. Never prints credentials. Needs the engine binary: MEGALENS_REVIEW_BIN, else `megalens-review` on PATH.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError, parseReviewArgs, assertReviewId, chooseAuth, childEnv, scrub, normalizeFirstReview, renderResult } from './lib/engine-core.mjs';

const MAX_OUT = 1 << 22; // bytes we keep from the engine's output streams
const MAX_FIRST_REVIEW = 1 << 20;
const FIRST_REVIEW_NAME = 'first-review.json';
const STATES = ['running', 'complete', 'partial', 'failed', 'cancelled'];
const flat = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ').trim().slice(0, n);
async function readStdin() { let b = ''; process.stdin.setEncoding('utf8'); for await (const c of process.stdin) { b += c; if (b.length > MAX_FIRST_REVIEW * 2) break; } return b; }

/** True only for the exact file `first-review-write` makes: <tmpdir>/megalens-XXXXXX/first-review.json, in a real (non-link) folder. */
function isOurFirstReview(p) {
  try {
    const dir = path.dirname(p);
    if (path.basename(p) !== FIRST_REVIEW_NAME || path.dirname(dir) !== tmpdir() || !/^megalens-[A-Za-z0-9_-]{6,}$/.test(path.basename(dir))) return false;
    const st = lstatSync(dir); return st.isDirectory() && !st.isSymbolicLink();
  } catch { return false; }
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

export async function main(argv, { env = process.env, cwd = process.cwd(), out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s), stdin = () => readStdin(), flags = {} } = {}) {
  const [cmd, ...rest] = argv;
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
    if (!['review', 'status', 'result'].includes(cmd)) throw new UsageError('usage: engine.mjs review|status|result ...');

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

    const o = parseReviewArgs(rest);
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
      // the host's file is deleted whether or not it validated, but only if it is exactly the file first-review-write made
      if (p !== null && isOurFirstReview(p)) rmSync(path.dirname(p), { recursive: true, force: true });
    }
  } catch (e) {
    if (e instanceof UsageError) { say(`${e.message}\n`); return 4; }
    err(scrub(`megalens engine front end error: ${String(e?.message ?? e).slice(0, 200)}\n`, env)); return 4;
  }
}

const REVIEW_ID = (s) => typeof s === 'string' && /^rv_[A-Za-z0-9_-]{6,64}$/.test(s);
const firstLine = (s) => String(s ?? '').split('\n').map((x) => x.trim()).filter(Boolean).slice(-1)[0]?.slice(0, 300) ?? '';
const missingBin = () => 'The engine is not installed: `megalens-review` was not found on PATH (set MEGALENS_REVIEW_BIN to its path). No review ran. /megalens:megalens-review (the bundle route) still works with a token.\n';

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
