#!/usr/bin/env node
// Installs the MegaLens Codex plugin for Codex CLI and the Codex desktop app:
//   - Skills ($megalens-review, $megalens-status, $megalens-result) under ~/.agents/skills/ (or <repo>/.agents/skills/)
//   - Custom CLI prompts (/prompts:megalens-review, /prompts:megalens-status, /prompts:megalens-result) under $CODEX_HOME/prompts/ (global only)
//   - Local Codex plugin package + marketplace entry under ~/.codex/plugins/megalens/ & ~/.agents/plugins/marketplace.json
//     (or <repo>/.codex/plugins/megalens/ & <repo>/.agents/plugins/marketplace.json with --project)
//   - Optional --with-oauth-mcp: adds [mcp_servers.megalens] Streamable HTTP entry to config.toml only if not already configured
//     (leaves existing `npx megalens-mcp setup codex` config untouched).
//
// Gated behind CODEX_PLUGIN_ENABLED (default false; enable with MEGALENS_CODEX_PLUGIN=1).
// Never writes tokens or secrets. Refuses symlinks. Creates owner-only backups outside any repo before overwriting.
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkToml } from '../../scripts/hosts/toml-check.mjs';
import { CODEX_PLUGIN_OFF_MESSAGE, isCodexPluginEnabled } from './flags.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODEX_DIR = path.resolve(HERE, '..');
const DEFAULT_RUNNER_SCRIPT = path.join(HERE, 'codex-review.mjs');

const BEGIN = '# >>> megalens-codex-plugin (managed block, safe to delete) >>>';
const END = '# <<< megalens-codex-plugin <<<';
const CODEX_MCP_URL = 'https://megalens.ai/api/mcp?ide=codex';

export function parseArgs(argv) {
  const o = {
    scope: 'global',
    dir: '',
    home: '',
    codexHome: '',
    withOauthMcp: false,
    dryRun: false,
  };
  const val = (i, flag) => {
    const v = argv[i];
    if (v === undefined || v === '' || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--global') o.scope = 'global';
    else if (a === '--project') o.scope = 'project';
    else if (a === '--dir') o.dir = val(++i, a);
    else if (a === '--home') o.home = val(++i, a);
    else if (a === '--codex-home') o.codexHome = val(++i, a);
    else if (a === '--with-oauth-mcp') o.withOauthMcp = true;
    else if (a === '--dry-run') o.dryRun = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return o;
}

export function resolveCodexHome(env = process.env, home = homedir(), explicit = '') {
  const custom = String(explicit || env.CODEX_HOME || '').trim();
  return custom ? path.resolve(custom) : path.join(path.resolve(home), '.codex');
}

function assertSafeScriptPath(p) {
  const abs = path.resolve(p);
  if (/[\r\n\0'"]/.test(abs)) {
    throw new Error(`Unsafe characters in script path: ${abs}`);
  }
  return abs;
}

function renderTemplate(relPath, scriptPath) {
  const raw = readFileSync(path.join(CODEX_DIR, relPath), 'utf8');
  return raw.replaceAll('codex/scripts/codex-review.mjs', scriptPath);
}

const SECRETISH = /(token|api[_-]?key|secret|password|authorization|bearer)["']?\s*[:=]\s*["']?(?!\$)[A-Za-z0-9_\-./+=]{8,}/i;

class Plan {
  constructor({ dryRun, allowedRoots, backupRoot }) {
    this.dryRun = dryRun;
    this.allowedRoots = allowedRoots.map((r) => path.resolve(r));
    this.backupRoot = path.resolve(backupRoot);
    this.ops = [];
    this.report = [];
    this.notes = [];
  }

  rootFor(file) {
    const abs = path.resolve(file);
    for (const r of this.allowedRoots) {
      const rel = path.relative(r, abs);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) return r;
    }
    throw new Error(`${file} is outside allowed roots; nothing was changed.`);
  }

  check(file) {
    const root = this.rootFor(file);
    const rel = path.relative(root, file);
    let cur = root;
    let st = null;
    for (const part of rel.split(path.sep)) {
      if (!part) continue;
      cur = path.join(cur, part);
      st = null;
      try {
        st = lstatSync(cur);
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
      if (st.isSymbolicLink()) {
        throw new Error(`${cur} is a symbolic link; refusing to read or write through it. Nothing was changed.`);
      }
    }
    if (st && !st.isFile()) throw new Error(`${file} is not a regular file; nothing was changed.`);
    return st;
  }

  write(file, content) {
    const st = this.check(file);
    const old = st ? readFileSync(file, 'utf8') : null;
    if (old === content) {
      this.report.push(`unchanged  ${file}`);
      return;
    }
    this.ops.push({ file, content, st, old });
  }

  skip(file, why) {
    this.report.push(`skipped    ${file}: ${why}`);
  }

  note(s) {
    this.notes.push(s);
  }

  flush() {
    const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
    const dir = path.join(this.backupRoot, stamp);
    let used = false;
    for (const { file, content, st, old } of this.ops) {
      const oldMode = st ? st.mode & 0o777 : null;
      const mode = oldMode === null ? 0o644 : oldMode;
      let backup = '';
      if (st) {
        backup = path.join(dir, file.split(path.sep).filter(Boolean).join('__'));
        if (!this.dryRun) {
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          if (!used) {
            for (let d = dir; ; d = path.dirname(d)) {
              chmodSync(d, 0o700);
              if (d === this.backupRoot) break;
            }
            used = true;
          }
          const fd = openSync(backup, 'wx', 0o600);
          try {
            writeSync(fd, old);
          } finally {
            closeSync(fd);
          }
        }
      }
      if (!this.dryRun) {
        mkdirSync(path.dirname(file), { recursive: true });
        const tmp = path.join(
          path.dirname(file),
          `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
        );
        const fd = openSync(tmp, 'wx', mode);
        try {
          fchmodSync(fd, mode);
          writeSync(fd, content);
        } catch (e) {
          closeSync(fd);
          try { unlinkSync(tmp); } catch {}
          throw e;
        }
        closeSync(fd);
        renameSync(tmp, file);
      }
      this.report.push(
        `${this.dryRun ? 'would ' : ''}${st ? 'updated  ' : 'created  '} ${file}`
        + (st ? `\n           backup (outside the repo, owner-only): ${backup}` : ''),
      );
      if (st && old && SECRETISH.test(old)) {
        this.report.push(
          `WARNING    the previous ${file} contained what looks like a credential. It is kept only in the backup above (mode 600).`,
        );
      }
    }
  }
}

const eolOf = (t) => (t.includes('\r\n') ? '\r\n' : '\n');
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function spliceBlock(old, begin, end, bodyLines) {
  const eol = eolOf(old);
  const block = [begin, ...bodyLines, end].join(eol) + eol;
  const re = new RegExp(`${escRe(begin)}[\\s\\S]*?${escRe(end)}(\\r?\\n)?`);
  if (re.test(old)) return { text: old.replace(re, () => block), had: true };
  const trimmed = old.replace(/(\r?\n)*$/, '');
  return { text: (trimmed ? trimmed + eol + eol : '') + block, had: false };
}

/** True if config.toml already defines mcp_servers.megalens outside our managed block. */
function hasExistingMegalensMcp(raw) {
  const withoutManaged = raw.replace(
    new RegExp(`${escRe(BEGIN)}[\\s\\S]*?${escRe(END)}(\\r?\\n)?`, 'g'),
    '',
  );
  return /^\s*\[\s*mcp_servers\.(?:megalens|"megalens"|'megalens')(?:\s|\.|])/m.test(withoutManaged)
    || /^\s*mcp_servers\.(?:megalens|"megalens"|'megalens')\b/m.test(withoutManaged)
    || /^\s*(?:megalens|"megalens"|'megalens')\s*=/m.test(
      (withoutManaged.match(/^\s*\[\s*mcp_servers\s*\][\s\S]*?(?=^\s*\[|$)/m) || [''])[0],
    );
}

function mergeOauthMcpToml(plan, file) {
  plan.check(file);
  const old = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (hasExistingMegalensMcp(old)) {
    plan.skip(file, 'already defines mcp_servers.megalens (keeping existing npx megalens-mcp setup codex config)');
    return;
  }
  const body = [
    '[mcp_servers.megalens]',
    `url = ${JSON.stringify(CODEX_MCP_URL)}`,
    'startup_timeout_sec = 20',
    'tool_timeout_sec = 1800  # reviews can take several minutes',
  ];
  const { text } = spliceBlock(old, BEGIN, END, body);
  try {
    checkToml(text);
  } catch (e) {
    throw new Error(`${file} cannot take the MegaLens MCP block: ${e.message}. Nothing was changed.`);
  }
  plan.write(file, text);
}

function mergeMarketplaceJson(plan, file, pluginRelPath, marketplaceName, displayName) {
  plan.check(file);
  const raw = existsSync(file) ? readFileSync(file, 'utf8') : '';
  let doc = {
    name: marketplaceName,
    interface: { displayName },
    plugins: [],
  };
  if (raw.trim()) {
    try {
      doc = JSON.parse(raw);
    } catch (e) {
      throw new Error(`${file} is not valid JSON (${e.message}); fix or move it, nothing was changed.`);
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error(`${file} does not contain a JSON object; nothing was changed.`);
    }
    if (doc.plugins !== undefined && !Array.isArray(doc.plugins)) {
      throw new Error(`${file}: "plugins" must be a JSON array; nothing was changed.`);
    }
    if (!Array.isArray(doc.plugins)) doc.plugins = [];
    if (!doc.name) doc.name = marketplaceName;
  }
  const entry = {
    name: 'megalens',
    source: {
      source: 'local',
      path: pluginRelPath,
    },
    policy: {
      installation: 'AVAILABLE',
      authentication: 'ON_USE',
    },
    category: 'Developer Tools',
  };
  const idx = doc.plugins.findIndex((p) => p && typeof p === 'object' && p.name === 'megalens');
  if (idx >= 0) doc.plugins[idx] = entry;
  else doc.plugins.push(entry);
  plan.write(file, JSON.stringify(doc, null, 2) + '\n');
}

const SKILLS = ['megalens-review', 'megalens-status', 'megalens-result'];
const PROMPTS = ['megalens-review.md', 'megalens-status.md', 'megalens-result.md'];

export function installCodex(opts = {}, { env = process.env, flags = {} } = {}) {
  if (!isCodexPluginEnabled(env, flags)) {
    return { code: 4, report: [CODEX_PLUGIN_OFF_MESSAGE] };
  }

  const o = { scope: 'global', dir: '', home: '', codexHome: '', withOauthMcp: false, dryRun: false, ...opts };
  const home = path.resolve(o.home || env.HOME || homedir());
  const project = path.resolve(o.dir || process.cwd());
  const codexHome = resolveCodexHome(env, home, o.codexHome);
  const root = o.scope === 'global' ? home : project;
  const scriptPath = assertSafeScriptPath(o.scriptPath || DEFAULT_RUNNER_SCRIPT);
  const allowedRoots = o.scope === 'global' ? [home, codexHome] : [project];
  const plan = new Plan({
    dryRun: Boolean(o.dryRun),
    allowedRoots,
    backupRoot: path.join(home, '.megalens', 'backups', 'codex-plugin'),
  });

  // 1. Standalone Codex Skills (~/.agents/skills/ or <repo>/.agents/skills/)
  //    Works in Codex CLI ($megalens-review), Codex desktop app (Skills), and IDE extension.
  for (const skill of SKILLS) {
    const destDir = path.join(root, '.agents', 'skills', skill);
    plan.write(
      path.join(destDir, 'SKILL.md'),
      renderTemplate(path.join('skills', skill, 'SKILL.md'), scriptPath),
    );
    plan.write(
      path.join(destDir, 'agents', 'openai.yaml'),
      readFileSync(path.join(CODEX_DIR, 'skills', skill, 'agents', 'openai.yaml'), 'utf8'),
    );
  }

  // 2. Codex CLI custom slash prompts ($CODEX_HOME/prompts/megalens-*.md, global only).
  if (o.scope === 'global') {
    for (const p of PROMPTS) {
      plan.write(
        path.join(codexHome, 'prompts', p),
        renderTemplate(path.join('prompts', p), scriptPath),
      );
    }
  } else {
    plan.note('Custom /prompts:* files only load from ~/.codex/prompts/ (use --global to install them alongside skills).');
  }

  // 3. Codex plugin package + local marketplace (for Codex desktop app Plugins Directory & `codex /plugins`).
  const pluginDir = path.join(root, '.codex', 'plugins', 'megalens');
  plan.write(path.join(pluginDir, 'plugin.json'), readFileSync(path.join(CODEX_DIR, 'plugin.json'), 'utf8'));
  plan.write(path.join(pluginDir, 'mcp.json'), readFileSync(path.join(CODEX_DIR, 'mcp.json'), 'utf8'));
  for (const skill of SKILLS) {
    const destDir = path.join(pluginDir, 'skills', skill);
    plan.write(
      path.join(destDir, 'SKILL.md'),
      renderTemplate(path.join('skills', skill, 'SKILL.md'), scriptPath),
    );
    plan.write(
      path.join(destDir, 'agents', 'openai.yaml'),
      readFileSync(path.join(CODEX_DIR, 'skills', skill, 'agents', 'openai.yaml'), 'utf8'),
    );
  }
  const marketplaceFile = path.join(root, '.agents', 'plugins', 'marketplace.json');
  mergeMarketplaceJson(
    plan,
    marketplaceFile,
    './.codex/plugins/megalens',
    o.scope === 'global' ? 'personal-megalens' : 'local-repo',
    o.scope === 'global' ? 'Personal Plugins' : 'Local Repo Plugins',
  );

  // 4. Optional Streamable HTTP OAuth MCP config in config.toml (never clobbers `npx megalens-mcp setup codex`).
  if (o.withOauthMcp) {
    const configPath = o.scope === 'global'
      ? path.join(codexHome, 'config.toml')
      : path.join(project, '.codex', 'config.toml');
    mergeOauthMcpToml(plan, configPath);
  }

  plan.flush();
  plan.note('Next: run `npx megalens-mcp setup codex` to sign in via browser (if not already done), then restart Codex.');
  plan.note('In Codex CLI or Codex desktop app, run `$megalens-review` (or `/prompts:megalens-review` in Codex CLI).');
  plan.report.push(...plan.notes);
  return { code: 0, report: plan.report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const o = parseArgs(process.argv.slice(2));
    const res = installCodex(o);
    for (const l of res.report) console.log(l);
    process.exitCode = res.code;
  } catch (e) {
    console.error(
      `install-codex: ${e.message}\n`
      + 'usage: node codex/scripts/install-codex.mjs [--global|--project] [--dir DIR] [--home DIR] [--codex-home DIR] [--with-oauth-mcp] [--dry-run]',
    );
    process.exit(2);
  }
}
