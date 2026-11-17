import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { secretPath, secretContent, validateRange } from '../scripts/lib/safety.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'scripts', 'mcp-server.mjs');
const COLLECT = path.join(ROOT, 'scripts', 'collect.mjs');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
const put = (root, p, c) => { mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); writeFileSync(path.join(root, p), c); };
function repo(extra = () => {}) {
  const d = mkdtempSync(path.join(tmpdir(), 'mlsec-'));
  git(d, 'init', '-q', '-b', 'main'); put(d, 'src/a.js', 'export const a = 1;\n'); git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'base');
  extra(d); put(d, 'src/a.js', 'export const a = 2;\n'); return d;
}
const collect = (cwd, ...args) => { const r = spawnSync('node', [COLLECT, '--json', '--max-bytes', '700000', ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 28 }); let j = null; try { j = JSON.parse(r.stdout); } catch { /* error exit */ } return { code: r.status, j, err: r.stderr }; };

// ---- 1. secret path + content rules
test('1: secret file names, any case, are recognised; look-alikes and .env.example are not', () => {
  const bad = ['.envrc', '.ENV', 'app/.env.production', 'config/Credentials.YML', 'credentials.yaml', 'credentials.toml', 'credentials.xml', 'id_dsa', 'id_ecdsa_sk', 'id_ed25519_sk', 'keys/id_rsa.pub.bak', 'putty.PPK', 'infra/prod.tfvars', 'terraform.tfstate', 'terraform.tfstate.backup', '.aws/credentials', 'home/.aws/config', '.docker/config.json', '.git-credentials', '.pgpass', '.pypirc', 'kubeconfig', '.kube/config', 'API.KEY', 'server.PEM', '.netrc', 'service-account-prod.json', 'serviceaccount.json', 'secrets.yaml', 'x/Secret.json', '.htpasswd'];
  for (const p of bad) assert.ok(secretPath(p), `${p} must be secret`);
  for (const p of ['.env.example', 'a/.ENV.SAMPLE', 'src/environment.ts', 'src/keyboard.ts', 'docs/credentials-guide.md', 'src/secretary.js', 'package.json']) assert.ok(!secretPath(p), `${p} must not be secret`);
});
test('1: secret-looking content is detected', () => {
  const pk = '-----BEGIN ' + 'RSA PRIVATE KEY-----\nabc';
  for (const t of [pk, 'k = "AKIA' + 'ABCDEFGHIJKLMNOP"', 'x=ghp_' + 'a'.repeat(36), 'sk-' + 'proj-' + 'a'.repeat(30), 'xoxb-' + '1234567890-abcdef', 'ml_tok_' + 'a'.repeat(20)]) assert.ok(secretContent(t), t.slice(0, 20));
  assert.ok(secretContent('//registry.npmjs.org/:_authToken=abcdef123', '.npmrc'));
  assert.equal(secretContent('registry=https://registry.npmjs.org/', '.npmrc'), null);
  assert.equal(secretContent('const x = 1;'), null);
});
test('1: collector skips secret files and files with secret content, and says so in the manifest', () => {
  const pk = '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----\nzzz\n';
  const d = repo((x) => {});
  put(d, '.envrc', 'export TOKEN=hunter2-envrc\n'); put(d, 'infra/prod.tfvars', 'password="hunter2-tfvars"\n');
  put(d, 'src/leaky.js', `const k = "${'AKIA' + 'ABCDEFGHIJKLMNOP'}"; // hunter2-leaky\n`); put(d, 'notes/key.txt', pk);
  put(d, '.npmrc', '//registry.npmjs.org/:_authToken=hunter2-npmrc\n'); put(d, '.env.example', 'API_URL=http://x\n');
  const { j } = collect(d);
  assert.ok(!j.bundle.includes('hunter2') && !j.bundle.includes('PRIVATE KEY') && !j.bundle.includes('AKIA'), 'no secret reaches the bundle');
  assert.ok(j.bundle.includes('.env.example'));
  assert.match(j.manifest, /\.envrc: .*secret/); assert.match(j.manifest, /leaky\.js: .*secret-looking content \(AWS access key id\)/); assert.match(j.manifest, /\.npmrc: .*secret/);
  rmSync(d, { recursive: true });
});

// ---- 2. quoted diff headers
test('2: file names with spaces / quotes / non-ASCII cannot smuggle a secret diff through', () => {
  const d = repo((x) => {});
  const names = ['my .env', 'prod key.pem', 'ünï.pem', 'we"ird.key', 'tab\there.pem'];
  for (const n of names) put(d, n, 'hunter2-quoted\n');
  git(d, 'add', '-A'); // staged, so the headers come from `git diff`, not --no-index
  const { j } = collect(d);
  assert.ok(!j.bundle.includes('hunter2-quoted'), 'secret diff content absent');
  assert.ok(!/diff --git "?a\/(my \.env|prod key\.pem)/.test(j.bundle));
  rmSync(d, { recursive: true });
});
test('2: an ordinary file with a space in its name still collects normally', () => {
  const d = repo(); put(d, 'src/my file.js', 'export const spaced = 1;\n'); git(d, 'add', '-A');
  const { j } = collect(d);
  assert.ok(j.bundle.includes('=== FILE: src/my file.js ==='));
  assert.ok(j.bundle.includes('diff --git a/src/my file.js b/src/my file.js'));
  rmSync(d, { recursive: true });
});

// ---- 3. extraContext
function mock({ flaky = false, hang = false } = {}) {
  const reqs = []; let polls = 0;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const j = JSON.parse(b); reqs.push(j); if (hang) return; // never answers
      const reply = (result) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result })); };
      if (j.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock', version: '1' } });
      if (j.params.name === 'megalens_debate') return reply({ content: [{ type: 'text', text: JSON.stringify({ run_id: '11111111-1111-4111-8111-111111111111', terminal: false }) }] });
      polls++;
      if (flaky && polls === 1) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end('event: ping\n\n'); }
      if (flaky && polls === 2) { res.writeHead(502); return res.end('bad gateway'); }
      if (flaky && polls === 3) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{not json'); }
      reply({ content: [{ type: 'text', text: JSON.stringify({ terminal: true, status: 'MCP_APPROVED', poll_after_ms: 10, hostDelta: { summary: 'OK' } }) }] });
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, reqs, url: `http://127.0.0.1:${srv.address().port}/api/mcp` })));
}
function client(env, cwd) {
  const p = spawn('node', [SERVER], { cwd, env: { ...process.env, MEGALENS_POLL_MIN_MS: '20', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; const w = new Map();
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) { const m = JSON.parse(l); w.get(m.id)?.(m); } } });
  let id = 0; const call = (method, params) => new Promise((res) => { const i = ++id; w.set(i, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
  return { call, tool: (args) => call('tools/call', { name: 'megalens_review_change', arguments: args }), close: () => { p.stdin.end(); p.kill(); } };
}
test('3: extraContext with secret names or content is refused, harmless files are appended', async () => {
  const d = repo(); const m = await mock(); const c = client({ MEGALENS_TOKEN: 't', MEGALENS_URL: m.url }, d); await c.call('initialize', {});
  const r = await c.tool({ extraContext: [
    { path: '.env', content: 'A=1' }, { path: 'keys/id_rsa', content: 'x' }, { path: 'src/ok.js', content: 'export const ok = 1;' },
    { path: 'src/leak.js', content: 'const k="' + 'AKIA' + 'ABCDEFGHIJKLMNOP";' }, { path: '.aws\\credentials', content: 'y' }] });
  assert.ok(!r.result.isError);
  const fc = m.reqs.find((x) => x.params?.name === 'megalens_debate').params.arguments.fileContext;
  assert.ok(fc.includes('=== FILE: src/ok.js ==='));
  for (const bad of ['A=1', 'keys/id_rsa', 'AKIA', '.aws']) assert.ok(!fc.includes(bad), `${bad} must not be sent`);
  const note = r.result.content.at(-1).text; assert.match(note, /extraContext refused \(not sent\): .*\.env.*id_rsa.*leak\.js.*credentials/s);
  c.close(); m.srv.close(); rmSync(d, { recursive: true });
});

// ---- 4. argument injection
test('4: range validation accepts refs/ranges and rejects everything else', () => {
  for (const ok of ['main', 'origin/main', 'v1.2.3', 'HEAD~3', 'HEAD^', 'a1b2c3d..e4f5a6b', 'main...feature/x', '--staged', 'HEAD@{1}'.replace('{1}', '')]) assert.doesNotThrow(() => validateRange(ok), ok);
  for (const bad of ['a;b', '$(touch x)', '`x`', '--output=/tmp/x', '-x', 'a b', 'a|b', 'a&&b', 'a\nb', '../../etc', '--cwd=/', '--out', 'x"y', "x'y", '....', '..', '--help', 'a..b..c']) assert.throws(() => validateRange(bad), /invalid range/, JSON.stringify(bad));
  assert.equal(validateRange(''), null); assert.equal(validateRange(undefined), null);
});
test('4: --args-stdin takes only a validated range; metacharacters are rejected with no side effects', () => {
  const d = repo(); const marker = path.join(tmpdir(), `ml-pwn-${Date.now()}`);
  const run = (stdin) => spawnSync('node', [COLLECT, '--args-stdin', '--json'], { cwd: d, input: stdin, encoding: 'utf8' });
  assert.equal(run(`main; touch ${marker}\n`).status, 2); assert.ok(!existsSync(marker));
  assert.equal(run('$(touch ' + marker + ')\n').status, 2); assert.ok(!existsSync(marker));
  assert.equal(run('--out /tmp/x --cwd /\n').status, 2);
  assert.equal(run('HEAD\nmain\n').status, 2);
  assert.equal(run('--staged\n').status, 0); assert.equal(run('\n').status, 0);
  assert.equal(spawnSync('node', [COLLECT, '--cwd'], { cwd: d, encoding: 'utf8' }).status, 2, 'missing option value is a clean error');
  rmSync(d, { recursive: true });
});
test('4: the local tool rejects an option-looking range without running git', async () => {
  const d = repo(); const m = await mock(); const c = client({ MEGALENS_TOKEN: 't', MEGALENS_URL: m.url }, d); await c.call('initialize', {});
  const r = await c.tool({ range: '--output=/tmp/ml-evil' });
  assert.equal(r.result.isError, true); assert.match(r.result.content[0].text, /invalid range/); assert.equal(m.reqs.length, 0); assert.ok(!existsSync('/tmp/ml-evil'));
  c.close(); m.srv.close(); rmSync(d, { recursive: true });
});
test('4: the remote command passes $ARGUMENTS only through a quoted heredoc', () => {
  const t = readFileSync(path.join(ROOT, 'commands', 'megalens-review-remote.md'), 'utf8');
  assert.match(t, /--args-stdin <<'MEGALENS_ARGS_END_\w+'\n\$ARGUMENTS\nMEGALENS_ARGS_END_\w+\n/);
  assert.ok(!/collect\.mjs"? \$ARGUMENTS/.test(t));
});

// ---- 5. timeout
test('5: a server that never answers ends in an error within the request timeout, not a hang', async () => {
  const d = repo(); const m = await mock({ hang: true }); const c = client({ MEGALENS_TOKEN: 't', MEGALENS_URL: m.url, MEGALENS_REQUEST_TIMEOUT_MS: '400' }, d); await c.call('initialize', {});
  const t0 = Date.now(); const r = await c.tool({});
  assert.equal(r.result.isError, true); assert.match(r.result.content[0].text, /no answer within 400 ms/); assert.ok(Date.now() - t0 < 5000);
  assert.equal(m.reqs.filter((x) => x.params?.name === 'megalens_debate').length, 0, 'it died on initialize; nothing paid');
  c.close(); m.srv.close(); rmSync(d, { recursive: true });
});

// ---- 6. hard cap
test('6: 600 changed files cannot push the bundle past the budget', () => {
  const d = repo((x) => { for (let i = 0; i < 600; i++) put(x, `bulk/f${i}.txt`, `line ${i}\n`.repeat(40)); git(x, 'add', '-A'); git(x, 'commit', '-qm', 'bulk'); for (let i = 0; i < 600; i++) put(x, `bulk/f${i}.txt`, `LINE ${i}\n`.repeat(40)); });
  for (const cap of [20000, 60000]) {
    const r = spawnSync('node', [COLLECT, '--json', '--max-bytes', String(cap)], { cwd: d, encoding: 'utf8', maxBuffer: 1 << 28 });
    const j = JSON.parse(r.stdout); assert.ok(j.bundleBytes <= cap, `${j.bundleBytes} > ${cap}`);
    assert.match(j.manifest, /diff sections left out for budget:/);
  }
  rmSync(d, { recursive: true });
});

// ---- 7. poll tolerance
test('7: empty SSE frame, 502 and garbage during polling are tolerated; debate is called exactly once', async () => {
  const d = repo(); const m = await mock({ flaky: true }); const c = client({ MEGALENS_TOKEN: 't', MEGALENS_URL: m.url }, d); await c.call('initialize', {});
  const r = await c.tool({});
  assert.ok(!r.result.isError, JSON.stringify(r.result).slice(0, 200));
  assert.equal(JSON.parse(r.result.content[0].text).terminal, true);
  assert.equal(m.reqs.filter((x) => x.params?.name === 'megalens_debate').length, 1);
  assert.ok(m.reqs.filter((x) => x.params?.name === 'megalens_poll').length >= 4);
  c.close(); m.srv.close(); rmSync(d, { recursive: true });
});

// ---- 8. description
test('8: the tool description forbids unprompted calls', async () => {
  const c = client({}, tmpdir()); await c.call('initialize', {});
  const t = (await c.call('tools/list', {})).result.tools[0];
  assert.match(t.description, /^ONLY call this tool when the user runs \/megalens:megalens-review or explicitly asks to use MegaLens\. Never call it for a general code-review request/);
  c.close();
});

// ---- 9. symlinks
test('9: symlinks (file, directory, .megalens/rules, untracked) are never followed outside the repo', () => {
  const outside = mkdtempSync(path.join(tmpdir(), 'mlout-')); writeFileSync(path.join(outside, 'private.txt'), 'OUTSIDE-MARKER-9\n'); mkdirSync(path.join(outside, 'dir')); writeFileSync(path.join(outside, 'dir', 'x.js'), 'OUTSIDE-MARKER-9b\n');
  const d = repo((x) => { symlinkSync(path.join(outside, 'private.txt'), path.join(x, 'tracked-link.txt')); symlinkSync(path.join(outside, 'dir'), path.join(x, 'linkdir')); mkdirSync(path.join(x, '.megalens')); symlinkSync(path.join(outside, 'private.txt'), path.join(x, '.megalens', 'rules')); git(x, 'add', '-A'); git(x, 'commit', '-qm', 'links'); });
  symlinkSync(path.join(outside, 'private.txt'), path.join(d, 'untracked-link.txt'));
  put(d, 'src/uses.js', "import './x.js'; // tracked-link.txt linkdir\n");
  const { j } = collect(d);
  assert.ok(!j.bundle.includes('OUTSIDE-MARKER'), 'no outside content in the bundle');
  assert.ok(!j.rules.includes('OUTSIDE-MARKER'), 'rules symlink not followed');
  assert.match(j.manifest, /\.megalens\/rules: symlink/); assert.match(j.manifest, /untracked-link\.txt: .*symlink/);
  rmSync(d, { recursive: true }); rmSync(outside, { recursive: true });
});

// ---- 10. manifest
test('10: plugin.json uses only fields the plugin manifest reference documents', () => {
  const documented = new Set(['$schema', 'name', 'displayName', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'metadata', 'icon', 'documentationUrl', 'supportUrl', 'privacyPolicyUrl', 'termsOfServiceUrl', 'defaultEnabled', 'dependencies', 'userConfig', 'types', 'channels', 'skills', 'commands', 'agents', 'hooks', 'mcpServers', 'lspServers', 'outputStyles', 'workflows', 'experimental']);
  const j = JSON.parse(readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  for (const k of Object.keys(j)) assert.ok(documented.has(k), `${k} is not documented`);
});
