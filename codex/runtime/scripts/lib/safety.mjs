// Shared safety rules for the collector and the local server: what must never be sent.
import { lstatSync, realpathSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Path rules, case-insensitive, matched against the repo-relative POSIX path.
export const SECRET_PATH_RE = new RegExp([
  String.raw`(^|/)\.env(\..*)?$`, String.raw`(^|/)\.envrc$`, String.raw`(^|/)[^/]*\.env$`,
  String.raw`\.(pem|key|p12|pfx|jks|keystore|ppk|gpg|asc|kdbx|tfvars|tfstate)(\.[^/]*)?$`,
  String.raw`\.tfstate\.backup$`, String.raw`(^|/)terraform\.tfvars(\.json)?$`,
  String.raw`(^|/)id_(rsa|dsa|ecdsa|ed25519)(_sk)?(\.[^/]*)?$`,
  String.raw`(^|/)credentials?(\.(json|ya?ml|toml|xml|ini|txt))?$`,
  String.raw`(^|/)secrets?(\.[^/]+)?$`, String.raw`(^|/)(service[-_]?account|gcloud|firebase-adminsdk)[^/]*\.json$`,
  String.raw`(^|/)\.aws/(credentials|config)$`, String.raw`(^|/)\.docker/config\.json$`, String.raw`(^|/)\.kube/config$`, String.raw`(^|/)kubeconfig[^/]*$`,
  String.raw`(^|/)\.git-credentials$`, String.raw`(^|/)\.pgpass$`, String.raw`(^|/)\.pypirc$`, String.raw`(^|/)\.netrc$`, String.raw`(^|/)_netrc$`,
  String.raw`(^|/)\.htpasswd$`, String.raw`(^|/)\.dockercfg$`, String.raw`(^|/)\.vault[-_]?pass[^/]*$`, String.raw`(^|/)\.s3cfg$`,
  String.raw`(^|/)authorized_keys$`,
].join('|'), 'i');
export const ENV_SAFE_RE = /(^|\/)\.env\.(example|sample|template|dist|defaults)$/i;
const RC_FILE_RE = /(^|\/)(\.npmrc|\.yarnrc(\.yml)?|\.bowerrc)$/i;
const RC_AUTH_RE = /(_authToken|_auth|_password|npmAuthToken|npmAuthIdent)\s*[=:]\s*\S/i;

export function secretPath(p) { return SECRET_PATH_RE.test(p) && !ENV_SAFE_RE.test(p); }

const CONTENT_PATTERNS = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/, 'private key'],
  [/\b(AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bgh[pousr]_[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_=-]+){2}|\bghs_[A-Za-z0-9_.-]{14,}[A-Za-z0-9_=-]|\bgh[pousr]_[A-Za-z0-9_]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/, 'GitHub token'],
  [/\bglpat-[A-Za-z0-9_-]{16,}/, 'GitLab token'],
  [/\bsk-(ant-|proj-|live-)?[A-Za-z0-9_-]{24,}/, 'API key (sk-)'],
  [/\b[sr]k_live_[A-Za-z0-9]{16,}/, 'Stripe live key'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/\bml_tok_[A-Za-z0-9_-]{16,}/, 'MegaLens token'],
  [/\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
];
// Returns a reason string if the text looks like it carries a credential, else null.
export function secretContent(text, p = '') {
  if (RC_FILE_RE.test(p) && RC_AUTH_RE.test(text)) return 'rc file with an auth token';
  for (const [re, why] of CONTENT_PATTERNS) if (re.test(text)) return why;
  return null;
}

// Strict range argument: --staged | REF | A..B | A...B. Never starts with '-', no whitespace or shell characters.
const REF = String.raw`[A-Za-z0-9_](?:(?!\.\.)[A-Za-z0-9._/@^~+-])*`;
const RANGE_RE = new RegExp(`^(${REF})?(\\.\\.\\.?)?(${REF})?$`);
export function validateRange(spec) {
  if (spec === undefined || spec === null || spec === '') return null;
  const s = String(spec).trim();
  if (s === '') return null;
  if (s === '--staged' || s === '--cached') return s;
  if (s.length > 200 || s.startsWith('-') || /\.\.\.\./.test(s) || !RANGE_RE.test(s) || s === '..' || s === '...') throw new Error(`invalid range argument ${JSON.stringify(s.slice(0, 60))}: use a ref, A..B, A...B or --staged`);
  return s;
}

// Read a file only if it is a regular file (not a symlink) whose real path stays inside the repo.
export function safeRead(root, rel) {
  const full = path.join(root, rel);
  let st; try { st = lstatSync(full); } catch { return { buf: null, why: 'unreadable' }; }
  if (st.isSymbolicLink()) return { buf: null, why: 'symlink' };
  if (!st.isFile()) return { buf: null, why: 'not a regular file' };
  let real, realRoot; try { real = realpathSync(full); realRoot = realpathSync(root); } catch { return { buf: null, why: 'unreadable' }; }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return { buf: null, why: 'outside the repository' };
  try { return { buf: readFileSync(full), why: null }; } catch { return { buf: null, why: 'unreadable' }; }
}

// Header of one `diff --git` section -> {a, b} paths (handles quoted C-style names; null when it cannot be parsed).
export function parseDiffHeader(line, knownNewPaths) {
  const rest = line.replace(/^diff --git /, '');
  const unq = (t) => t.replace(/(?:\\[0-7]{3})+|\\./g, (m) => {
    if (/^(?:\\[0-7]{3})+$/.test(m)) return Buffer.from(m.match(/[0-7]{3}/g).map((o) => parseInt(o, 8))).toString('utf8'); // escaped bytes are UTF-8
    return { '\\n': '\n', '\\t': '\t', '\\"': '"', '\\\\': '\\' }[m] ?? m.slice(1);
  });
  if (rest.startsWith('"') || /\s"b\//.test(rest)) {
    const toks = []; const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g; let m;
    while ((m = re.exec(rest))) toks.push(m[1] !== undefined ? unq(m[1]) : m[2]);
    if (toks.length === 2 && toks[1].startsWith('b/')) return { a: toks[0].replace(/^a\//, ''), b: toks[1].slice(2) };
  }
  // unquoted: names may contain spaces; resolve against the known changed paths first
  for (const p of knownNewPaths) if (rest.endsWith(` b/${p}`) && rest.startsWith('a/')) return { a: rest.slice(2, rest.length - p.length - 3), b: p };
  const m = rest.match(/^a\/(.*) b\/(.*)$/);
  if (m && m[1] === m[2]) return { a: m[1], b: m[2] };
  return null;
}

// Context files (not touched by the user's change) that commonly carry plain credentials: never pulled in as context.
export const CONTEXT_CONFIG_RE = new RegExp([
  String.raw`(^|/)database\.ya?ml$`, String.raw`(^|/)(local_|production_|prod_|dev_)?settings[^/]*\.py$`, String.raw`(^|/)wp-config[^/]*\.php$`,
  String.raw`\.(ini|conf|cfg|properties|toml)$`, String.raw`(^|/)application[^/]*\.(properties|ya?ml)$`, String.raw`(^|/)appsettings[^/]*\.json$`,
  String.raw`(^|/)(docker-)?compose[^/]*\.ya?ml$`, String.raw`(^|/)docker-compose[^/]*\.ya?ml$`, String.raw`(^|/)\.htpasswd$`,
  String.raw`(^|/)config/(secrets|credentials|master)[^/]*$`, String.raw`(^|/)(local|production|prod|staging)\.(json|ya?ml)$`,
  String.raw`(^|/)(config|configuration)\.(php|rb|ini)$`, String.raw`(^|/)\.?(my\.cnf|pgpass|boto)$`, String.raw`(^|/)(values|secrets?)[^/]*\.ya?ml$`,
  String.raw`(^|/)Dockerfile[^/]*$`,
].join('|'), 'i');
export const contextConfigSkip = (p) => CONTEXT_CONFIG_RE.test(p) && !ENV_SAFE_RE.test(p);

// Redact values of credential-style keys. Same number of lines (and characters per line may change), so line numbers still match.
const KEY = String.raw`[\w.-]*(?:pass(?:word|wd|phrase)?|secret|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|credentials?)[\w.-]*`;
const RED = '***REDACTED***';
const CONFIGISH = /\.(ya?ml|ini|env|properties|conf|cfg|cnf|toml|txt|example|sample|template|dist|envrc|sh|bash|zsh|mk)$|(^|\/)(\.env|Makefile|Dockerfile)/i;
const SECRETKEY = /pass|secret|private|credential|access[_-]?key/i;
const keep = (v, key) => { const t = v.trim().replace(/^["']|["']$/g, ''); return t === '' || t === RED || /^\$\{.*\}$|^\$\(.*\)$|^<.*>$|^%.*%$|^\{\{.*\}\}$/.test(t) || /^(true|false|null|none|nil|~)$/i.test(t) || (/^\d+$/.test(t) && !SECRETKEY.test(key)); };
const reQuoted = new RegExp(`(["']?(${KEY})["']?\\s*(?:=>|:=|=|:)\\s*)(["'])((?:(?!\\3).|\\\\.)*?)\\3`, 'gi');
const reDefine = new RegExp(`(define\\(\\s*["'](${KEY})["']\\s*,\\s*)(["'])((?:(?!\\3).)*?)\\3`, 'gi');
const reBare = new RegExp(`^((?:\\s*-\\s+)?\\s*(?:export\\s+)?["']?(${KEY})["']?\\s*[:=]\\s*)([^"'\\s#][^#\\n]*?)(\\s*(?:#.*)?)$`, 'i');
const reJsonBare = new RegExp(`(["'](${KEY})["']\\s*:\\s*)([^"'\\s,}\\]][^,}\\]\\n]*)`, 'gi');
const reXml = new RegExp(`(<(${KEY})(?:\\s[^>]*)?>)([^<]+)(</\\2>)`, 'gi');
export function redactSecrets(text, file = '', { diff = false } = {}) {
  let count = 0; const configish = CONFIGISH.test(file) || diff && false;
  const out = text.split('\n').map((full) => {
    let pre = ''; let line = full;
    if (diff) { if (/^(diff --git |index |--- |\+\+\+ |@@)/.test(full)) return full; pre = full.slice(0, 1); line = full.slice(1); }
    let l = line;
    l = l.replace(reDefine, (m, a, k, q, v) => (keep(v, k) ? m : (count++, `${a}${q}${RED}${q}`)));
    l = l.replace(reQuoted, (m, a, k, q, v) => (keep(v, k) ? m : (count++, `${a}${q}${RED}${q}`)));
    l = l.replace(reXml, (m, o, k, v, c) => (keep(v, k) ? m : (count++, `${o}${RED}${c}`)));
    l = l.replace(reJsonBare, (m, a, k, v) => (keep(v, k) ? m : (count++, `${a}"${RED}"`)));
    if (configish || diff) { const m = reBare.exec(l); if (m && !keep(m[3], m[2]) && (configish || CONFIGISH.test(file))) { count++; l = `${m[1]}${RED}${m[4]}`; } }
    return pre + l;
  });
  return { text: out.join('\n'), count };
}
