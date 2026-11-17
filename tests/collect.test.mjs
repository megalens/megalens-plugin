import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COLLECT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'collect.mjs');
const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
const put = (root, p, c) => { mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); writeFileSync(path.join(root, p), c); };
function collect(cwd, ...args) {
  const r = spawnSync('node', [COLLECT, ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const bundleOf = (out) => out.split('<<<BUNDLE START')[1].split('\n').slice(1).join('\n').split('<<<BUNDLE END')[0];
const fileBlocks = (out) => [...bundleOf(out).matchAll(/^=== FILE: (.*) ===$/gm)].map((m) => m[1]);

function fixture() {
  const d = mkdtempSync(path.join(tmpdir(), 'mlfix-'));
  sh(d, 'init', '-q', '-b', 'main');
  put(d, 'src/pricing.js', 'export function price(q) {\n  return q * 10;\n}\n');
  put(d, 'src/cart.js', "import { price } from './pricing.js';\nexport function total(items) {\n  return items.reduce((a, i) => a + price(i.q), 0);\n}\n");
  put(d, 'test/pricing.test.js', "import { price } from '../src/pricing.js';\nconsole.assert(price(2) === 20);\n");
  put(d, 'src/unrelated.js', 'export const x = 1;\n');
  put(d, 'package-lock.json', '{"lockfileVersion":3}\n');
  put(d, 'config.json', '{"rate": 10}\n');
  sh(d, 'add', '-A'); sh(d, 'commit', '-q', '-m', 'base');
  return d;
}

test('unstaged + staged + untracked changes are collected; callers and tests come along', () => {
  const d = fixture();
  put(d, 'src/pricing.js', "import cfg from '../config.json';\nexport function price(q) {\n  return q * cfg.rate - 1;\n}\n");
  put(d, 'src/newfile.js', 'export const added = true;\n');
  sh(d, 'add', 'src/newfile.js');
  const r = collect(d);
  assert.equal(r.code, 0, r.err);
  const files = fileBlocks(r.out);
  assert.ok(files.includes('src/pricing.js'));
  assert.ok(files.includes('src/newfile.js'));
  assert.ok(files.includes('src/cart.js'), 'caller of changed symbol');
  assert.ok(files.includes('test/pricing.test.js'), 'test touching changed code');
  assert.ok(files.includes('config.json'), 'config the change reads');
  assert.ok(!files.includes('src/unrelated.js'));
  assert.match(bundleOf(r.out), /^=== DIFF ===\ndiff --git a\//);
  assert.match(bundleOf(r.out), /diff --git a\/src\/pricing.js/);
  rmSync(d, { recursive: true });
});

test('priority order: diff, then changed files, then tests, then other context', () => {
  const d = fixture();
  put(d, 'src/pricing.js', 'export function price(q) {\n  return q * 11;\n}\n');
  const files = fileBlocks(collect(d).out);
  assert.deepEqual(files.slice(0, 3), ['src/pricing.js', 'test/pricing.test.js', 'src/cart.js']);
  rmSync(d, { recursive: true });
});

test('lockfiles, binaries, generated, vendored and secret files are skipped and listed', () => {
  const d = fixture();
  put(d, 'package-lock.json', '{"lockfileVersion":3,"x":1}\n');
  writeFileSync(path.join(d, 'logo.png'), Buffer.from([137, 80, 78, 71, 0, 0, 1, 2, 3]));
  put(d, 'dist/app.js', 'var a=1;\n');
  put(d, 'src/api.generated.ts', '// @generated\nexport const g = 1;\n');
  put(d, 'node_modules/x/index.js', 'x\n');
  put(d, '.env', 'SECRET_KEY=abc123\n');
  put(d, 'blob.dat', 'ab\0cd\0');
  put(d, 'src/pricing.js', 'export function price(q) {\n  return q * 12;\n}\n');
  const r = collect(d);
  const b = bundleOf(r.out);
  for (const bad of ['package-lock.json', 'logo.png', 'dist/app.js', 'api.generated.ts', 'node_modules', '.env', 'blob.dat', 'abc123']) assert.ok(!b.includes(bad), `${bad} must not be in the bundle`);
  const manifest = r.out.split('<<<BUNDLE START')[0];
  assert.match(manifest, /package-lock\.json: .*lockfile/);
  assert.match(manifest, /\.env: .*secret/);
  assert.match(manifest, /logo\.png: .*binary/);
  assert.match(manifest, /api\.generated\.ts: .*generated/);
  rmSync(d, { recursive: true });
});

test('size cap is respected and what was left out is listed', () => {
  const d = fixture();
  const big = (n) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i}; // padding line to take up space\n`).join('');
  for (let i = 0; i < 12; i++) put(d, `src/mod${i}.js`, big(40));
  sh(d, 'add', '-A'); sh(d, 'commit', '-q', '-m', 'mods');
  for (let i = 0; i < 12; i++) put(d, `src/mod${i}.js`, big(40).replace('v0 = 0', 'v0 = 99'));
  const cap = 15000;
  const r = collect(d, '--max-bytes', String(cap));
  assert.equal(r.code, 0, r.err);
  const size = Buffer.byteLength(bundleOf(r.out).replace(/^\n/, '').replace(/\n$/, ''));
  assert.ok(size <= cap, `bundle ${size} > cap ${cap}`);
  assert.ok(fileBlocks(r.out).length >= 1);
  assert.match(r.out, /windowed|fair share|left out for budget:/, 'what did not fit whole is stated');
  const r2 = collect(d, '--max-bytes', '900000'); // clamped to the 700 KB hard limit
  assert.match(r2.out, /hard limit 700000/);
  rmSync(d, { recursive: true });
});

test('a diff larger than its budget is truncated with a note, never dropped', () => {
  const d = fixture();
  put(d, 'src/huge.js', Array.from({ length: 3000 }, (_, i) => `export const h${i} = ${i};\n`).join(''));
  const r = collect(d, '--max-bytes', '20000');
  assert.match(bundleOf(r.out), /truncated by MegaLens collector/);
  assert.ok(Buffer.byteLength(bundleOf(r.out)) <= 20000 + 200);
  rmSync(d, { recursive: true });
});

test('ref argument: diff against merge base, committed branch work is included', () => {
  const d = fixture();
  sh(d, 'checkout', '-q', '-b', 'feature');
  put(d, 'src/cart.js', "import { price } from './pricing.js';\nexport function total(items) {\n  return items.length ? items.reduce((a, i) => a + price(i.q), 0) : 0;\n}\n");
  sh(d, 'commit', '-qam', 'feature work');
  put(d, 'src/pricing.js', 'export function price(q) {\n  return q * 13;\n}\n');
  sh(d, 'checkout', '-q', 'main'); put(d, 'src/mainonly.js', 'export const m = 1;\n'); sh(d, 'add', '-A'); sh(d, 'commit', '-qm', 'main moves on');
  sh(d, 'checkout', '-q', 'feature');
  put(d, 'src/pricing.js', 'export function price(q) {\n  return q * 13;\n}\n');
  const none = collect(d); // default base = merge-base with main
  assert.ok(fileBlocks(none.out).includes('src/cart.js') && fileBlocks(none.out).includes('src/pricing.js'));
  assert.ok(!bundleOf(none.out).includes('mainonly'));
  const ref = collect(d, 'main');
  assert.ok(bundleOf(ref.out).includes('diff --git a/src/cart.js'));
  assert.ok(!bundleOf(ref.out).includes('mainonly'));
  const last = collect(d, 'HEAD'); // only the uncommitted change
  assert.ok(!bundleOf(last.out).includes('diff --git a/src/cart.js'));
  assert.ok(bundleOf(last.out).includes('diff --git a/src/pricing.js'));
  rmSync(d, { recursive: true });
});

test('range argument reads post-change content from the end commit, not the working tree', () => {
  const d = fixture();
  put(d, 'src/pricing.js', 'export function price(q) {\n  return q * 14;\n}\n');
  sh(d, 'commit', '-qam', 'c1');
  const c1 = sh(d, 'rev-parse', 'HEAD').trim();
  put(d, 'src/pricing.js', 'export function price(q) {\n  return q * 999;\n}\n');
  const r = collect(d, `HEAD~1..${c1}`);
  assert.equal(r.code, 0, r.err);
  assert.ok(bundleOf(r.out).includes('q * 14'));
  assert.ok(!bundleOf(r.out).includes('q * 999'));
  rmSync(d, { recursive: true });
});

test('--staged ignores unstaged work; no changes says so; output is deterministic', () => {
  const d = fixture();
  assert.match(collect(d).out, /NO CHANGES FOUND/);
  put(d, 'src/pricing.js', 'export function price(q) {\n  return q * 15;\n}\n');
  sh(d, 'add', '-A');
  put(d, 'src/unrelated.js', 'export const x = 2;\n');
  const s = collect(d, '--staged');
  assert.ok(bundleOf(s.out).includes('q * 15') && !bundleOf(s.out).includes('x = 2'));
  assert.equal(collect(d).out, collect(d).out);
  rmSync(d, { recursive: true });
});

test('.megalens/rules is surfaced, capped at 8 KB', () => {
  const d = fixture();
  put(d, '.megalens/rules', 'Never log tokens.\n' + 'x'.repeat(20000));
  sh(d, 'add', '-A'); sh(d, 'commit', '-qm', 'rules');
  put(d, 'src/pricing.js', 'export function price(q) {\n  return q * 16;\n}\n');
  const r = collect(d);
  assert.match(r.out, /<<<RULES START[^\n]*\nNever log tokens\./);
  assert.match(r.out, /rules truncated at 8 KB/);
  assert.ok(!bundleOf(r.out).includes('Never log tokens'), 'rules are sent in the prompt, not fileContext');
  rmSync(d, { recursive: true });
});

test('bad input fails loudly', () => {
  const d = fixture();
  assert.equal(collect(d, 'no-such-ref').code, 2);
  assert.equal(collect(d, '--bogus').code, 2);
  const outside = mkdtempSync(path.join(tmpdir(), 'mlnogit-'));
  assert.equal(collect(outside).code, 2);
  rmSync(d, { recursive: true }); rmSync(outside, { recursive: true });
});
