import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chooseRoute, shouldFallBack, ghEnv, preflight, startRun, mapState, runnerStatus, runnerResult, runnerReview, isRunnerId, runIdOf, workflowText, MSG, WORKFLOW_FILE } from '../scripts/lib/gh-runner.mjs';
import { main } from '../scripts/engine.mjs';

const TOKEN = 'ml_SECRETTOKEN1234567890';
const H = 'a'.repeat(40); const B = 'b'.repeat(40);
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const bad = (stderr = 'boom', code = 1) => ({ code, stdout: '', stderr });

// A fake gh + git. `over` replaces the answer for a command key ("gh auth", "git status", ...). Every call is recorded.
function fakeExec(over = {}, { runs = [] } = {}) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env });
    const key = `${cmd} ${args.slice(0, 2).join(' ')}`;
    for (const k of Object.keys(over)) if (key.startsWith(k)) return typeof over[k] === 'function' ? over[k](args, opts) : over[k];
    if (key.startsWith('gh --version')) return ok('gh version 2');
    if (key.startsWith('gh auth')) return ok('Logged in');
    if (key.startsWith('gh repo')) return ok(JSON.stringify({ nameWithOwner: 'acme/widget', defaultBranchRef: { name: 'main' }, url: 'https://github.com/acme/widget' }));
    if (key.startsWith('gh api') && args.some((a) => a.includes('/contents/'))) return ok('file');
    if (key.startsWith('gh secret')) return ok(JSON.stringify([{ name: 'MEGALENS_TOKEN' }]));
    if (key.startsWith('git rev-parse')) return ok(H + '\n');
    if (key.startsWith('git merge-base')) return ok(B + '\n');
    if (key.startsWith('git status')) return ok('');
    if (key.startsWith('git branch')) return ok('feature\n');
    if (key.startsWith('gh api') && args.some((a) => a.includes('/commits/'))) return ok(H + '\n');
    if (key.startsWith('gh workflow run')) return ok('');
    if (key.startsWith('gh run list')) return ok(JSON.stringify(runs));
    return bad(`unexpected call: ${key}`, 99);
  };
  return { exec, calls };
}
const env = { PATH: process.env.PATH, HOME: tmpdir(), MEGALENS_TOKEN: TOKEN, GH_TOKEN: 'ghp_x' };
const pf = (over, extra = {}) => preflight({ exec: fakeExec(over).exec, cwd: '/r', env, ...extra });
const msgOf = async (p) => { try { await p; return null; } catch (e) { return e; } };

test('route choice: platform, local engine first on Linux, flags force a route', () => {
  assert.deepEqual(chooseRoute({ platform: 'linux' }), { route: 'local', fallbackAllowed: true });
  assert.deepEqual(chooseRoute({ platform: 'darwin' }), { route: 'github', fallbackAllowed: false });
  assert.deepEqual(chooseRoute({ platform: 'win32' }), { route: 'github', fallbackAllowed: false });
  assert.equal(chooseRoute({ platform: 'linux', runner: 'github' }).route, 'github');
  assert.deepEqual(chooseRoute({ platform: 'darwin', runner: 'local' }), { route: 'local', fallbackAllowed: false });
  assert.equal(shouldFallBack({ code: 127 }), true);
  assert.equal(shouldFallBack({ code: 4, stderr: 'error: Your runner blocks nested sandboxes (Ubuntu AppArmor).' }), true);
  assert.equal(shouldFallBack({ code: 4, stderr: 'something else' }), false);
  assert.equal(shouldFallBack({ code: 3, stderr: 'blocks nested sandboxes' }), false);
});

test('id format gh:<run id>', () => {
  for (const g of ['gh:1', 'gh:12345678901']) assert.equal(isRunnerId(g), true);
  for (const b of ['gh:', 'gh:0', 'gh:012', 'gh:1a', 'rv_abc12345', 'gh: 1', 'gh:1\n2', 'gh:1234567890123456789', undefined]) assert.equal(isRunnerId(b), false, String(b));
  assert.equal(runIdOf('gh:42'), '42');
  assert.throws(() => runIdOf('gh:x'), /not a GitHub review id/);
});

test('precondition messages name the exact fix', async () => {
  assert.equal((await msgOf(pf({ 'gh --version': bad('', 127) }))).message, MSG.noGh);
  assert.match(MSG.noGh, /cli\.github\.com/);
  assert.equal((await msgOf(pf({ 'gh auth': bad() }))).message, MSG.noLogin);
  assert.match(MSG.noLogin, /gh auth login/);
  assert.equal((await msgOf(pf({ 'gh repo': bad('no git remotes found') }))).message, MSG.noRemote);
  const wf = await msgOf(pf({ 'gh api': (a) => (a.some((x) => x.includes('/contents/')) ? bad('HTTP 404') : ok(H)) }));
  assert.match(wf.message, /not on your default branch \(main\)/);
  assert.match(wf.message, /\.github\/workflows\/megalens-dispatch\.yml/);
  assert.ok(wf.message.includes(workflowText()), 'prints the whole file to add');
  const sec = await msgOf(pf({ 'gh secret': ok('[{"name":"OTHER"}]') }));
  assert.equal(sec.message, MSG.noSecret); assert.match(sec.message, /gh secret set MEGALENS_TOKEN/);
  assert.equal((await msgOf(pf({ 'gh secret': ok('[]') }))).message, MSG.noSecret);
});

test('secret check: only the name is asked for; no permission to list is a note, not a stop; the value is never read or printed', async () => {
  const f = fakeExec();
  const r = await preflight({ exec: f.exec, cwd: '/r', env });
  const sc = f.calls.filter((c) => c.args[0] === 'secret');
  assert.deepEqual(sc.map((c) => c.args), [['secret', 'list', '--json', 'name']]);
  assert.equal(JSON.stringify(f.calls.map((c) => c.args)).includes(TOKEN), false);
  for (const c of f.calls) { assert.equal(c.env?.MEGALENS_TOKEN, undefined); assert.equal(Object.values(c.env ?? {}).includes(TOKEN), false); }
  assert.equal(r.note, '');
  const n = await pf({ 'gh secret': bad('HTTP 403: Resource not accessible by integration') });
  assert.match(n.note, /Could not check the repository secret/);
});

test('ghEnv passes gh credentials and basics, never MegaLens or OpenAI secrets', () => {
  const e = ghEnv({ PATH: '/b', HOME: '/h', GH_TOKEN: 'g', MEGALENS_TOKEN: TOKEN, OPENAI_API_KEY: 'k', MEGALENS_REVIEW_KEY: 'rk', AWS_SECRET_ACCESS_KEY: 'a', SystemRoot: 'C:\\Windows' });
  assert.equal(e.GH_TOKEN, 'g'); assert.equal(e.SystemRoot, 'C:\\Windows');
  for (const k of ['MEGALENS_TOKEN', 'OPENAI_API_KEY', 'MEGALENS_REVIEW_KEY', 'AWS_SECRET_ACCESS_KEY']) assert.equal(e[k], undefined);
});

test('change must be on GitHub: unpushed HEAD asks the user and never pushes; dirty tree is said plainly; nothing to review stops', async () => {
  const f = fakeExec({ 'gh api': (a) => (a.some((x) => x.includes('/contents/')) ? ok('file') : bad('HTTP 422 No commit found')) });
  const e = await msgOf(preflight({ exec: f.exec, cwd: '/r', env }));
  assert.equal(e.needsUser, true);
  assert.match(e.message, /NEEDS THE USER'S OK/); assert.match(e.message, /Nothing was pushed/); assert.match(e.message, /Only if the user says yes, run `git push`/);
  assert.equal(f.calls.some((c) => c.cmd === 'git' && c.args[0] === 'push'), false);
  const dirty = await pf({ 'git status': ok(' M a.js\n') });
  assert.match(dirty.note, /uncommitted changes are not reviewable/);
  const same = await msgOf(pf({ 'git merge-base': ok(H + '\n') }));
  assert.match(same.message, /Nothing to review/);
  const nobase = await msgOf(pf({ 'git merge-base': bad('') }));
  assert.match(nobase.message, /git fetch origin main/);
});

test('start: dispatch args, run id found by head sha, tier and time, printed as gh:<id>', async () => {
  const now = Date.now();
  const mk = (id, title, ago) => ({ databaseId: id, displayTitle: title, createdAt: new Date(now - ago).toISOString(), url: `https://github.com/acme/widget/actions/runs/${id}` });
  const f = fakeExec({}, { runs: [mk(1, `MegaLens standard ${H}`, 3_600_000), mk(2, `MegaLens standard ${'c'.repeat(40)}`, 1000), mk(3, `MegaLens standard ${H}`, 1000), mk(4, `MegaLens deep ${H}`, 500)] });
  const r = await runnerReview({ exec: f.exec, cwd: '/r', env, tier: 'standard', sleepMs: 1, tries: 2 });
  assert.equal(r.code, 0); assert.equal(r.id, 'gh:3');
  assert.match(r.text, /Review started on GitHub: gh:3/); assert.match(r.text, /actions\/runs\/3/); assert.match(r.text, /\/megalens:status gh:3/);
  const w = f.calls.find((c) => c.args[0] === 'workflow');
  assert.deepEqual(w.args, ['workflow', 'run', WORKFLOW_FILE, '--ref', 'main', '-f', 'tier=standard', '-f', `base_sha=${B}`, '-f', `head_sha=${H}`]);
  assert.equal(r.text.includes(TOKEN), false);
  const none = await runnerReview({ exec: fakeExec({}, { runs: [] }).exec, cwd: '/r', env, tier: 'standard', sleepMs: 1, tries: 2 });
  assert.equal(none.code, 0); assert.match(none.text, /id could not be found/);
  const refused = await runnerReview({ exec: fakeExec({ 'gh workflow': bad('HTTP 422: Workflow does not have workflow_dispatch') }).exec, cwd: '/r', env, tier: 'standard' });
  assert.equal(refused.code, 4); assert.match(refused.text, /did not start the workflow/);
});

test('deep prints the id and stops, even with --wait', async () => {
  const runs = [{ databaseId: 77, displayTitle: `MegaLens deep ${H}`, createdAt: new Date().toISOString(), url: 'https://github.com/acme/widget/actions/runs/77' }];
  const f = fakeExec({}, { runs });
  const r = await runnerReview({ exec: f.exec, cwd: '/r', env, tier: 'deep', wait: true, sleepMs: 1, tries: 2 });
  assert.match(r.text, /Review started on GitHub: gh:77/); assert.match(r.text, /about 20 minutes/); assert.match(r.text, /Nothing has been reviewed yet/);
  assert.equal(f.calls.some((c) => c.args[0] === 'run' && c.args[1] === 'view'), false);
  assert.equal((await runnerReview({ exec: f.exec, cwd: '/r', env, tier: 'double' })).code, 4);
});

test('status mapping: queued / running / done / failed, with the run URL; unknown is never fine', async () => {
  assert.deepEqual(['queued', 'waiting', 'pending', 'requested'].map((s) => mapState(s, '')), ['queued', 'queued', 'queued', 'queued']);
  assert.equal(mapState('in_progress', ''), 'running');
  assert.equal(mapState('completed', 'success'), 'done');
  for (const c of ['failure', 'cancelled', 'timed_out', 'skipped', 'neutral', '', 'action_required']) assert.equal(mapState('completed', c), 'failed', c);
  assert.equal(mapState('weird', ''), 'failed');
  const view = (status, conclusion, name = 'MegaLens Dispatch') => ({ 'gh run': ok(JSON.stringify({ status, conclusion, url: 'https://github.com/acme/widget/actions/runs/9', workflowName: name, displayTitle: 't' })) });
  for (const [s, c, word] of [['queued', '', 'queued'], ['in_progress', '', 'running'], ['completed', 'success', 'done'], ['completed', 'failure', 'failed']]) {
    const f = fakeExec(view(s, c)); const r = await runnerStatus({ exec: f.exec, cwd: '/r', env }, 'gh:9');
    assert.match(r.text, new RegExp(`Review gh:9: ${word}\\.`)); assert.match(r.text, /Run: https:\/\/github\.com\/acme\/widget\/actions\/runs\/9/);
    if (word === 'failed') assert.match(r.text, /not a clean review/);
  }
  const other = await runnerStatus({ exec: fakeExec(view('completed', 'success', 'CI')).exec, cwd: '/r', env }, 'gh:9');
  assert.match(other.text, /not a MegaLens review run/); assert.equal(other.code, 4);
  const gone = await runnerStatus({ exec: fakeExec({ 'gh run': bad('HTTP 404: Not Found') }).exec, cwd: '/r', env }, 'gh:9');
  assert.match(gone.text, /not a finished review/); assert.equal(gone.code, 4);
});

const doc = (o = {}) => ({ schema: 'megalens.findings/v1', review_id: 'rv_abc12345', tier: 'standard', status: 'complete', passes: [{ name: 'codex-standard', model: 'm', status: 'ok' }],
  findings: [{ id: 'f1', file: 'src/a.js', line_start: 3, line_end: 3, title: 'Null deref', claim: 'x is null', failure_scenario: 'call with no args', priority: 'P1', strength: 'strong', found_by: ['codex-standard'] }], ...o });
// download writes findings.json into the -D folder, like gh does
function resultExec(status, conclusion, document) {
  const dirs = [];
  const f = fakeExec({
    'gh run view': ok(JSON.stringify({ status, conclusion, url: 'https://github.com/acme/widget/actions/runs/9', workflowName: 'MegaLens Dispatch', displayTitle: 't' })),
    'gh run download': (a) => { const dir = a[a.indexOf('-D') + 1]; dirs.push(dir); if (document === null) return bad('no valid artifacts found to download'); writeFileSync(path.join(dir, 'findings.json'), JSON.stringify(document)); return ok(); },
  });
  return { ...f, dirs };
}

test('result: downloads the findings artifact, renders with the shared presenter, deletes the temp folder', async () => {
  const f = resultExec('completed', 'success', doc());
  const r = await runnerResult({ exec: f.exec, cwd: '/r', env }, 'gh:9');
  assert.equal(r.code, 0);
  assert.match(r.text, /## MegaLens standard review: complete/); assert.match(r.text, /Strong findings \(1\)/); assert.match(r.text, /src\/a\.js:3/); assert.match(r.text, /Null deref/);
  const dl = f.calls.find((c) => c.args[1] === 'download'); assert.deepEqual(dl.args.slice(0, 5), ['run', 'download', '9', '-n', 'megalens-findings']);
  assert.equal(f.dirs.length, 1); assert.equal(existsSync(f.dirs[0]), false, 'temp folder removed');
});

test('result: PARTIAL, FAILED, failed run, missing artifact and still-running are never called clean', async () => {
  const partial = await runnerResult({ exec: resultExec('completed', 'success', doc({ status: 'partial', passes: [{ name: 'a', status: 'ok' }, { name: 'b', status: 'failed' }] })).exec, cwd: '/r', env }, 'gh:9');
  assert.match(partial.text, /review: PARTIAL/); assert.match(partial.text, /does not mean the change is clean/);
  const failedDoc = await runnerResult({ exec: resultExec('completed', 'failure', doc({ status: 'failed', findings: [] })).exec, cwd: '/r', env }, 'gh:9');
  assert.match(failedDoc.text, /review: FAILED/); assert.equal(failedDoc.code, 4); assert.equal(/No findings were reported by a complete review/.test(failedDoc.text), false);
  const failedRunCompleteDoc = await runnerResult({ exec: resultExec('completed', 'failure', doc({ findings: [] })).exec, cwd: '/r', env }, 'gh:9');
  assert.match(failedRunCompleteDoc.text, /FAILED/); assert.equal(failedRunCompleteDoc.code, 4);
  const noArt = resultExec('completed', 'failure', null);
  const na = await runnerResult({ exec: noArt.exec, cwd: '/r', env }, 'gh:9');
  assert.match(na.text, /NOT COMPLETED/); assert.match(na.text, /not a clean review/); assert.equal(existsSync(noArt.dirs[0]), false);
  const running = await runnerResult({ exec: resultExec('in_progress', '', doc()).exec, cwd: '/r', env }, 'gh:9');
  assert.match(running.text, /still running/); assert.equal(running.code, 4);
  const junk = await runnerResult({ exec: resultExec('completed', 'success', { schema: 'nope' }).exec, cwd: '/r', env }, 'gh:9');
  assert.match(junk.text, /NOT COMPLETED/);
});

// ---- through engine.mjs main: route choice and secrets ----
function fakeBin(exit, stderr) {
  const d = mkdtempSync(path.join(tmpdir(), 'mlfake-')); const bin = path.join(d, 'megalens-review');
  writeFileSync(bin, `#!/usr/bin/env node\nprocess.stderr.write(${JSON.stringify(stderr)}+'\\n');process.exit(${exit});\n`); chmodSync(bin, 0o755); return bin;
}
async function viaMain(argv, { platform = 'linux', bin, exec, env: e = {} } = {}) {
  let text = '';
  const code = await main(argv, { platform, exec, env: { PATH: process.env.PATH, HOME: tmpdir(), MEGALENS_TOKEN: TOKEN, GH_TOKEN: 'ghp_x', ...(bin ? { MEGALENS_REVIEW_BIN: bin } : {}), ...e }, cwd: tmpdir(), out: (s) => { text += s; }, err: () => {}, flags: { runnerTiming: { sleepMs: 1, tries: 2 } } });
  return { code, text };
}
const runList = [{ databaseId: 5, displayTitle: `MegaLens standard ${H}`, createdAt: new Date().toISOString(), url: 'https://github.com/acme/widget/actions/runs/5' }];

test('main: macOS and Windows use the runner; no engine and no MEGALENS_TOKEN needed', async () => {
  for (const platform of ['darwin', 'win32']) {
    const f = fakeExec({}, { runs: runList });
    const r = await viaMain(['review', 'standard'], { platform, exec: f.exec, env: { MEGALENS_TOKEN: undefined } });
    assert.equal(r.code, 0); assert.match(r.text, /Review started on GitHub: gh:5/);
  }
});

test('main: Linux with a missing engine, or a failed sandbox pre-check, falls back to the runner; other failures do not', async () => {
  const f1 = fakeExec({}, { runs: runList });
  const missing = await viaMain(['review', 'standard'], { exec: f1.exec, env: { MEGALENS_REVIEW_BIN: '/nonexistent/megalens-review' } });
  assert.match(missing.text, /runs on your GitHub runner instead/); assert.match(missing.text, /gh:5/);
  const f2 = fakeExec({}, { runs: runList });
  const sb = await viaMain(['review', 'standard'], { exec: f2.exec, bin: fakeBin(4, 'error: Your runner blocks nested sandboxes (Ubuntu AppArmor). Add this') });
  assert.match(sb.text, /runs on your GitHub runner instead/); assert.match(sb.text, /gh:5/);
  const f3 = fakeExec({}, { runs: runList });
  const other = await viaMain(['review', 'standard'], { exec: f3.exec, bin: fakeBin(4, 'error: something unrelated') });
  assert.equal(other.code, 4); assert.equal(f3.calls.length, 0); assert.doesNotMatch(other.text, /GitHub runner/);
});

test('main: Linux with no local MEGALENS_TOKEN cannot run the engine, so it uses the runner (which needs no local token)', async () => {
  const f = fakeExec({}, { runs: runList });
  const r = await viaMain(['review', 'standard'], { exec: f.exec, bin: fakeBin(0, ''), env: { MEGALENS_TOKEN: undefined } });
  assert.match(r.text, /runs on your GitHub runner instead/); assert.match(r.text, /gh:5/);
});

test('main: the runner failing too still says why the local engine did not run', async () => {
  const f = fakeExec({ 'gh --version': bad('', 127) });
  const r = await viaMain(['review', 'standard'], { exec: f.exec, env: { MEGALENS_REVIEW_BIN: '/nonexistent/megalens-review' } });
  assert.match(r.text, /not installed/); assert.match(r.text, /GitHub CLI/); assert.equal(r.code, 4);
});

test('main: --runner github forces the runner on Linux; --runner local never touches gh', async () => {
  const f = fakeExec({}, { runs: runList });
  const g = await viaMain(['review', '--runner', 'github', 'standard'], { exec: f.exec, bin: fakeBin(0, '') });
  assert.match(g.text, /gh:5/);
  const f2 = fakeExec();
  const l = await viaMain(['review', 'standard', '--runner', 'local'], { exec: f2.exec, env: { MEGALENS_REVIEW_BIN: '/nonexistent/megalens-review' }, platform: 'darwin' });
  assert.equal(f2.calls.length, 0); assert.match(l.text, /not installed/);
  const bad1 = await viaMain(['review', '--runner', 'cloud'], { exec: f2.exec });
  assert.match(bad1.text, /--runner needs github or local/);
});

test('main: status and result take gh: ids; junk ids are refused; no secret value reaches gh or the output', async () => {
  const f = fakeExec({ 'gh run view': ok(JSON.stringify({ status: 'completed', conclusion: 'success', url: 'https://github.com/acme/widget/actions/runs/9', workflowName: 'MegaLens Dispatch', displayTitle: 't' })) });
  const s = await viaMain(['status', 'gh:9'], { exec: f.exec, env: { MEGALENS_TOKEN: undefined } });
  assert.match(s.text, /Review gh:9: done/);
  const bad1 = await viaMain(['status', 'gh:9;rm'], { exec: f.exec });
  assert.match(bad1.text, /not a GitHub review id/);
  const rf = resultExec('completed', 'success', doc({ findings: [{ id: 'x', file: 'a.js', line_start: 1, title: `leaks ${TOKEN}`, claim: `token ${TOKEN}`, priority: 'P2', strength: 'normal', found_by: ['codex-standard'] }] }));
  const r = await viaMain(['result', 'gh:9'], { exec: rf.exec });
  assert.equal(r.text.includes(TOKEN), false, 'scrubbed on output');
  for (const c of [...f.calls, ...rf.calls]) { assert.equal(JSON.stringify(c.args).includes(TOKEN), false); assert.equal(c.env?.MEGALENS_TOKEN, undefined); }
});

test('workflow template: pinned shas, run-name carries tier and head, publish needs no write scope', () => {
  const y = workflowText();
  assert.match(y, /run-name: MegaLens \$\{\{ inputs\.tier \}\} \$\{\{ inputs\.head_sha \}\}/);
  assert.match(y, /workflow_dispatch:/);
  assert.equal((y.match(/megalens\/review-action@[0-9a-f]{40}/g) || []).length, 3);
  for (const sha of ['11bd71901bbe5b1630ceea73d27597364c9af683', 'ea165f8d65b6e75b540449e92b4886f43607fa02', 'd3f86a106a0bac45b974a628896c90dbdf5c8093']) assert.ok(y.includes(sha));
  assert.match(y, /apparmor_restrict_unprivileged_userns=0/);
  assert.equal(/pull-requests: write|contents: write|actions: write/.test(y), false);
  assert.equal((y.match(/megalens-token:/g) || []).length, 1, 'the account token goes to the create job only');
  assert.equal(/secrets\.MEGALENS_TOKEN/.test(y.split('review:')[1] ?? ''), false);
});
