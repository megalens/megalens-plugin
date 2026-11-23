// Shared wait loop for /megalens:review across all runners (GitHub App, GitHub Actions, local deep).
// Injectable clock (`now`, `sleep`) and `signal` so tests simulate the full 20-minute cap in milliseconds.

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
 * Poll until the review reaches a terminal state, the 20-minute cap passes, or `signal` aborts.
 * Prints short, non-repeating progress lines through `onLine`. Never prints review ids.
 */
export async function waitForReview({
  poll,
  onLine = () => {},
  startedLine = 'Review started',
  queuedLine = null,
  runningLine = 'Running on GitHub...',
  waitMs = DEFAULT_WAIT_MS,
  pollMs = DEFAULT_POLL_MS,
  progressMs = DEFAULT_PROGRESS_MS,
  now = () => Date.now(),
  sleep = defaultSleep,
  signal = null,
}) {
  if (startedLine) onLine(`${startedLine}\n`);
  const t0 = now();
  let last = null;
  let lastState = null;
  let lastBucket = 0;

  while (!signal?.aborted) {
    last = await poll();
    const st = last?.state;
    if (st === 'done' || st === 'complete' || st === 'partial' || st === 'failed' || st === 'cancelled' || st === 'error') {
      return { finished: true, timedOut: false, aborted: false, last };
    }
    if (st !== lastState) {
      if (st === 'queued' && queuedLine) onLine(`${queuedLine}\n`);
      else if (st === 'running' && runningLine) onLine(`${runningLine}\n`);
      lastState = st;
    }
    const elapsed = Math.max(0, now() - t0);
    if (progressMs > 0) {
      const bucket = Math.floor(elapsed / progressMs);
      if (bucket > lastBucket) {
        lastBucket = bucket;
        onLine(`${formatElapsed(elapsed)}\n`);
      }
    }
    const remaining = waitMs - elapsed;
    if (remaining <= 0 || signal?.aborted) break;
    await sleep(Math.min(pollMs, remaining), signal);
    const afterSleep = Math.max(0, now() - t0);
    if (afterSleep >= waitMs || signal?.aborted) {
      // One final poll right at the boundary if not aborted, in case it finished during the last sleep.
      if (!signal?.aborted) {
        last = await poll();
        const st2 = last?.state;
        if (st2 === 'done' || st2 === 'complete' || st2 === 'partial' || st2 === 'failed' || st2 === 'cancelled' || st2 === 'error') {
          return { finished: true, timedOut: false, aborted: false, last };
        }
      }
      break;
    }
  }

  onLine(`${STILL_RUNNING_LINE}\n`);
  return { finished: false, timedOut: !signal?.aborted, aborted: Boolean(signal?.aborted), last };
}
