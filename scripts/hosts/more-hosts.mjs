// Host config writers for Roadmap 13: GitHub Copilot (VS Code Agent Mode & CLI), OpenCode, and Antigravity.
// Flag MORE_HOSTS_ENABLED defaults to false so live installer behaviour stays unchanged until enabled.
import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import * as T from './text.mjs';
import { mergeJsonServer, managedMarkdown, codexToml, writeOwnedFile } from './plan.mjs';
import { deviceLogin, promptConfirmAccount } from '../lib/device-login.mjs';

export const MORE_HOSTS_ENABLED = false;
export const BASE_HOSTS = ['codex', 'cursor', 'copilot'];
export const ALL_HOSTS = ['codex', 'cursor', 'copilot', 'opencode', 'antigravity'];
export const HOST_ALIASES = { agy: 'antigravity', 'vscode-copilot': 'copilot', 'github-copilot': 'copilot' };

export const HOST_DOCS = {
  copilot: {
    mcp: 'https://code.visualstudio.com/docs/copilot/chat/mcp-servers',
    skills: 'https://code.visualstudio.com/docs/agent-customization/migrate-customizations#convert-prompt-files-to-skills',
    instructions: 'https://code.visualstudio.com/docs/copilot/customization/custom-instructions',
    cli: 'https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli',
    extensionsSunset: 'https://github.blog/changelog/2025-09-24-deprecate-github-copilot-extensions-github-apps/',
  },
  opencode: {
    mcp: 'https://opencode.ai/docs/mcp-servers/',
    commands: 'https://opencode.ai/docs/commands/',
    config: 'https://opencode.ai/docs/config/',
    rules: 'https://opencode.ai/docs/rules/',
  },
  antigravity: {
    mcp: 'https://antigravity.google/docs/mcp',
    rules: 'https://antigravity.google/docs/rules',
    skills: 'https://antigravity.google/docs/skills',
    workflows: 'https://antigravity.google/docs/workflows',
  },
};

export function resolveHostName(raw) {
  const key = String(raw || '').trim().toLowerCase();
  return HOST_ALIASES[key] || key;
}

function insideRoot(root, candidate) {
  if (!candidate) return '';
  const abs = path.resolve(candidate);
  const rel = path.relative(root, abs);
  return !rel.startsWith('..') && !path.isAbsolute(rel) ? abs : '';
}

function pathExists(p) {
  try { lstatSync(p); return true; } catch { return false; }
}

function resolveEnvDirOrThrow({ home, envVar, rawValue, fallbackDir, hostLabel, subPath = '' }) {
  if (!rawValue || !String(rawValue).trim()) return subPath ? path.join(fallbackDir, subPath) : fallbackDir;
  const raw = String(rawValue).trim();
  // Per XDG Base Directory spec, relative XDG_CONFIG_HOME values are ignored by compliant hosts.
  if (envVar === 'XDG_CONFIG_HOME' && !path.isAbsolute(raw)) {
    return subPath ? path.join(fallbackDir, subPath) : fallbackDir;
  }
  const abs = path.resolve(raw);
  const effective = subPath ? path.join(abs, subPath) : abs;
  const inside = insideRoot(home, abs);
  if (!inside) {
    const fallbackTarget = subPath ? path.join(fallbackDir, subPath) : fallbackDir;
    throw new Error(
      `${hostLabel} reads ${envVar} (${effective}), which is outside ${home}. Refusing to write an inactive config under ${fallbackTarget}; unset ${envVar}, point it inside ${home}, or update ${effective} directly. Nothing was changed.`,
    );
  }
  return effective;
}

export function vscodeUserMcpPath(home, platform = process.platform, env = process.env) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
  if (platform === 'win32') {
    const appData = resolveEnvDirOrThrow({
      home,
      envVar: 'APPDATA',
      rawValue: env.APPDATA,
      fallbackDir: path.join(home, 'AppData', 'Roaming'),
      hostLabel: 'VS Code',
    });
    return path.join(appData, 'Code', 'User', 'mcp.json');
  }
  const xdg = resolveEnvDirOrThrow({
    home,
    envVar: 'XDG_CONFIG_HOME',
    rawValue: env.XDG_CONFIG_HOME,
    fallbackDir: path.join(home, '.config'),
    hostLabel: 'VS Code',
    subPath: path.join('Code', 'User'),
  });
  return path.join(xdg, 'mcp.json');
}

export function opencodeGlobalDir(home, env = process.env) {
  if (env.OPENCODE_CONFIG_DIR && String(env.OPENCODE_CONFIG_DIR).trim()) {
    return resolveEnvDirOrThrow({
      home,
      envVar: 'OPENCODE_CONFIG_DIR',
      rawValue: env.OPENCODE_CONFIG_DIR,
      fallbackDir: path.join(home, '.config', 'opencode'),
      hostLabel: 'OpenCode',
    });
  }
  return resolveEnvDirOrThrow({
    home,
    envVar: 'XDG_CONFIG_HOME',
    rawValue: env.XDG_CONFIG_HOME,
    fallbackDir: path.join(home, '.config'),
    hostLabel: 'OpenCode',
    subPath: 'opencode',
  });
}

export function copilotCliGlobalPath(home, env = process.env) {
  const ch = resolveEnvDirOrThrow({
    home,
    envVar: 'COPILOT_HOME',
    rawValue: env.COPILOT_HOME,
    fallbackDir: path.join(home, '.copilot'),
    hostLabel: 'Copilot CLI',
  });
  return path.join(ch, 'mcp-config.json');
}

const mcpUrl = (ide) => `https://megalens.ai/api/mcp?ide=${ide}`;

function resolveOpenCodeConfigInDir(dir) {
  // OpenCode gives opencode.jsonc precedence over opencode.json in the same directory.
  const jsonc = path.join(dir, 'opencode.jsonc');
  const json = path.join(dir, 'opencode.json');
  if (pathExists(jsonc)) return jsonc;
  if (pathExists(json)) return json;
  return json;
}

export function resolveOpenCodeProjectConfigFile(root) {
  // OpenCode precedence (highest first): .opencode/opencode.jsonc -> .opencode/opencode.json -> opencode.jsonc -> opencode.json.
  const candidates = [
    path.join(root, '.opencode', 'opencode.jsonc'),
    path.join(root, '.opencode', 'opencode.json'),
    path.join(root, 'opencode.jsonc'),
    path.join(root, 'opencode.json'),
  ];
  for (const c of candidates) {
    if (pathExists(c)) return c;
  }
  return path.join(root, 'opencode.json');
}

export function installMoreHost({
  plan,
  host,
  scope,
  root,
  home,
  mode = 'local',
  token = '',
  allowProjectToken = false,
  allowCustomUrl = false,
  confirmedCustomUrls = null,
  platform = process.platform,
  env = process.env,
  serverPath,
}) {
  if (scope === 'project' && token && !allowProjectToken) {
    throw new Error(
      'Refusing to write a literal token into a project folder (it could be committed). Use --global, omit --token-file to use env/input references, or pass --allow-project-token if this folder is private.',
    );
  }
  const isHosted = mode === 'hosted';
  const serverName = isHosted ? 'megalens' : 'megalens-local';
  const collectPath = path.join(path.dirname(serverPath), 'collect.mjs');
  const textOpts = { collectPath };
  const mergeOpts = { secret: !!token, allowCustomUrl, confirmedCustomUrls };
  const stdio = (envObj) => ({ type: 'stdio', command: 'node', args: [serverPath], env: envObj });

  if (host === 'copilot') {
    const cliFile = scope === 'global'
      ? copilotCliGlobalPath(home, env)
      : path.join(root, '.github', 'mcp.json');
    const cliEntry = isHosted
      ? { type: 'http', url: mcpUrl('copilot'), headers: { Authorization: `Bearer ${token || '${MEGALENS_TOKEN}'}` }, tools: ['*'] }
      : { type: 'local', command: 'node', args: [serverPath], env: { MEGALENS_TOKEN: token || '${MEGALENS_TOKEN}', MEGALENS_URL: mcpUrl('copilot') }, tools: ['*'] };
    mergeJsonServer(plan, cliFile, 'mcpServers', serverName, cliEntry, {}, mergeOpts);

    if (scope === 'project') {
      const inputs = (cur) => {
        const a = Array.isArray(cur) ? cur.filter((x) => x?.id !== 'megalens-token') : [];
        if (!token) a.push({ type: 'promptString', id: 'megalens-token', description: 'MegaLens MCP token (MEGALENS_TOKEN)', password: true });
        return a;
      };
      const tokRef = token || '${input:megalens-token}';
      const vsEntry = isHosted
        ? { type: 'http', url: mcpUrl('copilot'), headers: { Authorization: `Bearer ${tokRef}` } }
        : stdio({ MEGALENS_TOKEN: tokRef, MEGALENS_PROJECT_DIR: '${workspaceFolder}', MEGALENS_URL: mcpUrl('copilot') });
      mergeJsonServer(plan, path.join(root, '.vscode', 'mcp.json'), 'servers', serverName, vsEntry, { inputs }, mergeOpts);
      writeOwnedFile(plan, path.join(root, '.github', 'skills', 'megalens-review', 'SKILL.md'), T.copilotSkill(mode, textOpts));
      managedMarkdown(plan, path.join(root, '.github', 'copilot-instructions.md'), T.copilotInstructionsSnippet(mode, textOpts));
      plan.note('Run in VS Code Copilot Chat (Agent mode) or Copilot CLI: ask "review my changes with MegaLens".');
    } else {
      const vsUserFile = vscodeUserMcpPath(home, platform, env);
      const tokRef = token || '${env:MEGALENS_TOKEN}';
      const vsUserEntry = isHosted
        ? { type: 'http', url: mcpUrl('copilot'), headers: { Authorization: `Bearer ${tokRef}` } }
        : stdio({ MEGALENS_TOKEN: tokRef, MEGALENS_URL: mcpUrl('copilot') });
      mergeJsonServer(plan, vsUserFile, 'servers', serverName, vsUserEntry, {}, mergeOpts);
      const cliDir = path.dirname(cliFile);
      writeOwnedFile(plan, path.join(cliDir, 'skills', 'megalens-review', 'SKILL.md'), T.copilotSkill(mode, textOpts));
      managedMarkdown(plan, path.join(cliDir, 'copilot-instructions.md'), T.copilotInstructionsSnippet(mode, textOpts));
      plan.note(`Configured Copilot CLI (${cliFile}), skill (${path.join(cliDir, 'skills', 'megalens-review', 'SKILL.md')}), and VS Code user MCP (${vsUserFile}). Restart VS Code / Copilot CLI, then ask "review my changes with MegaLens".`);
    }
    plan.note('Note: server-side GitHub App Copilot Extensions were sunset on 2025-11-10 in favor of MCP.');
    return;
  }

  if (host === 'opencode') {
    let ocDir;
    let configFile;
    if (scope === 'global') {
      ocDir = opencodeGlobalDir(home, env);
      if (env.OPENCODE_CONFIG && String(env.OPENCODE_CONFIG).trim()) {
        configFile = resolveEnvDirOrThrow({
          home,
          envVar: 'OPENCODE_CONFIG',
          rawValue: env.OPENCODE_CONFIG,
          fallbackDir: path.join(ocDir, 'opencode.json'),
          hostLabel: 'OpenCode',
        });
      } else {
        configFile = resolveOpenCodeConfigInDir(ocDir);
      }
    } else {
      ocDir = path.join(root, '.opencode');
      configFile = resolveOpenCodeProjectConfigFile(root);
    }

    const entry = isHosted
      ? {
          type: 'remote',
          url: mcpUrl('opencode'),
          headers: { Authorization: `Bearer ${token || '{env:MEGALENS_TOKEN}'}` },
          enabled: true,
        }
      : {
          type: 'local',
          command: ['node', serverPath],
          environment: {
            MEGALENS_TOKEN: token || '{env:MEGALENS_TOKEN}',
            MEGALENS_URL: mcpUrl('opencode'),
          },
          enabled: true,
        };
    mergeJsonServer(
      plan,
      configFile,
      'mcp',
      serverName,
      entry,
      { $schema: (cur) => cur ?? 'https://opencode.ai/config.json' },
      mergeOpts,
    );
    writeOwnedFile(plan, path.join(ocDir, 'commands', 'megalens-review.md'), T.opencodeCommand(mode, textOpts));
    const agentsFile = scope === 'global' ? path.join(ocDir, 'AGENTS.md') : path.join(root, 'AGENTS.md');
    managedMarkdown(plan, agentsFile, T.opencodeAgentsSnippet(mode, textOpts));
    plan.note('Run in OpenCode: /megalens-review or ask "review my changes with MegaLens". Restart OpenCode first.');
    return;
  }

  if (host === 'antigravity') {
    const configFile = scope === 'global'
      ? path.join(home, '.gemini', 'config', 'mcp_config.json')
      : path.join(root, '.agents', 'mcp_config.json');
    const entry = isHosted
      ? {
          url: mcpUrl('antigravity'),
          headers: { Authorization: `Bearer ${token || '${MEGALENS_TOKEN}'}` },
          disabled: false,
        }
      : {
          command: 'node',
          args: [serverPath],
          env: {
            MEGALENS_TOKEN: token || '${MEGALENS_TOKEN}',
            MEGALENS_URL: mcpUrl('antigravity'),
          },
        };
    mergeJsonServer(plan, configFile, 'mcpServers', serverName, entry, {}, mergeOpts);

    if (scope === 'global') {
      writeOwnedFile(plan, path.join(home, '.gemini', 'antigravity', 'skills', 'megalens-review', 'SKILL.md'), T.antigravitySkill(mode, textOpts));
      managedMarkdown(plan, path.join(home, '.gemini', 'GEMINI.md'), T.antigravityGeminiSnippet(mode, textOpts));
      plan.note('Gemini CLI also reads ~/.gemini/GEMINI.md, so those MegaLens lines apply to Gemini CLI too.');
      const legacyIdeCfg = path.join(home, '.gemini', 'antigravity', 'mcp_config.json');
      if (existsSync(legacyIdeCfg)) {
        plan.note(`Also detected ${legacyIdeCfg}; if your Antigravity IDE reads that path, update it or run Refresh in Manage MCP Servers.`);
      }
    } else {
      writeOwnedFile(plan, path.join(root, '.agents', 'skills', 'megalens-review', 'SKILL.md'), T.antigravitySkill(mode, textOpts));
      writeOwnedFile(plan, path.join(root, '.agents', 'rules', 'megalens-review.md'), T.antigravityRule(mode, textOpts));
    }
    plan.note('Run in Antigravity: ask "review my changes with MegaLens". Restart or refresh MCP servers first.');
    return;
  }

  if (host === 'codex' && isHosted) {
    const cfg = path.join(root, '.codex', 'config.toml');
    codexToml(plan, cfg, serverName, serverPath, token, { hostedUrl: mcpUrl('codex') });
    const skillDir = path.join(root, '.agents', 'skills', 'megalens-review');
    writeOwnedFile(plan, path.join(skillDir, 'SKILL.md'), T.codexHostedSkill(textOpts));
    writeOwnedFile(plan, path.join(skillDir, 'agents', 'openai.yaml'), T.codexSkillPolicy(), { commentStyle: 'hash' });
    if (scope === 'global') writeOwnedFile(plan, path.join(root, '.codex', 'prompts', 'megalens-review.md'), T.codexHostedPrompt(textOpts));
    else managedMarkdown(plan, path.join(root, 'AGENTS.md'), T.codexHostedAgentsSnippet(textOpts));
    plan.note('Hosted HTTP config for Codex uses TOML url + http_headers. Restart Codex first.');
    return;
  }

  if (host === 'cursor' && isHosted) {
    const entry = { url: mcpUrl('cursor'), headers: { Authorization: `Bearer ${token || '${env:MEGALENS_TOKEN}'}` } };
    mergeJsonServer(plan, path.join(root, '.cursor', 'mcp.json'), 'mcpServers', serverName, entry, {}, mergeOpts);
    writeOwnedFile(plan, path.join(root, '.cursor', 'commands', 'megalens-review.md'), T.cursorHostedCommand(textOpts));
    if (scope === 'project') writeOwnedFile(plan, path.join(root, '.cursor', 'rules', 'megalens-review.mdc'), T.cursorHostedRule(textOpts));
    plan.note('Run in Cursor: /megalens-review or ask "review my changes with MegaLens". Restart Cursor first.');
    return;
  }

  throw new Error(`Unsupported host for more-hosts installer: ${host}`);
}

/**
 * Browser sign-in setup flow (`--browser-login`):
 * 1. Validates flags & runs a dry-run preflight on every target file BEFORE opening the browser.
 * 2. Runs RFC 8628 device sign-in (`deviceLogin`) with mandatory terminal account confirmation.
 * 3. Writes the host config atomically (0600, backups outside repo), never printing the token.
 */
export async function setupWithBrowserLogin(opts, deps = {}) {
  const {
    host: rawHost,
    scope = 'global',
    allowProjectToken = false,
    dryRun = false,
    moreHosts = MORE_HOSTS_ENABLED,
  } = opts;
  if (!moreHosts) throw new Error('Browser-login host setup is behind MORE_HOSTS_ENABLED (currently off).');
  const host = resolveHostName(rawHost);
  if (!ALL_HOSTS.includes(host)) throw new Error(`Unknown host: ${rawHost}`);
  if (scope === 'project' && !allowProjectToken) {
    throw new Error('Refusing to write a browser sign-in token into a project folder (it could be committed). Use --global, or pass --allow-project-token if this folder is private.');
  }

  const installFn = deps.installFn;
  if (typeof installFn !== 'function') throw new Error('installFn is required');

  // Preflight config files BEFORE signing in so broken JSON/symlinks/collisions/bad XDG never cost a browser login.
  const preflightReport = installFn({
    ...opts,
    host,
    scope,
    mode: 'hosted',
    token: 'ml_tok_preflight_placeholder_00000000',
    allowProjectToken,
    dryRun: true,
    moreHosts: true,
  });
  if (dryRun) return preflightReport;

  const loginFn = deps.deviceLogin || deviceLogin;
  const confirmAccount = deps.confirmAccount || promptConfirmAccount({
    input: deps.input ?? process.stdin,
    output: deps.output ?? process.stderr,
  });
  const auth = await loginFn({
    ...(deps.loginOpts || {}),
    confirmAccount,
  });
  const report = installFn({
    ...opts,
    host,
    scope,
    mode: 'hosted',
    token: auth.token,
    allowProjectToken,
    dryRun: false,
    moreHosts: true,
  });
  return [`Signed in as ${auth.account}.`, ...report];
}
