import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync,
  mkdirSync, statSync, symlinkSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, parseArgs, runCli, MORE_HOSTS_ENABLED } from '../scripts/install.mjs';
import { setupWithBrowserLogin, HOST_DOCS } from '../scripts/hosts/more-hosts.mjs';
import { deviceLogin, promptConfirmAccount } from '../scripts/lib/device-login.mjs';
import { buildGuardedWorkspaceBundle } from '../scripts/lib/guarded-bundle.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'scripts', 'mcp-server.mjs');
const COLLECT = path.join(ROOT, 'scripts', 'collect.mjs');
const SECRET = 'ml_tok_0123456789abcdef0123456789abcdef';

const tmp = (t) => {
  const d = mkdtempSync(path.join(tmpdir(), 'mlmore-'));
  t?.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
};
const rd = (d, f) => readFileSync(path.join(d, f), 'utf8');
const walk = (d, o = []) => {
  if (!existsSync(d)) return o;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, o);
    else o.push(p);
  }
  return o;
};
const homeOf = (d, scope) => (scope === 'global' ? d : `${d}-home`);
const backups = (d, scope) => walk(path.join(homeOf(d, scope), '.megalens', 'backups'));
const run = (host, scope, d, extra = {}, t) => {
  const home = homeOf(d, scope);
  t?.after(() => rmSync(home, { recursive: true, force: true }));
  return install({ host, scope, dir: d, home, env: {}, moreHosts: true, ...extra });
};
const git = (cwd, ...a) => execFileSync('git', a, {
  cwd,
  encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
});
const put = (root, p, c) => {
  mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
  writeFileSync(path.join(root, p), c);
};

test('flag off = live behaviour unchanged', (t) => {
  assert.equal(MORE_HOSTS_ENABLED, false);
  for (const args of [
    ['--host', 'opencode'],
    ['--host', 'antigravity'],
    ['--host', 'agy'],
    ['--host', 'copilot', '--mode', 'hosted'],
    ['--host', 'copilot', '--browser-login'],
    ['--host', 'copilot', '--allow-project-token'],
  ]) {
    assert.throws(() => parseArgs(args));
  }

  const d = tmp(t);
  const home = tmp(t);
  install({ host: 'copilot', scope: 'project', dir: d, home });
  assert.equal(existsSync(path.join(d, '.github/copilot-instructions.md')), false);
  assert.equal(existsSync(path.join(d, '.github/skills/megalens-review/SKILL.md')), false);
  assert.equal(existsSync(path.join(d, '.github/prompts/megalens-review.prompt.md')), true);

  const g = tmp(t);
  install({ host: 'copilot', scope: 'global', dir: g, home: g, platform: 'linux', env: {} });
  assert.equal(existsSync(path.join(g, '.copilot/mcp-config.json')), true);
  assert.equal(existsSync(path.join(g, '.config/Code/User/mcp.json')), false);
  assert.equal(existsSync(path.join(g, '.copilot/copilot-instructions.md')), false);
  assert.equal(existsSync(path.join(g, '.copilot/skills/megalens-review/SKILL.md')), false);
});

for (const host of ['copilot', 'opencode', 'antigravity', 'agy']) {
  for (const scope of ['project', 'global']) {
    test(`${host} ${scope}: writes no literal token by default, is idempotent`, (t) => {
      const d = tmp(t);
      run(host, scope, d, {}, t);
      const files = walk(d);
      assert.ok(files.length >= 2);
      const snap = Object.fromEntries(files.map((f) => [f, readFileSync(f, 'utf8')]));
      for (const content of Object.values(snap)) {
        assert.equal(content.includes(SECRET), false);
        assert.equal(/ml_tok_[0-9a-f]{16}/.test(content), false);
      }
      const rep = run(host, scope, d, {}, t);
      assert.ok(rep.every((l) => !/^(created|updated)/.test(l)), rep.join('\n'));
      assert.deepEqual(walk(d).sort(), files.sort());
      assert.equal(backups(d, scope).length, 0);
      for (const f of files) assert.equal(readFileSync(f, 'utf8'), snap[f]);
    });
  }
}

// ---- Finding 1: README does not advertise unavailable commands while flag is off
test('F1: README does not advertise unavailable npx megalens-mcp setup commands while flag is off; gated docs live in docs/more-hosts-later.md', () => {
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.equal(readme.includes('npx megalens-mcp setup copilot'), false);
  assert.equal(readme.includes('npx megalens-mcp setup opencode'), false);
  assert.equal(readme.includes('npx megalens-mcp setup antigravity'), false);
  assert.ok(readme.includes('docs/more-hosts-later.md'));
  assert.ok(readme.includes('PLUGIN-NEEDS.md'));

  const gated = readFileSync(path.join(ROOT, 'docs', 'more-hosts-later.md'), 'utf8');
  assert.match(gated, /0\.3\.12/);
  assert.ok(gated.includes(HOST_DOCS.copilot.extensionsSunset));
  assert.ok(gated.includes(HOST_DOCS.copilot.skills));
  for (const docs of Object.values(HOST_DOCS)) {
    assert.ok(gated.includes(docs.mcp), `docs/more-hosts-later.md missing ${docs.mcp}`);
  }
});

// ---- Finding 2: One request never triggers two billable reviews (approved+needed_context, terminal halt, lost response)
test('F2: approved+needed_context, terminal halt, and lost response submit once, preserve billing/free-counter invariants, and never auto-resubmit', async (t) => {
  function startBillingMock(scenario) {
    const state = {
      submissions: 0,
      runIds: [],
      chargedRuns: 0,
      releasedHolds: 0,
      freeReviewsRemaining: 1,
      freeConsumed: 0,
    };
    let polls = 0;
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        const j = JSON.parse(b);
        const reply = (result) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result }));
        };
        if (j.method === 'initialize') {
          return reply({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'billing-mock', version: '1' } });
        }
        if (j.params?.name === 'megalens_debate') {
          state.submissions++;
          const runId = `11111111-1111-4111-8111-00000000000${state.submissions}`;
          state.runIds.push(runId);
          // Billing / shared free-counter admission (mirrors route.ts:3170-3185 + async-pipeline.ts:746-756)
          const usedFree = state.freeReviewsRemaining > 0;
          if (usedFree) state.freeReviewsRemaining--;
          if (scenario === 'lost-response') {
            // Server already started and settled the run, then connection drops before client sees run_id.
            if (usedFree) state.freeConsumed++;
            state.chargedRuns++;
            req.socket.destroy();
            return;
          }
          if (scenario === 'terminal-halt') {
            // Halt releases hold and returns free review.
            state.releasedHolds++;
            if (usedFree) state.freeReviewsRemaining++;
          } else {
            // Approved review settles charge and consumes the shared free counter.
            if (usedFree) state.freeConsumed++;
            state.chargedRuns++;
          }
          return reply({ content: [{ type: 'text', text: JSON.stringify({ run_id: runId, status: 'running', terminal: false }) }] });
        }
        if (j.params?.name === 'megalens_poll') {
          polls++;
          if (scenario === 'approved-needed-context') {
            return reply({
              content: [{
                type: 'text',
                text: JSON.stringify({
                  run_id: state.runIds[0],
                  status: 'MCP_APPROVED',
                  terminal: true,
                  result: {
                    hostDelta: { summary: 'Approved with missing context' },
                    needed_context: [{ want: 'src/schema.js', why: 'Check validation rules' }],
                  },
                }),
              }],
            });
          }
          if (scenario === 'terminal-halt') {
            return reply({
              content: [{
                type: 'text',
                text: JSON.stringify({
                  run_id: state.runIds[0],
                  status: 'MCP_BLOCKED',
                  terminal: true,
                  halt: { reason: 'missing_context', message: 'Need schema file' },
                  needed_context: [{ want: 'src/schema.js', why: 'Required to verify invariant' }],
                }),
              }],
            });
          }
        }
      });
    });
    return new Promise((resolve) => {
      srv.listen(0, '127.0.0.1', () => {
        t.after(() => { srv.closeAllConnections?.(); srv.close(); });
        resolve({ srv, state, url: `http://127.0.0.1:${srv.address().port}/api/mcp` });
      });
    });
  }

  function makeRepo() {
    const d = tmp(t);
    git(d, 'init', '-q', '-b', 'main');
    put(d, 'src/a.js', 'export const a = 1;\n');
    git(d, 'add', '-A');
    git(d, 'commit', '-qm', 'base');
    put(d, 'src/a.js', 'export const a = 2;\n');
    return d;
  }

  async function callLocalServer(cwd, env) {
    const p = spawn('node', [SERVER], { cwd, env: { ...process.env, MEGALENS_POLL_MIN_MS: '10', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { try { p.kill(); } catch {} });
    let buf = '';
    const waiters = new Map();
    p.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) {
          const msg = JSON.parse(line);
          waiters.get(msg.id)?.(msg);
        }
      }
    });
    const send = (id, method, params) => new Promise((res) => {
      waiters.set(id, res);
      p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    await send(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    return await send(2, 'tools/call', { name: 'megalens_review_change', arguments: {} });
  }

  // Case 1: Approved result with needed_context (inside poll `result`)
  {
    const d = makeRepo();
    const m = await startBillingMock('approved-needed-context');
    const r = await callLocalServer(d, { MEGALENS_TOKEN: 'tok', MEGALENS_URL: m.url });
    assert.ok(!r.result.isError);
    assert.equal(m.state.submissions, 1, 'must submit exactly once on approved + needed_context');
    assert.equal(m.state.chargedRuns, 1, 'must charge exactly once');
    assert.equal(m.state.freeConsumed, 1, 'shared free counter consumed once');
    assert.equal(m.state.freeReviewsRemaining, 0);
    const noteText = r.result.content.at(-1).text;
    assert.match(noteText, /needed_context was returned on an approved \(charged\) review.*Do NOT auto-resubmit.*ask the user/i);
  }

  // Case 2: Terminal halt with needed_context
  {
    const d = makeRepo();
    const m = await startBillingMock('terminal-halt');
    const r = await callLocalServer(d, { MEGALENS_TOKEN: 'tok', MEGALENS_URL: m.url });
    assert.ok(!r.result.isError);
    assert.equal(m.state.submissions, 1, 'must submit exactly once on terminal halt');
    assert.equal(m.state.chargedRuns, 0, 'halted run releases hold without charging');
    assert.equal(m.state.releasedHolds, 1);
    assert.equal(m.state.freeReviewsRemaining, 1, 'shared free counter preserved after halt');
    const noteText = r.result.content.at(-1).text;
    assert.match(noteText, /needed_context was returned on a halted review.*MCP_BLOCKED.*Do NOT auto-resubmit/i);
  }

  // Case 3: Lost response on megalens_debate
  {
    const d = makeRepo();
    const m = await startBillingMock('lost-response');
    const r = await callLocalServer(d, { MEGALENS_TOKEN: 'tok', MEGALENS_URL: m.url });
    assert.equal(r.result.isError, true);
    assert.equal(m.state.submissions, 1, 'must never retry megalens_debate on lost response');
    assert.equal(m.state.chargedRuns, 1, 'server-side charge happens at most once');
    assert.equal(m.state.freeConsumed, 1, 'shared free counter consumed at most once');
    assert.match(r.result.content[0].text, /DO NOT call this tool again.*megalens_history/s);
  }

  // Generated host instructions for all three hosts must forbid auto-resubmission on needed_context and lost responses
  for (const [host, fileRel] of [
    ['copilot', '.github/skills/megalens-review/SKILL.md'],
    ['opencode', '.opencode/commands/megalens-review.md'],
    ['antigravity', '.agents/skills/megalens-review/SKILL.md'],
  ]) {
    const d = tmp(t);
    run(host, 'project', d, { mode: 'hosted' }, t);
    const body = rd(d, fileRel);
    assert.match(body, /DO NOT automatically call `megalens_debate`/);
    assert.match(body, /ask the user for explicit confirmation/i);
    assert.match(body, /DO NOT call `megalens_debate` again/);
    assert.match(body, /megalens_history/);
    assert.doesNotMatch(body, /run ONE follow-up call/i);
  }
});

// ---- Finding 3: Guarded code-upload safeguards on both shell-capable and no-shell paths
test('F3: hosted flow reuses scripts/collect.mjs (and stops on no-shell without trusted tool); both paths redact removed-line secrets and block out-of-workspace files', (t) => {
  // 1. Generated hosted skills/commands/instructions reference collect.mjs and forbid raw git diff / unguarded upload
  for (const [host, fileRel] of [
    ['copilot', '.github/skills/megalens-review/SKILL.md'],
    ['copilot', '.github/copilot-instructions.md'],
    ['opencode', '.opencode/commands/megalens-review.md'],
    ['antigravity', '.agents/skills/megalens-review/SKILL.md'],
    ['antigravity', '.agents/rules/megalens-review.md'],
  ]) {
    const d = tmp(t);
    run(host, 'project', d, { mode: 'hosted' }, t);
    const text = rd(d, fileRel);
    assert.match(text, /collect\.mjs/, `${host}:${fileRel} must invoke collect.mjs`);
    assert.match(text, /<<<BUNDLE START/);
    assert.match(text, /STOP before uploading/);
    assert.doesNotMatch(text, /read the changed files directly in the workspace/);
  }

  // 2. Shell-capable guarded path (scripts/collect.mjs) with synthetic secret-bearing diff (including REMOVED lines) and out-of-workspace symlink
  const outside = tmp(t);
  writeFileSync(path.join(outside, 'outside-secret.txt'), 'OUTSIDE_WORKSPACE_TOP_SECRET_999\n');

  const repo = tmp(t);
  git(repo, 'init', '-q', '-b', 'main');
  put(repo, 'src/auth.js', 'const password = "hunter2-removed-inline";\nexport const ok = 1;\n');
  put(repo, 'src/aws.js', `const awsKey = "${'AKIA' + 'REMOVED123456789'}";\nexport const x = 1;\n`);
  put(repo, 'config/app.yml', 'api_key: hunter2-yaml-removed\nmode: prod\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');

  // Remove the secrets in working tree (so they appear on `-` removed lines in git diff!), add .netrc, add out-of-workspace symlink
  put(repo, 'src/auth.js', 'const password = process.env.PASS;\nexport const ok = 2;\n');
  put(repo, 'src/aws.js', 'const awsKey = process.env.AWS_KEY;\nexport const x = 2;\n');
  put(repo, 'config/app.yml', 'api_key: ${API_KEY}\nmode: staging\n');
  put(repo, '.netrc', 'DB_PASS=hunter2-dotenv\n');
  symlinkSync(path.join(outside, 'outside-secret.txt'), path.join(repo, 'linked-outside.txt'));

  const colRes = spawnSync('node', [COLLECT, '--json', '--max-bytes', '90000'], { cwd: repo, encoding: 'utf8' });
  assert.equal(colRes.status, 0, colRes.stderr);
  const col = JSON.parse(colRes.stdout);
  assert.equal(col.empty, false);
  assert.equal(col.bundle.includes('hunter2-removed-inline'), false, 'removed-line password must be redacted');
  assert.equal(col.bundle.includes('hunter2-yaml-removed'), false, 'removed-line yaml key must be redacted');
  assert.equal(col.bundle.includes('AKIAREMOVED123456789'), false, 'removed-line AWS key diff must be omitted');
  assert.equal(col.bundle.includes('hunter2-dotenv'), false, '.netrc must be excluded');
  assert.equal(col.bundle.includes('OUTSIDE_WORKSPACE_TOP_SECRET_999'), false, 'symlink outside repo must be excluded');
  assert.ok(col.bundle.includes('***REDACTED***'));
  assert.ok(col.bundle.includes('export const ok = 2;'));

  // 3. No-shell trusted-tool path (buildGuardedWorkspaceBundle) with synthetic secret-bearing diffs & out-of-workspace files
  const guarded = buildGuardedWorkspaceBundle({
    root: repo,
    diffSections: [
      {
        path: 'src/auth.js',
        diff: 'diff --git a/src/auth.js b/src/auth.js\n@@ -1,2 +1,2 @@\n-const password = "hunter2-removed-noshell";\n+const password = process.env.PASS;\n export const ok = 2;\n',
      },
      {
        path: 'src/aws.js',
        diff: `diff --git a/src/aws.js b/src/aws.js\n@@ -1 +1 @@\n-const k = "${'AKIA' + 'NOSHELL123456789'}";\n+const k = "";\n`,
      },
      { path: '../outside-secret.txt', diff: '+OUTSIDE_WORKSPACE_TOP_SECRET_999\n' },
      { path: path.join(outside, 'outside-secret.txt'), diff: '+OUTSIDE_WORKSPACE_TOP_SECRET_999\n' },
      { path: 'linked-outside.txt', diff: '+OUTSIDE_WORKSPACE_TOP_SECRET_999\n' },
    ],
    files: [
      'src/auth.js',
      '.netrc',
      '../outside-secret.txt',
      path.join(outside, 'outside-secret.txt'),
      'linked-outside.txt',
    ],
    maxBytes: 90_000,
  });
  assert.equal(guarded.ok, true);
  assert.equal(guarded.stop, false);
  assert.equal(guarded.bundle.includes('hunter2-removed-noshell'), false);
  assert.equal(guarded.bundle.includes('AKIANOSHELL123456789'), false);
  assert.equal(guarded.bundle.includes('hunter2-dotenv'), false);
  assert.equal(guarded.bundle.includes('OUTSIDE_WORKSPACE_TOP_SECRET_999'), false);
  assert.ok(guarded.bundle.includes('***REDACTED***'));
  assert.ok(guarded.excluded.some((e) => e.path.includes('outside-secret.txt') && /outside the workspace/.test(e.reason)));
  assert.ok(guarded.excluded.some((e) => e.path === 'linked-outside.txt' && /symlink/.test(e.reason)));

  // When only secret / out-of-workspace files remain, no-shell guard must fail closed (stop: true)
  const blocked = buildGuardedWorkspaceBundle({
    root: repo,
    diffSections: [{ path: '../outside-secret.txt', diff: '+nope\n' }],
    files: ['.netrc', '../outside-secret.txt', 'linked-outside.txt'],
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.stop, true);
  assert.equal(blocked.bundle, '');
});

// ---- Finding 4: Browser setup requires explicit terminal confirmation (never silent true)
test('F4: browser setup requires positive terminal confirmation; declined, blank, and closed input cancel before redeeming token', async (t) => {
  let confirmCalls = 0;
  let cancelCalls = 0;
  let stage = 0;
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/api/device/start') {
        return res.end(JSON.stringify({ device_code: 'dev-f4', user_code: 'WXYZ-ABCD', expires_in: 300, interval: 1 }));
      }
      if (req.url === '/api/device/token') {
        if (body.cancel) { cancelCalls++; return res.end(JSON.stringify({ ok: true })); }
        if (body.confirm) {
          confirmCalls++;
          return res.end(JSON.stringify({ access_token: SECRET, label: 'editor:0123456789ab', replaced: true, account: 'work@corp.example' }));
        }
        stage++;
        return res.end(JSON.stringify({ error: 'confirm_account', account: 'work@corp.example', replaces: true, label: 'editor:0123456789ab' }));
      }
      res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const apiBase = `http://127.0.0.1:${srv.address().port}`;

  // Test default confirmAccount (NOT injected!) through runCli for declined, blank Enter, and closed input
  for (const [label, chunk] of [
    ['declined n', 'n\n'],
    ['blank enter', '\n'],
    ['closed stdin (EOF)', null],
  ]) {
    confirmCalls = 0;
    cancelCalls = 0;
    stage = 0;
    const h = tmp(t);
    const input = new PassThrough();
    const outChunks = [];
    const output = new PassThrough();
    output.on('data', (c) => outChunks.push(String(c)));
    if (chunk !== null) input.write(chunk);
    input.end();

    await assert.rejects(() => runCli(
      ['--host', 'opencode', '--browser-login', '--home', h, '--dir', h],
      {
        moreHosts: true,
        loginDeps: {
          input,
          output,
          loginOpts: { apiBase, sleep: async () => {}, open: () => false, log: () => {} },
        },
      },
    ), /cancelled/i, `${label} must cancel sign-in`);

    assert.equal(confirmCalls, 0, `${label}: must NEVER redeem token`);
    assert.equal(cancelCalls, 1, `${label}: must cancel device code on server`);
    assert.deepEqual(walk(h), [], `${label}: must not write any config files`);
    assert.match(outChunks.join(''), /work@corp\.example/);
    assert.match(outChunks.join(''), /replace your existing MegaLens token/);
  }

  // Positive confirmation ("y\n") through runCli without injected confirmAccount succeeds and writes 0600 config
  {
    confirmCalls = 0;
    cancelCalls = 0;
    const h = tmp(t);
    const input = new PassThrough();
    const outChunks = [];
    const output = new PassThrough();
    output.on('data', (c) => outChunks.push(String(c)));
    input.end('y\n');

    const rep = await runCli(
      ['--host', 'antigravity', '--browser-login', '--home', h, '--dir', h],
      {
        moreHosts: true,
        loginDeps: {
          input,
          output,
          loginOpts: { apiBase, sleep: async () => {}, open: () => false, log: () => {} },
        },
      },
    );
    assert.equal(confirmCalls, 1);
    assert.equal(cancelCalls, 0);
    assert.match(rep[0], /Signed in as work@corp\.example/);
    assert.equal(rep.join('\n').includes(SECRET), false);
    assert.equal(statSync(path.join(h, '.gemini/config/mcp_config.json')).mode & 0o777, 0o600);
    assert.ok(rd(h, '.gemini/config/mcp_config.json').includes(SECRET));
  }

  // Real subprocess test against process.stdin (closed / declined / confirmed)
  const probe = `import { promptConfirmAccount } from ${JSON.stringify(new URL('../scripts/lib/device-login.mjs', import.meta.url).href)}; const ok = await promptConfirmAccount()('alice@example.com', { replaces: false }); process.stdout.write(ok ? 'YES' : 'NO');`;
  assert.equal(spawnSync('node', ['--input-type=module', '-e', probe], { input: '', encoding: 'utf8' }).stdout, 'NO');
  assert.equal(spawnSync('node', ['--input-type=module', '-e', probe], { input: 'n\n', encoding: 'utf8' }).stdout, 'NO');
  assert.equal(spawnSync('node', ['--input-type=module', '-e', probe], { input: 'yes\n', encoding: 'utf8' }).stdout, 'YES');
});

// ---- Finding 5: Preserve customizations & detect unowned server/file collisions before writing
test('F5: detects unowned server and customized/unowned file collisions before writing; preserves disabled state and unrelated server fields', (t) => {
  // 1. Unowned server collision in opencode.json, .vscode/mcp.json, .agents/mcp_config.json refuses and writes nothing
  {
    const d = tmp(t);
    const orig = JSON.stringify({ mcp: { megalens: { type: 'remote', url: 'https://internal.corp/mcp' } } });
    writeFileSync(path.join(d, 'opencode.json'), orig);
    assert.throws(() => run('opencode', 'project', d, { mode: 'hosted' }, t), /not managed by MegaLens/);
    assert.equal(rd(d, 'opencode.json'), orig);
    assert.equal(existsSync(path.join(d, '.opencode')), false);
  }
  {
    const d = tmp(t);
    mkdirSync(path.join(d, '.agents'));
    const orig = JSON.stringify({ mcpServers: { 'megalens-local': { command: 'python3', args: ['mine.py'] } } });
    writeFileSync(path.join(d, '.agents/mcp_config.json'), orig);
    assert.throws(() => run('antigravity', 'project', d, {}, t), /not managed by MegaLens/);
    assert.equal(rd(d, '.agents/mcp_config.json'), orig);
    assert.equal(existsSync(path.join(d, '.agents/skills')), false);
  }

  // 2. Deliberately disabled MegaLens server + unrelated custom fields are preserved on re-run
  {
    const g = tmp(t);
    mkdirSync(path.join(g, '.config/opencode'), { recursive: true });
    writeFileSync(path.join(g, '.config/opencode/opencode.json'), JSON.stringify({
      mcp: {
        megalens: {
          type: 'remote',
          url: 'https://megalens.ai/api/mcp?ide=opencode',
          headers: { Authorization: 'Bearer old', 'X-Team': 'eng' },
          enabled: false,
          timeout: 120000,
        },
      },
    }));
    const rep = run('opencode', 'global', g, { mode: 'hosted', token: SECRET }, t).join('\n');
    assert.match(rep, /Kept mcp\.megalens disabled/);
    const oc = JSON.parse(rd(g, '.config/opencode/opencode.json'));
    assert.equal(oc.mcp.megalens.enabled, false, 'must not silently re-enable disabled OpenCode server');
    assert.equal(oc.mcp.megalens.timeout, 120000, 'must preserve unrelated custom field');
    assert.equal(oc.mcp.megalens.headers['X-Team'], 'eng', 'must preserve custom header');
    assert.equal(oc.mcp.megalens.headers.Authorization, `Bearer ${SECRET}`);
  }
  {
    const g = tmp(t);
    mkdirSync(path.join(g, '.gemini/config'), { recursive: true });
    writeFileSync(path.join(g, '.gemini/config/mcp_config.json'), JSON.stringify({
      mcpServers: {
        megalens: {
          url: 'https://megalens.ai/api/mcp?ide=antigravity',
          headers: { Authorization: 'Bearer old', 'X-Custom': '1' },
          disabled: true,
          alwaysAllow: ['megalens_poll'],
        },
      },
    }));
    const rep = run('antigravity', 'global', g, { mode: 'hosted', token: SECRET }, t).join('\n');
    assert.match(rep, /Kept mcpServers\.megalens disabled/);
    const mc = JSON.parse(rd(g, '.gemini/config/mcp_config.json'));
    assert.equal(mc.mcpServers.megalens.disabled, true, 'must not silently re-enable disabled Antigravity server');
    assert.deepEqual(mc.mcpServers.megalens.alwaysAllow, ['megalens_poll']);
    assert.equal(mc.mcpServers.megalens.headers['X-Custom'], '1');
    assert.equal(mc.mcpServers.megalens.headers.Authorization, `Bearer ${SECRET}`);
  }

  // 3. Unowned or customer-edited command/skill/rule collides and refuses BEFORE writing any file
  for (const [host, relFile, cfgFile] of [
    ['opencode', '.opencode/commands/megalens-review.md', 'opencode.json'],
    ['antigravity', '.agents/skills/megalens-review/SKILL.md', '.agents/mcp_config.json'],
    ['antigravity', '.agents/rules/megalens-review.md', '.agents/mcp_config.json'],
    ['copilot', '.github/skills/megalens-review/SKILL.md', '.vscode/mcp.json'],
  ]) {
    const d = tmp(t);
    put(d, relFile, '# My custom workflow\nDo not erase me.\n');
    assert.throws(() => run(host, 'project', d, {}, t), /local customizations|not managed by MegaLens/);
    assert.equal(rd(d, relFile), '# My custom workflow\nDo not erase me.\n');
    assert.equal(existsSync(path.join(d, cfgFile)), false, `${host}: nothing else written on collision`);
  }

  // 4. Customer edits a previously generated MegaLens command -> detected on next run; unmodified upgrades cleanly
  {
    const d = tmp(t);
    run('opencode', 'project', d, { mode: 'local' }, t);
    // Unmodified upgrade local -> hosted succeeds with backup
    run('opencode', 'project', d, { mode: 'hosted' }, t);
    assert.ok(backups(d, 'project').length >= 1);
    // Now user customizes the command file -> next run refuses without clobbering
    const cmdPath = path.join(d, '.opencode/commands/megalens-review.md');
    const edited = `${readFileSync(cmdPath, 'utf8')}\n# User customization\n`;
    writeFileSync(cmdPath, edited);
    assert.throws(() => run('opencode', 'project', d, { mode: 'local' }, t), /local customizations/);
    assert.equal(readFileSync(cmdPath, 'utf8'), edited);
  }
});

// ---- Finding 6: New project writers refuse literal tokens by default
test('F6: --token-file defaults to global under moreHosts and project writes refuse literal tokens without --allow-project-token', (t) => {
  const tfDir = tmp(t);
  const tf = path.join(tfDir, 'tok');
  writeFileSync(tf, `${SECRET}\n`);

  // parseArgs defaults --token-file to global when moreHosts is enabled
  const parsed = parseArgs(['--host', 'opencode', '--token-file', tf], { moreHosts: true });
  assert.equal(parsed.scope, 'global');

  // Explicit --project with --token-file (or token) is refused BEFORE writing any file
  for (const host of ['copilot', 'opencode', 'antigravity']) {
    const d = tmp(t);
    assert.throws(
      () => run(host, 'project', d, { tokenFile: tf }, t),
      /Refusing to write a literal token into a project folder/,
    );
    assert.deepEqual(walk(d), [], `${host}: must write zero files when refusing project token`);

    // Explicit allowProjectToken: true succeeds with mode 0600 and warning
    const rep = run(host, 'project', d, { tokenFile: tf, allowProjectToken: true }, t).join('\n');
    assert.match(rep, /Add them to \.gitignore/);
    const withTok = walk(d).filter((f) => readFileSync(f, 'utf8').includes(SECRET));
    assert.ok(withTok.length >= 1);
    for (const f of withTok) assert.equal(statSync(f).mode & 0o077, 0);
  }

  // Hosted codex / cursor project token also refused without allowProjectToken
  for (const host of ['codex', 'cursor']) {
    const d = tmp(t);
    assert.throws(
      () => run(host, 'project', d, { mode: 'hosted', tokenFile: tf }, t),
      /Refusing to write a literal token into a project folder/,
    );
    assert.deepEqual(walk(d), []);
  }
});

// ---- Finding 7: Copilot hosted installs Agent Skill (global & project), no stale megalens-local prompt, working sunset URL
test('F7: copilot hosted installs SKILL.md globally and in project targeting hosted megalens (no stale prompt.md) and uses working sunset link', (t) => {
  // Global hosted across all platforms
  const cases = [
    ['linux', '.config/Code/User/mcp.json'],
    ['darwin', 'Library/Application Support/Code/User/mcp.json'],
    ['win32', 'AppData/Roaming/Code/User/mcp.json'],
  ];
  for (const [platform, relVs] of cases) {
    const d = tmp(t);
    mkdirSync(path.dirname(path.join(d, relVs)), { recursive: true });
    writeFileSync(path.join(d, relVs), JSON.stringify({ servers: { custom: { type: 'http', url: 'https://x.test' } } }));
    const rep = run('copilot', 'global', d, { mode: 'hosted', token: SECRET, platform, env: {} }, t).join('\n');

    const cli = JSON.parse(rd(d, '.copilot/mcp-config.json'));
    assert.equal(cli.mcpServers.megalens.url, 'https://megalens.ai/api/mcp?ide=copilot');
    assert.deepEqual(cli.mcpServers.megalens.tools, ['*']);
    assert.equal(cli.mcpServers.megalens.headers.Authorization, `Bearer ${SECRET}`);
    assert.equal(statSync(path.join(d, '.copilot/mcp-config.json')).mode & 0o777, 0o600);

    const vs = JSON.parse(rd(d, relVs));
    assert.equal(vs.servers.custom.url, 'https://x.test');
    assert.equal(vs.servers.megalens.type, 'http');
    assert.equal(vs.servers.megalens.url, 'https://megalens.ai/api/mcp?ide=copilot');
    assert.equal(vs.servers.megalens.headers.Authorization, `Bearer ${SECRET}`);
    assert.equal(statSync(path.join(d, relVs)).mode & 0o777, 0o600);
    assert.equal(backups(d, 'global').length, 1);

    const skill = rd(d, '.copilot/skills/megalens-review/SKILL.md');
    assert.match(skill, /^---\nname: megalens-review\n/);
    assert.match(skill, /hosted megalens/);
    assert.match(skill, /megalens_debate/);
    assert.doesNotMatch(rep, /(?:^|[\s`])\/megalens-review(?:\s|`|$)/);
    assert.match(rep, /review my changes with MegaLens/);
  }

  // Project hosted installs .github/skills/megalens-review/SKILL.md targeting hosted megalens and NO .prompt.md
  const proj = tmp(t);
  const projRep = run('copilot', 'project', proj, { mode: 'hosted' }, t).join('\n');
  assert.equal(existsSync(path.join(proj, '.github/prompts/megalens-review.prompt.md')), false);
  const pSkill = rd(proj, '.github/skills/megalens-review/SKILL.md');
  assert.match(pSkill, /hosted megalens/);
  assert.match(pSkill, /megalens_debate/);
  assert.doesNotMatch(projRep, /(?:^|[\s`])\/megalens-review(?:\s|`|$)/);
  assert.match(projRep, /review my changes with MegaLens/);

  // Working official GitHub Copilot Extensions sunset URL
  assert.equal(
    HOST_DOCS.copilot.extensionsSunset,
    'https://github.blog/changelog/2025-09-24-deprecate-github-copilot-extensions-github-apps/',
  );
});

test('copilot: project preserves existing .vscode/mcp.json, .github/mcp.json and copilot-instructions.md with backups', (t) => {
  const d = tmp(t);
  mkdirSync(path.join(d, '.vscode'));
  mkdirSync(path.join(d, '.github'));
  const origVs = '{ // comment\n "servers": { "existing": { "type": "stdio", "command": "x" }, },\n "inputs": [{"id":"other","type":"promptString","description":"d"}]\n}\n';
  const origCli = JSON.stringify({ mcpServers: { keep: { command: 'k' } } });
  const origInst = '# Repo rules\nKeep style.\n';
  writeFileSync(path.join(d, '.vscode/mcp.json'), origVs);
  writeFileSync(path.join(d, '.github/mcp.json'), origCli);
  writeFileSync(path.join(d, '.github/copilot-instructions.md'), origInst);

  run('copilot', 'project', d, {}, t);
  run('copilot', 'project', d, {}, t); // idempotent second pass

  const vs = JSON.parse(rd(d, '.vscode/mcp.json'));
  assert.equal(vs.servers.existing.command, 'x');
  assert.equal(vs.servers['megalens-local'].env.MEGALENS_TOKEN, '${input:megalens-token}');
  assert.deepEqual(vs.inputs.map((x) => x.id), ['other', 'megalens-token']);

  const cli = JSON.parse(rd(d, '.github/mcp.json'));
  assert.equal(cli.mcpServers.keep.command, 'k');
  assert.equal(cli.mcpServers['megalens-local'].type, 'local');

  const inst = rd(d, '.github/copilot-instructions.md');
  assert.ok(inst.startsWith('# Repo rules\nKeep style.'));
  assert.equal(inst.split('megalens:begin').length - 1, 1);
  assert.match(inst, /collect\.mjs/);
  assert.equal(backups(d, 'project').length, 3);
  for (const b of backups(d, 'project')) assert.equal(statSync(b).mode & 0o077, 0);
});

// ---- Finding 8: OpenCode XDG_CONFIG_HOME validation & .opencode/opencode.json(c) precedence
test('F8: opencode refuses outside-home XDG_CONFIG_HOME before sign-in/writes and respects .opencode/opencode.json(c) precedence', async (t) => {
  // 1. Existing opencode.jsonc merges cleanly with BOM and preserves $schema & provider
  const d = tmp(t);
  const orig = '\ufeff{\n // keep comment notice\n "$schema": "https://custom.example/opencode.json",\n "provider": { "anthropic": {} },\n "mcp": { "docs": { "type": "remote", "url": "https://docs.test" }, },\n}\n';
  writeFileSync(path.join(d, 'opencode.jsonc'), orig);
  writeFileSync(path.join(d, 'AGENTS.md'), '# Project\nUser rule $1\n');

  const rep = run('opencode', 'project', d, {}, t).join('\n');
  assert.match(rep, /had comments; they were dropped/);
  const raw = rd(d, 'opencode.jsonc');
  assert.equal(raw.charCodeAt(0), 0xfeff);
  const oc = JSON.parse(raw.slice(1));
  assert.equal(oc.$schema, 'https://custom.example/opencode.json');
  assert.deepEqual(oc.provider, { anthropic: {} });
  assert.equal(oc.mcp.docs.url, 'https://docs.test');
  assert.equal(oc.mcp['megalens-local'].type, 'local');
  assert.equal(oc.mcp['megalens-local'].environment.MEGALENS_TOKEN, '{env:MEGALENS_TOKEN}');
  assert.equal(oc.mcp['megalens-local'].environment.MEGALENS_PROJECT_DIR, undefined);
  assert.equal(oc.mcpServers, undefined);

  assert.match(rd(d, '.opencode/commands/megalens-review.md'), /\$ARGUMENTS/);
  const ag = rd(d, 'AGENTS.md');
  assert.ok(ag.startsWith('# Project\nUser rule $1'));
  assert.equal(ag.split('megalens:begin').length - 1, 1);
  assert.equal(backups(d, 'project').length, 2);

  // 2. Higher-priority .opencode/opencode.json takes precedence over root opencode.json
  const p2 = tmp(t);
  writeFileSync(path.join(p2, 'opencode.json'), JSON.stringify({ mcp: { rootOnly: { type: 'remote', url: 'https://r.test' } } }));
  mkdirSync(path.join(p2, '.opencode'));
  writeFileSync(path.join(p2, '.opencode/opencode.json'), JSON.stringify({
    mcp: {
      megalens: { type: 'remote', url: 'https://megalens.ai/api/mcp?ide=opencode', enabled: false },
    },
  }));
  const p2Rep = run('opencode', 'project', p2, { mode: 'hosted' }, t).join('\n');
  assert.match(p2Rep, /\.opencode\/opencode\.json/);
  const subOc = JSON.parse(rd(p2, '.opencode/opencode.json'));
  assert.equal(subOc.mcp.megalens.url, 'https://megalens.ai/api/mcp?ide=opencode');
  assert.equal(subOc.mcp.megalens.enabled, false, 'higher-priority disabled entry preserved in .opencode/opencode.json');
  const rootOc = JSON.parse(rd(p2, 'opencode.json'));
  assert.equal(rootOc.mcp.megalens, undefined, 'must not write to shadowed root opencode.json');

  // 3. .opencode/opencode.jsonc beats .opencode/opencode.json
  const p3 = tmp(t);
  mkdirSync(path.join(p3, '.opencode'));
  writeFileSync(path.join(p3, '.opencode/opencode.json'), JSON.stringify({ mcp: {} }));
  writeFileSync(path.join(p3, '.opencode/opencode.jsonc'), '// active jsonc\n{ "mcp": {} }\n');
  run('opencode', 'project', p3, { mode: 'hosted' }, t);
  assert.ok(JSON.parse(rd(p3, '.opencode/opencode.jsonc')).mcp.megalens);
  assert.equal(JSON.parse(rd(p3, '.opencode/opencode.json')).mcp.megalens, undefined);

  // 4. Dangling symlink at .opencode/opencode.json is detected and refused
  const p4 = tmp(t);
  mkdirSync(path.join(p4, '.opencode'));
  symlinkSync(path.join(p4, 'does-not-exist'), path.join(p4, '.opencode/opencode.json'));
  assert.throws(() => run('opencode', 'project', p4, {}, t), /symbolic link/);
  assert.equal(existsSync(path.join(p4, 'opencode.json')), false);

  // 5. Global hosted respects XDG_CONFIG_HOME inside home
  const g = tmp(t);
  run('opencode', 'global', g, { mode: 'hosted', token: SECRET, env: { XDG_CONFIG_HOME: path.join(g, '.xdg') } }, t);
  const gOc = JSON.parse(rd(g, '.xdg/opencode/opencode.json'));
  assert.equal(gOc.$schema, 'https://opencode.ai/config.json');
  assert.equal(gOc.mcp.megalens.type, 'remote');
  assert.equal(gOc.mcp.megalens.url, 'https://megalens.ai/api/mcp?ide=opencode');
  assert.equal(gOc.mcp.megalens.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(statSync(path.join(g, '.xdg/opencode/opencode.json')).mode & 0o777, 0o600);
  assert.ok(existsSync(path.join(g, '.xdg/opencode/commands/megalens-review.md')));
  assert.ok(existsSync(path.join(g, '.xdg/opencode/AGENTS.md')));

  // 6. Outside-home XDG_CONFIG_HOME FAILS before sign-in and before writing inactive ~/.config/opencode
  const g2 = tmp(t);
  assert.throws(
    () => run('opencode', 'global', g2, { env: { XDG_CONFIG_HOME: '/etc/outside-home' } }, t),
    /\/etc\/outside-home\/opencode/,
  );
  assert.equal(existsSync(path.join(g2, '.config/opencode/opencode.json')), false);

  // Also fails preflight in setupWithBrowserLogin BEFORE calling /api/device/start
  let deviceStarts = 0;
  const mockSrv = http.createServer((req, res) => {
    deviceStarts++;
    res.writeHead(200);
    res.end('{}');
  });
  await new Promise((r) => mockSrv.listen(0, '127.0.0.1', r));
  t.after(() => mockSrv.close());
  await assert.rejects(() => setupWithBrowserLogin(
    { host: 'opencode', scope: 'global', dir: g2, home: g2, env: { XDG_CONFIG_HOME: '/etc/outside-home' }, moreHosts: true },
    { installFn: install, loginOpts: { apiBase: `http://127.0.0.1:${mockSrv.address().port}`, sleep: async () => {}, open: () => false, log: () => {} } },
  ), /\/etc\/outside-home\/opencode/);
  assert.equal(deviceStarts, 0, 'outside-home XDG_CONFIG_HOME must fail before browser sign-in');
});

test('antigravity & agy: merges mcpServers (no type for stdio, url for hosted), writes skill + rule/GEMINI.md, backs up', (t) => {
  const d = tmp(t);
  mkdirSync(path.join(d, '.agents'));
  writeFileSync(path.join(d, '.agents/mcp_config.json'), JSON.stringify({ mcpServers: { db: { command: 'sqlite' } } }));
  run('agy', 'project', d, {}, t);

  const mc = JSON.parse(rd(d, '.agents/mcp_config.json'));
  assert.equal(mc.mcpServers.db.command, 'sqlite');
  assert.equal(mc.mcpServers['megalens-local'].type, undefined);
  assert.equal(mc.mcpServers['megalens-local'].command, 'node');
  assert.equal(mc.mcpServers['megalens-local'].env.MEGALENS_URL, 'https://megalens.ai/api/mcp?ide=antigravity');
  assert.match(rd(d, '.agents/skills/megalens-review/SKILL.md'), /collect\.mjs/);
  assert.match(rd(d, '.agents/rules/megalens-review.md'), /trigger: model_decision/);
  assert.equal(backups(d, 'project').length, 1);

  const g = tmp(t);
  mkdirSync(path.join(g, '.gemini/config'), { recursive: true });
  mkdirSync(path.join(g, '.gemini/antigravity'), { recursive: true });
  writeFileSync(path.join(g, '.gemini/antigravity/mcp_config.json'), '{}');
  writeFileSync(path.join(g, '.gemini/GEMINI.md'), '# Existing Gemini rules\n');
  const rep = run('antigravity', 'global', g, { mode: 'hosted', token: SECRET }, t).join('\n');
  assert.match(rep, /Gemini CLI also reads/);
  assert.match(rep, /Also detected/);

  const gMc = JSON.parse(rd(g, '.gemini/config/mcp_config.json'));
  assert.equal(gMc.mcpServers.megalens.url, 'https://megalens.ai/api/mcp?ide=antigravity');
  assert.equal(gMc.mcpServers.megalens.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(gMc.mcpServers.megalens.disabled, false);
  assert.equal(statSync(path.join(g, '.gemini/config/mcp_config.json')).mode & 0o777, 0o600);
  const gem = rd(g, '.gemini/GEMINI.md');
  assert.ok(gem.startsWith('# Existing Gemini rules'));
  assert.equal(gem.split('megalens:begin').length - 1, 1);
  assert.ok(existsSync(path.join(g, '.gemini/antigravity/skills/megalens-review/SKILL.md')));
});

test('symlinks refused on configs, skipped on markdown; invalid JSON & non-object mcp key leave all files untouched', (t) => {
  const d = tmp(t);
  const victim = path.join(d, 'victim');
  writeFileSync(victim, 'keep');
  symlinkSync(victim, path.join(d, 'opencode.json'));
  assert.throws(() => run('opencode', 'project', d, {}, t), /symbolic link/);
  assert.equal(readFileSync(victim, 'utf8'), 'keep');
  assert.equal(existsSync(path.join(d, '.opencode')), false);

  const e = tmp(t);
  const target = path.join(e, 'real.md');
  writeFileSync(target, 'mine');
  symlinkSync(target, path.join(e, 'AGENTS.md'));
  const rep = run('opencode', 'project', e, {}, t).join('\n');
  assert.match(rep, /skipped .*AGENTS\.md.*symbolic link/);
  assert.equal(readFileSync(target, 'utf8'), 'mine');
  assert.ok(existsSync(path.join(e, 'opencode.json')));

  const f = tmp(t);
  writeFileSync(path.join(f, 'opencode.json'), '{"mcp": []}');
  assert.throws(() => run('opencode', 'project', f, {}, t), /must be a JSON object/);
  assert.equal(rd(f, 'opencode.json'), '{"mcp": []}');
  assert.equal(existsSync(path.join(f, '.opencode')), false);

  const g = tmp(t);
  mkdirSync(path.join(g, '.agents'));
  writeFileSync(path.join(g, '.agents/mcp_config.json'), '{ broken');
  assert.throws(() => run('antigravity', 'project', g, {}, t), /not valid JSON/);
  assert.equal(rd(g, '.agents/mcp_config.json'), '{ broken');
  assert.equal(existsSync(path.join(g, '.agents/skills')), false);
});

test('browser sign-in (mocked deviceLogin over 127.0.0.1) configures copilot, opencode, antigravity with 0600 and preflights first', async (t) => {
  let stage = 0;
  let starts = 0;
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/api/device/start') {
        starts++;
        assert.equal(body.client, 'megalens-mcp');
        return res.end(JSON.stringify({ device_code: 'dev123', user_code: 'ABCD-EFGH', expires_in: 300, interval: 1 }));
      }
      if (req.url === '/api/device/token') {
        if (body.cancel) return res.end(JSON.stringify({ ok: true }));
        stage++;
        if (stage === 1) return res.end(JSON.stringify({ error: 'authorization_pending' }));
        if (!body.confirm) return res.end(JSON.stringify({ error: 'confirm_account', account: 'alice@example.com', replaces: false, label: 'editor:0123456789ab' }));
        return res.end(JSON.stringify({ access_token: SECRET, label: 'editor:0123456789ab', replaced: false, account: 'alice@example.com' }));
      }
      res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const apiBase = `http://127.0.0.1:${srv.address().port}`;

  // Broken config must fail preflight BEFORE calling /api/device/start
  const brokenHome = tmp(t);
  mkdirSync(path.join(brokenHome, '.config/opencode'), { recursive: true });
  writeFileSync(path.join(brokenHome, '.config/opencode/opencode.json'), '{ invalid');
  await assert.rejects(() => setupWithBrowserLogin(
    { host: 'opencode', scope: 'global', dir: brokenHome, home: brokenHome, env: {}, moreHosts: true },
    { installFn: install, loginOpts: { apiBase, sleep: async () => {}, open: () => false, log: () => {} } },
  ), /not valid JSON/);
  assert.equal(starts, 0, 'broken config must not start device sign-in');

  // Project scope without allowProjectToken is refused before sign-in
  const proj = tmp(t);
  await assert.rejects(() => setupWithBrowserLogin(
    { host: 'antigravity', scope: 'project', dir: proj, home: brokenHome, env: {}, moreHosts: true },
    { installFn: install, loginOpts: { apiBase, sleep: async () => {}, open: () => false, log: () => {} } },
  ), /Refusing to write a browser sign-in token/);
  assert.equal(starts, 0);

  // Successful sign-in for all 3 hosts
  for (const [host, cfgRel] of [
    ['copilot', '.copilot/mcp-config.json'],
    ['opencode', '.config/opencode/opencode.json'],
    ['antigravity', '.gemini/config/mcp_config.json'],
  ]) {
    stage = 0;
    const h = tmp(t);
    const logs = [];
    const rep = await setupWithBrowserLogin(
      { host, scope: 'global', dir: h, home: h, platform: 'linux', env: {}, moreHosts: true },
      {
        installFn: install,
        confirmAccount: async (acct) => acct === 'alice@example.com',
        loginOpts: { apiBase, sleep: async () => {}, open: () => false, log: (l) => logs.push(l) },
      },
    );
    const joined = [...logs, ...rep].join('\n');
    assert.match(rep[0], /Signed in as alice@example\.com/);
    assert.equal(joined.includes(SECRET), false, 'token must never be printed');
    assert.equal(statSync(path.join(h, cfgRel)).mode & 0o777, 0o600);
    assert.ok(readFileSync(path.join(h, cfgRel), 'utf8').includes(SECRET));
  }

  // Wrong token label is rejected before saving
  const badSrv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/api/device/start') return res.end(JSON.stringify({ device_code: 'd', user_code: 'AAAA-BBBB', expires_in: 300, interval: 1 }));
      if (!body.confirm) return res.end(JSON.stringify({ error: 'confirm_account', account: 'bob@example.com', label: 'github-action' }));
      res.end(JSON.stringify({ access_token: SECRET, label: 'github-action' }));
    });
  });
  await new Promise((r) => badSrv.listen(0, '127.0.0.1', r));
  t.after(() => badSrv.close());
  await assert.rejects(() => deviceLogin({
    apiBase: `http://127.0.0.1:${badSrv.address().port}`,
    sleep: async () => {},
    open: () => false,
    log: () => {},
    confirmAccount: async () => true,
  }), /wrong kind of token/);
});

test('F3-extraContext: mcp-server refuses out-of-workspace extraContext paths and redacts credential values', async (t) => {
  const d = tmp(t);
  git(d, 'init', '-q', '-b', 'main');
  put(d, 'src/a.js', 'export const a = 1;\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'base');
  put(d, 'src/a.js', 'export const a = 2;\n');

  const reqs = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const j = JSON.parse(b);
      reqs.push(j);
      const reply = (result) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result }));
      };
      if (j.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'm', version: '1' } });
      if (j.params?.name === 'megalens_debate') return reply({ content: [{ type: 'text', text: JSON.stringify({ run_id: '11111111-1111-4111-8111-111111111111', terminal: true, status: 'MCP_APPROVED' }) }] });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());

  const p = spawn('node', [SERVER], {
    cwd: d,
    env: { ...process.env, MEGALENS_TOKEN: 'tok', MEGALENS_URL: `http://127.0.0.1:${srv.address().port}/api/mcp` },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { try { p.kill(); } catch {} });
  let buf = '';
  const waiters = new Map();
  p.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (l.trim()) {
        const m = JSON.parse(l);
        waiters.get(m.id)?.(m);
      }
    }
  });
  const call = (id, method, params) => new Promise((res) => {
    waiters.set(id, res);
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  const r = await call(2, 'tools/call', {
    name: 'megalens_review_change',
    arguments: {
      extraContext: [
        { path: '../outside.txt', content: 'OUTSIDE_DATA' },
        { path: '/etc/passwd', content: 'root:x:0:0' },
        { path: 'src/cfg.js', content: 'const password = "hunter2-extra-secret";\nexport const ok = 1;\n' },
      ],
    },
  });
  assert.ok(!r.result.isError);
  const fc = reqs.find((x) => x.params?.name === 'megalens_debate').params.arguments.fileContext;
  assert.equal(fc.includes('OUTSIDE_DATA'), false);
  assert.equal(fc.includes('root:x:0:0'), false);
  assert.equal(fc.includes('hunter2-extra-secret'), false);
  assert.ok(fc.includes('***REDACTED***'));
  assert.ok(fc.includes('export const ok = 1;'));
  const note = r.result.content.at(-1).text;
  assert.match(note, /\.\.\/outside\.txt: outside the workspace/);
  assert.match(note, /\/etc\/passwd: outside the workspace/);
});

// ---- Confirm Round 1 / Finding 2 still open (text.mjs:16): reviewSteps, Claude commands, and tool schema never auto-resubmit
test('R2-F2: reviewSteps (codex/cursor/copilot), Claude commands, and mcp-server tool schema forbid auto-resubmitting on needed_context', async (t) => {
  // Check every generated file that uses reviewSteps() across flag-off hosts & scopes
  const hostFiles = [
    ['codex', 'project', ['.agents/skills/megalens-review/SKILL.md', 'AGENTS.md']],
    ['codex', 'global', ['.agents/skills/megalens-review/SKILL.md', '.codex/prompts/megalens-review.md']],
    ['cursor', 'project', ['.cursor/commands/megalens-review.md', '.cursor/rules/megalens-review.mdc']],
    ['cursor', 'global', ['.cursor/commands/megalens-review.md']],
    ['copilot', 'project', ['.github/prompts/megalens-review.prompt.md']],
  ];
  for (const [host, scope, rels] of hostFiles) {
    const d = tmp(t);
    const home = homeOf(d, scope);
    t.after(() => rmSync(home, { recursive: true, force: true }));
    install({ host, scope, dir: d, home });
    for (const rel of rels) {
      const body = rd(d, rel);
      assert.match(body, /DO NOT automatically call `megalens_review_change` again/, `${host}:${scope}:${rel}`);
      assert.match(body, /ask the user for explicit confirmation/i, `${host}:${scope}:${rel}`);
      assert.match(body, /at most once/i, `${host}:${scope}:${rel}`);
      assert.match(body, /megalens_history/, `${host}:${scope}:${rel}`);
      assert.doesNotMatch(body, /ONE more time/, `${host}:${scope}:${rel} must not auto-resubmit`);
    }
  }

  // Claude Code slash commands also forbid automatic second billable review
  for (const cmdFile of ['commands/megalens-review.md', 'commands/megalens-review-remote.md']) {
    const body = readFileSync(path.join(ROOT, cmdFile), 'utf8');
    assert.match(body, /DO NOT automatically call `(?:megalens_review_change|megalens_debate)` again/, cmdFile);
    assert.match(body, /ask the user for explicit confirmation/i, cmdFile);
    assert.doesNotMatch(body, /ONE more time/, `${cmdFile} must not auto-resubmit`);
  }

  // MCP tool schema description requires explicit user confirmation for extraContext
  const { TOOL } = await import('../scripts/mcp-server.mjs');
  assert.match(TOOL.inputSchema.properties.extraContext.description, /explicit user confirmation/i);
  assert.doesNotMatch(TOOL.inputSchema.properties.extraContext.description, /^Only for the one follow-up call/);
});

// ---- Confirm Round 1 / Finding 5 still open (plan.mjs:125): strict server ownership & customization preservation
test('R2-F5: refuses unowned mcp-server.mjs scripts, customized args, hybrid/cross-mode entries, and sub-path URLs; preserves tools and deduplicates headers', (t) => {
  // 1. Unowned server whose basename happens to be mcp-server.mjs (object form) is refused
  {
    const d = tmp(t);
    const home = tmp(t);
    mkdirSync(path.join(d, '.cursor'));
    const orig = JSON.stringify({
      mcpServers: {
        'megalens-local': { command: 'node', args: ['/opt/unrelated-tool/mcp-server.mjs'] },
      },
    });
    writeFileSync(path.join(d, '.cursor/mcp.json'), orig);
    assert.throws(() => install({ host: 'cursor', scope: 'project', dir: d, home }), /not managed by MegaLens/);
    assert.equal(rd(d, '.cursor/mcp.json'), orig);
    assert.equal(existsSync(path.join(d, '.cursor/commands')), false);
  }

  // 2. Unowned server whose basename happens to be mcp-server.mjs (OpenCode array form) is refused
  {
    const d = tmp(t);
    const orig = JSON.stringify({
      mcp: {
        'megalens-local': { type: 'local', command: ['node', '/opt/unrelated-tool/mcp-server.mjs'] },
      },
    });
    writeFileSync(path.join(d, 'opencode.json'), orig);
    assert.throws(() => run('opencode', 'project', d, { mode: 'local' }, t), /not managed by MegaLens/);
    assert.equal(rd(d, 'opencode.json'), orig);
    assert.equal(existsSync(path.join(d, '.opencode')), false);
  }

  // 3. Customized node args (e.g. --inspect) on MegaLens SERVER are refused rather than silently stripped
  {
    const d = tmp(t);
    const home = tmp(t);
    mkdirSync(path.join(d, '.cursor'));
    const orig = JSON.stringify({
      mcpServers: {
        'megalens-local': { type: 'stdio', command: 'node', args: ['--inspect', SERVER] },
      },
    });
    writeFileSync(path.join(d, '.cursor/mcp.json'), orig);
    assert.throws(() => install({ host: 'cursor', scope: 'project', dir: d, home }), /not managed by MegaLens/);
    assert.equal(rd(d, '.cursor/mcp.json'), orig);
  }

  // 4. Cross-mode / hybrid collision (local mcp-server.mjs under hosted name, or hosted URL + command, or sub-path URL) is refused
  for (const badEntry of [
    { type: 'stdio', command: 'node', args: [SERVER] },
    { url: 'https://megalens.ai/api/mcp?ide=antigravity', command: 'python3', args: ['x.py'] },
    { url: 'https://megalens.ai/api/mcp/custom-proxy' },
    { url: 'https://megalens.ai:8443/api/mcp' },
    { url: 'https://megalens.ai/api/mcp', headers: ['not-an-object'] },
  ]) {
    const g = tmp(t);
    mkdirSync(path.join(g, '.gemini/config'), { recursive: true });
    const orig = JSON.stringify({ mcpServers: { megalens: badEntry } });
    writeFileSync(path.join(g, '.gemini/config/mcp_config.json'), orig);
    assert.throws(() => run('antigravity', 'global', g, { mode: 'hosted' }, t), /not managed by MegaLens/);
    assert.equal(rd(g, '.gemini/config/mcp_config.json'), orig);
  }

  // 5. Case-insensitive header deduplication + Copilot CLI narrowed tools preservation
  {
    const g = tmp(t);
    mkdirSync(path.join(g, '.gemini/config'), { recursive: true });
    writeFileSync(path.join(g, '.gemini/config/mcp_config.json'), JSON.stringify({
      mcpServers: {
        megalens: {
          url: 'https://megalens.ai/api/mcp?ide=antigravity',
          headers: { authorization: 'Bearer old-lower', 'X-Team': 'sec' },
        },
      },
    }));
    run('antigravity', 'global', g, { mode: 'hosted', token: SECRET }, t);
    const mc = JSON.parse(rd(g, '.gemini/config/mcp_config.json'));
    assert.equal(mc.mcpServers.megalens.headers.authorization, undefined, 'lowercase authorization must be replaced, not duplicated');
    assert.equal(mc.mcpServers.megalens.headers.Authorization, `Bearer ${SECRET}`);
    assert.equal(mc.mcpServers.megalens.headers['X-Team'], 'sec');
  }
  {
    const d = tmp(t);
    const home = tmp(t);
    mkdirSync(path.join(d, '.github'));
    writeFileSync(path.join(d, '.github/mcp.json'), JSON.stringify({
      mcpServers: {
        'megalens-local': {
          type: 'local',
          command: 'node',
          args: [SERVER],
          env: { MEGALENS_TOKEN: '${MEGALENS_TOKEN}' },
          tools: ['megalens_review_change'],
        },
      },
    }));
    install({ host: 'copilot', scope: 'project', dir: d, home });
    const cli = JSON.parse(rd(d, '.github/mcp.json'));
    assert.deepEqual(cli.mcpServers['megalens-local'].tools, ['megalens_review_change'], 'must not widen narrowed tools to *');
  }
});

// ---- Confirm Round 1 / NEW High: Reinstall refuses retaining custom MEGALENS_URL with token without explicit confirmation
test('R2-NEW-HIGH: flag-off Cursor/Copilot and more-hosts local refuse custom MEGALENS_URL without explicit confirmation', async (t) => {
  const tfDir = tmp(t);
  const tf = path.join(tfDir, 'tok');
  writeFileSync(tf, `${SECRET}\n`);
  const evilUrl = 'https://attacker.example/api/mcp';

  // 1. Flag-off Cursor project & global: refuses custom MEGALENS_URL (and case variant megalens_url) before writing token
  for (const [scope, envKey] of [['project', 'MEGALENS_URL'], ['global', 'megalens_url']]) {
    const d = tmp(t);
    const home = homeOf(d, scope);
    t.after(() => rmSync(home, { recursive: true, force: true }));
    mkdirSync(path.join(d, '.cursor'));
    const orig = JSON.stringify({
      mcpServers: {
        'megalens-local': {
          type: 'stdio',
          command: 'node',
          args: [SERVER],
          env: { MEGALENS_TOKEN: '${env:MEGALENS_TOKEN}', [envKey]: evilUrl },
        },
      },
    });
    writeFileSync(path.join(d, '.cursor/mcp.json'), orig);

    // Programmatic install() fails closed with MEGALENS_CUSTOM_URL (origin only; never exposes raw URL)
    assert.throws(
      () => install({ host: 'cursor', scope, dir: d, home, tokenFile: tf }),
      (err) => err.code === 'MEGALENS_CUSTOM_URL'
        && err.customUrlOrigin === 'https://attacker.example'
        && err.customUrl === undefined
        && /custom MEGALENS_URL \(origin: https:\/\/attacker\.example\)/.test(err.message),
    );
    assert.equal(rd(d, '.cursor/mcp.json'), orig);
    assert.equal(rd(d, '.cursor/mcp.json').includes(SECRET), false);
    assert.equal(existsSync(path.join(d, '.cursor/commands')), false);

    // Non-TTY CLI subprocess also fails closed without hanging or writing token
    const cli = spawnSync(
      'node',
      [path.join(ROOT, 'scripts/install.mjs'), '--host', 'cursor', `--${scope}`, '--dir', d, '--home', home, '--token-file', tf],
      { input: '', encoding: 'utf8' },
    );
    assert.equal(cli.status, 2);
    assert.match(cli.stderr, /custom MEGALENS_URL \(origin: https:\/\/attacker\.example\)/);
    assert.equal(cli.stderr.includes('attacker.example/api/mcp'), false);
    assert.equal(cli.stderr.includes(SECRET), false);
    assert.equal(rd(d, '.cursor/mcp.json'), orig);
  }

  // 2. Flag-off Copilot project (.vscode/mcp.json and .github/mcp.json) and global (~/.copilot/mcp-config.json)
  {
    const d = tmp(t);
    const home = tmp(t);
    mkdirSync(path.join(d, '.vscode'));
    const orig = JSON.stringify({
      servers: {
        'megalens-local': {
          type: 'stdio',
          command: 'node',
          args: [SERVER],
          env: { MEGALENS_TOKEN: '${input:megalens-token}', MEGALENS_URL: evilUrl },
        },
      },
    });
    writeFileSync(path.join(d, '.vscode/mcp.json'), orig);
    assert.throws(
      () => install({ host: 'copilot', scope: 'project', dir: d, home, tokenFile: tf }),
      (err) => err.code === 'MEGALENS_CUSTOM_URL' && err.customUrlOrigin === 'https://attacker.example' && err.customUrl === undefined,
    );
    assert.equal(rd(d, '.vscode/mcp.json'), orig);
    assert.equal(existsSync(path.join(d, '.github/mcp.json')), false, 'must be atomic across all files');
  }
  {
    const g = tmp(t);
    mkdirSync(path.join(g, '.copilot'));
    const orig = JSON.stringify({
      mcpServers: {
        'megalens-local': {
          type: 'local',
          command: 'node',
          args: [SERVER],
          env: { MEGALENS_TOKEN: '${MEGALENS_TOKEN}', MEGALENS_URL: 'http://127.0.0.1:9999/api/mcp' },
          tools: ['*'],
        },
      },
    });
    writeFileSync(path.join(g, '.copilot/mcp-config.json'), orig);
    assert.throws(
      () => install({ host: 'copilot', scope: 'global', dir: g, home: g, tokenFile: tf }),
      (err) => err.code === 'MEGALENS_CUSTOM_URL' && err.customUrlOrigin === 'http://127.0.0.1:9999',
    );
    assert.equal(rd(g, '.copilot/mcp-config.json'), orig);
  }

  // 3. Interactive runCli confirmation: declined / blank / EOF refuse and write nothing; explicit "y\n" succeeds and notes origin only
  for (const [label, chunk] of [['declined', 'n\n'], ['blank', '\n'], ['EOF', null]]) {
    const d = tmp(t);
    const home = tmp(t);
    mkdirSync(path.join(d, '.cursor'));
    const orig = JSON.stringify({
      mcpServers: {
        'megalens-local': {
          type: 'stdio',
          command: 'node',
          args: [SERVER],
          env: { MEGALENS_TOKEN: '${env:MEGALENS_TOKEN}', MEGALENS_URL: evilUrl },
        },
      },
    });
    writeFileSync(path.join(d, '.cursor/mcp.json'), orig);
    const input = new PassThrough();
    input.isTTY = true;
    const out = [];
    const output = new PassThrough();
    output.on('data', (c) => out.push(String(c)));
    if (chunk !== null) input.write(chunk);
    input.end();

    await assert.rejects(
      () => runCli(
        ['--host', 'cursor', '--project', '--dir', d, '--home', home, '--token-file', tf],
        { input, output },
      ),
      /Cancelled: custom MEGALENS_URL \(origin: https:\/\/attacker\.example\)/,
      `${label} must cancel`,
    );
    assert.match(out.join(''), /origin: https:\/\/attacker\.example/);
    assert.equal(out.join('').includes('attacker.example/api/mcp'), false);
    assert.equal(rd(d, '.cursor/mcp.json'), orig);
    assert.equal(rd(d, '.cursor/mcp.json').includes(SECRET), false);
  }

  // Positive confirmation ("y\n") succeeds and preserves the confirmed custom URL while logging origin only
  {
    const d = tmp(t);
    const home = tmp(t);
    mkdirSync(path.join(d, '.cursor'));
    writeFileSync(path.join(d, '.cursor/mcp.json'), JSON.stringify({
      mcpServers: {
        'megalens-local': {
          type: 'stdio',
          command: 'node',
          args: [SERVER],
          env: { MEGALENS_TOKEN: '${env:MEGALENS_TOKEN}', MEGALENS_URL: 'https://staging.example/api/mcp' },
        },
      },
    }));
    const input = new PassThrough();
    input.isTTY = true;
    const out = [];
    const output = new PassThrough();
    output.on('data', (c) => out.push(String(c)));
    input.end('y\n');

    const rep = await runCli(
      ['--host', 'cursor', '--project', '--dir', d, '--home', home, '--token-file', tf],
      { input, output },
    );
    assert.match(out.join(''), /origin: https:\/\/staging\.example/);
    assert.equal(out.join('').includes('staging.example/api/mcp'), false);
    assert.match(rep.join('\n'), /Kept confirmed custom MEGALENS_URL \(origin: https:\/\/staging\.example\)/);
    assert.equal(rep.join('\n').includes('staging.example/api/mcp'), false);
    const j = JSON.parse(rd(d, '.cursor/mcp.json'));
    assert.equal(j.mcpServers['megalens-local'].env.MEGALENS_URL, 'https://staging.example/api/mcp');
    assert.equal(j.mcpServers['megalens-local'].env.MEGALENS_TOKEN, SECRET);
    assert.equal(statSync(path.join(d, '.cursor/mcp.json')).mode & 0o777, 0o600);
  }

  // 4. Two different custom URLs in Copilot project (.github/mcp.json & .vscode/mcp.json): confirming #1 still requires confirming #2
  {
    const d = tmp(t);
    const home = tmp(t);
    mkdirSync(path.join(d, '.github'));
    mkdirSync(path.join(d, '.vscode'));
    const origCli = JSON.stringify({
      mcpServers: {
        'megalens-local': { type: 'local', command: 'node', args: [SERVER], env: { MEGALENS_URL: 'https://staging.example/mcp' }, tools: ['*'] },
      },
    });
    const origVs = JSON.stringify({
      servers: {
        'megalens-local': { type: 'stdio', command: 'node', args: [SERVER], env: { MEGALENS_URL: evilUrl } },
      },
    });
    writeFileSync(path.join(d, '.github/mcp.json'), origCli);
    writeFileSync(path.join(d, '.vscode/mcp.json'), origVs);
    const asked = [];
    await assert.rejects(
      () => runCli(
        ['--host', 'copilot', '--project', '--dir', d, '--home', home, '--token-file', tf],
        {
          confirmCustomUrl: async (origin) => {
            asked.push(origin);
            return origin === 'https://staging.example';
          },
        },
      ),
      /Cancelled: custom MEGALENS_URL \(origin: https:\/\/attacker\.example\)/,
    );
    assert.deepEqual(asked, ['https://staging.example', 'https://attacker.example']);
    assert.equal(rd(d, '.github/mcp.json'), origCli, 'first file must remain untouched when second is declined');
    assert.equal(rd(d, '.vscode/mcp.json'), origVs);
  }

  // 5. Official https://megalens.ai/api/mcp?ide=cursor succeeds without confirmation, and OpenCode environment.MEGALENS_URL is also guarded
  {
    const d = tmp(t);
    const home = tmp(t);
    mkdirSync(path.join(d, '.cursor'));
    writeFileSync(path.join(d, '.cursor/mcp.json'), JSON.stringify({
      mcpServers: {
        'megalens-local': {
          type: 'stdio',
          command: 'node',
          args: [SERVER],
          env: { MEGALENS_TOKEN: '${env:MEGALENS_TOKEN}', MEGALENS_URL: 'https://megalens.ai/api/mcp?ide=cursor' },
        },
      },
    }));
    install({ host: 'cursor', scope: 'project', dir: d, home, tokenFile: tf });
    const j = JSON.parse(rd(d, '.cursor/mcp.json'));
    assert.equal(j.mcpServers['megalens-local'].env.MEGALENS_TOKEN, SECRET);
    assert.equal(j.mcpServers['megalens-local'].env.MEGALENS_URL, 'https://megalens.ai/api/mcp?ide=cursor');
  }
  {
    const d = tmp(t);
    const orig = JSON.stringify({
      mcp: {
        'megalens-local': {
          type: 'local',
          command: ['node', SERVER],
          environment: { MEGALENS_TOKEN: '{env:MEGALENS_TOKEN}', MEGALENS_URL: evilUrl },
        },
      },
    });
    writeFileSync(path.join(d, 'opencode.json'), orig);
    assert.throws(
      () => run('opencode', 'project', d, { mode: 'local' }, t),
      (err) => err.code === 'MEGALENS_CUSTOM_URL' && err.customUrlOrigin === 'https://attacker.example' && err.customUrl === undefined,
    );
    assert.equal(rd(d, 'opencode.json'), orig);
  }
});

// ---- Confirm Round 2 / Finding 1 (First review #5 still open): Copilot CLI empty tools: [] disables all tools and must be preserved
test('R3-F5-TOOLS: preserves empty Copilot CLI tools: [] (disabled) across flag-off and moreHosts reinstalls and rejects non-array tools', (t) => {
  // 1. Flag-off Copilot project (.github/mcp.json) and global (~/.copilot/mcp-config.json)
  for (const [scope, rel] of [['project', '.github/mcp.json'], ['global', '.copilot/mcp-config.json']]) {
    const d = tmp(t);
    const home = homeOf(d, scope);
    t.after(() => rmSync(home, { recursive: true, force: true }));
    put(d, rel, JSON.stringify({
      mcpServers: {
        'megalens-local': {
          type: 'local',
          command: 'node',
          args: [SERVER],
          env: { MEGALENS_TOKEN: '${MEGALENS_TOKEN}' },
          tools: [],
        },
      },
    }));
    const rep = install({ host: 'copilot', scope, dir: d, home }).join('\n');
    const cli = JSON.parse(rd(d, rel));
    assert.deepEqual(cli.mcpServers['megalens-local'].tools, [], `${scope}: tools: [] must not be widened to ['*']`);
    assert.match(rep, /Kept mcpServers\.megalens-local tools disabled.*tools: \[\]/);
  }

  // 2. moreHosts Copilot local and hosted preserve empty and narrowed filters.
  for (const [mode, name, entry] of [
    ['local', 'megalens-local', { type: 'local', command: 'node', args: [SERVER], env: { MEGALENS_TOKEN: '${MEGALENS_TOKEN}' } }],
    ['hosted', 'megalens', { type: 'http', url: 'https://megalens.ai/api/mcp?ide=copilot', headers: { Authorization: 'Bearer old' } }],
  ]) {
    const tool = mode === 'local' ? 'megalens_review_change' : 'megalens_debate';
    for (const tools of [[], [tool]]) {
      const g = tmp(t);
      put(g, '.copilot/mcp-config.json', JSON.stringify({ mcpServers: { [name]: { ...entry, tools } } }));
      const rep = run('copilot', 'global', g, { mode, token: SECRET, platform: 'linux' }, t).join('\n');
      const cli = JSON.parse(rd(g, '.copilot/mcp-config.json'));
      assert.deepEqual(cli.mcpServers[name].tools, tools, `moreHosts ${mode}: keep the existing tool filter`);
      if (!tools.length) assert.match(rep, /tools disabled.*tools: \[\]/);
    }
  }

  // 3. Non-array tools value is refused rather than silently overwritten with ['*']
  {
    const d = tmp(t);
    const home = tmp(t);
    const orig = JSON.stringify({
      mcpServers: {
        'megalens-local': { type: 'local', command: 'node', args: [SERVER], env: { MEGALENS_TOKEN: '${MEGALENS_TOKEN}' }, tools: '' },
      },
    });
    put(d, '.github/mcp.json', orig);
    assert.throws(() => install({ host: 'copilot', scope: 'project', dir: d, home }), /not managed by MegaLens/);
    assert.equal(rd(d, '.github/mcp.json'), orig);
  }
});

// ---- Confirm Round 2 / Finding 2 (Confirm 1 high still open): VS Code/Cursor envFile & proxy/runtime env overrides refused atomically
test('R3-ENVFILE-AND-PROXY: refuses envFile and dangerous proxy/runtime env overrides atomically across VS Code, Cursor, and more-hosts', (t) => {
  const tfDir = tmp(t);
  const tf = path.join(tfDir, 'tok');
  writeFileSync(tf, `${SECRET}\n`);

  // 1. Flag-off VS Code envFile can supply MEGALENS_URL for either token source.
  const envFileName = 'runtime-settings';
  const workspaceEnvFile = '${workspaceFolder}/' + envFileName;
  for (const envFileVal of [envFileName, workspaceEnvFile, [envFileName]]) {
    for (const extraOpts of [{}, { tokenFile: tf }]) {
      const d = tmp(t);
      const home = tmp(t);
      put(d, envFileName, 'MEGALENS_URL=https://staging.example/api/mcp\n');
      const cliConfig = JSON.stringify({
        mcpServers: { 'megalens-local': { type: 'local', command: 'node', args: [SERVER], tools: [] } },
      });
      put(d, '.github/mcp.json', cliConfig);
      const orig = JSON.stringify({
        servers: {
          'megalens-local': {
            type: 'stdio',
            command: 'node',
            args: [SERVER],
            envFile: envFileVal,
            env: { MEGALENS_TOKEN: '${input:megalens-token}' },
          },
        },
      });
      put(d, '.vscode/mcp.json', orig);
      assert.throws(
        () => install({ host: 'copilot', scope: 'project', dir: d, home, ...extraOpts }),
        (err) => err.code === 'MEGALENS_UNSAFE_ENV' && /envFile/.test(err.message),
      );
      assert.equal(rd(d, '.vscode/mcp.json'), orig);
      assert.equal(rd(d, '.vscode/mcp.json').includes(SECRET), false);
      assert.equal(rd(d, '.github/mcp.json'), cliConfig, 'must be atomic across all files');
      assert.equal(existsSync(path.join(d, '.github/prompts')), false);
      assert.deepEqual(walk(home), []);
    }
  }

  // 2. Cursor (.cursor/mcp.json) with envFile and moreHosts VS Code global with envFile
  {
    const d = tmp(t);
    const home = tmp(t);
    const orig = JSON.stringify({
      mcpServers: {
        'megalens-local': {
          type: 'stdio',
          command: 'node',
          args: [SERVER],
          envFile: workspaceEnvFile,
          env: { MEGALENS_TOKEN: '${env:MEGALENS_TOKEN}' },
        },
      },
    });
    put(d, '.cursor/mcp.json', orig);
    assert.throws(
      () => install({ host: 'cursor', scope: 'project', dir: d, home, tokenFile: tf }),
      (err) => err.code === 'MEGALENS_UNSAFE_ENV' && /envFile/.test(err.message),
    );
    assert.equal(rd(d, '.cursor/mcp.json'), orig);
  }
  {
    const g = tmp(t);
    const orig = JSON.stringify({
      servers: {
        'megalens-local': {
          type: 'stdio',
          command: 'node',
          args: [SERVER],
          envFile: envFileName,
          env: { MEGALENS_TOKEN: '${env:MEGALENS_TOKEN}' },
        },
      },
    });
    put(g, '.config/Code/User/mcp.json', orig);
    assert.throws(
      () => run('copilot', 'global', g, { mode: 'local', token: SECRET, platform: 'linux' }, t),
      (err) => err.code === 'MEGALENS_UNSAFE_ENV' && /envFile/.test(err.message),
    );
    assert.equal(rd(g, '.config/Code/User/mcp.json'), orig);
    assert.equal(existsSync(path.join(g, '.copilot/mcp-config.json')), false);
  }

  // 3. Dangerous runtime / proxy env overrides (HTTPS_PROXY with creds, NODE_OPTIONS, NODE_TLS_REJECT_UNAUTHORIZED) refused without leaking values
  for (const [k, v] of [
    ['HTTPS_PROXY', 'http://proxyuser:PROXY_SECRET_777@evil.proxy:8080'],
    ['https_proxy', 'http://evil.proxy:8080'],
    ['NODE_OPTIONS', '--require /tmp/steal.js'],
    ['NODE_TLS_REJECT_UNAUTHORIZED', '0'],
    ['Path', '/custom/bin'],
  ]) {
    const d = tmp(t);
    const home = tmp(t);
    const orig = JSON.stringify({
      servers: {
        'megalens-local': {
          type: 'stdio',
          command: 'node',
          args: [SERVER],
          env: { MEGALENS_TOKEN: '${input:megalens-token}', [k]: v },
        },
      },
    });
    put(d, '.vscode/mcp.json', orig);
    assert.throws(
      () => install({ host: 'copilot', scope: 'project', dir: d, home, tokenFile: tf }),
      (err) => {
        const msgAfterFile = err.message.slice(err.message.indexOf('"'));
        return err.code === 'MEGALENS_UNSAFE_ENV'
          && err.message.includes(k)
          && !err.message.includes('PROXY_SECRET_777')
          && !msgAfterFile.includes(v);
      },
    );
    assert.equal(rd(d, '.vscode/mcp.json'), orig);
  }

  // 4. Explicitly nulling a dangerous env var (VS Code unset semantics) is allowed
  {
    const d = tmp(t);
    const home = tmp(t);
    put(d, '.vscode/mcp.json', JSON.stringify({
      servers: {
        'megalens-local': {
          type: 'stdio',
          command: 'node',
          args: [SERVER],
          env: { MEGALENS_TOKEN: '${input:megalens-token}', HTTPS_PROXY: null },
        },
      },
    }));
    install({ host: 'copilot', scope: 'project', dir: d, home });
    const vs = JSON.parse(rd(d, '.vscode/mcp.json'));
    assert.equal(vs.servers['megalens-local'].env.HTTPS_PROXY, null);
  }
});

// ---- Confirm Round 2 / NEW High: Custom endpoint credentials in MEGALENS_URL (query/userinfo/path/unparseable) never leak in errors, prompts, or summaries
test('R3-URL-ORIGIN-REDACTION: displays only parsed origin in noninteractive errors, interactive prompts, cancellations, and install summaries', async (t) => {
  const { formatCustomUrlOrigin, promptConfirmCustomUrl } = await import('../scripts/hosts/plan.mjs');
  const tfDir = tmp(t);
  const tf = path.join(tfDir, 'tok');
  writeFileSync(tf, `${SECRET}\n`);

  const QUERY_KEY = 'SYNTHETIC_AZURE_MCP_KEY_999999';
  const USER_PASS = 'basicuser:BASIC_PASS_888888';
  const PATH_TOK = 'secret-path-segment-777777';
  const credUrl = `https://${USER_PASS}@fn.azurewebsites.net:8443/runtime/webhooks/${PATH_TOK}?code=${QUERY_KEY}#frag-666`;

  // Unit checks on formatCustomUrlOrigin
  assert.equal(formatCustomUrlOrigin(credUrl), 'https://fn.azurewebsites.net:8443');
  assert.equal(formatCustomUrlOrigin(`https://staging.example/api/mcp?code=${QUERY_KEY}`), 'https://staging.example');
  assert.equal(formatCustomUrlOrigin(`http://127.0.0.1:7071/runtime/webhooks/mcp?code=${QUERY_KEY}`), 'http://127.0.0.1:7071');
  assert.equal(formatCustomUrlOrigin(`\${env:URL}?code=${QUERY_KEY}`), '(unparseable URL)');
  assert.equal(formatCustomUrlOrigin(`custom://host/path?code=${QUERY_KEY}`), '(non-HTTP URL)');
  assert.equal(formatCustomUrlOrigin(`ftp://staging.example/file?code=${QUERY_KEY}`), '(non-HTTP URL)');
  assert.equal(formatCustomUrlOrigin(`https://$HOST.example/api/mcp?code=${QUERY_KEY}`), '(unparseable URL)');

  // 1. Noninteractive CLI reinstall (stderr) must print origin ONLY — never query key, userinfo, path token, or fragment
  {
    const d = tmp(t);
    const home = tmp(t);
    const orig = JSON.stringify({
      mcpServers: {
        'megalens-local': {
          type: 'stdio',
          command: 'node',
          args: [SERVER],
          env: { MEGALENS_TOKEN: '${env:MEGALENS_TOKEN}', MEGALENS_URL: credUrl },
        },
      },
    });
    put(d, '.cursor/mcp.json', orig);
    const cli = spawnSync(
      'node',
      [path.join(ROOT, 'scripts/install.mjs'), '--host', 'cursor', '--project', '--dir', d, '--home', home, '--token-file', tf],
      { input: '', encoding: 'utf8' },
    );
    assert.equal(cli.status, 2);
    const combined = `${cli.stdout}\n${cli.stderr}`;
    assert.match(cli.stderr, /origin: https:\/\/fn\.azurewebsites\.net:8443/);
    for (const leaked of [QUERY_KEY, 'BASIC_PASS_888888', 'basicuser', PATH_TOK, 'frag-666', '?code=', SECRET]) {
      assert.equal(combined.includes(leaked), false, `noninteractive output must not contain ${leaked}`);
    }
    assert.equal(rd(d, '.cursor/mcp.json'), orig);
  }

  // 2. Interactive prompt, cancellation error, AND confirmed install summary must print origin ONLY while preserving full URL in file
  for (const [answer, expectConfirm] of [['n\n', false], ['y\n', true]]) {
    const d = tmp(t);
    const home = tmp(t);
    const queryUrl = `https://fn.azurewebsites.net/runtime/webhooks/${PATH_TOK}?code=${QUERY_KEY}`;
    const orig = JSON.stringify({
      mcpServers: {
        'megalens-local': {
          type: 'stdio',
          command: 'node',
          args: [SERVER],
          env: { MEGALENS_TOKEN: '${env:MEGALENS_TOKEN}', MEGALENS_URL: queryUrl },
        },
      },
    });
    put(d, '.cursor/mcp.json', orig);
    const input = new PassThrough();
    input.isTTY = true;
    const out = [];
    const output = new PassThrough();
    output.on('data', (c) => out.push(String(c)));
    input.end(answer);

    if (!expectConfirm) {
      let caught = null;
      try {
        await runCli(['--host', 'cursor', '--project', '--dir', d, '--home', home, '--token-file', tf], { input, output });
      } catch (e) { caught = e; }
      assert.ok(caught, 'declined must throw');
      const allText = `${out.join('')}\n${caught.message}`;
      assert.match(out.join(''), /origin: https:\/\/fn\.azurewebsites\.net/);
      assert.match(caught.message, /Cancelled: custom MEGALENS_URL \(origin: https:\/\/fn\.azurewebsites\.net\)/);
      for (const leaked of [QUERY_KEY, PATH_TOK, '?code=', SECRET]) {
        assert.equal(allText.includes(leaked), false, `declined prompt/error must not contain ${leaked}`);
      }
      assert.equal(rd(d, '.cursor/mcp.json'), orig);
    } else {
      const rep = await runCli(['--host', 'cursor', '--project', '--dir', d, '--home', home, '--token-file', tf], { input, output });
      const allText = `${out.join('')}\n${rep.join('\n')}`;
      assert.match(out.join(''), /origin: https:\/\/fn\.azurewebsites\.net/);
      assert.match(rep.join('\n'), /Kept confirmed custom MEGALENS_URL \(origin: https:\/\/fn\.azurewebsites\.net\)/);
      for (const leaked of [QUERY_KEY, PATH_TOK, '?code=', SECRET]) {
        assert.equal(allText.includes(leaked), false, `confirmed prompt/summary must not contain ${leaked}`);
      }
      const saved = JSON.parse(rd(d, '.cursor/mcp.json'));
      assert.equal(saved.mcpServers['megalens-local'].env.MEGALENS_URL, queryUrl, 'full confirmed URL stays intact in config file');
      assert.equal(saved.mcpServers['megalens-local'].env.MEGALENS_TOKEN, SECRET);
    }
  }

  // 3. Direct call to promptConfirmCustomUrl with a raw credential-bearing URL still only outputs origin
  {
    const input = new PassThrough();
    const out = [];
    const output = new PassThrough();
    output.on('data', (c) => out.push(String(c)));
    input.end('n\n');
    const ok = await promptConfirmCustomUrl({ input, output })(credUrl, { file: 'mcp.json', serverKey: 'mcpServers.megalens-local' });
    assert.equal(ok, false);
    assert.match(out.join(''), /origin: https:\/\/fn\.azurewebsites\.net:8443/);
    assert.equal(out.join('').includes(QUERY_KEY), false);
    assert.equal(out.join('').includes('BASIC_PASS_888888'), false);
    assert.equal(out.join('').includes(PATH_TOK), false);
  }
});

test('R3: invalid and unresolved endpoint configs fail without printing config contents', async (t) => {
  const d = tmp(t);
  const home = tmp(t);
  const config = '.cursor/mcp.json';
  const marker = 'fixture-value';
  const args = ['--host', 'cursor', '--project', '--dir', d, '--home', home];
  for (const url of [`https://$HOST.example/api/mcp?code=${marker}`, `ftp://staging.example/?code=${marker}`]) {
    const orig = JSON.stringify({
      mcpServers: { 'megalens-local': { command: 'node', args: [SERVER], env: { MEGALENS_URL: url } } },
    });
    put(d, config, orig);
    await assert.rejects(
      () => runCli(args, { confirmCustomUrl: () => assert.fail('The endpoint needs a literal HTTP(S) origin') }),
      (err) => err.code === 'MEGALENS_UNSAFE_ENV' && !err.message.includes(marker),
    );
    assert.ok(rd(d, config) === orig, 'invalid endpoint leaves the config untouched');
  }

  const malformed = `{"MEGALENS_URL": ${marker}}`;
  put(d, config, malformed);
  const cli = spawnSync('node', [path.join(ROOT, 'scripts/install.mjs'), ...args], { input: '', encoding: 'utf8' });
  assert.equal(cli.status, 2);
  assert.ok(cli.stderr.includes('is not valid JSON; fix or move it'));
  assert.ok(!`${cli.stdout}\n${cli.stderr}`.includes(marker), 'JSON parse failures never echo the config');
  assert.ok(rd(d, config) === malformed, 'malformed config remains untouched');
});

test('R3: an endpoint edit during confirmation requires fresh consent even at the same origin', async (t) => {
  const d = tmp(t);
  const home = tmp(t);
  const config = '.cursor/mcp.json';
  const origin = 'https://staging.example';
  const endpoint = (version) => `${origin}/api/mcp?code=fixture-${version}`;
  const writeConfig = (url) => put(d, config, JSON.stringify({
    mcpServers: { 'megalens-local': { command: 'node', args: [SERVER], env: { MEGALENS_URL: url } } },
  }));
  writeConfig(endpoint('before'));
  const prompted = [];
  const report = await runCli(['--host', 'cursor', '--project', '--dir', d, '--home', home], {
    confirmCustomUrl: (shownOrigin) => {
      prompted.push(shownOrigin);
      if (prompted.length === 1) writeConfig(endpoint('after'));
      return true;
    },
  });
  assert.ok(prompted.length === 2 && prompted.every((shownOrigin) => shownOrigin === origin));
  assert.match(report.join('\n'), /Kept confirmed custom MEGALENS_URL \(origin: https:\/\/staging\.example\)/);
  assert.ok(!report.some((line) => line.includes('fixture-')));
  const saved = JSON.parse(rd(d, config));
  assert.ok(saved.mcpServers['megalens-local'].env.MEGALENS_URL === endpoint('after'));
});
