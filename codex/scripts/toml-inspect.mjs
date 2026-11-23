// Zero-dependency TOML 1.0 / 1.1 validator, path inspector, and inline-table editor for Codex config.toml.
// Supports arbitrary-length bare keys/values (no substring cap), quoted/dotted keys,
// single-line and multiline inline tables (with optional trailing commas and comments),
// basic/literal/multiline strings (including TOML 1.1 \e and \xHH escapes), and arrays.

const BARE_KEY_RE = /[A-Za-z0-9_-]+/y;
const BARE_VAL_RE = /[^\s,\]}#]+/y;
const TIME_PART_RE = /[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?(?:[Zz]|[+-][0-9]{2}:[0-9]{2})?/y;
const SCALAR_VAL_RE = /^(?:true|false|[+-]?(?:inf|nan)|[+-]?(?:0|[1-9](?:_?[0-9])*)(?:\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?|0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*|[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[Tt ][0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?(?:[Zz]|[+-][0-9]{2}:[0-9]{2})?)?|[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?)$/;

function inspectToml(src) {
  if (typeof src !== 'string') return { paths: [], inlineTables: [] };
  const hasBom = src.charCodeAt(0) === 0xfeff;
  let i = hasBom ? 1 : 0;
  let line = 1;
  const fail = (m) => { throw new Error(`line ${line}: ${m}`); };
  const eof = () => i >= src.length;
  const ws = () => { while (src[i] === ' ' || src[i] === '\t') i++; };
  const skipComment = () => { if (src[i] === '#') while (!eof() && src[i] !== '\n') i++; };
  const nl = () => {
    if (src[i] === '\r' && src[i + 1] === '\n') i++;
    if (src[i] === '\n') { i++; line++; return true; }
    return false;
  };
  const wsNl = () => { for (;;) { ws(); skipComment(); if (!nl()) break; } };

  function hexDigits(len) {
    const h = src.slice(i, i + len);
    if (h.length !== len || !/^[0-9A-Fa-f]+$/.test(h)) fail('invalid hex escape');
    i += len;
    return parseInt(h, 16);
  }

  function decodeEscape() {
    const n = src[i];
    if (n === undefined) fail('unterminated escape');
    i++;
    if (n === 'b') return '\b';
    if (n === 't') return '\t';
    if (n === 'n') return '\n';
    if (n === 'f') return '\f';
    if (n === 'r') return '\r';
    if (n === 'e') return '\x1b';
    if (n === '"') return '"';
    if (n === '\\') return '\\';
    if (n === 'x') return String.fromCharCode(hexDigits(2));
    if (n === 'u') return String.fromCharCode(hexDigits(4));
    if (n === 'U') {
      const cp = hexDigits(8);
      if (cp > 0x10ffff) fail('invalid unicode code point');
      return String.fromCodePoint(cp);
    }
    fail(`invalid escape \\${n}`);
  }

  function basicString() {
    if (src.startsWith('"""', i)) {
      i += 3;
      if (src[i] === '\r' && src[i + 1] === '\n') { i += 2; line++; }
      else if (src[i] === '\n') { i++; line++; }
      let s = '';
      for (;;) {
        if (eof()) fail('unterminated multi-line basic string');
        if (src[i] === '\\') {
          let j = i + 1;
          while (src[j] === ' ' || src[j] === '\t') j++;
          if (src[j] === '\n' || (src[j] === '\r' && src[j + 1] === '\n')) {
            i = j + (src[j] === '\r' ? 2 : 1);
            line++;
            while (src[i] === ' ' || src[i] === '\t' || src[i] === '\r' || src[i] === '\n') {
              if (src[i] === '\n') line++;
              i++;
            }
            continue;
          }
          i++;
          s += decodeEscape();
          continue;
        }
        if (src.startsWith('"""', i)) {
          let q = 0;
          while (src[i + q] === '"') q++;
          if (q > 5) fail('too many quotes in multi-line basic string');
          s += '"'.repeat(q - 3);
          i += q;
          return s;
        }
        if (src[i] === '\n') line++;
        s += src[i++];
      }
    }
    i++; // opening "
    let s = '';
    for (;;) {
      const c = src[i];
      if (c === undefined || c === '\n' || c === '\r') fail('unterminated basic string');
      if (c === '\\') {
        i++;
        s += decodeEscape();
        continue;
      }
      if (c === '"') { i++; return s; }
      s += c;
      i++;
    }
  }

  function literalString() {
    if (src.startsWith("'''", i)) {
      i += 3;
      if (src[i] === '\r' && src[i + 1] === '\n') { i += 2; line++; }
      else if (src[i] === '\n') { i++; line++; }
      let s = '';
      for (;;) {
        if (eof()) fail('unterminated multi-line literal string');
        if (src.startsWith("'''", i)) {
          let q = 0;
          while (src[i + q] === "'") q++;
          if (q > 5) fail('too many quotes in multi-line literal string');
          s += "'".repeat(q - 3);
          i += q;
          return s;
        }
        if (src[i] === '\n') line++;
        s += src[i++];
      }
    }
    i++; // opening '
    let s = '';
    for (;;) {
      const c = src[i];
      if (c === undefined || c === '\n' || c === '\r') fail('unterminated literal string');
      if (c === "'") { i++; return s; }
      s += c;
      i++;
    }
  }

  function keyPart() {
    ws();
    const c = src[i];
    if (c === '"') {
      if (src.startsWith('"""', i)) fail('multi-line string not allowed as key');
      return basicString();
    }
    if (c === "'") {
      if (src.startsWith("'''", i)) fail('multi-line string not allowed as key');
      return literalString();
    }
    BARE_KEY_RE.lastIndex = i;
    const m = BARE_KEY_RE.exec(src);
    if (!m) fail('invalid key');
    i = BARE_KEY_RE.lastIndex;
    return m[0];
  }

  function dottedKey() {
    const parts = [keyPart()];
    for (;;) {
      ws();
      if (src[i] === '.') { i++; parts.push(keyPart()); }
      else return parts;
    }
  }

  const paths = [];
  const inlineTables = [];
  const enc = (p) => JSON.stringify(p);

  function parseValue(prefix) {
    ws();
    const c = src[i];
    if (c === '"') { basicString(); return; }
    if (c === "'") { literalString(); return; }
    if (c === '[') {
      i++;
      for (;;) {
        wsNl();
        if (src[i] === ']') { i++; return; }
        parseValue(null);
        wsNl();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === ']') { i++; return; }
        fail('invalid array');
      }
    }
    if (c === '{') {
      const openIdx = i;
      i++;
      wsNl();
      if (src[i] === '}') {
        const closeIdx = i;
        i++;
        if (prefix) {
          inlineTables.push({ path: prefix, openIdx, closeIdx, hasEntries: false, lastEntryEnd: openIdx + 1, trailingCommaIdx: -1 });
        }
        return;
      }
      const seenKeys = new Set();
      const seenDotted = new Set();
      let hasEntries = false;
      let lastEntryEnd = openIdx + 1;
      let trailingCommaIdx = -1;
      for (;;) {
        wsNl();
        if (src[i] === '}') {
          const closeIdx = i;
          i++;
          if (prefix) {
            inlineTables.push({ path: prefix, openIdx, closeIdx, hasEntries, lastEntryEnd, trailingCommaIdx });
          }
          return;
        }
        const k = dottedKey();
        ws();
        if (src[i] !== '=') fail('expected = in inline table');
        i++;
        for (let n = 1; n < k.length; n++) {
          const pre = enc(k.slice(0, n));
          if (seenKeys.has(pre)) fail(`cannot extend key "${k.slice(0, n).join('.')}" in inline table`);
          seenDotted.add(pre);
        }
        const id = enc(k);
        if (seenKeys.has(id) || seenDotted.has(id)) fail('duplicate key in inline table');
        seenKeys.add(id);

        const nextPrefix = prefix ? [...prefix, ...k] : null;
        if (nextPrefix) paths.push(nextPrefix);
        parseValue(nextPrefix);
        hasEntries = true;
        lastEntryEnd = i;
        trailingCommaIdx = -1;
        wsNl();
        if (src[i] === ',') { trailingCommaIdx = i; i++; continue; }
        if (src[i] === '}') {
          const closeIdx = i;
          i++;
          if (prefix) {
            inlineTables.push({ path: prefix, openIdx, closeIdx, hasEntries, lastEntryEnd, trailingCommaIdx });
          }
          return;
        }
        fail('invalid inline table');
      }
    }
    BARE_VAL_RE.lastIndex = i;
    const m = BARE_VAL_RE.exec(src);
    if (!m) fail('missing value');
    let rawVal = m[0];
    i = BARE_VAL_RE.lastIndex;
    // Allow space-separated RFC 3339 date-time (e.g. 2026-11-23 12:00:00Z or 2026-11-23 12:00)
    if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(rawVal) && src[i] === ' ') {
      TIME_PART_RE.lastIndex = i + 1;
      const tm = TIME_PART_RE.exec(src);
      if (tm) {
        rawVal += ` ${tm[0]}`;
        i = TIME_PART_RE.lastIndex;
      }
    }
    if (!SCALAR_VAL_RE.test(rawVal)) fail(`invalid value "${rawVal.slice(0, 20)}"`);
  }

  const headers = new Set();
  const keys = new Set();
  const dotted = new Set();
  const arrays = new Set();
  const cnt = new Map();
  const scopeOf = (p) => {
    const out = [];
    for (let n = 0; n < p.length; n++) {
      out.push(p[n]);
      const pre = enc(p.slice(0, n + 1));
      if (arrays.has(pre) && n < p.length - 1) out.push(`#${cnt.get(pre)}`);
    }
    return out;
  };

  let table = [];
  let scope = [];
  while (!eof()) {
    wsNl();
    if (eof()) break;
    if (src[i] === '[') {
      const isArr = src[i + 1] === '[';
      i += isArr ? 2 : 1;
      const p = dottedKey();
      ws();
      if (isArr) {
        if (src[i] !== ']' || src[i + 1] !== ']') fail('bad array-table header');
        i += 2;
      } else {
        if (src[i] !== ']') fail('bad table header');
        i++;
      }
      for (let n = 1; n < p.length; n++) {
        const pre = scopeOf(p.slice(0, n));
        if (keys.has(enc(pre))) {
          fail(`[${p.join('.')}] extends "${p.slice(0, n).join('.')}", which is already a value or inline table`);
        }
      }
      const upto = isArr ? p.length - 1 : p.length;
      const base = [];
      for (let n = 0; n < upto; n++) {
        base.push(p[n]);
        const pre = enc(p.slice(0, n + 1));
        if (arrays.has(pre)) base.push(`#${cnt.get(pre)}`);
      }
      if (isArr) {
        const k = enc([...base, p[p.length - 1]]);
        if (headers.has(k) || keys.has(k) || dotted.has(k)) fail(`[[${p.join('.')}]] redefines a table or key`);
        arrays.add(enc(p));
        cnt.set(enc(p), (cnt.get(enc(p)) || 0) + 1);
        scope = [...base, p[p.length - 1], `#${cnt.get(enc(p))}`];
      } else {
        const k = enc(base);
        if (headers.has(k)) fail(`duplicate table [${p.join('.')}]`);
        if (keys.has(k)) fail(`[${p.join('.')}] redefines a key`);
        if (dotted.has(k)) fail(`[${p.join('.')}] was already defined by dotted keys`);
        headers.add(k);
        scope = base;
      }
      table = p;
      paths.push(p);
    } else {
      const p = dottedKey();
      ws();
      if (src[i] !== '=') fail('expected =');
      i++;
      for (let n = 1; n < p.length; n++) {
        const pre = enc([...scope, ...p.slice(0, n)]);
        if (keys.has(pre)) fail(`cannot extend key "${p.slice(0, n).join('.')}"`);
        dotted.add(pre);
      }
      const scopedKey = enc([...scope, ...p]);
      if (keys.has(scopedKey) || headers.has(scopedKey) || dotted.has(scopedKey)) {
        fail(`duplicate key ${p.join('.')}`);
      }
      keys.add(scopedKey);
      const full = [...table, ...p];
      paths.push(full);
      parseValue(full);
    }
    ws();
    skipComment();
    if (!eof() && !nl()) fail('unexpected trailing text');
  }
  return { paths, inlineTables };
}

/** Validate TOML 1.0 / 1.1 syntax and key/table uniqueness. Returns true or throws Error('line N: ...'). */
export function validateToml(src) {
  inspectToml(src);
  return true;
}

export function collectTomlPaths(src) {
  return inspectToml(src).paths;
}

/** True if `src` defines `targetPath` (or any sub-key/table under it). Returns false if `src` is not valid TOML. */
export function hasTomlPath(src, targetPath) {
  if (!Array.isArray(targetPath) || targetPath.length === 0) return false;
  let paths;
  try {
    paths = collectTomlPaths(src);
  } catch {
    return false;
  }
  return paths.some(
    (p) => p.length >= targetPath.length && targetPath.every((seg, idx) => p[idx] === seg),
  );
}

/**
 * Find the character span of an inline table assigned to `targetPath` (e.g. `mcp_servers = { ... }`).
 * Returns `{ path, openIdx, closeIdx, hasEntries, lastEntryEnd, trailingCommaIdx }` or `null`.
 */
export function findTomlInlineTable(src, targetPath) {
  if (!Array.isArray(targetPath) || targetPath.length === 0) return null;
  let inlineTables;
  try {
    inlineTables = inspectToml(src).inlineTables;
  } catch {
    return null;
  }
  return inlineTables.find(
    (t) => t.path.length === targetPath.length && targetPath.every((seg, idx) => t.path[idx] === seg),
  ) ?? null;
}

/**
 * Insert `key = value` into an inline table span returned by `findTomlInlineTable`.
 * Preserves existing entries, formatting, comments, and surrounding lines.
 */
export function insertIntoTomlInlineTable(src, span, key, valueExpr) {
  if (!span.hasEntries) {
    const inner = src.slice(span.openIdx + 1, span.closeIdx);
    if (inner.includes('\n')) {
      const eol = inner.includes('\r\n') ? '\r\n' : '\n';
      return `${src.slice(0, span.closeIdx)}  ${key} = ${valueExpr}${eol}${src.slice(span.closeIdx)}`;
    }
    return `${src.slice(0, span.openIdx)}{ ${key} = ${valueExpr} }${src.slice(span.closeIdx + 1)}`;
  }
  if (span.trailingCommaIdx >= 0) {
    const insertAt = span.trailingCommaIdx + 1;
    return `${src.slice(0, insertAt)} ${key} = ${valueExpr}${src.slice(insertAt)}`;
  }
  return `${src.slice(0, span.lastEntryEnd)}, ${key} = ${valueExpr}${src.slice(span.lastEntryEnd)}`;
}
