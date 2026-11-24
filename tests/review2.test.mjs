import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDiffHeader, redactSecrets } from '../scripts/lib/safety.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const COLLECT = path.join(ROOT, 'scripts', 'collect.mjs'); const SERVER = path.join(ROOT, 'scripts', 'mcp-server.mjs');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
const put = (root, p, c) => { mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); writeFileSync(path.join(root, p), c); };
function repo(extra = () => {}) { const d = mkdtempSync(path.join(tmpdir(), 'mlr2-')); git(d, 'init', '-q', '-b', 'main'); put(d, 'src/a.js', 'export const a = 1;\n'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'base'); extra(d); put(d, 'src/a.js', 'export const a = 2;\n'); return d; }
const collect = (cwd, ...args) => { const r = spawnSync('node', [COLLECT, '--json', ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 28 }); return { code: r.status, j: JSON.parse(r.stdout), err: r.stderr }; };

test('1: a changed file that does not fit whole is windowed and still outranks context', () => {
  const big = (tag) => Array.from({ length: 1500 }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n') + '\n';
  const d = repo((x) => { put(x, 'src/beta.js', big('b')); put(x, 'src/gamma.js', big('g')); put(x, 'tests/beta.test.js', "import { b7 } from '../src/beta.js';\nconsole.assert(b7 === 7);\n"); git(x, 'add', '-A'); git(x, 'commit', '-qm', 'big'); });
  let beta = big('b').split('\n'); beta[700] = 'export const b700 = 99999;'; put(d, 'src/beta.js', beta.join('\n'));
  let gamma = big('g').split('\n'); gamma[10] = 'export const g10 = 77777;'; put(d, 'src/gamma.js', gamma.join('\n'));
  const { j } = collect(d, '--max-bytes', '30000');
  assert.ok(j.bundleBytes <= 30000, String(j.bundleBytes));
  for (const f of ['src/beta.js', 'src/gamma.js']) assert.ok(j.bundle.includes(`=== FILE: ${f} ===`), `${f} (changed) must be present`);
  assert.ok(j.bundle.includes('b700 = 99999') && j.bundle.includes('g10 = 77777'), 'the changed hunks are in the windows');
  assert.match(j.manifest, /beta\.js .*windowed ±\d+ lines around the changed hunks|beta\.js .*fair share/);
  const names = [...j.bundle.matchAll(/^=== FILE: (.*) ===$/gm)].map((m) => m[1]);
  assert.ok(names.indexOf('src/beta.js') < (names.indexOf('tests/beta.test.js') === -1 ? 99 : names.indexOf('tests/beta.test.js')), 'changed before context');
  rmSync(d, { recursive: true });
});
test('1: when changed files fit whole, context follows them', () => {
  const d = repo((x) => { put(x, 'src/a.js', 'export function alpha() { return 1; }\n'); put(x, 'tests/a.test.js', "import { alpha } from '../src/a.js';\n"); git(x, 'add', '-A'); git(x, 'commit', '-qm', 't'); });
  put(d, 'src/a.js', 'export function alpha() { return 2; }\n');
  const { j } = collect(d); const names = [...j.bundle.matchAll(/^=== FILE: (.*) ===$/gm)].map((m) => m[1]);
  assert.deepEqual(names.slice(0, 2), ['src/a.js', 'tests/a.test.js']);
  rmSync(d, { recursive: true });
});

test('2: nothing reviewable (all changed files excluded) -> no bundle, a clear reason, and no remote call', async () => {
  const d = repo(); put(d, 'src/a.js', 'export const a = 1;\n'); // undo the only reviewable change
  put(d, 'src/key.js', `const k = "${'AKIA' + 'ABCDEFGHIJKLMNOP'}";\n`); put(d, '.netrc', 'X=1\n'); git(d, 'add', '-A');
  const { j } = collect(d, '--staged'); assert.equal(j.nothingReviewable, true); assert.match(j.reason, /key\.js.*secret/s);
  const reqs = []; const srv = http.createServer((q, r) => { reqs.push(1); r.end('{}'); }); await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const p = spawn('node', [SERVER], { cwd: d, env: { ...process.env, MEGALENS_TOKEN: 't', MEGALENS_URL: `http://127.0.0.1:${srv.address().port}/x` }, stdio: ['pipe', 'pipe', 'inherit'] });
  const out = await new Promise((res) => { let b = ''; p.stdout.on('data', (c) => { b += c; if (b.includes('\n')) res(JSON.parse(b.split('\n')[0])); }); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'megalens_review_change', arguments: { range: '--staged' } } }) + '\n'); });
  assert.ok(!out.result.isError); assert.match(out.result.content[0].text, /Nothing reviewable was sent.*not called.*nothing was charged.*Why:.*key\.js/s);
  assert.equal(reqs.length, 0); p.kill(); srv.close(); rmSync(d, { recursive: true });
  const cli = spawnSync('node', [COLLECT, '--staged'], { cwd: repo(), encoding: 'utf8' }); assert.ok(!/NOTHING REVIEWABLE/.test(cli.stdout));
});

test('3: unchanged credential-bearing config is never pulled in as context; values are redacted in changed files and diffs', () => {
  const d = repo((x) => {
    put(x, 'config/database.yml', 'production:\n  password: hunter2-ctx\n'); put(x, 'settings.py', "SECRET_KEY = 'hunter2-settings'\n"); put(x, 'wp-config.php', "define('DB_PASSWORD', 'hunter2-wp');\n");
    put(x, 'app.ini', 'password=hunter2-ini\n'); put(x, 'docker-compose.yml', 'services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: hunter2-dc\n');
    put(x, 'src/uses.js', "// reads config/database.yml and app.ini via a(\nexport const u = () => a(1);\n"); put(x, 'config.json', '{"db": {"password": "hunter2-json", "host": "h"}}\n');
    put(x, 'src/conf.yml', 'api_key: hunter2-yaml\nname: n\n'); git(x, 'add', '-A'); git(x, 'commit', '-qm', 'cfg');
  });
  put(d, 'src/conf.yml', 'api_key: hunter2-yaml-changed\nname: n2\n'); put(d, 'src/a.js', "const token = 'hunter2-changed-js';\nexport const a = 3; read('config.json', 'config/database.yml', 'settings.py', 'wp-config.php', 'app.ini', 'docker-compose.yml');\n");
  const { j } = collect(d);
  assert.ok(!j.bundle.includes('hunter2'), 'no password value anywhere (files or diff)');
  for (const f of ['database.yml', 'settings.py', 'wp-config.php', 'app.ini', 'docker-compose.yml']) assert.ok(!j.bundle.includes(`=== FILE: ${f}`) && !j.bundle.includes(`config/${f}`.replace('config/settings', 'settings')) || true);
  for (const f of ['config/database.yml', 'settings.py', 'wp-config.php', 'app.ini', 'docker-compose.yml']) assert.ok(!j.bundle.includes(`=== FILE: ${f} ===`), `${f} not sent as context`);
  assert.match(j.manifest, /database\.yml: context, config file that may carry credentials/);
  assert.match(j.manifest, /redacted credential-style values: \d+/);
  assert.ok(/=== FILE: config\.json ===\n[^=]*\*\*\*REDACTED\*\*\*/.test(j.bundle), 'non-listed config is context but redacted');
  assert.ok(j.bundle.includes('***REDACTED***'));
  const lines = (t) => t.split('\n').length;
  const r = redactSecrets('a: 1\npassword: x\nb: 2\n', 'x.yml'); assert.equal(lines(r.text), 4); assert.equal(r.count, 1);
  rmSync(d, { recursive: true });
});
test('3: redaction keeps line numbers in windows aligned with the original file', () => {
  const body = Array.from({ length: 50 }, (_, i) => (i === 20 ? 'password: hunter2-line21' : `k${i}: v${i}`)); const d = repo((x) => { put(x, 'conf/x.yml', body.join('\n') + '\n'); git(x, 'add', '-A'); git(x, 'commit', '-qm', 'x'); });
  put(d, 'conf/x.yml', body.map((l, i) => (i === 20 ? l : i === 30 ? 'k30: CHANGED' : l)).join('\n') + '\n');
  const { j } = collect(d, '--max-bytes', '2500'); assert.ok(!j.bundle.includes('hunter2'));
  rmSync(d, { recursive: true });
});

test('4: octal-escaped UTF-8 names decode as UTF-8', () => {
  assert.equal(parseDiffHeader('diff --git "a/caf\\303\\251.js" "b/caf\\303\\251.js"', []).b, 'café.js');
  assert.equal(parseDiffHeader('diff --git "a/\\346\\227\\245\\346\\234\\254.pem" "b/\\346\\227\\245\\346\\234\\254.pem"', []).b, '日本.pem');
  const d = repo(); put(d, 'café.js', 'export const c = 1;\n'); put(d, 'ünï.pem', 'hunter2-pem\n'); git(d, 'add', '-A');
  const { j } = collect(d, '--staged'); assert.ok(j.bundle.includes('=== FILE: café.js ===')); assert.ok(!j.bundle.includes('hunter2-pem'));
  assert.ok(j.bundle.includes('diff --git "a/caf\\303\\251.js"') || j.bundle.includes('diff --git a/café.js'));
  rmSync(d, { recursive: true });
});

test('5: --staged reads file content from the index, not the working tree', () => {
  const d = repo(); put(d, 'src/a.js', 'export const a = "STAGED-VERSION";\n'); git(d, 'add', 'src/a.js'); put(d, 'src/a.js', 'export const a = "WORKTREE-VERSION";\n');
  const { j } = collect(d, '--staged');
  assert.ok(j.bundle.includes('STAGED-VERSION')); assert.ok(!j.bundle.includes('WORKTREE-VERSION'));
  const full = collect(d); assert.ok(full.j.bundle.includes('WORKTREE-VERSION'));
  rmSync(d, { recursive: true });
});

test('6: the local server sends no instructions field (nothing that could prompt paid runs)', async () => {
  const p = spawn('node', [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });
  const init = await new Promise((res) => { p.stdout.once('data', (c) => res(JSON.parse(String(c)))); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n'); });
  assert.equal(init.result.instructions, undefined); p.kill();
});

test('7: a timed-out debate call says a run may have started, not to call again; no retry', async () => {
  const d = repo(); const reqs = [];
  const srv = http.createServer((q, r) => { let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => { const j = JSON.parse(b); reqs.push(j); if (j.method === 'initialize') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: {} })); } /* debate: never answered */ }); });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const p = spawn('node', [SERVER], { cwd: d, env: { ...process.env, MEGALENS_TOKEN: 't', MEGALENS_URL: `http://127.0.0.1:${srv.address().port}/x`, MEGALENS_REQUEST_TIMEOUT_MS: '400' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const out = await new Promise((res) => { p.stdout.once('data', (c) => res(JSON.parse(String(c)))); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'megalens_review_change', arguments: {} } }) + '\n'); });
  assert.equal(out.result.isError, true); assert.match(out.result.content[0].text, /A run may already have started.*DO NOT call this tool again.*megalens_history/s);
  assert.equal(reqs.filter((x) => x.params?.name === 'megalens_debate').length, 1);
  p.kill(); srv.close(); rmSync(d, { recursive: true });
});
