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
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_PLUGIN_OFF_MESSAGE, PREVIEW_OPT_IN_FILENAME, isCodexPluginEnabled } from './flags.mjs';
import { findTomlInlineTable, hasTomlPath, insertIntoTomlInlineTable, validateToml } from './toml-inspect.mjs';

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

function isSubpath(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
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

  checkPathNoSymlinks(target) {
    const root = this.rootFor(target);
    const rel = path.relative(root, target);
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
    return st;
  }

  check(file) {
    const st = this.checkPathNoSymlinks(file);
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
    this.ops.push({ kind: 'write', file, content, st, old, defaultMode });
  }

  removeFile(file, { backup = true, pruneTo = null } = {}) {
    const st = this.check(file);
    if (!st) return;
    const old = backup ? readFileSync(file, 'utf8') : null;
    this.ops.push({ kind: 'removeFile', file, st, old, backup, pruneTo });
  }

  removeDirTree(dir, { stopPruneAt = null } = {}) {
    const absDir = path.resolve(dir);
    const st = this.checkPathNoSymlinks(absDir);
    if (!st) return;
    if (!st.isDirectory()) throw new Error(`${absDir} is not a directory; nothing was changed.`);
    const files = [];
    const dirs = [];
    const visit = (d) => {
      for (const entry of readdirSync(d)) {
        const p = path.join(d, entry);
        const est = lstatSync(p);
        if (est.isSymbolicLink()) {
          throw new Error(`${p} is a symbolic link; refusing to remove through it. Nothing was changed.`);
        }
        if (est.isDirectory()) {
          visit(p);
          dirs.push(p);
        } else if (est.isFile()) {
          files.push(p);
        } else {
          throw new Error(`${p} is not a regular file or directory; nothing was changed.`);
        }
      }
    };
    visit(absDir);
    dirs.push(absDir);
    this.ops.push({ kind: 'removeDirTree', dir: absDir, files, dirs, stopPruneAt });
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
    const ensureBackupDir = () => {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!used) {
        for (let d = dir; ; d = path.dirname(d)) {
          chmodSync(d, 0o700);
          if (d === this.backupRoot) break;
        }
        used = true;
      }
    };
    const writeBackup = (file, old) => {
      const backup = path.join(dir, file.split(path.sep).filter(Boolean).join('__'));
      if (!this.dryRun) {
        ensureBackupDir();
        const fd = openSync(backup, 'wx', 0o600);
        try {
          writeSync(fd, old);
        } finally {
          closeSync(fd);
        }
      }
      return backup;
    };
    const pruneEmptyDirs = (startDir, stopAt) => {
      if (!stopAt || this.dryRun) return;
      const stopAbs = path.resolve(stopAt);
      let cur = path.resolve(startDir);
      while (cur !== stopAbs && isSubpath(stopAbs, cur)) {
        let st;
        try { st = lstatSync(cur); } catch { break; }
        if (st.isSymbolicLink() || !st.isDirectory()) break;
        if (readdirSync(cur).length > 0) break;
        rmdirSync(cur);
        cur = path.dirname(cur);
      }
    };

    for (const op of this.ops) {
      if (op.kind === 'removeFile') {
        const { file, old, backup: doBackup, pruneTo } = op;
        const backup = doBackup && old !== null ? writeBackup(file, old) : '';
        if (!this.dryRun) {
          unlinkSync(file);
          if (pruneTo) pruneEmptyDirs(path.dirname(file), pruneTo);
        }
        this.report.push(
          `${this.dryRun ? 'would ' : ''}removed    ${file}`
          + (backup ? `\n           backup (outside the repo, owner-only): ${backup}` : ''),
        );
        continue;
      }
      if (op.kind === 'removeDirTree') {
        const { dir: targetDir, files, dirs, stopPruneAt } = op;
        if (!this.dryRun) {
          for (const f of files) unlinkSync(f);
          for (const d of dirs) rmdirSync(d);
          if (stopPruneAt) pruneEmptyDirs(path.dirname(targetDir), stopPruneAt);
        }
        this.report.push(`${this.dryRun ? 'would ' : ''}removed    ${targetDir}`);
        continue;
      }

      const { file, content, st, old, defaultMode } = op;
      const oldMode = st ? st.mode & 0o777 : null;
      const mode = oldMode === null ? defaultMode : oldMode;
      const backup = st ? writeBackup(file, old) : '';
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

function stripManagedBlock(raw, begin, end) {
  return String(raw ?? '').replace(
    new RegExp(`${escRe(begin)}[\\s\\S]*?${escRe(end)}(\\r?\\n)?`, 'g'),
    '',
  );
}

function readManagedBlockLines(raw, begin, end) {
  const m = new RegExp(`${escRe(begin)}\\r?\\n([\\s\\S]*?)${escRe(end)}`).exec(String(raw ?? ''));
  if (!m) return [];
  return m[1].split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** True if config.toml already defines mcp_servers.megalens outside our managed block (TOML-aware). */
export function hasExistingMegalensMcp(raw) {
  const withoutManaged = stripManagedBlock(raw, BEGIN, END);
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
  const withoutManaged = stripManagedBlock(old, BEGIN, END);
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
    validateToml(text);
    if (!hasTomlPath(text, ['mcp_servers', 'megalens'])) {
      throw new Error('merged config is missing mcp_servers.megalens');
    }
  } catch (e) {
    throw new Error(`${file} cannot take the MegaLens MCP block: ${e.message}. Nothing was changed.`);
  }
  plan.write(file, text);
}

/**
 * Clean up legacy repo-local MegaLens plugin artifacts written inside `<project>` by earlier
 * `--project` installs (`.codex/plugins/megalens/` and the repo-local `megalens` entry in
 * `.agents/plugins/marketplace.json`), without touching unrelated user files or other plugins.
 */
function cleanupLegacyProjectPlugin(plan, project) {
  const legacyPluginDir = path.join(project, '.codex', 'plugins', 'megalens');
  const pluginSt = plan.checkPathNoSymlinks(legacyPluginDir);
  if (pluginSt && pluginSt.isDirectory()) {
    const isLegacyMegalens = [
      path.join(legacyPluginDir, '.codex-plugin', 'plugin.json'),
      path.join(legacyPluginDir, 'scripts', 'codex-review.mjs'),
      path.join(legacyPluginDir, PREVIEW_OPT_IN_FILENAME),
    ].some((p) => existsSync(p));
    if (isLegacyMegalens) {
      plan.removeDirTree(legacyPluginDir, { stopPruneAt: project });
    }
  }

  const legacyMarketplace = path.join(project, '.agents', 'plugins', 'marketplace.json');
  const mpSt = plan.checkPathNoSymlinks(legacyMarketplace);
  if (mpSt && mpSt.isFile()) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(legacyMarketplace, 'utf8'));
    } catch {
      doc = null;
    }
    if (doc && typeof doc === 'object' && !Array.isArray(doc) && Array.isArray(doc.plugins)) {
      const remaining = doc.plugins.filter(
        (p) => !(
          p
          && typeof p === 'object'
          && p.name === 'megalens'
          && p.source?.source === 'local'
          && p.source?.path === './.codex/plugins/megalens'
        ),
      );
      if (remaining.length !== doc.plugins.length) {
        if (remaining.length === 0 && doc.name === 'local-repo') {
          plan.removeFile(legacyMarketplace, { backup: true, pruneTo: project });
        } else {
          plan.write(legacyMarketplace, JSON.stringify({ ...doc, plugins: remaining }, null, 2) + '\n');
        }
      }
    }
  }
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
  let pluginDir = o.scope === 'global'
    ? path.join(home, '.codex', 'plugins', 'megalens')
    : path.join(codexHome, 'plugins', 'megalens');
  if (o.scope === 'project' && isSubpath(project, pluginDir)) {
    pluginDir = path.join(home, '.codex', 'plugins', 'megalens');
  }
  const installedRunner = path.join(pluginDir, 'scripts', 'codex-review.mjs');
  const scriptPath = assertSafeScriptPath(o.scriptPath || installedRunner);
  const gitExclude = o.scope === 'project' ? resolveGitInfoExclude(project) : null;
  const allowedRoots = o.scope === 'global'
    ? [home, codexHome]
    : [project, codexHome, home, ...(gitExclude ? [gitExclude.excludeRoot] : [])];
  const plan = new Plan({
    dryRun: Boolean(o.dryRun),
    allowedRoots,
    backupRoot: path.join(home, '.megalens', 'backups', 'codex-plugin'),
  });

  // 0. Project scope upgrade: remove any stale repo-local MegaLens plugin runtime or marketplace entry
  //    left inside `<project>` by earlier installs so no executable or marketplace points into the repo.
  if (o.scope === 'project') {
    cleanupLegacyProjectPlugin(plan, project);
  }

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
  //    supports inline tables, long keys/values, and quoted keys).
  const projectConfigPath = path.join(project, '.codex', 'config.toml');
  let projectConfigSt = null;
  let projectConfigIsManagedOnly = false;
  if (o.scope === 'project') {
    projectConfigSt = plan.checkPathNoSymlinks(projectConfigPath);
    if (projectConfigSt && projectConfigSt.isFile()) {
      const existingProjectCfg = readFileSync(projectConfigPath, 'utf8');
      projectConfigIsManagedOnly = existingProjectCfg.includes(BEGIN)
        && stripManagedBlock(existingProjectCfg, BEGIN, END).trim() === '';
    }
  }
  const projectCreatedConfig = o.scope === 'project' && o.withOauthMcp && !projectConfigSt;
  if (o.withOauthMcp) {
    const configPath = o.scope === 'global'
      ? path.join(codexHome, 'config.toml')
      : projectConfigPath;
    mergeOauthMcpToml(plan, configPath);
  }

  // 5. Project scope: exclude only the installer's own untracked files in local `.git/info/exclude`
  //    so default `$megalens-review` does not reject its own installation files as uncommitted changes
  //    (and preserve `/.codex/config.toml` exclusion across reinstalls and upgrades from earlier versions).
  if (o.scope === 'project' && gitExclude) {
    const configExcludePattern = `/${gitExclude.prefix}.codex/config.toml`;
    const existingExcludeSt = plan.check(gitExclude.excludeFile);
    const prevExcludeLines = existingExcludeSt
      ? readManagedBlockLines(readFileSync(gitExclude.excludeFile, 'utf8'), BEGIN, END)
      : [];
    const prevExcludedConfig = prevExcludeLines.includes(configExcludePattern);
    const shouldExcludeConfig = projectCreatedConfig
      || projectConfigIsManagedOnly
      || (prevExcludedConfig && Boolean(projectConfigSt || o.withOauthMcp));
    const excludePatterns = SKILLS.map((s) => `/${gitExclude.prefix}.agents/skills/${s}/`);
    if (shouldExcludeConfig) excludePatterns.push(configExcludePattern);
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
