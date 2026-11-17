#!/usr/bin/env node
// MegaLens review collector. No dependencies: Node >= 18 and git.
// Usage: node collect.mjs [REF | A..B | A...B | --staged] [--max-bytes N] [--cwd DIR] [--out FILE] [--json]
// Prints: a short MANIFEST, then the bundle between BUNDLE START / BUNDLE END markers.
// The bundle is: === DIFF === block, then `=== FILE: path ===` blocks in a fixed priority order.
// Deterministic: same repo state + same arguments = byte-identical output.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { secretPath, secretContent, validateRange, safeRead, parseDiffHeader, redactSecrets, contextConfigSkip } from './lib/safety.mjs';

const DEFAULT_MAX = 90_000; // bytes of bundle the host has to retype; see README "size limits"
const HARD_MAX = 700_000; // never exceed, whatever the caller asks (server limit is 1 MB per call)
const RULES_MAX = 8_000;
const FILE_WHOLE_MAX = 60_000; // changed files above this are windowed around the changes
const CTX_FILE_MAX = 14_000; // context files above this are windowed around the matches
const MAX_CONTEXT_FILES = 40;

// ---------- args
const argv = process.argv.slice(2);
let maxBytes = Number(process.env.MEGALENS_MAX_BYTES) || DEFAULT_MAX;
let cwd = process.cwd();
let outFile = null;
let spec = null;
let staged = false;
let asJson = false;
const need = (i, name) => { if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) die(`${name} needs a value`); return argv[i + 1]; };
let argsStdin = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--max-bytes') maxBytes = Number(need(i++, a));
  else if (a === '--cwd') cwd = path.resolve(need(i++, a));
  else if (a === '--out') outFile = need(i++, a);
  else if (a === '--staged' || a === '--cached') staged = true;
  else if (a === '--json') asJson = true;
  else if (a === '--args-stdin') argsStdin = true;
  else if (a.startsWith('-')) die(`unknown option ${a}`);
  else if (spec === null) spec = a;
  else die('only one ref or range argument is accepted');
}
// Slash-command path: the range comes on stdin (never interpolated into a shell command line) and is validated strictly.
if (argsStdin) {
  const raw = readFileSync(0, 'utf8').trim();
  if (raw.includes('\n')) die('the range argument must be a single line');
  let v; try { v = validateRange(raw); } catch (e) { die(e.message); }
  if (v === '--staged' || v === '--cached') staged = true; else if (v) { if (spec !== null) die('only one ref or range argument is accepted'); spec = v; }
}
try { if (spec !== null) spec = validateRange(spec); } catch (e) { die(e.message); }
if (!Number.isFinite(maxBytes) || maxBytes < 2000) die('--max-bytes must be a number >= 2000');
maxBytes = Math.min(maxBytes, HARD_MAX);

function die(m) { process.stderr.write(`megalens collect: ${m}\n`); process.exit(2); }
function git(args, opts = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: opts.buffer ? 'buffer' : 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (opts.okStatus && e.status === opts.okStatus) return e.stdout;
    if (opts.soft) return null;
    die(`git ${args.join(' ')} failed: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
  }
}
const bytes = (s) => Buffer.byteLength(s, 'utf8');

// ---------- repo + base
const top = (git(['rev-parse', '--show-toplevel'], { soft: true }) || '').trim();
if (!top) die('not inside a git repository');
cwd = top;
const hasHead = git(['rev-parse', '--verify', '-q', 'HEAD'], { soft: true }) !== null;

function defaultBase() {
  if (!hasHead) return null;
  const cands = [];
  const sym = (git(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], { soft: true }) || '').trim();
  if (sym) cands.push(sym.replace('refs/remotes/', ''));
  cands.push('origin/main', 'origin/master', 'main', 'master');
  for (const c of cands) {
    if (git(['rev-parse', '--verify', '-q', c], { soft: true }) === null) continue;
    const mb = (git(['merge-base', c, 'HEAD'], { soft: true }) || '').trim();
    if (mb) return { base: mb, label: `merge-base(${c}, HEAD)` };
  }
  return { base: 'HEAD', label: 'HEAD' };
}

let diffArgs; // args after `git diff`
let label;
let endRef = null; // null = read post-change content from the working tree
let includeUntracked = true;
if (staged) {
  diffArgs = ['--cached', ...(hasHead ? ['HEAD'] : [])]; label = 'staged changes vs HEAD'; includeUntracked = false;
} else if (spec && spec.includes('...')) {
  const [a, b] = spec.split('...'); diffArgs = [`${a}...${b || 'HEAD'}`]; endRef = b || 'HEAD'; label = `range ${spec}`; includeUntracked = false;
} else if (spec && spec.includes('..')) {
  const [a, b] = spec.split('..'); diffArgs = [`${a}..${b || 'HEAD'}`]; endRef = b || 'HEAD'; label = `range ${spec}`; includeUntracked = false;
} else if (spec) {
  const mb = (git(['merge-base', spec, 'HEAD'], { soft: true }) || '').trim();
  if (!mb) die(`cannot resolve ref ${spec}`);
  diffArgs = [mb]; label = `working tree vs merge-base(${spec}, HEAD)`;
} else {
  const d = defaultBase();
  if (!d) { diffArgs = ['--cached']; label = 'initial commit (staged)'; }
  else { diffArgs = [d.base]; label = `working tree vs ${d.label}`; }
}

// ---------- classification
const LOCK_NAMES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'Cargo.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'go.sum', 'composer.lock', 'Gemfile.lock', 'Podfile.lock', 'mix.lock', 'pubspec.lock', 'flake.lock', 'gradle.lockfile', 'packages.lock.json', 'deno.lock']);
const VENDOR_RE = /(^|\/)(node_modules|vendor|vendors|third_party|dist|build|out|target|\.next|\.nuxt|__pycache__|\.venv|venv|coverage|\.gradle|Pods)\//;
const GENERATED_NAME_RE = /(\.min\.(js|css)|\.map|\.pb\.go|_pb2(_grpc)?\.py|\.pb\.(h|cc)|\.generated\.\w+|_generated\.\w+|\.gen\.\w+|\.snap|\.svg|\.ipynb)$|(^|\/)(__generated__|generated)\//;
const BINARY_EXT_RE = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|so|dylib|dll|exe|bin|o|a|wasm|woff2?|ttf|otf|eot|mp[34]|mov|avi|webm|ogg|wav|sqlite3?|db|pyc|psd|ai|keystore)$/i;

function skipReason(p, content) {
  const base = path.posix.basename(p);
  if (secretPath(p)) return 'secret-looking file';
  if (LOCK_NAMES.has(base) || /\.lock$/.test(base)) return 'lockfile';
  if (VENDOR_RE.test(p)) return 'vendored/build output';
  if (GENERATED_NAME_RE.test(p)) return 'generated/binary-like';
  if (BINARY_EXT_RE.test(p)) return 'binary';
  if (content) {
    if (content.subarray(0, 8000).includes(0)) return 'binary';
    const head = content.subarray(0, 600).toString('utf8');
    if (/(@generated|DO NOT EDIT|auto-?generated|autogenerated|Code generated by)/i.test(head)) return 'generated';
    const sc = secretContent(content.toString('utf8'), p); if (sc) return `secret-looking content (${sc})`;
  }
  return null;
}

// ---------- diff
const rawDiff = git(['diff', '--no-color', '--no-ext-diff', '--find-renames', '-U3', ...diffArgs, '--']);
let diffText = rawDiff;
const untracked = [];
if (includeUntracked) {
  const u = git(['ls-files', '--others', '--exclude-standard', '-z'], { soft: true }) || '';
  for (const f of u.split('\0').filter(Boolean).sort()) untracked.push(f);
}
const nameStatus = git(['diff', '--no-color', '--find-renames', '--name-status', '-z', ...diffArgs, '--']).split('\0').filter(Boolean);
const changed = []; // {path, status}
for (let i = 0; i < nameStatus.length;) {
  const st = nameStatus[i++];
  if (st[0] === 'R' || st[0] === 'C') { i++; changed.push({ path: nameStatus[i++], status: st[0] }); }
  else changed.push({ path: nameStatus[i++], status: st[0] });
}
const excluded = []; // {path, reason}
const redactions = []; // {path, count}
const redact = (text, file, opts) => { const r = redactSecrets(text, file, opts); if (r.count) { const e = redactions.find((x) => x.path === file); if (e) e.count += r.count; else redactions.push({ path: file, count: r.count }); } return r.text; };
const untrackedIncluded = [];
for (const f of untracked) {
  const { buf, why: rwhy } = safeRead(cwd, f);
  if (!buf) { excluded.push({ path: f, reason: `untracked, ${rwhy}` }); continue; }
  const why = skipReason(f, buf) || (buf.length > 400_000 ? 'too large' : null);
  if (why) { excluded.push({ path: f, reason: `untracked, ${why}` }); continue; }
  const d = git(['diff', '--no-color', '--no-index', '--', '/dev/null', f], { okStatus: 1 });
  if (d) { diffText += d.replace(/^diff --git a\/dev\/null b\//m, 'diff --git a/').replace(/^diff --git a\/(.*) b\/.*$/m, `diff --git a/${f} b/${f}`); changed.push({ path: f, status: 'A' }); untrackedIncluded.push(f); }
}

// Drop diff sections for files we skip (lockfiles, binaries, generated, secrets): they only burn the budget.
function splitDiff(text) {
  const known = changed.map((c) => c.path).sort((x, y) => y.length - x.length);
  const parts = text.split(/^(?=diff --git )/m).filter(Boolean);
  return parts.map((p) => {
    const h = parseDiffHeader(p.split('\n', 1)[0], known);
    return { file: h ? h.b : null, text: p };
  });
}
const sections = splitDiff(diffText);
const keptSections = [];
for (const s of sections) {
  if (s.file === null) { excluded.push({ path: '(unparseable diff header)', reason: 'changed, path could not be parsed, diff omitted (fail closed)' }); continue; }
  const isBinaryDiff = /^Binary files |^GIT binary patch/m.test(s.text);
  const why = skipReason(s.file, null) || (isBinaryDiff ? 'binary' : null) || (() => { const sc = secretContent(s.text, s.file); return sc ? `secret-looking content (${sc})` : null; })();
  if (why) { excluded.push({ path: s.file, reason: `changed, ${why} (diff omitted)` }); continue; }
  keptSections.push({ ...s, text: redact(s.text, s.file, { diff: true }) });
}
const changeSize = (s) => (s.text.match(/^[+-](?![+-])/gm) || []).length;
// Diff budget: at most 45% of the bundle; the largest sections lose their tail first.
let diffBudget = Math.floor(maxBytes * 0.45);
const diffNotes = [];
let diffBlocks = keptSections.map((s) => ({ ...s, n: changeSize(s), text: s.text }));
const diffTotal = diffBlocks.reduce((a, s) => a + bytes(s.text), 0);
const diffOmitted = [];
if (diffTotal > diffBudget) {
  // Hard cap: sections are served in priority order (most changed lines first) from a shrinking remainder; no per-file floor.
  const order = diffBlocks.map((s, i) => ({ i, n: s.n, f: s.file })).sort((x, y) => y.n - x.n || (x.f < y.f ? -1 : 1));
  let remaining = diffBudget; let left = order.length; const result = new Array(diffBlocks.length).fill(null);
  for (const o of order) {
    const s = diffBlocks[o.i]; const fair = Math.floor(remaining / left); left--;
    const note = (b) => `[... diff for ${s.file} truncated by MegaLens collector: ${b} bytes left out ...]\n`;
    if (bytes(s.text) <= Math.max(fair, 0)) { result[o.i] = s; remaining -= bytes(s.text); continue; }
    const room = fair - bytes(note(9999999));
    if (room < 200) { diffOmitted.push(s.file); continue; }
    let t = Buffer.from(s.text).subarray(0, room).toString('utf8'); t = t.slice(0, t.lastIndexOf('\n') + 1);
    const out = { ...s, text: t + note(bytes(s.text) - bytes(t)) };
    diffNotes.push(s.file); result[o.i] = out; remaining -= bytes(out.text);
  }
  diffBlocks = result.filter(Boolean);
}
const diffOut = diffBlocks.map((s) => s.text).join('');
const diffBytes = bytes(diffOut);

// ---------- changed files, full post-change content
function modeOf(p) { // git file mode of p at the content source, to refuse symlinks in index / commit modes
  if (endRef) { const o = git(['ls-tree', endRef, '--', p], { soft: true }) || ''; return o.split(' ')[0]; }
  if (staged) { const o = git(['ls-files', '-s', '--', p], { soft: true }) || ''; return o.split(' ')[0]; }
  return '';
}
function readPostChange(p) {
  if (endRef || staged) {
    if (modeOf(p) === '120000') return null;
    return git(['show', endRef ? `${endRef}:${p}` : `:${p}`], { buffer: true, soft: true });
  }
  return safeRead(cwd, p).buf;
}
function lineWindows(text, patterns, radius, limit) {
  const lines = text.split('\n');
  const hit = new Set();
  lines.forEach((l, i) => { if (patterns.some((re) => re.test(l))) hit.add(i); });
  const keep = new Set();
  for (const i of [...hit].sort((a, b) => a - b)) for (let j = Math.max(0, i - radius); j <= Math.min(lines.length - 1, i + radius); j++) keep.add(j);
  const out = []; let prev = -2; let size = 0;
  for (const j of [...keep].sort((a, b) => a - b)) {
    if (j !== prev + 1) out.push(`[... lines ${prev + 2}-${j} omitted ...]`);
    const piece = `${j + 1}: ${lines[j]}`; size += piece.length + 1; if (size > limit) { out.push('[... further matches omitted ...]'); break; }
    out.push(piece); prev = j;
  }
  if (prev < lines.length - 1) out.push(`[... lines ${prev + 2}-${lines.length} omitted ...]`);
  return out.join('\n');
}
function changedLineRanges(file) {
  const sec = keptSections.find((s) => s.file === file); if (!sec) return [];
  const r = []; for (const m of sec.text.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) r.push([Number(m[1]), Number(m[1]) + Number(m[2] ?? 1) - 1]);
  return r;
}

const candidates = []; // changed files: {path, kind:'changed', text (whole), size, ranges}
const changedPaths = new Set(changed.map((c) => c.path));
const deletedPaths = new Set(changed.filter((c) => c.status === 'D').map((c) => c.path));
const changedOrdered = keptSections.filter((s) => !deletedPaths.has(s.file)).sort((a, b) => b.n - a.n || (a.file < b.file ? -1 : 1));
for (const s of changedOrdered) {
  const buf = readPostChange(s.file);
  if (!buf) { excluded.push({ path: s.file, reason: 'changed, content unreadable or a symlink' }); continue; }
  const why = skipReason(s.file, buf); if (why) { excluded.push({ path: s.file, reason: `changed, ${why}` }); continue; }
  candidates.push({ path: s.file, kind: 'changed', text: redact(buf.toString('utf8'), s.file), size: buf.length, ranges: changedLineRanges(s.file) });
}
function windowText(text, ranges, radius) {
  const lines = text.split('\n'); const keep = new Set();
  for (const [a, b] of ranges) for (let l = Math.max(1, a - radius); l <= Math.min(lines.length, Math.max(a, b) + radius); l++) keep.add(l);
  if (!keep.size) for (let l = 1; l <= Math.min(lines.length, 80); l++) keep.add(l);
  const out = []; let prev = 0;
  for (const l of [...keep].sort((x, y) => x - y)) { if (l !== prev + 1) out.push(`[... lines ${prev + 1}-${l - 1} omitted ...]`); out.push(`${l}: ${lines[l - 1]}`); prev = l; }
  if (prev < lines.length) out.push(`[... lines ${prev + 1}-${lines.length} omitted ...]`);
  return out.join('\n');
}

// ---------- context: tests, definitions, callers, config
const STOP = new Set('if else for while return function const let var class def import from export default new this self true false null none undefined void int string bool boolean float double char long short byte public private protected static final async await try catch finally throw throws switch case break continue in of is not and or with as pass lambda yield print println len range type interface enum struct impl fn func package use mod pub match where then end do begin let mut ref str list dict map set get put post delete update create find find_one find_all assert expect describe test it require module exports console log error warn info debug length push pop slice splice join split includes indexOf toString valueOf constructor super extends implements Promise Array Object String Number Boolean JSON Math Date Error Map Set RegExp Buffer open read write close format main init'.split(' '));
const DEF_RE = [
  /\b(?:function\*?|def|fn|func|class|interface|struct|enum|trait|type|impl|object|record)\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:const|let|var|val|export\s+const)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/g,
  /^\s*(?:public|private|protected|internal|static|override|suspend|async|open|abstract|final|\s)*(?:[\w<>\[\],?.]+\s+)([A-Za-z_$][\w$]*)\s*\([^;{)]*\)\s*(?:\{|:|=>|throws)/gm,
];
const symDefined = new Set(); const symCalled = new Set(); const envNames = new Set(); const literalFiles = new Set();
for (const s of keptSections) {
  for (const m of s.text.matchAll(/^@@ [^@]*@@\s*(.*)$/gm)) {
    for (const re of DEF_RE) for (const d of m[1].matchAll(re)) symDefined.add(d[1]);
    const call = m[1].match(/([A-Za-z_$][\w$]*)\s*\(/); if (call) symDefined.add(call[1]);
  }
  // enclosing definition of every changed line: the last def seen at or above it in the hunk
  let current = null;
  for (const l of s.text.split('\n')) {
    if (l.startsWith('@@')) { const h = l.replace(/^@@[^@]*@@\s*/, ''); current = null; for (const re of DEF_RE) for (const d of h.matchAll(new RegExp(re.source, re.flags))) current = d[1]; if (current) symDefined.add(current); continue; }
    if (!/^[ +-]/.test(l) || /^(\+\+\+|---)/.test(l)) continue;
    const t = l.slice(1);
    for (const re of DEF_RE) for (const d of t.matchAll(new RegExp(re.source, re.flags))) { current = d[1]; if (l[0] !== ' ') symDefined.add(d[1]); }
    if (l[0] !== ' ' && current) symDefined.add(current);
  }
  for (const l of s.text.split('\n')) {
    if (!/^\+(?!\+)/.test(l)) continue;
    const t = l.slice(1);
    for (const c of t.matchAll(/(?<![\w$])([A-Za-z_$][\w$]{3,})\s*\(/g)) symCalled.add(c[1]);
    for (const e of t.matchAll(/(?:process\.env\.|os\.environ(?:\.get)?[\[(]\s*['"]|getenv\(\s*['"]|env\(\s*['"]|ENV\[\s*['"])([A-Z][A-Z0-9_]{2,})/g)) envNames.add(e[1]);
    for (const f of t.matchAll(/['"]([\w./-]*\w\.(?:json|ya?ml|toml|ini|env|cfg|conf|properties))['"]/g)) literalFiles.add(f[1].replace(/^(\.{1,2}\/)+/, ''));
  }
}
for (const d of [...symCalled]) if (STOP.has(d) || STOP.has(d.toLowerCase())) symCalled.delete(d);
for (const d of [...symDefined]) if (STOP.has(d) || d.length < 3) symDefined.delete(d);

const tracked = (git(['ls-files', '-z'], { soft: true }) || '').split('\0').filter(Boolean);
const trackedSet = new Set(tracked);
function isTest(p) { return /(^|\/)(tests?|__tests__|spec|specs|e2e|integration)(\/|$)|(\.|_)(test|spec)\.\w+$|(^|\/)test_[^/]*\.py$|Tests?\.(java|kt|cs|swift)$/i.test(p); }
function grepFiles(sym, extra = []) {
  const out = git(['grep', '-l', '-I', '-w', '-F', '-e', sym, ...extra, '--'], { soft: true });
  return out ? out.split('\n').filter(Boolean) : [];
}
const ctx = new Map(); // path -> {score, why:Set, syms:Set}
function bump(p, score, why, sym) {
  if (changedPaths.has(p) || !trackedSet.has(p)) return;
  if (skipReason(p, null)) return;
  const e = ctx.get(p) || { score: 0, why: new Set(), syms: new Set() };
  e.score += score; e.why.add(why); if (sym) e.syms.add(sym); ctx.set(p, e);
}
// 1) tests touching changed files (by name) and by symbol
const GENERIC_STEMS = new Set(['index', 'main', 'mod', 'util', 'utils', 'types', 'type', 'common', 'helpers', 'helper', 'config', 'constants', 'app', 'lib', 'core', 'base', 'init', '__init__', 'model', 'models', 'endpoints']);
const keptFiles = new Set(keptSections.map((s) => s.file));
for (const c of changed) {
  if (!keptFiles.has(c.path)) continue;
  const stem = path.posix.basename(c.path).replace(/\.[^.]+$/, '');
  if (stem.length < 3 || GENERIC_STEMS.has(stem.toLowerCase())) continue;
  for (const t of tracked) if (isTest(t) && path.posix.basename(t).replace(/\.[^.]+$/, '').replace(/^test_|(\.|_)(test|spec)$|Tests?$/gi, '') === stem) bump(t, 100, 'test named for a changed file');
}
// 2) callers of changed/defined symbols; tests among them rank higher
const defList = [...symDefined].sort().slice(0, 25);
for (const sym of defList) {
  const files = grepFiles(sym);
  if (files.length > 60) continue; // too common to be informative
  for (const f of files) bump(f, isTest(f) ? 60 : 30, `uses changed symbol`, sym);
}
// 3) definitions of symbols the change calls
const callList = [...symCalled].filter((s) => !symDefined.has(s)).sort().slice(0, 40);
for (const sym of callList) {
  const out = git(['grep', '-l', '-I', '-E', '-e', `(function\\*?|def|fn|func|class|interface|struct|enum|trait|type|const|let|var|val)[[:space:]]+${sym.replace(/\$/g, '\\$')}\\b|^[[:space:]]*(public|private|protected|static|export)[^=;]*[[:space:]]${sym.replace(/\$/g, '\\$')}[[:space:]]*\\(`, '--'], { soft: true });
  const files = out ? out.split('\n').filter(Boolean) : [];
  if (files.length > 6) continue;
  for (const f of files) bump(f, 45, 'defines a symbol the change calls', sym);
}
// 4) config the change reads
for (const lit of literalFiles) for (const t of tracked) if (t === lit || t.endsWith(`/${lit}`)) bump(t, 40, 'config file named in the change');
for (const env of [...envNames].slice(0, 10)) {
  for (const t of tracked) if (/(^|\/)\.env\.(example|sample|template)$|(^|\/)(config|settings)\.[\w.]+$/.test(t)) {
    const buf = (() => { const r = safeRead(cwd, t).buf; return r ? r.toString('utf8') : ''; })();
    if (buf.includes(env)) bump(t, 35, 'config declaring an env var the change reads', env);
  }
}
// same-directory siblings are a weak signal, used only to fill leftover room
const ctxOrdered = [...ctx.entries()].map(([p, e]) => ({ path: p, ...e, score: e.score + (isTest(p) ? 10 : 0) + Math.min(e.syms.size, 5) * 3 }))
  .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1)).slice(0, MAX_CONTEXT_FILES);
const ctxCandidates = [];
for (const e of ctxOrdered) {
  const buf = safeRead(cwd, e.path).buf; if (!buf) continue;
  { const why = skipReason(e.path, buf); if (why) { if (/secret/.test(why)) excluded.push({ path: e.path, reason: `context, ${why}` }); continue; } }
  if (contextConfigSkip(e.path)) { excluded.push({ path: e.path, reason: 'context, config file that may carry credentials (not sent unless the change touches it)' }); continue; }
  const text = redact(buf.toString('utf8'), e.path);
  const why = `context: ${[...e.why].join('; ')}${e.syms.size ? ` (${[...e.syms].slice(0, 4).join(', ')})` : ''}`;
  if (buf.length > CTX_FILE_MAX) {
    const pats = [...e.syms].map((s) => new RegExp(`(?<![\\w$])${s.replace(/\$/g, '\\$')}(?![\\w$])`));
    const body = pats.length ? lineWindows(text, pats, 12, CTX_FILE_MAX) : text.slice(0, CTX_FILE_MAX);
    ctxCandidates.push({ path: e.path, kind: 'context', text: body, partial: true, why: `${why}; windowed around matches` });
  } else ctxCandidates.push({ path: e.path, kind: 'context', text, partial: false, why });
}

// ---------- rules
let rules = '';
{
  const r = safeRead(cwd, '.megalens/rules');
  if (r.buf) {
    rules = r.buf.toString('utf8');
    const sc = secretContent(rules);
    if (sc) { excluded.push({ path: '.megalens/rules', reason: `secret-looking content (${sc})` }); rules = ''; }
    else if (bytes(rules) > RULES_MAX) rules = Buffer.from(rules).subarray(0, RULES_MAX).toString('utf8') + '\n[... rules truncated at 8 KB ...]';
  } else if (r.why && r.why !== 'unreadable') excluded.push({ path: '.megalens/rules', reason: r.why });
}

// ---------- assemble in priority order under the budget
const header = (p) => `=== FILE: ${p} ===\n`;
const blockOf = (p, t) => `${header(p)}${t}\n`;
let used = diffBytes + bytes('=== DIFF ===\n');
const included = []; const left = [];
const add = (c, text, partial, why) => { const block = blockOf(c.path, text); const size = bytes(block) + 1; used += size; included.push({ ...c, block, size, partial, why }); };
// 1) changed files ALWAYS outrank context. Whole if they all fit; else every one gets windows around its changed hunks
//    at the widest radius that fits them all; as a last resort each gets a fair share, cut at a line boundary.
{
  const LEVELS = [null, 40, 10, 3, 0];
  const form = (c, lv) => (lv === null ? { text: c.text, partial: false } : { text: windowText(c.text, c.ranges, lv), partial: true });
  const room = maxBytes - used;
  const wholeOk = (c) => c.size <= FILE_WHOLE_MAX;
  let chosen = null; let fitsSomeLevel = false;
  const totalAt = (lv) => candidates.reduce((a, c) => a + bytes(blockOf(c.path, form(c, lv === null && !wholeOk(c) ? 40 : lv).text)) + 1, 0);
  for (const lv of LEVELS) if (totalAt(lv) <= room) { chosen = lv; fitsSomeLevel = true; break; }
  if (fitsSomeLevel) {
    for (const c of candidates) { const lv = chosen === null && !wholeOk(c) ? 40 : chosen; const f = form(c, lv); add(c, f.text, f.partial, lv === null ? 'changed (full post-change content)' : `changed, ${c.size} bytes, windowed ±${lv} lines around the changed hunks (did not fit whole)`); }
  } else {
    let left_ = candidates.length;
    for (const c of candidates) {
      const allot = Math.floor((maxBytes - used) / left_); left_--;
      const lines = windowText(c.text, c.ranges, 0).split('\n'); let t = ''; const note = '\n[... window cut to fit the budget ...]';
      for (const ln of lines) { if (bytes(blockOf(c.path, t + (t ? '\n' : '') + ln + note)) + 1 > allot) break; t += (t ? '\n' : '') + ln; }
      if (!t) { left.push({ path: c.path, reason: `changed, no room left (${allot}-byte share of the ${maxBytes}-byte budget)` }); continue; }
      add(c, t + (t.split('\n').length < lines.length ? note : ''), true, `changed, ${c.size} bytes, only the changed hunks, cut to a fair share of the budget`);
    }
  }
}
// 2) context only after every changed file is in: tests first, then the rest by score
function tryAdd(c) {
  const sz = bytes(blockOf(c.path, c.text)) + 1;
  if (used + sz > maxBytes) { left.push({ path: c.path, reason: `${c.kind}, ${sz} bytes would exceed the ${maxBytes}-byte budget` }); return false; }
  add(c, c.text, c.partial, c.why); return true;
}
for (const c of ctxCandidates.filter((c) => isTest(c.path))) tryAdd(c);
for (const c of ctxCandidates.filter((c) => !isTest(c.path))) tryAdd(c);

const parts = [];
parts.push(`=== DIFF ===\n${diffOut}`);
for (const c of included) parts.push(c.block);
const bundle = parts.join('\n');
const bundleBytes = bytes(bundle);
if (bundleBytes > maxBytes + 200) die(`internal: bundle ${bundleBytes} bytes exceeds the ${maxBytes}-byte budget`);

// ---------- manifest
const mf = [];
mf.push('MEGALENS COLLECTION MANIFEST');
mf.push(`change: ${label}`);
mf.push(`changed files: ${changed.length} (${changed.filter((c) => !excluded.some((x) => x.path === c.path)).length} usable)`);
mf.push(`bundle: ${bundleBytes} bytes of ${maxBytes} budget (hard limit ${HARD_MAX}); diff ${diffBytes} bytes`);
mf.push(`included, in order:`);
mf.push(`  1. DIFF (${keptSections.length} file sections${diffNotes.length ? `; truncated: ${diffNotes.join(', ')}` : ''})`);
included.forEach((c, i) => mf.push(`  ${i + 2}. ${c.path}  [${c.size} B${c.partial ? ', partial' : ''}] ${c.why}`));
if (left.length) { mf.push('left out for budget:'); left.forEach((l) => mf.push(`  - ${l.path}: ${l.reason}`)); }
if (diffOmitted.length) mf.push(`diff sections left out for budget: ${diffOmitted.join(', ')}`);
if (excluded.length) { mf.push('excluded by rule:'); excluded.sort((a, b) => (a.path < b.path ? -1 : 1)).forEach((x) => mf.push(`  - ${x.path}: ${x.reason}`)); }
if (deletedPaths.size) mf.push(`deleted files (diff only): ${[...deletedPaths].join(', ')}`);
if (redactions.length) mf.push(`redacted credential-style values: ${redactions.reduce((a, r) => a + r.count, 0)} (as "***REDACTED***", line numbers unchanged) in ${redactions.map((r) => `${r.path} x${r.count}`).join(', ')}`);
mf.push(`rules file: ${rules ? `.megalens/rules (${bytes(rules)} bytes)` : 'none'}`);
mf.push(`searched symbols: defined/changed=${defList.length}, called=${callList.length}`);
const manifest = mf.join('\n');

if (changed.length === 0 && asJson) { writeSync(1, JSON.stringify({ empty: true, change: label }) + '\n'); process.exit(0); }
if (changed.length === 0) { process.stdout.write('MEGALENS COLLECTION MANIFEST\nchange: ' + label + '\nNO CHANGES FOUND. Nothing to review; tell the user and stop.\n'); process.exit(0); }

{
  const reviewable = diffBlocks.length > 0 || included.some((c) => c.kind === 'changed');
  if (!reviewable) {
    const why = excluded.length ? excluded.map((x) => `${x.path}: ${x.reason}`).join('; ') : 'no reviewable content remained';
    if (asJson) { writeSync(1, JSON.stringify({ empty: true, nothingReviewable: true, change: label, reason: why, manifest }) + '\n'); process.exit(0); }
    process.stdout.write(`${manifest}\n\nNOTHING REVIEWABLE was collected. Nothing was sent. Why: ${why}\nTell the user and stop.\n`); process.exit(0);
  }
}
if (asJson) {
  const j = JSON.stringify({ empty: false, change: label, manifest, rules, bundle, bundleBytes, maxBytes, changedFiles: changed.length }) + '\n';
  if (outFile) writeFileSync(outFile, j);
  process.stdout.write(j, () => process.exit(0));
} else {
{
const out = [];
out.push(manifest);
if (rules) { out.push('\n<<<RULES START (put this text in the prompt argument, not in fileContext)'); out.push(rules); out.push('<<<RULES END'); }
out.push('\n<<<BUNDLE START (copy everything between the markers, byte for byte, into fileContext)');
out.push(bundle);
out.push('<<<BUNDLE END');
const text = out.join('\n') + '\n';
if (outFile) writeFileSync(outFile, text);
process.stdout.write(text);
}
}
