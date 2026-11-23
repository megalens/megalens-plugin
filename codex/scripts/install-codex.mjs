#!/usr/bin/env node
// Installs the MegaLens Codex plugin for Codex CLI and the Codex desktop app:
//   - Self-contained plugin + runtime ALWAYS under user-owned ~/.codex/plugins/megalens/
//     (or $CODEX_HOME/plugins/megalens/ for --project), NEVER inside the repository under review,
//     including .codex-plugin/plugin.json, mcp.json, scripts/, runtime/, skills/, and persisted preview opt-in marker
//   - Standalone Codex Skills ($megalens-review, $megalens-status, $megalens-result) under ~/.agents/skills/ (or <repo>/.agents/skills/)
//   - Custom CLI prompts (/prompts:megalens-review, /prompts:megalens-status, /prompts:megalens-result) under $CODEX_HOME/prompts/ (global only)
//   - Local marketplace entry under ~/.agents/plugins/marketplace.json (global only; never places executable code in a reviewed repo)
//   - Project scope (--project): also records installed untracked skill paths in the repo's local .git/info/exclude so
//     default GitHub reviews do not reject the installer's own files as uncommitted changes
//   - Optional --with-oauth-mcp: adds [mcp_servers.megalens] Streamable HTTP OAuth entry to config.toml only if not already configured
//     (uses TOML-aware lookup and inline-table insertion; leaves existing MegaLens config untouched).
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
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkToml } from '../runtime/scripts/hosts/toml-check.mjs';
import { CODEX_PLUGIN_OFF_MESSAGE, PREVIEW_OPT_IN_FILENAME, isCodexPluginEnabled } from './flags.mjs';
import { collectTomlPaths, findTomlInlineTable, hasTomlPath, insertIntoTomlInlineTable } from './toml-inspect.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODEX_DIR = path.resolve(HERE, '..');

const SKILL_RUNNER_TOKEN = '<SKILL_DIR>/../../scripts/codex-review.mjs';
const BEGIN = '# >>> megalens-codex-plugin (managed block, safe to delete) >>>';
const END = '# <<< megalens-codex-plugin <<<';
const CODEX_MCP_URL = 'https://megalens.ai/api/mcp?ide=codex';

const BUNDLED_PLUGIN_FILES = [
  '.codex-plugin/plugin.json',
  'mcp.json',
  'scripts/codex-review.mjs',
  'scripts/flags.mjs',
  'runtime/scripts/engine.mjs',
  'runtime/scripts/hosts/toml-check.mjs',
  'runtime/scripts/lib/engine-core.mjs',
  'runtime/scripts/lib/gh-runner.mjs',
  'runtime/scripts/lib/latest-review.mjs',
  'runtime/scripts/lib/local-standard.mjs',
  'runtime/scripts/lib/safety.mjs',
  'runtime/scripts/lib/wait-loop.mjs',
  'runtime/templates/megalens-dispatch.yml',
];

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
  return raw.replaceAll(SKILL_RUNNER_TOKEN, scriptPath);
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

  write(file, content, { mode: defaultMode = 0o644 } = {}) {
    const st = this.check(file);
    const old = st ? readFileSync(file, 'utf8') : null;
    if (old === content) {
      this.report.push(`unchanged  ${file}`);
      return;
    }
    this.ops.push({ file, content, st, old, defaultMode });
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
    for (const { file, content, st, old, defaultMode } of this.ops) {
      const oldMode = st ? st.mode & 0o777 : null;
      const mode = oldMode === null ? defaultMode : oldMode;
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

/** True if config.toml already defines mcp_servers.megalens outside our managed block (TOML-aware). */
export function hasExistingMegalensMcp(raw) {
  const withoutManaged = String(raw ?? '').replace(
    new RegExp(`${escRe(BEGIN)}[\\s\\S]*?${escRe(END)}(\\r?\\n)?`, 'g'),
    '',
  );
  return hasTomlPath(withoutManaged, ['mcp_servers', 'megalens']);
}

function mergeOauthMcpToml(plan, file) {
  plan.check(file);
  const old = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (hasExistingMegalensMcp(old)) {
    plan.skip(file, 'already defines mcp_servers.megalens (keeping existing Codex MCP config)');
    return;
  }

  // If the user defines `mcp_servers = { ... }` as an inline table, TOML 1.0 forbids
  // extending it with a `[mcp_servers.megalens]` table header; splice directly into the inline table.
  const withoutManaged = String(old).replace(
    new RegExp(`${escRe(BEGIN)}[\\s\\S]*?${escRe(END)}(\\r?\\n)?`, 'g'),
    '',
  );
  const inlineSpan = findTomlInlineTable(withoutManaged, ['mcp_servers']);
  let text;
  if (inlineSpan) {
    const inlineValue = `{ url = ${JSON.stringify(CODEX_MCP_URL)}, startup_timeout_sec = 20, tool_timeout_sec = 1800 }`;
    text = insertIntoTomlInlineTable(withoutManaged, inlineSpan, 'megalens', inlineValue);
  } else {
    const body = [
      '[mcp_servers.megalens]',
      `url = ${JSON.stringify(CODEX_MCP_URL)}`,
      'startup_timeout_sec = 20',
      'tool_timeout_sec = 1800  # reviews can take several minutes',
    ];
    text = spliceBlock(old, BEGIN, END, body).text;
  }

  try {
    checkToml(text);
  } catch (e) {
    // Allow pre-existing valid TOML 1.1 constructs (e.g. multiline inline tables) when both
    // the original and updated configs parse cleanly with collectTomlPaths and contain our entry.
    let ok11 = false;
    try {
      collectTomlPaths(old);
      ok11 = hasTomlPath(text, ['mcp_servers', 'megalens']);
    } catch {
      ok11 = false;
    }
    if (!ok11) {
      throw new Error(`${file} cannot take the MegaLens MCP block: ${e.message}. Nothing was changed.`);
    }
  }
  plan.write(file, text);
}

/**
 * Locate the repo's local `.git/info/exclude` for `--project` installs (never modifies tracked `.gitignore`).
 * Supports standard `.git/` dirs and worktree/submodule `.git` files; returns null outside a git repo.
 */
function resolveGitInfoExclude(projectDir) {
  let cur = path.resolve(projectDir);
  let repoRoot = null;
  for (;;) {
    const dotGit = path.join(cur, '.git');
    try {
      const st = lstatSync(dotGit);
      if (st.isSymbolicLink()) return null;
      if (st.isDirectory() || st.isFile()) {
        repoRoot = cur;
        break;
      }
    } catch (e) {
      if (e.code !== 'ENOENT') return null;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }

  const dotGit = path.join(repoRoot, '.git');
  let gitDir = dotGit;
  const st = lstatSync(dotGit);
  if (st.isFile()) {
    const raw = readFileSync(dotGit, 'utf8');
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(raw);
    if (!m) return null;
    gitDir = path.resolve(repoRoot, m[1]);
  }
  // Linked worktrees share info/exclude under commondir when present.
  const commonDirFile = path.join(gitDir, 'commondir');
  let commonGitDir = gitDir;
  try {
    const cst = lstatSync(commonDirFile);
    if (cst.isFile() && !cst.isSymbolicLink()) {
      const relCommon = readFileSync(commonDirFile, 'utf8').trim();
      if (relCommon) commonGitDir = path.resolve(gitDir, relCommon);
    }
  } catch { /* normal repo without commondir */ }

  const relFromRoot = path.relative(repoRoot, path.resolve(projectDir)).split(path.sep).filter(Boolean).join('/');
  const prefix = relFromRoot ? `${relFromRoot}/` : '';
  return {
    excludeRoot: commonGitDir,
    excludeFile: path.join(commonGitDir, 'info', 'exclude'),
    prefix,
  };
}

function mergeGitExclude(plan, excludeFile, patterns) {
  plan.check(excludeFile);
  const old = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
  const { text } = spliceBlock(old, BEGIN, END, patterns);
  plan.write(excludeFile, text);
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

function isMainModule(metaUrl, argv1) {
  if (!argv1) return false;
  const self = fileURLToPath(metaUrl);
  try {
    return realpathSync(argv1) === realpathSync(self);
  } catch {
    return path.resolve(argv1) === self;
  }
}

export function installCodex(opts = {}, { env = process.env, flags = {} } = {}) {
  // Installer itself requires explicit enablement (never relies on an opt-in marker in source).
  if (!isCodexPluginEnabled(env, flags, { checkOptInMarker: false })) {
    return { code: 4, report: [CODEX_PLUGIN_OFF_MESSAGE] };
  }

  const o = { scope: 'global', dir: '', home: '', codexHome: '', withOauthMcp: false, dryRun: false, ...opts };
  const home = path.resolve(o.home || env.HOME || homedir());
  const project = path.resolve(o.dir || process.cwd());
  const codexHome = resolveCodexHome(env, home, o.codexHome);
  const skillsRoot = o.scope === 'global' ? home : project;
  // ALWAYS install executable runtime + opt-in marker in user-owned storage, NEVER inside the reviewed repo.
  // In global mode, place under ~/.codex/plugins/megalens so ~/.agents/plugins/marketplace.json resolves `./.codex/plugins/megalens`.
  const pluginDir = o.scope === 'global'
    ? path.join(home, '.codex', 'plugins', 'megalens')
    : path.join(codexHome, 'plugins', 'megalens');
  const installedRunner = path.join(pluginDir, 'scripts', 'codex-review.mjs');
  const scriptPath = assertSafeScriptPath(o.scriptPath || installedRunner);
  const gitExclude = o.scope === 'project' ? resolveGitInfoExclude(project) : null;
  const allowedRoots = o.scope === 'global'
    ? [home, codexHome]
    : [project, codexHome, ...(gitExclude ? [gitExclude.excludeRoot] : [])];
  const plan = new Plan({
    dryRun: Boolean(o.dryRun),
    allowedRoots,
    backupRoot: path.join(home, '.megalens', 'backups', 'codex-plugin'),
  });

  // 1. Self-contained Codex plugin package + bundled runtime (ALWAYS user-owned, never inside reviewed repo).
  //    Works standalone even after a temporary npx cache or checkout is removed, and persists
  //    the user's explicit preview opt-in across CLI and Codex desktop app restarts.
  for (const rel of BUNDLED_PLUGIN_FILES) {
    const mode = rel === 'scripts/codex-review.mjs' ? 0o755 : 0o644;
    plan.write(
      path.join(pluginDir, rel),
      readFileSync(path.join(CODEX_DIR, rel), 'utf8'),
      { mode },
    );
  }
  plan.write(
    path.join(pluginDir, PREVIEW_OPT_IN_FILENAME),
    JSON.stringify({ enabled: true, source: 'install-codex' }, null, 2) + '\n',
  );
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

  // 2. Standalone Codex Skills (~/.agents/skills/ or <repo>/.agents/skills/)
  //    Works in Codex CLI ($megalens-review), Codex desktop app (Skills), and IDE extension.
  //    Always invokes the user-owned runner outside the repository under review.
  for (const skill of SKILLS) {
    const destDir = path.join(skillsRoot, '.agents', 'skills', skill);
    plan.write(
      path.join(destDir, 'SKILL.md'),
      renderTemplate(path.join('skills', skill, 'SKILL.md'), scriptPath),
    );
    plan.write(
      path.join(destDir, 'agents', 'openai.yaml'),
      readFileSync(path.join(CODEX_DIR, 'skills', skill, 'agents', 'openai.yaml'), 'utf8'),
    );
  }

  // 3. Codex CLI custom slash prompts ($CODEX_HOME/prompts/megalens-*.md, global only)
  //    and user-scoped local marketplace entry (~/.agents/plugins/marketplace.json, global only).
  if (o.scope === 'global') {
    for (const p of PROMPTS) {
      plan.write(
        path.join(codexHome, 'prompts', p),
        renderTemplate(path.join('prompts', p), scriptPath),
      );
    }
    const marketplaceFile = path.join(home, '.agents', 'plugins', 'marketplace.json');
    mergeMarketplaceJson(
      plan,
      marketplaceFile,
      './.codex/plugins/megalens',
      'personal-megalens',
      'Personal Plugins',
    );
  } else {
    plan.note(`Self-contained runtime and preview opt-in installed in user storage (${pluginDir}), never inside the repository under review.`);
    plan.note('Custom /prompts:* and local marketplace entries are user-scoped (use --global to install them alongside skills).');
  }

  // 4. Optional Streamable HTTP OAuth MCP config in config.toml (never clobbers existing config;
  //    supports inline tables and quoted keys).
  let projectCreatedConfig = false;
  if (o.withOauthMcp) {
    const configPath = o.scope === 'global'
      ? path.join(codexHome, 'config.toml')
      : path.join(project, '.codex', 'config.toml');
    projectCreatedConfig = o.scope === 'project' && !existsSync(configPath);
    mergeOauthMcpToml(plan, configPath);
  }

  // 5. Project scope: exclude only the installer's own untracked files in local `.git/info/exclude`
  //    so default `$megalens-review` does not reject its own installation files as uncommitted changes.
  if (o.scope === 'project' && gitExclude) {
    const excludePatterns = SKILLS.map((s) => `/${gitExclude.prefix}.agents/skills/${s}/`);
    if (projectCreatedConfig) excludePatterns.push(`/${gitExclude.prefix}.codex/config.toml`);
    mergeGitExclude(plan, gitExclude.excludeFile, excludePatterns);
  }

  plan.flush();
  plan.note('Preview opt-in saved inside user-owned plugin storage so it survives CLI and Codex desktop app restarts (set MEGALENS_CODEX_PLUGIN=0 anytime to disable).');
  plan.note('Next: run `codex mcp login megalens` to sign in via browser OAuth (zero token paste; add `--with-oauth-mcp` first if `[mcp_servers.megalens]` is not in config.toml), then restart Codex.');
  plan.note('GitHub runs also need `gh auth login`, `.github/workflows/megalens-dispatch.yml` on your default branch, and repository secret `MEGALENS_TOKEN` while APP_PATH_ENABLED=false.');
  plan.note('In Codex CLI or Codex desktop app, run `$megalens-review` (or `/prompts:megalens-review` in Codex CLI).');
  plan.report.push(...plan.notes);
  return { code: 0, report: plan.report };
}

if (isMainModule(import.meta.url, process.argv[1])) {
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
