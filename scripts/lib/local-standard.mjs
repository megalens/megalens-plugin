import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stateDir } from './latest-review.mjs';

export const isStandardReviewId = (id) => /^rv_plugin_[a-f0-9]{32}$/.test(id);

function privateDirectory(dir, create = false) {
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || (process.getuid && (st.uid !== process.getuid() || (st.mode & 0o077) !== 0))) {
    throw new Error('Local review state requires a private directory.');
  }
  return dir;
}

function reviewDirectory(env, id, create = false) {
  if (!isStandardReviewId(id)) throw new Error('Invalid local Standard review id.');
  const state = privateDirectory(stateDir(env), create);
  const root = privateDirectory(path.join(state, 'standard'), create);
  return privateDirectory(path.join(root, id), create);
}

export function createStandardReview(env) {
  const id = `rv_plugin_${randomUUID().replaceAll('-', '')}`;
  reviewDirectory(env, id, true);
  return id;
}

export function writeStandardPid(env, id, pid) {
  writeFileSync(path.join(reviewDirectory(env, id), 'pid'), String(pid), { mode: 0o600, flag: 'wx' });
}

export function saveStandardOutcome(env, id, outcome) {
  const dir = reviewDirectory(env, id);
  const tmp = path.join(dir, 'outcome.tmp');
  writeFileSync(tmp, JSON.stringify(outcome), { mode: 0o600, flag: 'wx' });
  renameSync(tmp, path.join(dir, 'outcome.json'));
}

export function readStandardReview(env, id) {
  try {
    const dir = reviewDirectory(env, id);
    const outcome = () => {
      const file = path.join(dir, 'outcome.json');
      try {
        const st = lstatSync(file);
        if (st.isFile() && st.size <= 8 * 1024 * 1024) return JSON.parse(readFileSync(file, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      return null;
    };
    const final = outcome();
    if (final) return final;
    const pidFile = path.join(dir, 'pid');
    const st = lstatSync(pidFile);
    if (!st.isFile() || st.size > 16) return null;
    const pid = Number(readFileSync(pidFile, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) return null;
    try {
      process.kill(pid, 0);
      return { state: 'running' };
    } catch (error) {
      // The worker might have published its result and exited between the first read and this probe.
      return error.code === 'EPERM' ? { state: 'running' } : outcome();
    }
  } catch {
    return null;
  }
}
