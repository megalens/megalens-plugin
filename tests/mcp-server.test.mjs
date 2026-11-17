import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'scripts', 'mcp-server.mjs');
const COLLECT = path.join(ROOT, 'scripts', 'collect.mjs');
const SERVER_URL = pathToFileURL(SERVER).href;
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
const put = (root, p, c) => { mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); writeFileSync(path.join(root, p), c); };

function repo(extra = () => {}) {
  const d = mkdtempSync(path.join(tmpdir(), 'mlsrv-'));
  git(d, 'init', '-q', '-b', 'main');
  put(d, 'src/a.js', 'export function a(x) {\n  return x + 1;\n}\n');
  put(d, 'src/b.js', "import { a } from './a.js';\nexport const b = () => a(1);\n");
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'base');
  extra(d);
  put(d, 'src/a.js', 'export function a(x) {\n  return x + 2;\n}\n');
  return d;
}

// mock MegaLens endpoint: records every request, never touches the network
function mock({ pollsBeforeDone = 1, status = 200, sse = false } = {}) {
  const reqs = []; let polls = 0;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const j = JSON.parse(b); reqs.push({ auth: req.headers.authorization, size: Buffer.byteLength(b), j });
      if (status !== 200) { res.writeHead(status); return res.end('{"error":"nope"}'); }
      const reply = (result) => { const o = JSON.stringify({ jsonrpc: '2.0', id: j.id, result }); if (sse) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`event: message\ndata: ${o}\n\n`); } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(o); } };
      if (j.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock', version: '1' } });
      if (j.params.name === 'megalens_debate') return reply({ content: [{ type: 'text', text: JSON.stringify({ run_id: '11111111-1111-4111-8111-111111111111', status: 'running', terminal: false }) }] });
      if (j.params.name === 'megalens_poll') { polls++; const done = polls > pollsBeforeDone; return reply({ content: [{ type: 'text', text: JSON.stringify(done ? { run_id: '1', status: 'MCP_APPROVED', terminal: true, hostDelta: { summary: 'MOCK-DELTA' }, poll_after_ms: 10 } : { run_id: '1', status: 'running', terminal: false, poll_after_ms: 10 }) }] }); }
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, reqs, url: `http://127.0.0.1:${srv.address().port}/api/mcp`, polls: () => polls })));
}

function client(env, cwd) {
  const p = spawn('node', [SERVER], { cwd, env: { ...process.env, MEGALENS_POLL_MIN_MS: '20', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; const waiters = new Map();
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; const m = JSON.parse(line); waiters.get(m.id)?.(m); } });
  let id = 0;
  const call = (method, params) => new Promise((res) => { const i = ++id; waiters.set(i, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
  return { call, close: () => { p.stdin.end(); p.kill(); }, p };
}
const toolCall = (c, args) => c.call('tools/call', { name: 'megalens_review_change', arguments: args });
const ASSESS = [{ claim: 'src/a.js:2 - off by one', quote: 'return x + 2;' }, { claim: 'src/b.js:2 - caller not updated' }];

test('stdio handshake and tool list; nothing but JSON on stdout', async () => {
  const c = client({}, tmpdir());
  const init = await c.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'megalens-local');
  const tools = await c.call('tools/list', {});
  assert.deepEqual(tools.result.tools.map((t) => t.name), ['megalens_review_change']);
  assert.ok(tools.result.tools[0].inputSchema.properties.yourAssessment);
  c.close();
});

test('full flow: bundle collected by the server, hash proves fidelity, result unchanged, bearer used', async () => {
  const d = repo(); const m = await mock({ pollsBeforeDone: 2 }); const audit = path.join(d, '.git', 'audit.jsonl');
  const c = client({ MEGALENS_TOKEN: 'tok-test', MEGALENS_URL: m.url, MEGALENS_AUDIT_LOG: audit }, d);
  await c.call('initialize', {});
  const r = await toolCall(c, { yourAssessment: ASSESS, prompt: 'Check the arithmetic.' });
  assert.ok(!r.result.isError, JSON.stringify(r.result).slice(0, 300));
  const calls = m.reqs.filter((x) => x.j.method === 'tools/call');
  assert.ok(calls.every((x) => x.auth === 'Bearer tok-test'));
  const debate = calls.filter((x) => x.j.params.name === 'megalens_debate');
  assert.equal(debate.length, 1, 'exactly one debate call');
  const args = debate[0].j.params.arguments;
  // independent collection of the same repo state
  const expected = JSON.parse(execFileSync('node', [COLLECT, '--json', '--max-bytes', '200000'], { cwd: d, encoding: 'utf8' }));
  assert.equal(sha(args.fileContext), sha(expected.bundle), 'bundle byte-identical to a fresh collection');
  assert.ok(args.prompt.includes(`sha256=${sha(expected.bundle)}`));
  assert.ok(args.prompt.startsWith('Check the arithmetic.'));
  assert.equal(args.skill, 'diff_audit');
  assert.equal(args.tier, 'standard');
  assert.deepEqual(args.yourAssessment, ASSESS);
  assert.equal(args.files, undefined);
  assert.equal(m.polls(), 3);
  // result: first content item is the remote's final poll text, untouched
  const first = JSON.parse(r.result.content[0].text);
  assert.equal(first.hostDelta.summary, 'MOCK-DELTA'); assert.equal(first.terminal, true);
  const note = r.result.content.at(-1).text;
  assert.ok(note.includes(`bundle_sha256=${sha(expected.bundle)}`) && note.includes(`sent_sha256=${sha(expected.bundle)}`));
  const rec = JSON.parse(readFileSync(audit, 'utf8').trim());
  assert.equal(rec.filecontext_sha256_sent, sha(expected.bundle)); assert.equal(rec.run_id, '11111111-1111-4111-8111-111111111111');
  c.close(); m.srv.close(); rmSync(d, { recursive: true });
});

test('SSE-framed responses are understood; rules go in the prompt; range argument is forwarded', async () => {
  const d = repo((x) => { put(x, '.megalens/rules', 'Never log tokens.\n'); git(x, 'add', '-A'); git(x, 'commit', '-qm', 'rules'); });
  const m = await mock({ sse: true, pollsBeforeDone: 0 });
  const c = client({ MEGALENS_TOKEN: 't', MEGALENS_URL: m.url }, d);
  await c.call('initialize', {});
  const r = await toolCall(c, { range: '--staged' });
  assert.match(r.result.content[0].text, /NO CHANGES FOUND/, '--staged with nothing staged');
  git(d, 'add', '-A');
  const r2 = await toolCall(c, { range: '--staged' });
  assert.ok(!r2.result.isError, JSON.stringify(r2.result).slice(0, 300));
  const a = m.reqs.find((x) => x.j.params?.name === 'megalens_debate').j.params.arguments;
  assert.match(a.prompt, /Repository review rules \(\.megalens\/rules\):\nNever log tokens\./);
  assert.ok(!a.fileContext.includes('Never log tokens'));
  c.close(); m.srv.close(); rmSync(d, { recursive: true });
});

test('large change: bundle well above the 90 KB host budget, request stays under 1 MB', async () => {
  const d = repo((x) => { for (let i = 0; i < 25; i++) put(x, `lib/m${i}.js`, Array.from({ length: 600 }, (_, k) => `export const v${k} = ${k};\n`).join('')); git(x, 'add', '-A'); git(x, 'commit', '-qm', 'many'); for (let i = 0; i < 25; i++) put(x, `lib/m${i}.js`, Array.from({ length: 600 }, (_, k) => `export const v${k} = ${k + 1};\n`).join('')); });
  const m = await mock({ pollsBeforeDone: 0 });
  const c = client({ MEGALENS_TOKEN: 't', MEGALENS_URL: m.url }, d);
  await c.call('initialize', {});
  const r = await toolCall(c, { maxBytes: 700000 });
  assert.ok(!r.result.isError);
  const deb = m.reqs.find((x) => x.j.params?.name === 'megalens_debate');
  assert.ok(Buffer.byteLength(deb.j.params.arguments.fileContext) > 300_000, 'uses the large budget when asked');
  assert.ok(deb.size < 1_000_000, `request ${deb.size}`);
  c.close(); m.srv.close(); rmSync(d, { recursive: true });
});

test('default budget is 200 KB: a large change is cut to fit', async () => {
  const d = repo((x) => { for (let i = 0; i < 25; i++) put(x, `lib/m${i}.js`, Array.from({ length: 600 }, (_, k) => `export const v${k} = ${k};\n`).join('')); git(x, 'add', '-A'); git(x, 'commit', '-qm', 'many'); for (let i = 0; i < 25; i++) put(x, `lib/m${i}.js`, Array.from({ length: 600 }, (_, k) => `export const v${k} = ${k + 1};\n`).join('')); });
  const m = await mock({ pollsBeforeDone: 0 });
  const c = client({ MEGALENS_TOKEN: 't', MEGALENS_URL: m.url }, d);
  await c.call('initialize', {});
  const r = await toolCall(c, {});
  assert.ok(!r.result.isError);
  const deb = m.reqs.find((x) => x.j.params?.name === 'megalens_debate');
  assert.ok(Buffer.byteLength(deb.j.params.arguments.fileContext) <= 200_200, 'default budget');
  c.close(); m.srv.close(); rmSync(d, { recursive: true });
});

test('JSON-escaping-heavy content: budget shrinks until the request fits under 1 MB', async () => {
  const nasty = (n) => Array.from({ length: 800 }, (_, k) => `const s${n}_${k} = "\\\\\\"\\\\\\"\\\\\\"\\\\\\"\\\\\\"\\\\\\"\\\\\\"\\\\\\"\\\\\\"";\n`).join('');
  const d = repo((x) => { for (let i = 0; i < 30; i++) put(x, `esc/e${i}.js`, nasty(i)); git(x, 'add', '-A'); git(x, 'commit', '-qm', 'esc'); for (let i = 0; i < 30; i++) put(x, `esc/e${i}.js`, nasty(i) + '// changed\n'); });
  const m = await mock({ pollsBeforeDone: 0 });
  const c = client({ MEGALENS_TOKEN: 't', MEGALENS_URL: m.url }, d);
  await c.call('initialize', {});
  const r = await toolCall(c, {});
  assert.ok(!r.result.isError, JSON.stringify(r.result).slice(0, 300));
  const deb = m.reqs.find((x) => x.j.params?.name === 'megalens_debate');
  assert.ok(deb.size <= 950_000, `request ${deb.size}`);
  const sent = deb.j.params.arguments;
  const fresh = r.result.content.at(-1).text.match(/bundle_bytes=(\d+)/)[1];
  assert.equal(Number(fresh), Buffer.byteLength(sent.fileContext));
  c.close(); m.srv.close(); rmSync(d, { recursive: true });
});

test('follow-up extraContext is appended after the collected bundle and covered by the hash', async () => {
  const d = repo(); const m = await mock({ pollsBeforeDone: 0 });
  const c = client({ MEGALENS_TOKEN: 't', MEGALENS_URL: m.url }, d);
  await c.call('initialize', {});
  const r = await toolCall(c, { extraContext: [{ path: 'src/needed.js', content: 'export const needed = 1;' }] });
  assert.ok(!r.result.isError);
  const fc = m.reqs.find((x) => x.j.params?.name === 'megalens_debate').j.params.arguments.fileContext;
  assert.ok(fc.endsWith('=== FILE: src/needed.js ===\nexport const needed = 1;\n'));
  assert.ok(r.result.content.at(-1).text.includes(`bundle_sha256=${sha(fc)}`));
  const big = await toolCall(c, { extraContext: [{ path: 'x', content: 'y'.repeat(120000) }] });
  assert.equal(big.result.isError, true);
  c.close(); m.srv.close(); rmSync(d, { recursive: true });
});

test('no token: clear error pointing at the OAuth fallback, no request made', async () => {
  const d = repo(); const m = await mock();
  const c = client({ MEGALENS_TOKEN: '${MEGALENS_TOKEN}', MEGALENS_URL: m.url }, d);
  await c.call('initialize', {});
  const r = await toolCall(c, { yourAssessment: ASSESS });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /MEGALENS_TOKEN is not set.*megalens-review-remote/s);
  assert.equal(m.reqs.length, 0);
  c.close(); m.srv.close(); rmSync(d, { recursive: true });
});

test('remote 401 and a non-repo directory are reported as errors, server keeps running', async () => {
  const d = repo(); const m = await mock({ status: 401 });
  const c = client({ MEGALENS_TOKEN: 'bad', MEGALENS_URL: m.url }, d);
  await c.call('initialize', {});
  const r = await toolCall(c, {});
  assert.equal(r.result.isError, true); assert.match(r.result.content[0].text, /HTTP 401/);
  assert.ok(!r.result.content[0].text.includes('bad'), 'token never echoed');
  const nogit = mkdtempSync(path.join(tmpdir(), 'mlnogit-'));
  const c2 = client({ MEGALENS_TOKEN: 'x', MEGALENS_URL: m.url }, nogit);
  await c2.call('initialize', {});
  const r2 = await toolCall(c2, {});
  assert.equal(r2.result.isError, true); assert.match(r2.result.content[0].text, /not inside a git repository/);
  const again = await c2.call('tools/list', {}); assert.ok(again.result.tools.length === 1);
  c.close(); c2.close(); m.srv.close(); rmSync(d, { recursive: true }); rmSync(nogit, { recursive: true });
});

test('unknown tool and unknown method return JSON-RPC errors', async () => {
  const c = client({}, tmpdir());
  await c.call('initialize', {});
  const t = await c.call('tools/call', { name: 'nope', arguments: {} }); assert.equal(t.error.code, -32602);
  const m = await c.call('resources/list', {}); assert.equal(m.error.code, -32601);
  c.close();
});

// ---- MEGALENS_URL override: loopback http or https only; default unchanged; bearer never sent elsewhere
test('resolveUrl: default stays the production endpoint; loopback http and https accepted', async () => {
  const { resolveUrl } = await import(SERVER_URL);
  assert.equal(resolveUrl('').url, 'https://megalens.ai/api/mcp?ide=claude-code');
  assert.equal(resolveUrl(undefined).url, 'https://megalens.ai/api/mcp?ide=claude-code');
  for (const ok of ['http://127.0.0.1:3320/api/mcp', 'http://localhost:3320/api/mcp?ide=claude-code', 'http://[::1]:3320/api/mcp', 'https://megalens.ai/api/mcp', 'https://staging.example.com/api/mcp']) {
    assert.equal(resolveUrl(ok).url, ok, ok);
  }
});

test('resolveUrl: plain http to a non-loopback host, other schemes, credentials and junk are refused', async () => {
  const { resolveUrl } = await import(SERVER_URL);
  for (const bad of ['http://megalens.ai/api/mcp', 'http://10.0.0.5:3320/api/mcp', 'http://127.0.0.1.evil.com/api/mcp', 'http://localhost.evil.com/api/mcp', 'ftp://127.0.0.1/api/mcp', 'file:///etc/passwd', 'https://user:pw@megalens.ai/api/mcp', 'http://user@127.0.0.1:3320/api/mcp', 'not a url', '127.0.0.1:3320/api/mcp']) {
    const r = resolveUrl(bad);
    assert.ok(r.error && !r.url, bad);
  }
});

test('a refused MEGALENS_URL makes no request and says why', async () => {
  const d = repo(); const m = await mock();
  const c = client({ MEGALENS_TOKEN: 'tok-test', MEGALENS_URL: m.url.replace('http://127.0.0.1', 'http://10.255.255.1') }, d);
  await c.call('initialize', {});
  const r = await toolCall(c, { yourAssessment: ASSESS });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /MEGALENS_URL must be https, or http only for 127\.0\.0\.1/);
  assert.equal(m.reqs.length, 0);
  c.close(); m.srv.close(); rmSync(d, { recursive: true });
});
