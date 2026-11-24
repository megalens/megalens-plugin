#!/usr/bin/env node
// Installs MegaLens host config for Codex, Cursor and GitHub Copilot (and OpenCode / Antigravity when MORE_HOSTS_ENABLED)
// around the local stdio server (or hosted MCP with browser sign-in).
//   node scripts/install.mjs --host codex|cursor|copilot [--project|--global] [--dir DIR] [--home DIR] [--token-file FILE] [--dry-run]
// Merges into existing files without removing other servers, backs up any file it changes, is idempotent,
// and never writes a token unless --token-file (or --browser-login) is given. Reads/writes only under --dir (project) or --home (global).
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as T from './hosts/text.mjs';
import { Plan, readToken, mergeJsonServer, managedMarkdown, codexToml, promptConfirmCustomUrl, formatCustomUrlOrigin } from './hosts/plan.mjs';
import { MORE_HOSTS_ENABLED, BASE_HOSTS, ALL_HOSTS, resolveHostName, installMoreHost, setupWithBrowserLogin } from './hosts/more-hosts.mjs';

export { MORE_HOSTS_ENABLED };

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-server.mjs');
const NAME = 'megalens-local';

export function parseArgs(argv, flags = {}) {
  const moreHosts = flags.moreHosts ?? MORE_HOSTS_ENABLED;
  const o = { host: '', scope: '', dir: '', home: '', tokenFile: '', dryRun: false };
  if (moreHosts) {
    o.mode = 'local';
    o.browserLogin = false;
    o.allowProjectToken = false;
  }
  const val = (i, flag) => { const v = argv[i]; if (v === undefined || v === '' || v.startsWith('--')) throw new Error(`${flag} needs a value`); return v; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') o.host = val(++i, a);
    else if (a === '--project') o.scope = 'project';
    else if (a === '--global') o.scope = 'global';
    else if (a === '--dir') o.dir = val(++i, a);
    else if (a === '--home') o.home = val(++i, a);
    else if (a === '--token-file') o.tokenFile = val(++i, a);
    else if (a === '--dry-run') o.dryRun = true;
    else if (moreHosts && a === '--mode') {
      const m = val(++i, a);
      if (m !== 'local' && m !== 'hosted') throw new Error('--mode must be local or hosted');
      o.mode = m;
    } else if (moreHosts && a === '--browser-login') {
      o.browserLogin = true;
      o.mode = 'hosted';
    } else if (moreHosts && a === '--allow-project-token') {
      o.allowProjectToken = true;
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (moreHosts) {
    o.host = resolveHostName(o.host);
    if (!ALL_HOSTS.includes(o.host)) throw new Error('--host must be codex, cursor, copilot, opencode or antigravity');
    o.scope = o.scope || ((o.browserLogin || o.tokenFile) ? 'global' : 'project');
    return o;
  }
  if (!BASE_HOSTS.includes(o.host)) throw new Error('--host must be codex, cursor or copilot');
  o.scope = o.scope || 'project';
  return o;
}

export function install(opts) {
  const o = { ...opts };
  const moreHosts = o.moreHosts ?? MORE_HOSTS_ENABLED;
  const host = moreHosts ? resolveHostName(o.host) : o.host;
  const project = path.resolve(o.dir || process.cwd());
  const home = path.resolve(o.home || homedir());
  const root = o.scope === 'global' ? home : project;
  const token = (moreHosts ? o.token : '') || (o.tokenFile ? readToken(o.tokenFile) : '');
  const plan = new Plan({ dryRun: o.dryRun, root, backupRoot: path.join(home, '.megalens', 'backups') });
  const stdio = (envObj) => ({ type: 'stdio', command: 'node', args: [SERVER], env: envObj });
  const workspaceEnv = o.scope === 'project' ? { MEGALENS_PROJECT_DIR: '${workspaceFolder}' } : {};
  const mode = moreHosts ? (o.mode || 'local') : 'local';
  const mergeOpts = { secret: !!token, allowCustomUrl: Boolean(o.allowCustomUrl), confirmedCustomUrls: o.confirmedCustomUrls };

  if (moreHosts && (['opencode', 'antigravity', 'copilot'].includes(host) || mode === 'hosted')) {
    installMoreHost({
      plan,
      host,
      scope: o.scope,
      root,
      home,
      mode,
      token,
      allowProjectToken: Boolean(o.allowProjectToken),
      allowCustomUrl: Boolean(o.allowCustomUrl),
      confirmedCustomUrls: o.confirmedCustomUrls,
      platform: o.platform || process.platform,
      env: o.env || process.env,
      serverPath: SERVER,
    });
  } else if (host === 'codex') {
    codexToml(plan, path.join(root, '.codex', 'config.toml'), NAME, SERVER, token);
    const skillDir = path.join(root, '.agents', 'skills', 'megalens-review');
    plan.write(path.join(skillDir, 'SKILL.md'), T.codexSkill());
    plan.write(path.join(skillDir, 'agents', 'openai.yaml'), T.codexSkillPolicy());
    if (o.scope === 'global') plan.write(path.join(root, '.codex', 'prompts', 'megalens-review.md'), T.codexPrompt()); // older Codex versions
    else managedMarkdown(plan, path.join(root, 'AGENTS.md'), T.agentsSnippet());
    plan.note('Run in Codex: type $megalens-review (or /skills, then pick it). Older Codex: /prompts:megalens-review. Project installs also add an AGENTS.md section. Restart Codex first.');
  } else if (host === 'cursor') {
    const env = { MEGALENS_TOKEN: token || '${env:MEGALENS_TOKEN}', ...workspaceEnv };
    mergeJsonServer(plan, path.join(root, '.cursor', 'mcp.json'), 'mcpServers', NAME, stdio(env), {}, mergeOpts);
    plan.write(path.join(root, '.cursor', 'commands', 'megalens-review.md'), T.cursorCommand());
    if (o.scope === 'project') plan.write(path.join(root, '.cursor', 'rules', 'megalens-review.mdc'), T.cursorRule());
    else plan.note('Global Cursor rules live in Cursor Settings, not in a file; only the /megalens-review command was installed globally. For a global MCP entry Cursor starts the server in its own working folder, so prefer --project.');
    plan.note('Run in Cursor: /megalens-review in Agent chat (or @megalens-review). Cursor asks before the tool runs. Restart Cursor first.');
  } else {
    const ghCli = path.join(root, o.scope === 'global' ? path.join('.copilot', 'mcp-config.json') : path.join('.github', 'mcp.json'));
    const cliServer = { type: 'local', command: 'node', args: [SERVER], env: { MEGALENS_TOKEN: token || '${MEGALENS_TOKEN}' }, tools: ['*'] };
    mergeJsonServer(plan, ghCli, 'mcpServers', NAME, cliServer, {}, mergeOpts);
    if (o.scope === 'project') {
      const inputs = (cur) => {
        const a = Array.isArray(cur) ? cur.filter((x) => x?.id !== 'megalens-token') : [];
        if (!token) a.push({ type: 'promptString', id: 'megalens-token', description: 'MegaLens MCP token (MEGALENS_TOKEN)', password: true });
        return a;
      };
      const env = { MEGALENS_TOKEN: token || '${input:megalens-token}', MEGALENS_PROJECT_DIR: '${workspaceFolder}' };
      mergeJsonServer(plan, path.join(root, '.vscode', 'mcp.json'), 'servers', NAME, stdio(env), { inputs }, mergeOpts);
      plan.write(path.join(root, '.github', 'prompts', 'megalens-review.prompt.md'), T.copilotPrompt());
      plan.note('Run in VS Code: Copilot Chat, Agent mode, type /megalens-review. VS Code asks for the token once and stores it.');
    } else plan.note('Global install covers Copilot CLI only (~/.copilot/mcp-config.json). For VS Code use --project (its user-profile mcp.json path differs per OS).');
    plan.note('Run in Copilot CLI: start copilot in the repo and ask "review my change with MegaLens". Needs MEGALENS_TOKEN exported; if it reaches the server as the text ${MEGALENS_TOKEN}, update the CLI or use --token-file.');
  }
  plan.flush(host);
  plan.report.push(...plan.notes);
  if (token) plan.report.push(`WARNING: the token was written into the files above (mode 600). ${o.scope === 'project' ? 'Add them to .gitignore; never commit them.' : ''}`);
  return plan.report;
}

export async function runCli(argv, { moreHosts = MORE_HOSTS_ENABLED, loginDeps = {}, confirmCustomUrl, input, output } = {}) {
  const o = parseArgs(argv, { moreHosts });
  if (o.browserLogin) {
    return await setupWithBrowserLogin({ ...o, moreHosts }, { installFn: install, ...loginDeps });
  }
  const ioInput = input ?? process.stdin;
  const ioOutput = output ?? process.stderr;
  const confirmedCustomUrls = new Set();
  for (let attempts = 0; attempts < 10; attempts++) {
    try {
      return install({ ...o, moreHosts, confirmedCustomUrls });
    } catch (err) {
      if (err?.code !== 'MEGALENS_CUSTOM_URL') throw err;
      const key = `${err.file}\0${err.customUrlHash}`;
      if (confirmedCustomUrls.has(key)) throw err;
      const confirmFn = confirmCustomUrl || (ioInput?.isTTY ? promptConfirmCustomUrl({ input: ioInput, output: ioOutput }) : null);
      if (!confirmFn) throw err;
      const origin = formatCustomUrlOrigin(err.customUrlOrigin);
      const ok = await confirmFn(origin, { file: err.file, serverKey: err.serverKey });
      if (ok !== true) {
        throw new Error(`Cancelled: custom MEGALENS_URL (origin: ${origin}) in ${err.file} was not confirmed. Nothing was changed.`);
      }
      confirmedCustomUrls.add(key);
    }
  }
  throw new Error('Too many custom MEGALENS_URL prompts; aborting. Nothing was changed.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const lines = await runCli(process.argv.slice(2));
    for (const l of lines) console.log(l);
  } catch (e) {
    const hostList = MORE_HOSTS_ENABLED ? 'codex|cursor|copilot|opencode|antigravity' : 'codex|cursor|copilot';
    console.error(`install: ${e.message}\nusage: node scripts/install.mjs --host ${hostList} [--project|--global] [--dir DIR] [--home DIR] [--token-file FILE] [--dry-run]`);
    process.exit(2);
  }
}
