// Shared wait loop for /megalens:review across all runners (GitHub App, GitHub Actions, local).
// Injectable clock (`now`, `sleep`) and `signal` so tests simulate the full 20-minute cap in milliseconds,
// and in-flight poll / result calls are cancelled promptly on deadline or user interrupt.

export const DEFAULT_WAIT_MS = 20 * 60_000;
export const DEFAULT_POLL_MS = 15_000;
export const DEFAULT_PROGRESS_MS = 2 * 60_000;
export const STILL_RUNNING_LINE = 'Still running. Run /megalens:result to see it.';

export function defaultSleep(ms, signal = null) {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve();
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

export function formatElapsed(elapsedMs) {
  const mins = Math.max(1, Math.floor(elapsedMs / 60_000));
  return mins === 1 ? 'About 1 minute so far' : `About ${mins} minutes so far`;
}

/**
 * Run `fn(callSignal)` bounded by both `signal` (user interrupt) and `remainingMs` (deadline).
 * If `signal` aborts or the deadline expires while `fn` is in flight, `callSignal` is aborted immediately
 * (terminating any child process) and this returns `{ interrupted: 'aborted' | 'timeout' }` without waiting
 * for a hung child. Also checks `now() - t0 >= waitMs` after `fn` resolves so fake-clock overtime polls are
 * never accepted as finished.
 */
export async function raceWithDeadline(fn, {
  signal = null,
  remainingMs,
  now = () => Date.now(),
  t0 = now(),
  waitMs = remainingMs,
} = {}) {
  if (signal?.aborted) return { interrupted: 'aborted', value: undefined };
  if (remainingMs <= 0) return { interrupted: 'timeout', value: undefined };

  const callAc = new AbortController();
  let timer = null;
  let onUserAbort = null;

  const race = new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    onUserAbort = () => {
      callAc.abort();
      finish({ interrupted: 'aborted', value: undefined });
    };
    if (signal) {
      if (signal.aborted) return onUserAbort();
      signal.addEventListener('abort', onUserAbort, { once: true });
    }
    if (Number.isFinite(remainingMs) && remainingMs > 0) {
      timer = setTimeout(() => {
        callAc.abort();
        finish({ interrupted: 'timeout', value: undefined });
      }, remainingMs);
    }
    Promise.resolve()
      .then(() => callAc.signal.aborted ? undefined : fn(callAc.signal))
      .then(
        (value) => finish({ interrupted: null, value }),
        (error) => finish({ interrupted: 'error', error }),
      );
  });

  try {
    const res = await race;
    if (res.interrupted === 'error') throw res.error;
    if (res.interrupted) return res;
    if (signal?.aborted) return { interrupted: 'aborted', value: undefined };
    if (Number.isFinite(waitMs) && Math.max(0, now() - t0) >= waitMs) {
      callAc.abort();
      return { interrupted: 'timeout', value: undefined };
    }
    return res;
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (signal && onUserAbort) signal.removeEventListener('abort', onUserAbort);
  }
}

/**
 * Poll until the review reaches a terminal state, the 20-minute cap passes, or `signal` aborts.
 * Passes a per-call AbortSignal to `poll(callSignal)` so in-flight child processes are killed on deadline/abort.
 * Prints short, non-repeating progress lines through `onLine`. Never prints review ids.
 */
export async function waitForReview({
  poll,
  onLine = () => {},
  startedLine = 'Review started',
  queuedLine = null,
  runningLine = 'Running on GitHub...',
  stillRunningLine = STILL_RUNNING_LINE,
  waitMs = DEFAULT_WAIT_MS,
  pollMs = DEFAULT_POLL_MS,
  progressMs = DEFAULT_PROGRESS_MS,
  now = () => Date.now(),
  t0 = null,
  initialSleptMs = 0,
  sleep = defaultSleep,
  signal = null,
}) {
  if (startedLine) onLine(`${startedLine}\n`);
  const start = t0 ?? now();
  let last = null;
  let lastState = null;
  let lastBucket = 0;
  let sleptMs = Math.max(0, Number(initialSleptMs) || 0);
  const elapsedNow = () => Math.max(0, now() - start, sleptMs);

  while (!signal?.aborted) {
    const remainingBeforePoll = waitMs - elapsedNow();
    if (remainingBeforePoll <= 0) break;

    const polled = await raceWithDeadline((callSignal) => poll(callSignal), {
      signal,
      remainingMs: remainingBeforePoll,
      now,
      t0: start,
      waitMs,
    });
    if (polled.interrupted) break;

    last = polled.value;
    const st = last?.state;
    if (st === 'done' || st === 'complete' || st === 'partial' || st === 'failed' || st === 'cancelled' || st === 'error') {
      return { finished: true, timedOut: false, aborted: false, last };
    }
    if (st !== 'retry' && st !== lastState) {
      if (st === 'queued' && queuedLine) onLine(`${queuedLine}\n`);
      else if (st === 'running' && runningLine) onLine(`${runningLine}\n`);
      lastState = st;
    }
    const elapsed = elapsedNow();
    if (progressMs > 0) {
      const bucket = Math.floor(elapsed / progressMs);
      if (bucket > lastBucket) {
        lastBucket = bucket;
        onLine(`${formatElapsed(elapsed)}\n`);
      }
    }
    const remaining = waitMs - elapsed;
    if (remaining <= 0 || signal?.aborted) break;
    const delayMs = (st === 'retry' && Number.isFinite(last?.retryAfterMs) && last.retryAfterMs > 0)
      ? last.retryAfterMs
      : pollMs;
    const actualDelay = Math.min(delayMs, remaining);
    const slept = await raceWithDeadline((callSignal) => sleep(actualDelay, callSignal), {
      signal, remainingMs: remaining, now, t0: start, waitMs,
    });
    if (slept.interrupted) break;
    sleptMs += actualDelay;
  }

  onLine(`${stillRunningLine}\n`);
  return { finished: false, timedOut: !signal?.aborted, aborted: Boolean(signal?.aborted), last };
}
