// Minimal zero-dependency TOML-aware path inspector for Codex config.toml.
// Collects defined table headers, dotted keys, and inline-table key paths while
// skipping comments, basic/literal/multiline strings, and arrays.

export function collectTomlPaths(src) {
  if (typeof src !== 'string') return [];
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  let i = 0;
  const eof = () => i >= src.length;
  const ws = () => { while (src[i] === ' ' || src[i] === '\t') i++; };
  const skipComment = () => { if (src[i] === '#') while (!eof() && src[i] !== '\n') i++; };
  const nl = () => {
    if (src[i] === '\r' && src[i + 1] === '\n') i++;
    if (src[i] === '\n') { i++; return true; }
    return false;
  };
  const wsNl = () => { for (;;) { ws(); skipComment(); if (!nl()) break; } };

  function basicString() {
    if (src.startsWith('"""', i)) {
      i += 3;
      let s = '';
      for (;;) {
        if (eof()) throw new Error('unterminated multi-line basic string');
        if (src[i] === '\\') {
          if (src[i + 1] === '\n' || (src[i + 1] === '\r' && src[i + 2] === '\n')) {
            i += src[i + 1] === '\r' ? 3 : 2;
            while (src[i] === ' ' || src[i] === '\t' || src[i] === '\r' || src[i] === '\n') i++;
            continue;
          }
          i += 2;
          continue;
        }
        if (src.startsWith('"""', i)) {
          i += 3;
          while (src[i] === '"') i++;
          return s;
        }
        s += src[i++];
      }
    }
    i++; // opening "
    let s = '';
    for (;;) {
      const c = src[i];
      if (c === undefined || c === '\n') throw new Error('unterminated basic string');
      if (c === '\\') {
        const n = src[i + 1];
        if (n === 'u') { s += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16) || 0); i += 6; continue; }
        if (n === 'U') { s += String.fromCodePoint(parseInt(src.slice(i + 2, i + 10), 16) || 0); i += 10; continue; }
        const map = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
        s += map[n] ?? n ?? '';
        i += 2;
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
      let s = '';
      for (;;) {
        if (eof()) throw new Error('unterminated multi-line literal string');
        if (src.startsWith("'''", i)) {
          i += 3;
          while (src[i] === "'") i++;
          return s;
        }
        s += src[i++];
      }
    }
    i++; // opening '
    let s = '';
    for (;;) {
      const c = src[i];
      if (c === undefined || c === '\n') throw new Error('unterminated literal string');
      if (c === "'") { i++; return s; }
      s += c;
      i++;
    }
  }

  function keyPart() {
    ws();
    const c = src[i];
    if (c === '"') return basicString();
    if (c === "'") return literalString();
    const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i, i + 256));
    if (!m) throw new Error('invalid key');
    i += m[0].length;
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
        throw new Error('invalid array');
      }
    }
    if (c === '{') {
      i++;
      wsNl();
      if (src[i] === '}') { i++; return; }
      for (;;) {
        wsNl();
        if (src[i] === '}') { i++; return; }
        const k = dottedKey();
        ws();
        if (src[i] !== '=') throw new Error('expected = in inline table');
        i++;
        const nextPrefix = prefix ? [...prefix, ...k] : null;
        if (nextPrefix) paths.push(nextPrefix);
        parseValue(nextPrefix);
        wsNl();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === '}') { i++; return; }
        throw new Error('invalid inline table');
      }
    }
    const m = /^[^\s,\]}#]+/.exec(src.slice(i, i + 256));
    if (!m) throw new Error('missing value');
    i += m[0].length;
    // Allow space-separated RFC 3339 date-time (e.g. 2026-11-23 12:00:00Z)
    if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(m[0]) && src[i] === ' ' && /[0-9]{2}:/.test(src.slice(i + 1, i + 4))) {
      i++;
      const t = /^[0-9:.]+([Zz]|[+-][0-9:]+)?/.exec(src.slice(i));
      if (t) i += t[0].length;
    }
  }

  let table = [];
  while (!eof()) {
    wsNl();
    if (eof()) break;
    if (src[i] === '[') {
      const isArr = src[i + 1] === '[';
      i += isArr ? 2 : 1;
      const p = dottedKey();
      ws();
      if (isArr) {
        if (src[i] !== ']' || src[i + 1] !== ']') throw new Error('bad array-table header');
        i += 2;
      } else {
        if (src[i] !== ']') throw new Error('bad table header');
        i++;
      }
      table = p;
      paths.push(p);
    } else {
      const p = dottedKey();
      ws();
      if (src[i] !== '=') throw new Error('expected =');
      i++;
      const full = [...table, ...p];
      paths.push(full);
      parseValue(full);
    }
    ws();
    skipComment();
    if (!eof() && !nl()) throw new Error('unexpected trailing text');
  }
  return paths;
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
