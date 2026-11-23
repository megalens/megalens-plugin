// Small TOML 1.0 syntax and duplicate-key checker (no dependencies). It validates; it does not build values.
// Throws Error('line N: reason') for invalid syntax, duplicate keys/tables, or a header that redefines a key.
export function checkToml(src) {
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1); // a leading BOM is allowed; the caller keeps it in the file
  let i = 0, line = 1;
  const fail = (m) => { throw new Error(`line ${line}: ${m}`); };
  const eof = () => i >= src.length;
  const ws = () => { while (src[i] === ' ' || src[i] === '\t') i++; };
  const skipComment = () => { if (src[i] === '#') while (!eof() && src[i] !== '\n') i++; };
  const nl = () => { if (src[i] === '\r' && src[i + 1] === '\n') i++; if (src[i] === '\n') { i++; line++; return true; } return false; };
  const wsNl = () => { for (;;) { ws(); skipComment(); if (!nl()) break; } };

  function basicString() { // at opening "
    if (src.startsWith('"""', i)) { i += 3; for (;;) { if (eof()) fail('unterminated multi-line string'); if (src[i] === '\\') { i += 2; continue; } if (src.startsWith('"""', i)) { i += 3; while (src[i] === '"') i++; return; } if (src[i] === '\n') line++; i++; } }
    i++; let s = '';
    for (;;) { const c = src[i]; if (c === undefined || c === '\n') fail('unterminated string'); if (c === '\\') { const n = src[i + 1]; if (n === 'u') { s += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16) || 0); i += 6; continue; } s += n === 'n' ? '\n' : n; i += 2; continue; } if (c === '"') { i++; return s; } s += c; i++; }
  }
  function literalString() {
    if (src.startsWith("'''", i)) { i += 3; for (;;) { if (eof()) fail('unterminated multi-line string'); if (src.startsWith("'''", i)) { i += 3; while (src[i] === "'") i++; return; } if (src[i] === '\n') line++; i++; } }
    i++; let s = ''; for (;;) { const c = src[i]; if (c === undefined || c === '\n') fail('unterminated string'); if (c === "'") { i++; return s; } s += c; i++; }
  }
  function keyPart() {
    ws(); const c = src[i];
    if (c === '"') { const s = basicString(); return typeof s === 'string' ? s : ''; }
    if (c === "'") { const s = literalString(); return typeof s === 'string' ? s : ''; }
    const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i, i + 200)); if (!m) fail('invalid key');
    i += m[0].length; return m[0];
  }
  function dottedKey() { const p = [keyPart()]; for (;;) { ws(); if (src[i] === '.') { i++; p.push(keyPart()); } else return p; } }
  function value() {
    ws(); const c = src[i];
    if (c === '"') { basicString(); return; }
    if (c === "'") { literalString(); return; }
    if (c === '[') { i++; for (;;) { wsNl(); if (src[i] === ']') { i++; return; } value(); wsNl(); if (src[i] === ',') { i++; continue; } if (src[i] === ']') { i++; return; } fail('bad array'); } }
    if (c === '{') { i++; const seen = new Set(); ws(); if (src[i] === '}') { i++; return; }
      for (;;) { const k = dottedKey(); ws(); if (src[i] !== '=') fail('expected ='); i++; const id = JSON.stringify(k); if (seen.has(id)) fail('duplicate key in inline table'); seen.add(id); value(); ws(); if (src[i] === ',') { i++; continue; } if (src[i] === '}') { i++; return; } fail('bad inline table'); } }
    const m = /^[^\s,\]}#]+/.exec(src.slice(i, i + 200));
    if (!m) fail('missing value');
    if (!/^(true|false|[+-]?(inf|nan)|[+-]?[0-9][0-9_]*(\.[0-9_]+)?([eE][+-]?[0-9_]+)?|0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|[0-9]{4}-[0-9]{2}-[0-9]{2}([Tt ][0-9:.]+([Zz]|[+-][0-9:]+)?)?|[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?)$/.test(m[0])) fail(`invalid value "${m[0].slice(0, 20)}"`);
    i += m[0].length;
    if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(m[0]) && src[i] === ' ' && /[0-9]{2}:/.test(src.slice(i + 1, i + 4))) { i++; const t = /^[0-9:.]+([Zz]|[+-][0-9:]+)?/.exec(src.slice(i)); if (t) i += t[0].length; }
  }

  const headers = new Set(), keys = new Set(), dotted = new Set(), arrays = new Set();
  const enc = (p) => JSON.stringify(p);
  const scopeOf = (p) => { const out = []; for (let n = 0; n < p.length; n++) { out.push(p[n]); const pre = enc(p.slice(0, n + 1)); if (arrays.has(pre) && n < p.length - 1) out.push(`#${cnt.get(pre)}`); } return out; };
  let table = [], scope = []; // scope = table path with array-table indexes
  const cnt = new Map();
  while (!eof()) {
    wsNl(); if (eof()) break;
    if (src[i] === '[') {
      const isArr = src[i + 1] === '['; i += isArr ? 2 : 1;
      const p = dottedKey(); ws();
      if (isArr) { if (src[i] !== ']' || src[i + 1] !== ']') fail('bad array-table header'); i += 2; } else { if (src[i] !== ']') fail('bad table header'); i++; }
      // each element of an array table has its own scope, indexed by how often the table has been opened
      // no proper prefix of a header path may already be a key (a scalar or an inline table cannot be extended)
      for (let n = 1; n < p.length; n++) { const pre = [...scopeOf(p.slice(0, n))]; if (keys.has(enc(pre))) fail(`[${p.join('.')}] extends "${p.slice(0, n).join('.')}", which is already a value or inline table`); }
      const upto = isArr ? p.length - 1 : p.length;
      const base = []; for (let n = 0; n < upto; n++) { base.push(p[n]); const pre = enc(p.slice(0, n + 1)); if (arrays.has(pre)) base.push(`#${cnt.get(pre)}`); }
      if (isArr) {
        const k = enc([...base, p[p.length - 1]]);
        if (headers.has(k) || keys.has(k)) fail(`[[${p.join('.')}]] redefines a table or key`);
        arrays.add(enc(p)); cnt.set(enc(p), (cnt.get(enc(p)) || 0) + 1);
        scope = [...base, p[p.length - 1], `#${cnt.get(enc(p))}`];
      } else {
        const k = enc(base);
        if (headers.has(k)) fail(`duplicate table [${p.join('.')}]`); if (keys.has(k)) fail(`[${p.join('.')}] redefines a key`); if (dotted.has(k)) fail(`[${p.join('.')}] was already defined by dotted keys`);
        headers.add(k); scope = base;
      }
      table = p;
    } else {
      const p = dottedKey(); ws(); if (src[i] !== '=') fail('expected ='); i++;
      const full = [...scope, ...p], k = enc(full);
      if (keys.has(k) || headers.has(k) || dotted.has(k) || false) fail(`duplicate key ${p.join('.')}`);
      keys.add(k); for (let n = 1; n < p.length; n++) dotted.add(enc([...scope, ...p.slice(0, n)]));
      value();
    }
    ws(); skipComment(); if (!eof() && !nl()) fail('unexpected text after value');
  }
  return true;
}
