#!/usr/bin/env node
// MegaLens Cursor plugin CLI (cross-platform: Windows, macOS, Linux; self-contained inside cursor/).
//   cursor-cli.mjs review [standard|deep] --allow-gateway [--pr NUMBER | --base REF --head REF] [--wait]
//   cursor-cli.mjs status [gh:<id>]
//   cursor-cli.mjs result [gh:<id>]         (alias: latest)
//   cursor-cli.mjs fix-prompt [<n>|<id>|--all] [--id gh:<id>] [--from-file FILE] [--copy]
//   cursor-cli.mjs login [--status|--logout]
//   cursor-cli.mjs deeplink [--local]
//   cursor-cli.mjs install [--local-plugin|--project|--global] [--dir DIR] [--home DIR] [--dry-run]
// Never prints secrets or tokens. Never writes OAuth tokens to plaintext files.

import { existsSync, mkdirSync, readFileSync, lstatSync, chmodSync, openSync, writeSync, fchmodSync, closeSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTION_GATEWAY_NOTICE,
  cursorFixPrompt,
  cursorLatestResult,
  cursorReview,
  cursorSignInStatus,
  cursorStateDir,
  cursorStatus,
} from './lib/cursor-commands.mjs';
import { browserSignIn, clearAuthRecord, createOsSecretStore } from './lib/browser-auth.mjs';
import { DEFAULT_REMOTE_MCP_URL, megalensRemoteDeeplink, megalensRunnerDeeplink } from './lib/cursor-deeplink.mjs';
import { scrub } from './lib/engine-core.mjs';
import { realExec } from './lib/gh-runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const MCP_SERVER_PATH = path.join(HERE, 'cursor-mcp-server.mjs');

export function parseCursorCliArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') return { cmd: 'help' };
  const val = (i, flag) => {
    const v = rest[i];
    if (v === undefined || v === '' || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };

  if (cmd === 'review') {
    const o = { cmd: 'review', tier: 'standard', pr: null, base: null, head: null, allowGateway: false, wait: false };
    let tierSeen = false;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === 'standard' || a === 'deep' || a === 'double') {
        if (tierSeen) throw new Error('give one tier only');
        o.tier = a;
        tierSeen = true;
      } else if (a === '--pr') o.pr = val(++i, a);
      else if (a === '--base') o.base = val(++i, a);
      else if (a === '--head') o.head = val(++i, a);
      else if (a === '--allow-gateway') o.allowGateway = true;
      else if (a === '--wait') o.wait = true;
      else throw new Error(`unknown argument: ${String(a).slice(0, 40)}`);
    }
    return o;
  }

  if (cmd === 'status' || cmd === 'result' || cmd === 'latest') {
    if (rest.length > 1) throw new Error(`${cmd} takes at most one review id (gh:<id>)`);
    return { cmd: cmd === 'latest' ? 'result' : cmd, id: rest[0] || null };
  }

  if (cmd === 'fix-prompt') {
    const o = { cmd: 'fix-prompt', selector: null, all: false, id: null, fromFile: null, copy: false };
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--all') o.all = true;
      else if (a === '--copy') o.copy = true;
      else if (a === '--id') o.id = val(++i, a);
      else if (a === '--from-file') o.fromFile = val(++i, a);
      else if (a.startsWith('--')) throw new Error(`unknown option: ${String(a).slice(0, 40)}`);
      else if (o.selector === null) o.selector = a;
      else throw new Error('give one finding number/id only (or --all)');
    }
    return o;
  }

  if (cmd === 'login') {
    const o = { cmd: 'login', statusOnly: false, logout: false };
    for (const a of rest) {
      if (a === '--status') o.statusOnly = true;
      else if (a === '--logout') o.logout = true;
      else throw new Error(`unknown option: ${String(a).slice(0, 40)}`);
    }
    return o;
  }

  if (cmd === 'deeplink') {
    let local = false;
    for (const a of rest) {
      if (a === '--local') local = true;
      else throw new Error(`unknown option: ${String(a).slice(0, 40)}`);
    }
    return { cmd: 'deeplink', local };
  }

  if (cmd === 'install') {
    const o = { cmd: 'install', scope: 'project', dir: '', home: '', dryRun: false };
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--project') o.scope = 'project';
      else if (a === '--global') o.scope = 'global';
      else if (a === '--local-plugin') o.scope = 'local-plugin';
      else if (a === '--dir') o.dir = val(++i, a);
      else if (a === '--home') o.home = val(++i, a);
      else if (a === '--dry-run') o.dryRun = true;
      else throw new Error(`unknown option: ${String(a).slice(0, 40)}`);
    }
    return o;
  }

  throw new Error(`unknown command: ${String(cmd).slice(0, 40)}`);
}

function makeSafeWriter(root, homeDir, dryRun) {
  const backupRoot = path.join(homeDir, '.megalens', 'backups', 'cursor-plugin');
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
  const backupDir = path.join(backupRoot, stamp);
  const ops = [];
  const report = [];

  const checkPath = (file) => {
    const rel = path.relative(root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${file} is outside ${root}; nothing was changed.`);
    let cur = root; let st = null;
    for (const part of rel.split(path.sep)) {
      cur = path.join(cur, part); st = null;
      try { st = lstatSync(cur); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
      if (st.isSymbolicLink()) throw new Error(`${cur} is a symbolic link; refusing to write through it. Nothing was changed.`);
    }
    if (st && !st.isFile()) throw new Error(`${file} is not a regular file; nothing was changed.`);
    return st;
  };

  const queue = (file, content) => {
    const st = checkPath(file);
    const old = st ? readFileSync(file, 'utf8') : null;
    if (old === content) { report.push(`unchanged  ${file}`); return; }
    ops.push({ file, content, st, old });
  };

  const flush = () => {
    for (const { file, content, st, old } of ops) {
      let backup = '';
      if (st) {
        backup = path.join(backupDir, file.split(path.sep).filter(Boolean).join('__'));
        if (!dryRun) {
          mkdirSync(backupDir, { recursive: true, mode: 0o700 });
          try { chmodSync(backupDir, 0o700); } catch {}
          const fd = openSync(backup, 'wx', 0o600);
          try { writeSync(fd, old); } finally { closeSync(fd); }
        }
      }
      if (!dryRun) {
        mkdirSync(path.dirname(file), { recursive: true });
        const mode = st ? st.mode & 0o777 : 0o644;
        const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
        const fd = openSync(tmp, 'wx', mode);
        try { fchmodSync(fd, mode); writeSync(fd, content); } catch (e) { closeSync(fd); try { unlinkSync(tmp); } catch {} throw e; }
        closeSync(fd);
        renameSync(tmp, file);
      }
      report.push(`${dryRun ? 'would ' : ''}${st ? 'updated  ' : 'created  '} ${file}${backup ? `\n           backup (owner-only, outside repo): ${backup}` : ''}`);
    }
  };

  return { checkPath, queue, flush, report };
}

function walkPluginFiles(baseDir, relDir = '') {
  const out = [];
  const fullDir = relDir ? path.join(baseDir, relDir) : baseDir;
  for (const entry of readdirSync(fullDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const rel = relDir ? path.join(relDir, entry.name) : entry.name;
    const abs = path.join(baseDir, rel);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) throw new Error(`Refusing to copy symbolic link in plugin source: ${abs}`);
    if (st.isDirectory()) out.push(...walkPluginFiles(baseDir, rel));
    else if (st.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Full pre-marketplace Cursor local plugin install: copies the entire self-contained `cursor/` plugin package
 * directly into `~/.cursor/plugins/local/megalens` (no symlinks, atomic writes, backs up existing files outside repo).
 */
export function installCursorLocalPlugin({ home = homedir(), dryRun = false, pluginRoot = PLUGIN_ROOT } = {}) {
  const homeDir = path.resolve(home);
  const destRoot = path.join(homeDir, '.cursor', 'plugins', 'local', 'megalens');
  const writer = makeSafeWriter(homeDir, homeDir, dryRun);

  const relFiles = walkPluginFiles(pluginRoot);
  for (const rel of relFiles) {
    const src = path.join(pluginRoot, rel);
    const dst = path.join(destRoot, rel);
    writer.queue(dst, readFileSync(src, 'utf8'));
  }
  writer.flush();
  writer.report.push(
    `Installed full MegaLens Cursor plugin into ${destRoot}. Restart Cursor (or run Developer: Reload Window). Run /megalens-login in Agent chat for repository setup, then run /megalens-review.`,
  );
  return writer.report;
}

/**
 * Standalone project/global install: merges `.cursor/mcp.json` (OAuth remote + local GitHub runner) + commands + rule.
 * Refuses symlinks, backs up overwritten files outside the repo with mode 0600, writes zero secrets.
 */
export function installCursorStandalone({ scope = 'project', dir = process.cwd(), home = homedir(), dryRun = false } = {}) {
  if (scope === 'local-plugin') {
    return installCursorLocalPlugin({ home, dryRun });
  }
  const project = path.resolve(dir);
  const homeDir = path.resolve(home);
  const root = scope === 'global' ? homeDir : project;
  const writer = makeSafeWriter(root, homeDir, dryRun);

  // 1. Merge into .cursor/mcp.json (or ~/.cursor/mcp.json)
  const mcpPath = path.join(root, '.cursor', 'mcp.json');
  const mcpStat = writer.checkPath(mcpPath);
  let mcpJson = {};
  if (mcpStat) {
    const raw = readFileSync(mcpPath, 'utf8').trim();
    if (raw) {
      try { mcpJson = JSON.parse(raw); } catch (e) { throw new Error(`${mcpPath} is not valid JSON (${e.message}); nothing was changed.`); }
    }
  }
  if (!mcpJson || typeof mcpJson !== 'object' || Array.isArray(mcpJson)) throw new Error(`${mcpPath} must contain a JSON object.`);
  if (mcpJson.mcpServers === undefined || mcpJson.mcpServers === null) mcpJson.mcpServers = {};
  if (typeof mcpJson.mcpServers !== 'object' || Array.isArray(mcpJson.mcpServers)) throw new Error(`${mcpPath}: "mcpServers" must be a JSON object.`);

  mcpJson.mcpServers.megalens = { url: DEFAULT_REMOTE_MCP_URL };
  mcpJson.mcpServers['megalens-runner'] = {
    type: 'stdio',
    command: 'node',
    args: [MCP_SERVER_PATH],
    ...(scope === 'project' ? { env: { MEGALENS_PROJECT_DIR: '${workspaceFolder}' } } : {}),
  };
  writer.queue(mcpPath, JSON.stringify(mcpJson, null, 2) + '\n');

  // 2. Copy Cursor command files from commands/ into .cursor/commands/
  const srcCmdDir = path.join(PLUGIN_ROOT, 'commands');
  if (existsSync(srcCmdDir)) {
    for (const name of readdirSync(srcCmdDir).filter((n) => n.endsWith('.md')).sort()) {
      writer.queue(path.join(root, '.cursor', 'commands', name), readFileSync(path.join(srcCmdDir, name), 'utf8'));
    }
  }

  // 3. Copy Cursor rule into .cursor/rules/ (project scope)
  const srcRule = path.join(PLUGIN_ROOT, 'rules', 'megalens.mdc');
  if (scope === 'project' && existsSync(srcRule)) {
    writer.queue(path.join(root, '.cursor', 'rules', 'megalens.mdc'), readFileSync(srcRule, 'utf8'));
  }

  writer.flush();
  writer.report.push('Restart Cursor (or run Developer: Reload Window). Run /megalens-login in Agent chat for repository setup, then run /megalens-review.');
  return writer.report;
}

const HELP = `MegaLens for Cursor CLI (GitHub Actions runner path)

Commands:
  review [standard|deep] --allow-gateway [--pr NUMBER | --base REF --head REF] [--wait]
  status [gh:<id>]
  result [gh:<id>]               (alias: latest)
  fix-prompt [<n>|<id>|--all] [--id gh:<id>] [--from-file FILE] [--copy]
  login [--status|--logout]
  deeplink [--local]
  install [--local-plugin|--project|--global] [--dir DIR] [--home DIR] [--dry-run]

Privacy for reviews: ${ACTION_GATEWAY_NOTICE}
`;

export async function runCursorCli(
  argv,
  {
    env = process.env,
    cwd = process.cwd(),
    out = (s) => process.stdout.write(s),
    exec = realExec,
    stateDir = cursorStateDir(),
    secretStore = createOsSecretStore(),
    signInFn = browserSignIn,
    copyFn,
    runnerTiming,
  } = {},
) {
  let parsed;
  try {
    parsed = parseCursorCliArgs(argv);
  } catch (e) {
    out(`${e.message}\n\n${HELP}`);
    return 4;
  }

  if (parsed.cmd === 'help') {
    out(HELP);
    return 0;
  }

  if (parsed.cmd === 'review') {
    if (parsed.allowGateway) out(`${ACTION_GATEWAY_NOTICE}\n`);
    const r = await cursorReview({
      exec, cwd, env, stateDir, runnerTiming,
      tier: parsed.tier, pr: parsed.pr, base: parsed.base, head: parsed.head,
      allowGateway: parsed.allowGateway, wait: parsed.wait,
    });
    out(r.text);
    return r.code;
  }

  if (parsed.cmd === 'status') {
    const r = await cursorStatus({ exec, cwd, env, id: parsed.id, stateDir });
    out(r.text);
    return r.code;
  }

  if (parsed.cmd === 'result') {
    const r = await cursorLatestResult({ exec, cwd, env, id: parsed.id, stateDir });
    out(r.text);
    return r.code;
  }

  if (parsed.cmd === 'fix-prompt') {
    const r = await cursorFixPrompt({
      exec,
      cwd,
      env,
      selector: parsed.selector,
      all: parsed.all,
      id: parsed.id,
      fromFile: parsed.fromFile,
      copy: parsed.copy,
      stateDir,
      ...(copyFn ? { copyFn } : {}),
    });
    out(r.text);
    return r.code;
  }

  if (parsed.cmd === 'login') {
    if (parsed.logout) {
      await clearAuthRecord(secretStore);
      out('Signed out of local CLI MegaLens browser OAuth session in OS credential store.\n');
      return 0;
    }
    if (parsed.statusOnly) {
      const r = await cursorSignInStatus({ exec, cwd, env, secretStore });
      out(r.text);
      return r.code;
    }
    try {
      const res = await signInFn({
        secretStore,
        onAuthorizeUrl: (u) => out(`Opening MegaLens browser sign-in...\nIf your browser did not open, visit:\n${u}\n`),
      });
      out(`Signed in to MegaLens hosted MCP (${res.issuer}) via browser OAuth. Your session is stored in ${res.backend}.\n`);
      const st = await cursorSignInStatus({ exec, cwd, env, secretStore });
      out(st.text);
      return 0;
    } catch (e) {
      out(`MegaLens browser sign-in failed: ${scrub(e.message, env)}\n`);
      return 4;
    }
  }

  if (parsed.cmd === 'deeplink') {
    out(`Hosted MegaLens MCP server sign-in link (hosted OAuth MCP server ONLY — does not install commands, rule, skill, or local runner):\n${megalensRemoteDeeplink()}\n`);
    if (parsed.local) {
      out(`\nLocal GitHub-runner MCP server link (single MCP server ONLY, pointing at this checkout; use \`install --local-plugin\` for the full plugin):\n${megalensRunnerDeeplink(MCP_SERVER_PATH)}\n`);
    }
    return 0;
  }

  if (parsed.cmd === 'install') {
    try {
      const lines = installCursorStandalone({
        scope: parsed.scope,
        dir: parsed.dir || cwd,
        home: parsed.home || homedir(),
        dryRun: parsed.dryRun,
      });
      out(lines.join('\n') + '\n');
      return 0;
    } catch (e) {
      out(`install failed: ${scrub(e.message, env)}\n`);
      return 4;
    }
  }

  return 4;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await runCursorCli(process.argv.slice(2));
}
