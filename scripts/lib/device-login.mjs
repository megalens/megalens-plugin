// Browser sign-in for MegaLens host setup (RFC 8628-style device authorization).
// Production always targets https://megalens.ai; tests inject fetchImpl / open / sleep / now.
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import readline from 'node:readline';

export const DEFAULT_API_BASE = 'https://megalens.ai';

export class DeviceLoginError extends Error {
  constructor(message, code = 'failed') {
    super(message);
    this.code = code;
  }
}

export function isExpectedEditorLabel(label) {
  return typeof label === 'string' && /^editor:[0-9a-f]{12}$/.test(label);
}

export function deviceNameHint() {
  try {
    return hostname().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || null;
  } catch {
    return null;
  }
}

export function canOpenBrowser(env = process.env, platform = process.platform) {
  if (env.MEGALENS_NO_BROWSER === '1') return false;
  if (platform === 'darwin' || platform === 'win32') return !(env.SSH_CONNECTION || env.SSH_TTY);
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

const BROWSER_ENV_EXACT = new Set([
  'PATH', 'HOME', 'LANG', 'LANGUAGE', 'BROWSER',
  'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS',
  'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE', 'XDG_DATA_DIRS', 'XDG_CONFIG_DIRS', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME',
  'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_COLLATE', 'LC_NUMERIC', 'LC_TIME', 'LC_MONETARY',
  'LC_PAPER', 'LC_NAME', 'LC_ADDRESS', 'LC_TELEPHONE', 'LC_MEASUREMENT', 'LC_IDENTIFICATION',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
]);

export function browserEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') continue;
    if (BROWSER_ENV_EXACT.has(k.toUpperCase())) out[k] = v;
  }
  return out;
}

export function openBrowser(url, platform = process.platform, env = process.env) {
  if (!/^https:\/\/megalens\.ai\/device\?code=[A-Z]{4}-[A-Z]{4}$/.test(url)) return false;
  try {
    const [cmd, args] = platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, shell: false, env: browserEnv(env) });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanAccount(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 200);
  return s || null;
}

/**
 * Interactive terminal confirmation required before redeeming a browser-approved device code.
 * Fails closed (`false`) on anything other than an explicit "y" or "yes", including declined answers,
 * empty input, closed stdin (EOF), SIGINT, or stream errors.
 */
export function promptConfirmAccount({ input = process.stdin, output = process.stderr } = {}) {
  return async (account, { replaces = false } = {}) => {
    const safeAcct = cleanAccount(account);
    if (!safeAcct) return false;
    if (!input || input.readableEnded || input.destroyed) return false;

    const warn = replaces ? '  Warning: confirming will replace your existing MegaLens token for this editor.\n' : '';
    output.write(`\n  Approved in browser as ${safeAcct}.\n${warn}  Save this token for ${safeAcct}? [y/N]: `);

    return await new Promise((resolve) => {
      let settled = false;
      const rl = readline.createInterface({ input, terminal: false });
      const done = (ok) => {
        if (settled) return;
        settled = true;
        input.removeListener('error', onErr);
        rl.close();
        resolve(ok);
      };
      const onErr = () => done(false);
      input.once('error', onErr);
      rl.once('line', (line) => done(/^y(?:es)?$/i.test(String(line).trim())));
      rl.once('close', () => done(false));
      rl.once('SIGINT', () => done(false));
    });
  };
}

async function postJson(fetchImpl, url, body) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

/**
 * Run browser device sign-in for an editor MCP token (`client: 'megalens-mcp'`).
 * Returns { token, label, replaced, account } in memory; never logs or prints the token.
 */
export async function deviceLogin({
  apiBase = DEFAULT_API_BASE,
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = (s) => process.stderr.write(`${s}\n`),
  open = openBrowser,
  sleep = sleepMs,
  now = () => Date.now(),
  platform = process.platform,
  confirmAccount,
  allowReplace = true,
} = {}) {
  if (typeof confirmAccount !== 'function') throw new DeviceLoginError('No account confirmation step.', 'config');
  let base;
  try {
    const u = new URL(apiBase);
    const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
      throw new DeviceLoginError('Sign-in endpoint must use HTTPS.', 'config');
    }
    base = u.origin;
  } catch (e) {
    if (e instanceof DeviceLoginError) throw e;
    throw new DeviceLoginError('Invalid sign-in endpoint.', 'config');
  }

  let start;
  try {
    start = await postJson(fetchImpl, `${base}/api/device/start`, { client: 'megalens-mcp', device_name: deviceNameHint() });
  } catch {
    throw new DeviceLoginError(`Could not reach ${base}. Check your connection and try again.`, 'network');
  }
  if (start.status === 404) throw new DeviceLoginError('Browser sign-in is not available yet.', 'unavailable');
  if (start.status === 429) throw new DeviceLoginError('Too many sign-ins from this network. Wait 10 minutes and try again.', 'rate_limited');
  const s = start.data ?? {};
  if (start.status !== 200 || typeof s.device_code !== 'string' || typeof s.user_code !== 'string' || !/^[A-Z]{4}-[A-Z]{4}$/.test(s.user_code)) {
    throw new DeviceLoginError('MegaLens could not start the sign-in.', 'failed');
  }

  const deviceCode = s.device_code;
  const expiresAt = now() + Math.min(Math.max(Number(s.expires_in) || 600, 60), 900) * 1000;
  let interval = Math.min(Math.max(Number(s.interval) || 3, 1), 30);
  const url = `${base}/device?code=${s.user_code}`;
  log('');
  log(`  Your code: ${s.user_code}`);
  const opened = canOpenBrowser(env, platform) && open(url, platform, env);
  log(opened ? `  Opening ${url}` : `  Open this page on any device: ${url}`);
  log('  Sign in, check the code matches, and click Approve.');

  let confirmed = null;
  let confirmedReplaces = false;
  while (now() < expiresAt) {
    if (!confirmed) await sleep(interval * 1000);
    let poll;
    try {
      poll = await postJson(fetchImpl, `${base}/api/device/token`, confirmed ? { device_code: deviceCode, confirm: true } : { device_code: deviceCode });
    } catch {
      if (confirmed) await sleep(interval * 1000);
      continue;
    }
    const d = poll.data ?? {};
    if (poll.status === 200 && typeof d.access_token === 'string' && /^ml_tok_[0-9a-f]{32}$/i.test(d.access_token)) {
      if (!confirmed) throw new DeviceLoginError('MegaLens sent a token before you confirmed the account, so nothing was saved.', 'unconfirmed');
      if (!isExpectedEditorLabel(d.label)) throw new DeviceLoginError('MegaLens returned the wrong kind of token, so nothing was saved.', 'wrong_label');
      return { token: d.access_token, label: d.label, replaced: d.replaced === true, account: cleanAccount(d.account) ?? confirmed };
    }
    switch (d.error) {
      case 'confirm_account': {
        const account = cleanAccount(d.account);
        if (!account) throw new DeviceLoginError('MegaLens did not say which account approved, so nothing was saved.', 'failed');
        if (confirmed) continue;
        if (d.label !== undefined && d.label !== null && !isExpectedEditorLabel(d.label)) {
          await postJson(fetchImpl, `${base}/api/device/token`, { device_code: deviceCode, cancel: true }).catch(() => {});
          throw new DeviceLoginError('MegaLens offered the wrong kind of token, so nothing was created.', 'wrong_label');
        }
        const replaces = d.replaces === true;
        if (!allowReplace && d.replaces !== false) {
          await postJson(fetchImpl, `${base}/api/device/token`, { device_code: deviceCode, cancel: true }).catch(() => {});
          throw new DeviceLoginError('Nothing was created or revoked: approving would replace your current token.', 'would_replace');
        }
        const answer = await confirmAccount(account, { replaces });
        if (answer !== true) {
          await postJson(fetchImpl, `${base}/api/device/token`, { device_code: deviceCode, cancel: true }).catch(() => {});
          throw new DeviceLoginError('Sign-in cancelled before any token was created.', 'cancelled');
        }
        confirmed = account;
        confirmedReplaces = replaces;
        break;
      }
      case 'authorization_pending':
        break;
      case 'slow_down':
        interval = Math.min(interval + 5, 30);
        break;
      case 'access_denied':
        throw new DeviceLoginError('Sign-in was denied in the browser.', 'denied');
      case 'expired_token':
        throw new DeviceLoginError('The sign-in code expired. Run setup again.', 'expired');
      default:
        if (poll.status >= 400 && poll.status < 500) {
          throw new DeviceLoginError(confirmed && confirmedReplaces ? 'Sign-in failed after confirmation; run setup again.' : 'Sign-in failed.', 'failed');
        }
        break;
    }
  }
  throw new DeviceLoginError('Timed out waiting for browser approval.', 'expired');
}
