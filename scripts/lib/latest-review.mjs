// Per-repo latest-review bookmark so `/megalens:result` and `/megalens:status` work with no id,
// and re-running `/megalens:review` can reuse an in-flight App job without starting a second review.
// Stored outside the repository (under MEGALENS_STATE_DIR or ~/.megalens/plugin-state/latest-reviews.json),
// owner-only (0700 dir, 0600 file), symlink-safe, and holds ONLY routing ids (never tokens or code).
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REVIEW_ID_RE } from './engine-core.mjs';

export const APP_ID_RE = /^app:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export const GH_ID_RE = /^gh:([1-9][0-9]{0,17})$/;
const NWO_RE = /^[\w.-]+\/[\w.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/i;
const MAX_ENTRIES = 100;

export const isAnyReviewId = (id) => typeof id === 'string' && (REVIEW_ID_RE.test(id) || GH_ID_RE.test(id) || APP_ID_RE.test(id));

export function stateDir(env = process.env) {
  const base = env.MEGALENS_STATE_DIR || path.join(env.HOME || env.USERPROFILE || tmpdir(), '.megalens');
  return path.join(base, 'plugin-state');
}

export function stateFilePath(env = process.env) {
  return path.join(stateDir(env), 'latest-reviews.json');
}

function isSymlink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function readMap(file) {
  try {
    if (isSymlink(file)) return {};
    const st = lstatSync(file);
    if (!st.isFile() || st.size > 256_000) return {};
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/** Resolve a stable key for the current repo: git toplevel if available, else resolved cwd. */
export async function resolveRepoKey({ exec, cwd, env, signal = null }) {
  try {
    const r = await exec('git', ['rev-parse', '--show-toplevel'], { cwd, env, signal });
    if (r.code === 0 && r.stdout.trim()) return path.resolve(r.stdout.trim());
  } catch { /* fall through */ }
  return path.resolve(cwd || '.');
}

const cleanSha = (v) => (typeof v === 'string' && SHA_RE.test(v) ? v.toLowerCase() : null);
const cleanPr = (v) => (Number.isInteger(v) && v > 0 && v <= 2_147_483_647 ? v : null);

export function saveLatestReview({
  env = process.env,
  repoKey,
  id,
  runner,
  nwo = null,
  tier = 'standard',
  headSha = null,
  prNumber = null,
  startedAt = null,
  now = () => Date.now(),
}) {
  if (!repoKey || !isAnyReviewId(id)) return false;
  if (!['app', 'github', 'local'].includes(runner)) return false;
  const dir = stateDir(env);
  const file = stateFilePath(env);
  try {
    if (isSymlink(dir)) return false;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (isSymlink(dir) || isSymlink(file)) return false;
    const map = readMap(file);
    const ts = typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt > 0
      ? startedAt
      : (Number(now()) || Date.now());
    const previous = map[String(repoKey)];
    if (previous && isAnyReviewId(previous.id) && Number(previous.startedAt) > ts) return false;
    const rec = {
      id,
      runner,
      nwo: typeof nwo === 'string' && NWO_RE.test(nwo) ? nwo : null,
      tier: ['standard', 'deep', 'double'].includes(tier) ? tier : 'standard',
      startedAt: ts,
    };
    const sha = cleanSha(headSha);
    if (sha) rec.headSha = sha;
    const pr = cleanPr(prNumber);
    if (pr !== null) rec.prNumber = pr;
    map[String(repoKey)] = rec;
    const entries = Object.entries(map)
      .filter(([, v]) => v && typeof v === 'object' && isAnyReviewId(v.id))
      .sort((a, b) => (Number(b[1].startedAt) || 0) - (Number(a[1].startedAt) || 0))
      .slice(0, MAX_ENTRIES);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries), null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

export function loadLatestReview({ env = process.env, repoKey, nwo = null }) {
  const file = stateFilePath(env);
  const map = readMap(file);
  const exact = repoKey ? map[String(repoKey)] : null;
  const pick = (rec) => {
    if (!rec || typeof rec !== 'object' || !isAnyReviewId(rec.id)) return null;
    if (!['app', 'github', 'local'].includes(rec.runner)) return null;
    return {
      id: rec.id,
      runner: rec.runner,
      nwo: typeof rec.nwo === 'string' && NWO_RE.test(rec.nwo) ? rec.nwo : null,
      tier: rec.tier ?? 'standard',
      headSha: cleanSha(rec.headSha),
      prNumber: cleanPr(rec.prNumber),
      startedAt: Number(rec.startedAt) || 0,
    };
  };
  const hit = pick(exact);
  if (hit) return hit;
  if (nwo && NWO_RE.test(nwo)) {
    const target = nwo.toLowerCase();
    const byNwo = Object.values(map)
      .map(pick)
      .filter((r) => r && r.nwo && r.nwo.toLowerCase() === target)
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    if (byNwo) return byNwo;
  }
  return null;
}
