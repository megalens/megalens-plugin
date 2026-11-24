// Shared atomic, symlink-safe config planner and JSONC / Markdown / TOML helpers for host installers.
import { readFileSync, mkdirSync, existsSync, chmodSync, lstatSync, openSync, writeSync, fchmodSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import { checkToml } from './toml-check.mjs';

export const BEGIN = '# >>> megalens (managed block, safe to delete) >>>';
export const END = '# <<< megalens <<<';
export const MD_BEGIN = '<!-- megalens:begin -->';
export const MD_END = '<!-- megalens:end -->';

// Looks like a credential: a token/key/secret/password key with a literal (not ${VAR} / $VAR / {env:VAR}) value.
const SECRETISH = /(token|api[_-]?key|secret|password|authorization|bearer)["']?\s*[:=]\s*["']?(?!\$|\{env:)[A-Za-z0-9_\-./+=]{8,}/i;

// JSONC (VS Code's mcp.json, OpenCode's opencode.jsonc): strip a BOM, comments and trailing commas. String-aware: text inside strings is never touched.
export function parseJsonc(text, info = {}) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let out = '', i = 0, inStr = false;
  const commas = [];
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { info.comments = true; while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { info.comments = true; i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; out += ' '; continue; }
    if (c === ',') commas.push(out.length);
    out += c;
    i++;
  }
  const drop = new Set();
  for (const at of commas) {
    let k = at + 1;
    while (k < out.length && /\s/.test(out[k])) k++;
    if (out[k] === '}' || out[k] === ']') drop.add(at);
  }
  if (drop.size) out = [...out].map((ch, idx) => (drop.has(idx) ? ' ' : ch)).join('');
  return out.trim() === '' ? {} : JSON.parse(out);
}

export function readToken(file) {
  const t = readFileSync(file, 'utf8').split(/\r?\n/)[0].trim();
  if (!t) throw new Error('--token-file is empty');
  return t;
}

export const readText = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');

export class Plan {
  // root: the folder everything is written under (project dir or home); backupRoot: where copies of changed files go (never inside the repo)
  constructor({ dryRun, root, backupRoot }) {
    this.dryRun = dryRun;
    this.root = root;
    this.backupRoot = backupRoot;
    this.ops = [];
    this.report = [];
    this.notes = [];
  }

  // every component below the root must be a plain directory/file, never a symlink
  check(file) {
    const rel = path.relative(this.root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${file} is outside ${this.root}; nothing was changed.`);
    let cur = this.root, st = null;
    for (const part of rel.split(path.sep)) {
      cur = path.join(cur, part);
      st = null;
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
    const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`; // random suffix: two installs in the same millisecond must not share a backup name
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

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const cleanDisplay = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 300);
const SENTINEL_ORIGINS = new Set(['(invalid URL)', '(non-HTTP URL)', '(unparseable URL)']);
const DANGEROUS_ENV_KEYS = new Set([
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'node_use_env_proxy',
  'node_options',
  'node_path',
  'node_extra_ca_certs',
  'node_tls_reject_unauthorized',
  'ssl_cert_file',
  'ssl_cert_dir',
  'ld_preload',
  'ld_library_path',
  'dyld_insert_libraries',
  'dyld_library_path',
  'path',
  'pathext',
  'claude_project_dir',
  'megalens_allow_home',
  'megalens_audit_log',
]);

export function formatCustomUrlOrigin(raw) {
  if (typeof raw !== 'string') return '(invalid URL)';
  const trimmed = raw.trim();
  if (!trimmed) return '(invalid URL)';
  if (SENTINEL_ORIGINS.has(trimmed)) return trimmed;
  let url;
  try { url = new URL(trimmed); } catch { return '(unparseable URL)'; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '(non-HTTP URL)';
  // A host can expand variables in the authority after setup. Require a literal origin to confirm.
  if (/[${}]/.test(url.hostname) || [url.username, url.password].some((part) => /\$[\w{]|%7benv/i.test(part))) {
    return '(unparseable URL)';
  }
  return cleanDisplay(url.origin);
}

export function isOfficialMegaLensUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  let u;
  try { u = new URL(raw); } catch { return false; }
  return (
    u.protocol === 'https:'
    && !u.username
    && !u.password
    && u.hostname.toLowerCase() === 'megalens.ai'
    && u.port === ''
    && u.pathname === '/api/mcp'
  );
}

function isSameServerPath(a, b) {
  return typeof a === 'string' && typeof b === 'string' && path.resolve(a) === path.resolve(b);
}

export function isMegaLensOwnedServer(entry, incoming = null) {
  if (!isPlainObject(entry)) return false;
  for (const mapKey of ['headers', 'env', 'environment']) {
    if (entry[mapKey] !== undefined && !isPlainObject(entry[mapKey])) return false;
  }
  if (entry.tools !== undefined && !Array.isArray(entry.tools)) return false;
  const existingIsHosted = typeof entry.url === 'string' && entry.command === undefined && entry.args === undefined;
  const existingIsStdioObj = entry.url === undefined && entry.command === 'node' && Array.isArray(entry.args) && entry.args.length === 1 && typeof entry.args[0] === 'string';
  const existingIsStdioArr = entry.url === undefined && entry.args === undefined && Array.isArray(entry.command) && entry.command.length === 2 && entry.command[0] === 'node' && typeof entry.command[1] === 'string';

  if (incoming && isPlainObject(incoming)) {
    if (typeof incoming.url === 'string') {
      return existingIsHosted && isOfficialMegaLensUrl(entry.url);
    }
    if (incoming.command === 'node' && Array.isArray(incoming.args) && incoming.args.length === 1) {
      return existingIsStdioObj && isSameServerPath(entry.args[0], incoming.args[0]);
    }
    if (Array.isArray(incoming.command) && incoming.command.length === 2 && incoming.command[0] === 'node') {
      return existingIsStdioArr && isSameServerPath(entry.command[1], incoming.command[1]);
    }
    return false;
  }

  return existingIsHosted && isOfficialMegaLensUrl(entry.url);
}

function findEnvFileProperty(existing) {
  for (const [k, v] of Object.entries(existing)) {
    if (!/^env[_-]?files?$/i.test(k)) continue;
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    return k;
  }
  return null;
}

function findDangerousEnvVar(existing) {
  for (const mapKey of ['env', 'environment']) {
    const map = existing[mapKey];
    if (!isPlainObject(map)) continue;
    for (const [k, v] of Object.entries(map)) {
      if (!DANGEROUS_ENV_KEYS.has(k.toLowerCase())) continue;
      if (v === undefined || v === null || v === '') continue;
      return { mapKey, key: k };
    }
  }
  return null;
}

function findCustomMegaLensUrls(existing) {
  const found = [];
  for (const mapKey of ['env', 'environment']) {
    const map = existing[mapKey];
    if (!isPlainObject(map)) continue;
    for (const [k, v] of Object.entries(map)) {
      if (k.toLowerCase() !== 'megalens_url') continue;
      if (v === undefined || v === null || v === '') continue;
      if (!isOfficialMegaLensUrl(v)) {
        found.push({ mapKey, key: k, value: v });
      }
    }
  }
  return found;
}

export function promptConfirmCustomUrl({ input = process.stdin, output = process.stderr } = {}) {
  return async (customUrl, { file = '', serverKey = '' } = {}) => {
    const origin = formatCustomUrlOrigin(customUrl);
    if (!input || input.readableEnded || input.destroyed) return false;
    const where = [cleanDisplay(file), cleanDisplay(serverKey)].filter(Boolean).join(' ');
    output.write(
      `\n  WARNING: ${where || 'Existing MegaLens config'} sets a custom MEGALENS_URL:\n`
      + `    origin: ${origin}\n`
      + `  Continuing will configure MegaLens to send your token and code reviews to that endpoint instead of https://megalens.ai/api/mcp.\n`
      + `  Use this custom endpoint? [y/N]: `,
    );
    return await new Promise((resolve) => {
      let settled = false;
      const rl = readline.createInterface({ input, terminal: false });
      const done = (ok) => {
        if (settled) return;
        settled = true;
        input.removeListener('error', onErr);
        rl.close();
        resolve(ok);
      };
      const onErr = () => done(false);
      input.once('error', onErr);
      rl.once('line', (line) => done(/^y(?:es)?$/i.test(String(line).trim())));
      rl.once('close', () => done(false));
      rl.once('SIGINT', () => done(false));
    });
  };
}

function mergeOwnedServer(existing, incoming, plan, file, topKey, serverName, opts = {}) {
  const serverKey = `${topKey}.${serverName}`;
  const unsafeEnv = (reason) => Object.assign(
    new Error(`${file}: "${serverKey}" ${reason} Nothing was changed.`),
    { code: 'MEGALENS_UNSAFE_ENV' },
  );
  const envFileKey = findEnvFileProperty(existing);
  if (envFileKey) {
    throw unsafeEnv(
      `sets ${envFileKey}, which can override MEGALENS_URL or runtime settings. Remove ${envFileKey} or rename the entry and run again.`,
    );
  }

  const dangerEnv = findDangerousEnvVar(existing);
  if (dangerEnv) {
    throw unsafeEnv(
      `sets ${dangerEnv.mapKey}.${dangerEnv.key}, which can redirect network traffic or alter runtime execution. Remove ${dangerEnv.key} or rename the entry and run again.`,
    );
  }

  const customUrls = findCustomMegaLensUrls(existing);
  if (customUrls.length > 1) {
    throw unsafeEnv('defines multiple custom MEGALENS_URL entries. Remove duplicate MEGALENS_URL entries and run again.');
  }
  const customUrl = customUrls[0] || null;
  const customUrlOrigin = customUrl ? formatCustomUrlOrigin(customUrl.value) : '';
  if (customUrl) {
    if (SENTINEL_ORIGINS.has(customUrlOrigin)) {
      throw unsafeEnv(`sets a custom MEGALENS_URL (origin: ${customUrlOrigin}). Use a URL with a literal HTTP or HTTPS origin, or remove MEGALENS_URL and run again.`);
    }
    const hash = createHash('sha256').update(customUrl.value, 'utf8').digest('hex');
    const confirmKey = `${file}\0${hash}`;
    const confirmed = opts.allowCustomUrl === true || Boolean(opts.confirmedCustomUrls?.has(confirmKey));
    if (!confirmed) {
      const err = new Error(
        `${file}: "${topKey}.${serverName}" sets a custom MEGALENS_URL (origin: ${customUrlOrigin}). Refusing to configure a token against a non-MegaLens endpoint without explicit confirmation. Remove MEGALENS_URL to use https://megalens.ai/api/mcp, or confirm the custom endpoint explicitly. Nothing was changed.`,
      );
      err.code = 'MEGALENS_CUSTOM_URL';
      err.customUrlOrigin = customUrlOrigin;
      err.customUrlHash = hash;
      err.file = file;
      err.serverKey = serverKey;
      throw err;
    }
  }

  const merged = { ...existing, ...incoming };
  for (const mapKey of ['headers', 'env', 'environment']) {
    if (isPlainObject(existing[mapKey]) && isPlainObject(incoming[mapKey])) {
      const incomingLower = new Set(Object.keys(incoming[mapKey]).map((k) => k.toLowerCase()));
      const kept = {};
      for (const [k, v] of Object.entries(existing[mapKey])) {
        if (!incomingLower.has(k.toLowerCase())) kept[k] = v;
      }
      merged[mapKey] = { ...kept, ...incoming[mapKey] };
    }
  }
  if (customUrl) {
    const targetMapKey = isPlainObject(merged[customUrl.mapKey]) ? customUrl.mapKey : null;
    if (targetMapKey) {
      for (const k of Object.keys(merged[targetMapKey])) {
        if (k.toLowerCase() === 'megalens_url') delete merged[targetMapKey][k];
      }
      merged[targetMapKey][customUrl.key] = customUrl.value;
    }
    plan.note(`Kept confirmed custom MEGALENS_URL (origin: ${customUrlOrigin}) in ${file} (${serverKey}).`);
  }
  if (Array.isArray(existing.tools)) {
    merged.tools = [...existing.tools];
    if (existing.tools.length === 0) {
      plan.note(`Kept ${serverKey} tools disabled in ${file} (tools: []).`);
    }
  }
  if (existing.enabled === false) {
    merged.enabled = false;
    plan.note(`Kept ${topKey}.${serverName} disabled in ${file} (enabled: false).`);
  }
  if (existing.disabled === true) {
    merged.disabled = true;
    plan.note(`Kept ${topKey}.${serverName} disabled in ${file} (disabled: true).`);
  }
  return merged;
}

export function mergeJsonServer(plan, file, topKey, serverName, server, extra = {}, opts = {}) {
  let j = {}, bom = '';
  plan.check(file);
  const raw = readText(file);
  if (raw.trim()) {
    if (raw.charCodeAt(0) === 0xfeff) bom = '\ufeff';
    const info = {};
    try {
      j = parseJsonc(raw, info);
      if (info.comments) (plan.comments ||= new Set()).add(file);
    } catch {
      // JSON.parse errors can include snippets from credential-bearing config files.
      throw new Error(`${file} is not valid JSON; fix or move it, nothing was changed.`);
    }
  }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) throw new Error(`${file} does not contain a JSON object; nothing was changed.`);
  if (j[topKey] === undefined || j[topKey] === null) j[topKey] = {};
  if (typeof j[topKey] !== 'object' || Array.isArray(j[topKey])) throw new Error(`${file}: "${topKey}" must be a JSON object; nothing was changed.`);
  if (Object.prototype.hasOwnProperty.call(j[topKey], serverName)) {
    const existing = j[topKey][serverName];
    if (!isMegaLensOwnedServer(existing, server)) {
      throw new Error(`${file}: "${topKey}.${serverName}" already exists and is not managed by MegaLens; remove or rename it and run again. Nothing was changed.`);
    }
    j[topKey][serverName] = mergeOwnedServer(existing, server, plan, file, topKey, serverName, opts);
  } else {
    j[topKey][serverName] = server;
  }
  for (const [k, fn] of Object.entries(extra)) j[k] = fn(j[k], j);
  plan.write(file, bom + JSON.stringify(j, null, 2) + '\n', { secret: Boolean(opts.secret) });
}

const sha256Hex = (s) => createHash('sha256').update(s.replace(/\r\n/g, '\n'), 'utf8').digest('hex');

export function writeOwnedFile(plan, file, content, { commentStyle = 'html', secret = false } = {}) {
  const st = plan.check(file);
  const body = content.replace(/\r\n/g, '\n').replace(/\n*$/, '');
  const hash = sha256Hex(body);
  const marker = commentStyle === 'hash'
    ? `# megalens:managed sha256=${hash}`
    : `<!-- megalens:managed sha256=${hash} -->`;
  const stamped = `${body}\n${marker}\n`;
  if (st) {
    const old = readFileSync(file, 'utf8');
    if (old.replace(/\r\n/g, '\n') === stamped) {
      plan.write(file, old, { secret });
      return;
    }
    const re = commentStyle === 'hash'
      ? /\r?\n# megalens:managed sha256=([0-9a-f]{64})\r?\n?$/
      : /\r?\n<!-- megalens:managed sha256=([0-9a-f]{64}) -->\r?\n?$/;
    const m = old.match(re);
    const oldBody = m ? old.slice(0, m.index) : null;
    if (!m || sha256Hex(oldBody) !== m[1]) {
      throw new Error(`${file} already exists and has local customizations (or is not managed by MegaLens); move, rename, or remove it before running setup again. Nothing was changed.`);
    }
  }
  plan.write(file, stamped, { secret });
}

const eolOf = (t) => (t.includes('\r\n') ? '\r\n' : '\n');
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// replace a managed block (or append one) without String.replace special patterns and without mixing line endings
export function spliceBlock(old, begin, end, bodyLines) {
  const eol = eolOf(old);
  const block = [begin, ...bodyLines, end].join(eol) + eol;
  const re = new RegExp(`${escRe(begin)}[\\s\\S]*?${escRe(end)}(\\r?\\n)?`);
  if (re.test(old)) return { text: old.replace(re, () => block), had: true };
  const trimmed = old.replace(/(\r?\n)*$/, '');
  return { text: (trimmed ? trimmed + eol + eol : '') + block, had: false };
}

export function managedMarkdown(plan, file, snippet) {
  try {
    if (lstatSync(file).isSymbolicLink()) return plan.skip(file, 'it is a symbolic link; not touched. Add the MegaLens section to the real file yourself if you want it.');
  } catch {}
  plan.write(file, spliceBlock(readText(file), MD_BEGIN, MD_END, snippet.trim().split('\n')).text);
}

export const tomlStr = (s) => JSON.stringify(s);

export function codexToml(plan, file, serverName, serverPath, token, { hostedUrl = '' } = {}) {
  plan.check(file);
  const old = readText(file);
  const body = hostedUrl
    ? [
        `[mcp_servers.${serverName}]`,
        `url = ${tomlStr(hostedUrl)}`,
        ...(token ? [`http_headers = { "Authorization" = ${tomlStr(`Bearer ${token}`)} }`] : []),
      ]
    : [
        `[mcp_servers.${serverName}]`,
        'command = "node"',
        `args = [${tomlStr(serverPath)}]`,
        'startup_timeout_sec = 20',
        'tool_timeout_sec = 1800  # a review can take several minutes; the default is 60 s',
        ...(token
          ? [`[mcp_servers.${serverName}.env]`, `MEGALENS_TOKEN = ${tomlStr(token)}`]
          : ['env_vars = ["MEGALENS_TOKEN"]  # forwarded by name; the value never enters this file']),
      ];
  const { text } = spliceBlock(old, BEGIN, END, body);
  // the result must be valid TOML with no duplicate table or key; otherwise change nothing
  try { checkToml(text); } catch (e) {
    let before = '';
    try { checkToml(old); } catch (e2) { before = ` (the file as it is now is already not valid TOML for this checker: ${e2.message})`; }
    throw new Error(`${file} cannot take the MegaLens block: ${e.message}${before}. If it already defines mcp_servers.${serverName}, remove or rename that entry and run again. Nothing was changed.`);
  }
  plan.write(file, text, { secret: !!token });
}
