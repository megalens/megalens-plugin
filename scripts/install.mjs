#!/usr/bin/env node
// Installs MegaLens host config for Codex, Cursor and GitHub Copilot around the local stdio server.
//   node scripts/install.mjs --host codex|cursor|copilot [--project|--global] [--dir DIR] [--home DIR] [--token-file FILE] [--dry-run]
// Merges into existing files without removing other servers, backs up any file it changes, is idempotent,
// and never writes a token unless --token-file is given. Reads/writes only under --dir (project) or --home (global).
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, chmodSync, lstatSync, openSync, writeSync, fchmodSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as T from './hosts/text.mjs';
import { checkToml } from './hosts/toml-check.mjs';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-server.mjs');
const NAME = 'megalens-local';
const BEGIN = '# >>> megalens (managed block, safe to delete) >>>';
const END = '# <<< megalens <<<';
const MD_BEGIN = '<!-- megalens:begin -->';
const MD_END = '<!-- megalens:end -->';

export function parseArgs(argv) {
  const o = { host: '', scope: '', dir: '', home: '', tokenFile: '', dryRun: false };
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
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!['codex', 'cursor', 'copilot'].includes(o.host)) throw new Error('--host must be codex, cursor or copilot');
  o.scope = o.scope || 'project';
  return o;
}

// JSONC (VS Code's mcp.json): strip a BOM, comments and trailing commas. String-aware: text inside strings is never touched.
function parseJsonc(text, info = {}) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let out = '', i = 0, inStr = false; const commas = [];
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inStr) { out += c; if (c === '\\') { out += n ?? ''; i += 2; continue; } if (c === '"') inStr = false; i++; continue; }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { info.comments = true; while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { info.comments = true; i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; out += ' '; continue; }
    if (c === ',') commas.push(out.length);
    out += c; i++;
  }
  const drop = new Set();
  for (const at of commas) { let k = at + 1; while (k < out.length && /\s/.test(out[k])) k++; if (out[k] === '}' || out[k] === ']') drop.add(at); }
  if (drop.size) out = [...out].map((ch, idx) => (drop.has(idx) ? ' ' : ch)).join('');
  return out.trim() === '' ? {} : JSON.parse(out);
}

function readToken(file) {
  const t = readFileSync(file, 'utf8').split(/\r?\n/)[0].trim();
  if (!t) throw new Error('--token-file is empty');
  return t;
}

// Looks like a credential: a token/key/secret/password key with a literal (not ${VAR} / $VAR) value.
const SECRETISH = /(token|api[_-]?key|secret|password|authorization|bearer)["']?\s*[:=]\s*["']?(?!\$)[A-Za-z0-9_\-./+=]{8,}/i;

class Plan {
  // root: the folder everything is written under (project dir or home); backupRoot: where copies of changed files go (never inside the repo)
  constructor({ dryRun, root, backupRoot }) { this.dryRun = dryRun; this.root = root; this.backupRoot = backupRoot; this.ops = []; this.report = []; this.notes = []; }
  // every component below the root must be a plain directory/file, never a symlink
  check(file) {
    const rel = path.relative(this.root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${file} is outside ${this.root}; nothing was changed.`);
    let cur = this.root, st = null;
    for (const part of rel.split(path.sep)) {
      cur = path.join(cur, part); st = null;
      try { st = lstatSync(cur); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
      if (st.isSymbolicLink()) throw new Error(`${cur} is a symbolic link; refusing to read or write through it. Nothing was changed.`);
    }
    if (st && !st.isFile()) throw new Error(`${file} is not a regular file; nothing was changed.`);
    return st;
  }
  // validate now, write later (flush): a failure in any file means no file is touched
  write(file, content, { secret = false } = {}) {
    const st = this.check(file);
    const old = st ? readFileSync(file, 'utf8') : null;
    if (old === content) { this.report.push(`unchanged  ${file}`); return; }
    this.ops.push({ file, content, secret, st, old });
  }
  skip(file, why) { this.report.push(`skipped    ${file}: ${why}`); }
  note(s) { this.notes.push(s); }
  flush(host) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(this.backupRoot, host, stamp);
    let used = false;
    for (const { file, content, secret, st, old } of this.ops) {
      const oldMode = st ? st.mode & 0o777 : null;
      const mode = oldMode === null ? (secret ? 0o600 : 0o644) : (secret ? oldMode & 0o600 : oldMode); // never widen
      let backup = '';
      if (st) {
        backup = path.join(dir, file.split(path.sep).filter(Boolean).join('__'));
        if (!this.dryRun) {
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          if (!used) { for (let d = dir; ; d = path.dirname(d)) { chmodSync(d, 0o700); if (d === this.backupRoot) break; } used = true; }
          const fd = openSync(backup, 'wx', 0o600); // owner-only from the first byte
          try { writeSync(fd, old); } finally { closeSync(fd); }
        }
      }
      if (!this.dryRun) {
        mkdirSync(path.dirname(file), { recursive: true });
        const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
        const fd = openSync(tmp, 'wx', mode); // created with the final mode
        try { fchmodSync(fd, mode); writeSync(fd, content); } catch (e) { closeSync(fd); try { unlinkSync(tmp); } catch {} throw e; }
        closeSync(fd);
        renameSync(tmp, file);
      }
      this.report.push(`${this.dryRun ? 'would ' : ''}${st ? 'updated  ' : 'created  '} ${file}${st ? `\n           backup (outside the repo, owner-only): ${backup}` : ''}`);
      if (st && old && SECRETISH.test(old)) this.report.push(`WARNING    the previous ${file} contained what looks like a credential (yours or another server's). It is kept only in the backup above (mode 600); delete the backup when you no longer need it.`);
      if (this.comments?.has(file)) this.report.push(`NOTE       ${file} had comments; they were dropped from the new file. The original, with comments, is the backup above.`);
    }
  }
}

const readText = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');

function mergeJsonServer(plan, file, topKey, server, extra = {}, opts = {}) {
  let j = {}, bom = '';
  plan.check(file); const raw = readText(file);
  if (raw.trim()) {
    if (raw.charCodeAt(0) === 0xfeff) bom = '\ufeff';
    const info = {}; try { j = parseJsonc(raw, info); if (info.comments) (plan.comments ||= new Set()).add(file); } catch (e) { throw new Error(`${file} is not valid JSON (${e.message}); fix or move it, nothing was changed.`); }
  }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) throw new Error(`${file} does not contain a JSON object; nothing was changed.`);
  if (j[topKey] === undefined || j[topKey] === null) j[topKey] = {};
  if (typeof j[topKey] !== 'object' || Array.isArray(j[topKey])) throw new Error(`${file}: "${topKey}" must be a JSON object; nothing was changed.`);
  j[topKey][NAME] = server;
  for (const [k, fn] of Object.entries(extra)) j[k] = fn(j[k]);
  plan.write(file, bom + JSON.stringify(j, null, 2) + '\n', opts);
}

const eolOf = (t) => (t.includes('\r\n') ? '\r\n' : '\n');
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// replace a managed block (or append one) without String.replace special patterns and without mixing line endings
function spliceBlock(old, begin, end, bodyLines) {
  const eol = eolOf(old);
  const block = [begin, ...bodyLines, end].join(eol) + eol;
  const re = new RegExp(`${escRe(begin)}[\\s\\S]*?${escRe(end)}(\\r?\\n)?`);
  if (re.test(old)) return { text: old.replace(re, () => block), had: true };
  const trimmed = old.replace(/(\r?\n)*$/, '');
  return { text: (trimmed ? trimmed + eol + eol : '') + block, had: false };
}
function managedMarkdown(plan, file, snippet) {
  try { if (lstatSync(file).isSymbolicLink()) return plan.skip(file, 'it is a symbolic link; not touched. Add the MegaLens section to the real file yourself if you want it.'); } catch {}
  plan.write(file, spliceBlock(readText(file), MD_BEGIN, MD_END, snippet.trim().split('\n')).text);
}

const tomlStr = (s) => JSON.stringify(s);

function codexToml(plan, file, token) {
  plan.check(file);
  const old = readText(file);
  const body = [`[mcp_servers.${NAME}]`, 'command = "node"', `args = [${tomlStr(SERVER)}]`,
    'startup_timeout_sec = 20', 'tool_timeout_sec = 1800  # a review can take several minutes; the default is 60 s'];
  if (token) body.push(`[mcp_servers.${NAME}.env]`, `MEGALENS_TOKEN = ${tomlStr(token)}`);
  else body.push('env_vars = ["MEGALENS_TOKEN"]  # forwarded by name; the value never enters this file');
  const { text } = spliceBlock(old, BEGIN, END, body);
  // the result must be valid TOML with no duplicate table or key; otherwise change nothing
  try { checkToml(text); } catch (e) {
    let before = ''; try { checkToml(old); } catch (e2) { before = ` (the file as it is now is already not valid TOML for this checker: ${e2.message})`; }
    throw new Error(`${file} cannot take the MegaLens block: ${e.message}${before}. If it already defines mcp_servers.${NAME}, remove or rename that entry and run again. Nothing was changed.`);
  }
  plan.write(file, text, { secret: !!token });
}

export function install(opts) {
  const o = { ...opts };
  const project = path.resolve(o.dir || process.cwd());
  const home = path.resolve(o.home || homedir());
  const root = o.scope === 'global' ? home : project;
  const token = o.tokenFile ? readToken(o.tokenFile) : '';
  const plan = new Plan({ dryRun: o.dryRun, root, backupRoot: path.join(home, '.megalens', 'backups') });
  const stdio = (envObj) => ({ type: 'stdio', command: 'node', args: [SERVER], env: envObj });
  const workspaceEnv = o.scope === 'project' ? { MEGALENS_PROJECT_DIR: '${workspaceFolder}' } : {};

  if (o.host === 'codex') {
    codexToml(plan, path.join(root, '.codex', 'config.toml'), token);
    const skillDir = path.join(root, '.agents', 'skills', 'megalens-review');
    plan.write(path.join(skillDir, 'SKILL.md'), T.codexSkill());
    plan.write(path.join(skillDir, 'agents', 'openai.yaml'), T.codexSkillPolicy());
    if (o.scope === 'global') plan.write(path.join(root, '.codex', 'prompts', 'megalens-review.md'), T.codexPrompt()); // older Codex versions
    else managedMarkdown(plan, path.join(root, 'AGENTS.md'), T.agentsSnippet());
    plan.note('Run in Codex: type $megalens-review (or /skills, then pick it). Older Codex: /prompts:megalens-review. Project installs also add an AGENTS.md section. Restart Codex first.');
  } else if (o.host === 'cursor') {
    const env = { MEGALENS_TOKEN: token || '${env:MEGALENS_TOKEN}', ...workspaceEnv };
    mergeJsonServer(plan, path.join(root, '.cursor', 'mcp.json'), 'mcpServers', stdio(env), {}, { secret: !!token });
    plan.write(path.join(root, '.cursor', 'commands', 'megalens-review.md'), T.cursorCommand());
    if (o.scope === 'project') plan.write(path.join(root, '.cursor', 'rules', 'megalens-review.mdc'), T.cursorRule());
    else plan.note('Global Cursor rules live in Cursor Settings, not in a file; only the /megalens-review command was installed globally. For a global MCP entry Cursor starts the server in its own working folder, so prefer --project.');
    plan.note('Run in Cursor: /megalens-review in Agent chat (or @megalens-review). Cursor asks before the tool runs. Restart Cursor first.');
  } else {
    const ghCli = path.join(root, o.scope === 'global' ? path.join('.copilot', 'mcp-config.json') : path.join('.github', 'mcp.json'));
    const cliServer = { type: 'local', command: 'node', args: [SERVER], env: { MEGALENS_TOKEN: token || '${MEGALENS_TOKEN}' }, tools: ['*'] };
    mergeJsonServer(plan, ghCli, 'mcpServers', cliServer, {}, { secret: !!token });
    if (o.scope === 'project') {
      const inputs = (cur) => {
        const a = Array.isArray(cur) ? cur.filter((x) => x?.id !== 'megalens-token') : [];
        if (!token) a.push({ type: 'promptString', id: 'megalens-token', description: 'MegaLens MCP token (MEGALENS_TOKEN)', password: true });
        return a;
      };
      const env = { MEGALENS_TOKEN: token || '${input:megalens-token}', MEGALENS_PROJECT_DIR: '${workspaceFolder}' };
      mergeJsonServer(plan, path.join(root, '.vscode', 'mcp.json'), 'servers', stdio(env), { inputs }, { secret: !!token });
      plan.write(path.join(root, '.github', 'prompts', 'megalens-review.prompt.md'), T.copilotPrompt());
      plan.note('Run in VS Code: Copilot Chat, Agent mode, type /megalens-review. VS Code asks for the token once and stores it.');
    } else plan.note('Global install covers Copilot CLI only (~/.copilot/mcp-config.json). For VS Code use --project (its user-profile mcp.json path differs per OS).');
    plan.note('Run in Copilot CLI: start copilot in the repo and ask "review my change with MegaLens". Needs MEGALENS_TOKEN exported; if it reaches the server as the text ${MEGALENS_TOKEN}, update the CLI or use --token-file.');
  }
  plan.flush(o.host);
  plan.report.push(...plan.notes);
  if (token) plan.report.push(`WARNING: the token was written into the files above (mode 600). ${o.scope === 'project' ? 'Add them to .gitignore; never commit them.' : ''}`);
  return plan.report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const o = parseArgs(process.argv.slice(2));
    for (const l of install(o)) console.log(l);
  } catch (e) { console.error(`install: ${e.message}\nusage: node scripts/install.mjs --host codex|cursor|copilot [--project|--global] [--dir DIR] [--home DIR] [--token-file FILE] [--dry-run]`); process.exit(2); }
}
