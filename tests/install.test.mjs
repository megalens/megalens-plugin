import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, statSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { install, parseArgs } from '../scripts/install.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'mlk_TESTSECRET_0123456789abcdef';
const tmp = () => mkdtempSync(path.join(tmpdir(), 'mlinst-'));
const rd = (d, f) => readFileSync(path.join(d, f), 'utf8');
const walk = (d, o = []) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p, o) : o.push(p); } return o; };
const homeOf = (d, scope) => (scope === 'global' ? d : d + '-home'); // project installs keep backups outside the repo folder
const run = (host, scope, d, extra = {}) => install({ host, scope, dir: d, home: homeOf(d, scope), ...extra });
const backups = (d, scope) => { const b = path.join(homeOf(d, scope), '.megalens', 'backups'); return existsSync(b) ? walk(b) : []; };

for (const host of ['codex', 'cursor', 'copilot']) for (const scope of ['project', 'global']) {
  test(`${host} ${scope}: writes no token by default, is idempotent`, () => {
    const d = tmp();
    run(host, scope, d);
    const files = walk(d);
    assert.ok(files.length >= 1);
    const snap = Object.fromEntries(files.map((f) => [f, readFileSync(f, 'utf8')]));
    for (const c of Object.values(snap)) { assert.ok(!c.includes(SECRET)); assert.ok(!/mlk_|sk-[A-Za-z0-9]{10}/.test(c)); }
    const rep = run(host, scope, d);
    assert.ok(rep.every((l) => !/^(created|updated)/.test(l)), rep.join('\n'));
    assert.deepEqual(walk(d).sort(), files.sort()); // no backups, no new files
    for (const f of files) assert.equal(readFileSync(f, 'utf8'), snap[f]);
  });
}

test('cursor: merge keeps other servers, backs up original, uses env reference', () => {
  const d = tmp(); mkdirSync(path.join(d, '.cursor'));
  const orig = JSON.stringify({ mcpServers: { other: { command: 'x' } }, keep: 1 });
  writeFileSync(path.join(d, '.cursor/mcp.json'), orig);
  run('cursor', 'project', d);
  const j = JSON.parse(rd(d, '.cursor/mcp.json'));
  assert.equal(j.mcpServers.other.command, 'x'); assert.equal(j.keep, 1);
  const s = j.mcpServers['megalens-local'];
  assert.equal(s.env.MEGALENS_TOKEN, '${env:MEGALENS_TOKEN}');
  assert.equal(s.env.MEGALENS_PROJECT_DIR, '${workspaceFolder}');
  assert.ok(path.isAbsolute(s.args[0]) && existsSync(s.args[0]));
  const baks = backups(d, 'project');
  assert.equal(baks.length, 1); assert.equal(readFileSync(baks[0], 'utf8'), orig);
  assert.ok(walk(d).every((f) => !f.includes('bak')), 'no backup inside the repo folder');
  assert.equal(statSync(baks[0]).mode & 0o777, 0o600); assert.equal(statSync(path.dirname(baks[0])).mode & 0o777, 0o700);
  assert.ok(existsSync(path.join(d, '.cursor/rules/megalens-review.mdc')));
  assert.match(rd(d, '.cursor/rules/megalens-review.mdc'), /alwaysApply: false/);
});

test('copilot: .vscode/mcp.json uses servers + promptString password input; JSONC and other servers survive', () => {
  const d = tmp(); mkdirSync(path.join(d, '.vscode'));
  writeFileSync(path.join(d, '.vscode/mcp.json'), '{\n // mine\n "inputs": [{"type":"promptString","id":"k","description":"d"}],\n "servers": { "a": {"type":"stdio","command":"a"}, },\n}\n');
  run('copilot', 'project', d);
  const j = JSON.parse(rd(d, '.vscode/mcp.json'));
  assert.equal(j.servers.a.command, 'a');
  assert.deepEqual(j.inputs.map((x) => x.id), ['k', 'megalens-token']);
  assert.equal(j.inputs[1].password, true);
  assert.equal(j.servers['megalens-local'].env.MEGALENS_TOKEN, '${input:megalens-token}');
  assert.equal(j.mcpServers, undefined);
  assert.doesNotMatch(rd(d, '.github/prompts/megalens-review.prompt.md'), /^tools:/m);
  const cli = JSON.parse(rd(d, '.github/mcp.json'));
  assert.equal(cli.mcpServers['megalens-local'].type, 'local');
  assert.equal(cli.mcpServers['megalens-local'].env.MEGALENS_TOKEN, '${MEGALENS_TOKEN}');
  // re-run does not duplicate the input
  run('copilot', 'project', d);
  assert.equal(JSON.parse(rd(d, '.vscode/mcp.json')).inputs.filter((x) => x.id === 'megalens-token').length, 1);
});

test('codex: toml merge keeps existing tables, backs up, forwards token by name, long tool timeout', () => {
  const d = tmp(); mkdirSync(path.join(d, '.codex'));
  const orig = 'model = "x"\n\n[mcp_servers.other]\ncommand = "y"\n';
  writeFileSync(path.join(d, '.codex/config.toml'), orig);
  run('codex', 'global', d);
  const t = rd(d, '.codex/config.toml');
  assert.ok(t.startsWith(orig.trimEnd()));
  assert.match(t, /\[mcp_servers\.megalens-local\]/);
  assert.match(t, /env_vars = \["MEGALENS_TOKEN"\]/);
  assert.match(t, /tool_timeout_sec = 1800/);
  assert.ok(!t.includes('MEGALENS_TOKEN = '));
  assert.equal(backups(d, 'global').length, 1);
  assert.match(rd(d, '.codex/prompts/megalens-review.md'), /megalens_review_change/);
  assert.match(rd(d, '.agents/skills/megalens-review/SKILL.md'), /^---\nname: megalens-review\ndescription: /);
  assert.match(rd(d, '.agents/skills/megalens-review/agents/openai.yaml'), /allow_implicit_invocation: false/);
});

test('codex: a hand-written megalens-local table is refused, never duplicated', () => {
  const d = tmp(); mkdirSync(path.join(d, '.codex'));
  const orig = '[mcp_servers.megalens-local]\ncommand = "mine"\n';
  writeFileSync(path.join(d, '.codex/config.toml'), orig);
  assert.throws(() => run('codex', 'global', d), /cannot take the MegaLens block/);
  assert.equal(rd(d, '.codex/config.toml'), orig);
});

test('codex project: AGENTS.md block appended and replaced in place, user text kept', () => {
  const d = tmp(); writeFileSync(path.join(d, 'AGENTS.md'), '# Mine\nkeep this\n');
  run('codex', 'project', d); run('codex', 'project', d);
  const a = rd(d, 'AGENTS.md');
  assert.ok(a.startsWith('# Mine\nkeep this'));
  assert.equal(a.split('megalens:begin').length - 1, 1);
});

test('--token-file writes the token only then, mode 600, and never prints it', () => {
  const d = tmp(); const tf = path.join(d, 'tok'); writeFileSync(tf, SECRET + '\n');
  for (const host of ['codex', 'cursor', 'copilot']) {
    const dir = tmp();
    const r = spawnSync('node', [path.join(ROOT, 'scripts/install.mjs'), '--host', host, '--project', '--dir', dir, '--home', dir, '--token-file', tf], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET));
    assert.match(r.stdout, /WARNING: the token was written/);
    const withTok = walk(dir).filter((f) => readFileSync(f, 'utf8').includes(SECRET));
    assert.ok(withTok.length >= 1);
    for (const f of withTok) assert.equal(statSync(f).mode & 0o077, 0);
    if (host === 'copilot') assert.ok(!rd(dir, '.vscode/mcp.json').includes('promptString'));
  }
});

test('invalid existing JSON is refused and untouched; dry-run writes nothing; bad args rejected', () => {
  const d = tmp(); mkdirSync(path.join(d, '.cursor')); writeFileSync(path.join(d, '.cursor/mcp.json'), '{ nope');
  assert.throws(() => run('cursor', 'project', d), /not valid JSON/);
  assert.equal(rd(d, '.cursor/mcp.json'), '{ nope');
  const e = tmp(); run('cursor', 'project', e, { dryRun: true }); assert.deepEqual(walk(e), []);
  assert.throws(() => parseArgs(['--host', 'vim']));
  assert.throws(() => parseArgs(['--host', 'codex', '--bogus']));
});

test('MEGALENS_PROJECT_DIR picks the repo the review is collected from (core change, backwards compatible)', async () => {
  const repo = tmp(); const g = (...a) => spawnSync('git', a, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  g('init', '-q', '-b', 'main'); writeFileSync(path.join(repo, 'a.js'), 'export const a = 1;\n'); g('add', '-A'); g('commit', '-q', '-m', 'b');
  writeFileSync(path.join(repo, 'a.js'), 'export const a = 2; // PROJDIR_MARK\n');
  const seen = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const j = JSON.parse(b); seen.push(j);
    const reply = (r) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: r })); };
    if (j.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'm', version: '1' } });
    if (j.params.name === 'megalens_debate') return reply({ content: [{ type: 'text', text: JSON.stringify({ run_id: '11111111-1111-4111-8111-111111111111', status: 'running', terminal: false }) }] });
    return reply({ content: [{ type: 'text', text: JSON.stringify({ run_id: '1', status: 'MCP_APPROVED', terminal: true, hostDelta: { summary: 'MOCK' } }) }] });
  }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const p = spawn('node', [path.join(ROOT, 'scripts/mcp-server.mjs')], { cwd: tmpdir(), env: { ...process.env, CLAUDE_PROJECT_DIR: '', MEGALENS_TOKEN: 'mock-token', MEGALENS_URL: `http://127.0.0.1:${srv.address().port}/api/mcp`, MEGALENS_PROJECT_DIR: repo, MEGALENS_POLL_MIN_MS: '20' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const out = await new Promise((res) => { let buf = ''; p.stdout.on('data', (d) => { buf += d; if (buf.includes('"id":2')) res(buf); });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'megalens_review_change', arguments: {} } }) + '\n'); });
  p.kill(); srv.close();
  const debate = seen.find((j) => j.params?.name === 'megalens_debate');
  assert.ok(debate, out);
  assert.match(debate.params.arguments.fileContext, /PROJDIR_MARK/);
});

test('codex toml: indented / quoted / dotted existing tables are refused; comments and CRLF kept; $ patterns in token survive reruns', () => {
  for (const orig of ['  [mcp_servers.megalens-local]\ncommand="m"\n', "[mcp_servers.'megalens-local']\ncommand='m'\n", 'mcp_servers.megalens-local.command = "m"\n']) {
    const d = tmp(); mkdirSync(path.join(d, '.codex')); writeFileSync(path.join(d, '.codex/config.toml'), orig);
    assert.throws(() => run('codex', 'global', d), /cannot take the MegaLens block/); assert.equal(rd(d, '.codex/config.toml'), orig);
  }
  const d = tmp(); mkdirSync(path.join(d, '.codex'));
  writeFileSync(path.join(d, '.codex/config.toml'), '# my comment\r\nmodel = "x"\r\n');
  const tf = path.join(d, 't');
  for (const tok of ['a$&b$1c$$d$`e$\'f', 'plain']) {
    writeFileSync(tf, tok + '\n'); run('codex', 'global', d, { tokenFile: tf }); run('codex', 'global', d, { tokenFile: tf });
    const t = rd(d, '.codex/config.toml');
    assert.ok(t.includes(JSON.stringify(tok)), t);
    assert.equal(t.split('# >>> megalens').length - 1, 1);
    assert.ok(t.startsWith('# my comment\r\nmodel = "x"\r\n'));
    assert.ok(!/(^|[^\r])\n/.test(t), 'mixed line endings');
  }
});

test('AGENTS.md block: $ patterns in existing text and CRLF survive', () => {
  const d = tmp(); writeFileSync(path.join(d, 'AGENTS.md'), 'cost $& $1\r\n');
  run('codex', 'project', d); run('codex', 'project', d);
  const a = rd(d, 'AGENTS.md'); assert.ok(a.startsWith('cost $& $1\r\n')); assert.ok(!/(^|[^\r])\n/.test(a));
});

test('jsonc: string values like ",}" and ", ]" survive; BOM read and kept; comment-only file ok', () => {
  const d = tmp(); mkdirSync(path.join(d, '.vscode'));
  const orig = '﻿{ // c\n "servers": { "a": { "type": "stdio", "command": "a", "args": ["x,}", ", ]", "/* not a comment */", "http://u//v"], }, }, }\n';
  writeFileSync(path.join(d, '.vscode/mcp.json'), orig);
  run('copilot', 'project', d);
  const t = rd(d, '.vscode/mcp.json'); assert.equal(t.charCodeAt(0), 0xfeff);
  const j = JSON.parse(t.slice(1)); assert.deepEqual(j.servers.a.args, ['x,}', ', ]', '/* not a comment */', 'http://u//v']);
  const e = tmp(); mkdirSync(path.join(e, '.cursor')); writeFileSync(path.join(e, '.cursor/mcp.json'), '// only a comment\n');
  run('cursor', 'project', e); assert.ok(JSON.parse(rd(e, '.cursor/mcp.json')).mcpServers['megalens-local']);
});

test('symlinks are never written through; dangling too; perms never widened; token file 0600 incl. backup', () => {
  const d = tmp(); const victim = path.join(d, 'victim'); writeFileSync(victim, 'keep');
  mkdirSync(path.join(d, '.cursor')); symlinkSync(victim, path.join(d, '.cursor/mcp.json'));
  assert.throws(() => run('cursor', 'project', d), /symbolic link/); assert.equal(readFileSync(victim, 'utf8'), 'keep');
  const e = tmp(); mkdirSync(path.join(e, '.cursor')); symlinkSync(path.join(e, 'nowhere'), path.join(e, '.cursor/mcp.json'));
  assert.throws(() => run('cursor', 'project', e), /symbolic link/); assert.ok(!existsSync(path.join(e, 'nowhere')));
  const f = tmp(); mkdirSync(path.join(f, '.cursor')); const cf = path.join(f, '.cursor/mcp.json');
  writeFileSync(cf, '{}'); chmodSync(cf, 0o640); run('cursor', 'project', f);
  assert.equal(statSync(cf).mode & 0o777, 0o640);
  const tf = path.join(f, 'tok'); writeFileSync(tf, SECRET); run('cursor', 'project', f, { tokenFile: tf });
  assert.equal(statSync(cf).mode & 0o777, 0o600);
  for (const b of backups(f, 'project')) assert.equal(statSync(b).mode & 0o077, 0);
  assert.ok(readdirSync(path.join(f, '.cursor')).every((n) => !n.endsWith('.tmp')));
});

test('argument values and array topKey are validated', () => {
  for (const a of [['--host', 'codex', '--token-file'], ['--host', 'codex', '--dir', '--global'], ['--host'], ['--host', 'codex', '--home']]) assert.throws(() => parseArgs(a), /needs a value|--host must/);
  const d = tmp(); mkdirSync(path.join(d, '.cursor')); writeFileSync(path.join(d, '.cursor/mcp.json'), '{"mcpServers": []}');
  assert.throws(() => run('cursor', 'project', d), /must be a JSON object/); assert.equal(rd(d, '.cursor/mcp.json'), '{"mcpServers": []}');
});

test('server refuses unexpanded ${workspaceFolder}, home, root and non-git folders instead of collecting', async () => {
  const { reviewChange, unsafeProjectDir } = await import('../scripts/mcp-server.mjs');
  const keep = { ...process.env };
  try {
    process.env.MEGALENS_TOKEN = 'mock-token'; process.env.MEGALENS_URL = 'http://127.0.0.1:9/never'; delete process.env.CLAUDE_PROJECT_DIR;
    process.env.MEGALENS_PROJECT_DIR = '${workspaceFolder}';
    assert.match(JSON.stringify(await reviewChange({}, {})), /did not expand it/);
    process.env.MEGALENS_PROJECT_DIR = '${input:x}'; process.env.CLAUDE_PROJECT_DIR = '';
    assert.match(JSON.stringify(await reviewChange({}, {})), /did not expand it/);
    delete process.env.MEGALENS_PROJECT_DIR;
    assert.match(JSON.stringify(await reviewChange({}, { cwd: '/' })), /home directory or the filesystem root/);
    assert.match(JSON.stringify(await reviewChange({}, { cwd: tmp() })), /not inside a git repository/);
  } finally { for (const k of ['MEGALENS_TOKEN', 'MEGALENS_URL', 'CLAUDE_PROJECT_DIR', 'MEGALENS_PROJECT_DIR']) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } }
  const os = await import('node:os');
  assert.match(unsafeProjectDir(os.homedir()), /home directory/);
});

test('backups: never in the repo; path printed; credential warning; token-bearing backup is 0600', () => {
  const d = tmp(); mkdirSync(path.join(d, '.cursor'));
  writeFileSync(path.join(d, '.cursor/mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x', env: { OPENAI_API_KEY: 'sk-abcdefghijklmnop1234' } } } }));
  const rep = run('cursor', 'project', d).join('\n');
  assert.match(rep, /backup \(outside the repo, owner-only\): /); assert.match(rep, /WARNING\s+the previous .* credential/);
  assert.ok(!rep.includes('sk-abcdefghijklmnop1234'));
  const b = backups(d, 'project'); assert.equal(b.length, 1); assert.ok(b[0].startsWith(homeOf(d, 'project')));
  assert.equal(statSync(b[0]).mode & 0o777, 0o600);
  assert.ok(walk(d).every((f) => !f.includes('bak')));
});

test('codex: [mcp_servers] + inline / dotted megalens-local, duplicate keys and invalid toml are refused', () => {
  for (const orig of ['[mcp_servers]\nmegalens-local = { command = "m" }\n', 'mcp_servers = { megalens-local = { command = "m" } }\n', 'mcp_servers = { other = { command = "o" } }\n', 'mcp_servers = 1\n', '[mcp_servers]\nmegalens-local.command = "m"\n', 'a = 1\na = 2\n', 'x = [1,\n']) {
    const d = tmp(); mkdirSync(path.join(d, '.codex')); writeFileSync(path.join(d, '.codex/config.toml'), orig);
    assert.throws(() => run('codex', 'global', d), /cannot take the MegaLens block/); assert.equal(rd(d, '.codex/config.toml'), orig);
    assert.ok(!existsSync(path.join(d, '.agents')), 'nothing else written either');
  }
});

test('toml checker accepts valid files and rejects duplicates', async () => {
  const { checkToml } = await import('../scripts/hosts/toml-check.mjs');
  const TQ = '"'.repeat(3);
  for (const ok of ['a=1\n[x]\nb="s"\n[x.y]\nz=[1,\n 2,]\n', '[[p]]\na=1\n[[p]]\na=2\n[p.q]\nr=1\n', `x={a=1,b={c=2}}\nd=1979-05-27T07:32:00Z\ns=${TQ}\nm\n${TQ}\n`, '# c\r\nmodel = "x"\r\n']) assert.ok(checkToml(ok));
  for (const bad of ['a=1\na=2\n', '[x]\n[x]\n', 'a=\n', '[p.q]\nr=1\n[p.q]\nr=2\n']) assert.throws(() => checkToml(bad));
});

test('nothing is written when a later file fails; symlinked path component refused; AGENTS.md symlink skipped', () => {
  const d = tmp(); mkdirSync(path.join(d, '.codex')); writeFileSync(path.join(d, '.codex/config.toml'), 'a=1\na=2\n');
  assert.throws(() => run('codex', 'project', d)); assert.ok(!existsSync(path.join(d, '.agents')) && !existsSync(path.join(d, 'AGENTS.md')));
  const e = tmp(); const real = tmp(); symlinkSync(real, path.join(e, '.cursor'));
  assert.throws(() => run('cursor', 'project', e), /symbolic link/); assert.deepEqual(readdirSync(real), []);
  const f = tmp(); const target = path.join(f, 'real.md'); writeFileSync(target, 'mine'); symlinkSync(target, path.join(f, 'AGENTS.md'));
  const rep = run('codex', 'project', f).join('\n'); assert.match(rep, /skipped .*AGENTS.md.*symbolic link/); assert.equal(readFileSync(target, 'utf8'), 'mine');
  assert.ok(existsSync(path.join(f, '.codex/config.toml')));
});

test('jsonc with comments: user is told they were dropped', () => {
  const d = tmp(); mkdirSync(path.join(d, '.vscode')); writeFileSync(path.join(d, '.vscode/mcp.json'), '{ // hi\n "servers": {} }');
  const rep = run('copilot', 'project', d).join('\n'); assert.match(rep, /had comments; they were dropped/);
});

test('git toplevel at home or root is refused unless MEGALENS_ALLOW_HOME=1', async () => {
  const { unsafeProjectDir } = await import('../scripts/mcp-server.mjs');
  const fakeHome = tmp(); spawnSync('git', ['init', '-q'], { cwd: fakeHome }); mkdirSync(path.join(fakeHome, 'sub'));
  const keep = { HOME: process.env.HOME, A: process.env.MEGALENS_ALLOW_HOME };
  try {
    process.env.HOME = fakeHome; delete process.env.MEGALENS_ALLOW_HOME;
    assert.match(unsafeProjectDir(path.join(fakeHome, 'sub')), /git repository/);
    assert.match(unsafeProjectDir(fakeHome), /home directory/);
    process.env.MEGALENS_ALLOW_HOME = '1';
    assert.equal(unsafeProjectDir(path.join(fakeHome, 'sub')), ''); assert.equal(unsafeProjectDir(fakeHome), '');
  } finally { process.env.HOME = keep.HOME; if (keep.A === undefined) delete process.env.MEGALENS_ALLOW_HOME; else process.env.MEGALENS_ALLOW_HOME = keep.A; }
});

test('toml: a leading BOM is accepted and kept on write', () => {
  const d = tmp(); mkdirSync(path.join(d, '.codex')); writeFileSync(path.join(d, '.codex/config.toml'), '\ufeffmodel = "x"\n');
  run('codex', 'global', d);
  const x = rd(d, '.codex/config.toml'); assert.equal(x.charCodeAt(0), 0xfeff); assert.match(x, /\[mcp_servers\.megalens-local\]/);
});
