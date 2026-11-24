import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('the distributable Claude plugin runs outside this checkout', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'megalens-claude-package-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marketplace = JSON.parse(readFileSync(path.join(root, '.claude-plugin/marketplace.json'), 'utf8'));
  const plugin = path.join(dir, 'plugin');
  cpSync(path.join(root, marketplace.plugins[0].source), plugin, { recursive: true });
  const config = JSON.parse(readFileSync(path.join(plugin, '.mcp.json'), 'utf8'));
  const nodeScript = config.mcpServers['megalens-local'].args[0].replace('${CLAUDE_PLUGIN_ROOT}', plugin);
  const reply = spawnSync(process.execPath, [nodeScript], {
    cwd: dir,
    input: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n',
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(reply.status, 0, reply.stderr);
  assert.equal(JSON.parse(reply.stdout).result.tools[0].name, 'megalens_review_change');
  const { workflowText } = await import(pathToFileURL(path.join(plugin, 'scripts/lib/gh-runner.mjs')));
  assert.equal(workflowText(), readFileSync(path.join(root, 'templates/megalens-dispatch.yml'), 'utf8'));
});

test('the four preview setup commands can validate a fresh profile without writes or sign in', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'megalens-preview-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [launcher, expected] of [
    ['codex/scripts/setup.mjs', /config\.toml/],
    ['copilot/setup.mjs', /mcp-config\.json/],
    ['opencode/setup.mjs', /opencode\.json/],
    ['antigravity/setup.mjs', /mcp_config\.json/],
  ]) {
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
    const result = spawnSync(process.execPath, [launcher, '--home', dir, '--dry-run'], { cwd: root, encoding: 'utf8', env, timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /would create/);
    assert.match(result.stdout, expected);
    assert.deepEqual(readdirSync(dir), []);
  }
});
