// Browser OAuth 2.0 (PKCE + Dynamic Client Registration) helper for MegaLens Cursor plugin.
// Reuses the exact same MegaLens OAuth discovery & endpoints as the Claude Code plugin:
//   - Protected Resource Metadata (RFC 9728): https://megalens.ai/.well-known/oauth-protected-resource
//   - Authorization Server Metadata (RFC 8414): https://megalens.ai/.well-known/oauth-authorization-server
//   - Dynamic Client Registration: /oauth/register
//   - Authorization + PKCE S256: /oauth/authorize -> loopback callback -> /oauth/token
// Never prints or logs access_token or refresh_token.
// Never writes OAuth tokens to plaintext files on disk: persists only via the OS credential store
// (macOS Keychain, Linux Secret Service via secret-tool, Windows Credential Manager) with secrets piped over stdin.

import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';

export const DEFAULT_MCP_RESOURCE = 'https://megalens.ai/api/mcp?ide=cursor';
export const DEFAULT_ISSUER = 'https://megalens.ai';
export const KEYCHAIN_SERVICE = 'megalens-cursor-oauth';
export const KEYCHAIN_ACCOUNT = 'default';

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

/** Accept only https URLs, or plain http strictly on loopback (127.0.0.1 / localhost / ::1) for local tests. */
export function assertSafeEndpointUrl(raw, label = 'URL') {
  let u;
  try { u = new URL(raw); } catch { throw new Error(`${label} is not a valid URL.`); }
  if (u.username || u.password) throw new Error(`${label} must not contain embedded credentials.`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) return u;
  throw new Error(`${label} must use https (or http on localhost/127.0.0.1 only).`);
}

export function base64Url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generatePkce() {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier, 'ascii').digest());
  return { verifier, challenge, method: 'S256' };
}

/** Run a command without a shell, optionally delivering sensitive input strictly via stdin (never argv). */
export function execWithStdin(cmd, args, { stdin = null, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        env,
        stdio: [stdin !== null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      return resolve({ code: 127, stdout: '', stderr: String(e.message) });
    }
    let stdout = '';
    let stderr = '';
    const MAX = 1 << 18;
    child.stdout.on('data', (c) => { if (stdout.length < MAX) stdout += c; });
    child.stderr.on('data', (c) => { if (stderr.length < MAX) stderr += c; });
    child.on('error', (e) => resolve({ code: e.code === 'ENOENT' ? 127 : 4, stdout, stderr: String(e.message) }));
    child.on('close', (code) => resolve({ code: code ?? 4, stdout, stderr }));
    if (stdin !== null && child.stdin) {
      child.stdin.on('error', () => {});
      try { child.stdin.end(stdin, 'utf8'); } catch {}
    }
  });
}

function assertSafeKeychainIds(service, account) {
  if (!SAFE_ID_RE.test(service) || !SAFE_ID_RE.test(account)) {
    throw new Error('Invalid keychain service or account identifier.');
  }
}

/**
 * OS credential store adapter. Never writes secrets to disk and never passes secrets on command-line argv.
 *   - macOS: `security -i` (base64 payload piped on stdin)
 *   - Linux: `secret-tool` (payload piped on stdin)
 *   - Windows: PowerShell `Windows.Security.Credentials.PasswordVault` (payload piped on stdin)
 */
export function createOsSecretStore({
  platform = process.platform,
  exec = execWithStdin,
  service = KEYCHAIN_SERVICE,
  account = KEYCHAIN_ACCOUNT,
} = {}) {
  assertSafeKeychainIds(service, account);
  const noStoreMsg = (why) =>
    `No OS credential store is available (${why}); refusing to save OAuth tokens in a plaintext file. Sign in inside Cursor (Customize -> megalens -> Connect) so Cursor stores the OAuth session in its encrypted host credential store.`;

  if (platform === 'darwin') {
    return {
      backend: 'macos-keychain',
      async set(value) {
        const b64 = Buffer.from(String(value), 'utf8').toString('base64');
        const script = `add-generic-password -U -a ${account} -s ${service} -w ${b64}\n`;
        const r = await exec('security', ['-i'], { stdin: script });
        if (r.code !== 0 || /security:\s*SecKeychain/i.test(r.stderr)) {
          throw new Error(noStoreMsg(r.stderr.trim() || `macOS security exited ${r.code}`));
        }
      },
      async get() {
        const r = await exec('security', ['find-generic-password', '-a', account, '-s', service, '-w']);
        if (r.code !== 0) return null;
        const raw = r.stdout.trim();
        if (!raw) return null;
        try {
          return Buffer.from(raw, 'base64').toString('utf8');
        } catch {
          return raw;
        }
      },
      async clear() {
        const r = await exec('security', ['delete-generic-password', '-a', account, '-s', service]);
        return r.code === 0;
      },
    };
  }

  if (platform === 'linux') {
    return {
      backend: 'linux-secret-service',
      async set(value) {
        const r = await exec(
          'secret-tool',
          ['store', '--label=MegaLens Cursor OAuth', 'service', service, 'account', account],
          { stdin: String(value) },
        );
        if (r.code !== 0) {
          throw new Error(noStoreMsg(r.code === 127 ? 'secret-tool not installed' : (r.stderr.trim() || `secret-tool exited ${r.code}`)));
        }
      },
      async get() {
        const r = await exec('secret-tool', ['lookup', 'service', service, 'account', account]);
        if (r.code !== 0) return null;
        return r.stdout.trim() || null;
      },
      async clear() {
        const r = await exec('secret-tool', ['clear', 'service', service, 'account', account]);
        return r.code === 0;
      },
    };
  }

  if (platform === 'win32') {
    const psHeader = '[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]; $v = New-Object Windows.Security.Credentials.PasswordVault;';
    return {
      backend: 'windows-credential-manager',
      async set(value) {
        const script =
          `${psHeader} $sec = [Console]::In.ReadToEnd(); ` +
          `try { $old = $v.Retrieve('${service}','${account}'); $v.Remove($old) } catch {}; ` +
          `$cred = New-Object Windows.Security.Credentials.PasswordCredential('${service}','${account}',$sec); ` +
          `$v.Add($cred)`;
        const r = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdin: String(value) });
        if (r.code !== 0) {
          throw new Error(noStoreMsg(r.stderr.trim() || `Windows PasswordVault exited ${r.code}`));
        }
      },
      async get() {
        const script =
          `${psHeader} try { $c = $v.Retrieve('${service}','${account}'); $c.RetrievePassword(); [Console]::Out.Write($c.Password) } catch { exit 1 }`;
        const r = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
        if (r.code !== 0) return null;
        return r.stdout || null;
      },
      async clear() {
        const script =
          `${psHeader} try { $c = $v.Retrieve('${service}','${account}'); $v.Remove($c) } catch {}`;
        const r = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
        return r.code === 0;
      },
    };
  }

  return {
    backend: 'unavailable',
    async set() { throw new Error(noStoreMsg(`unsupported platform: ${platform}`)); },
    async get() { return null; },
    async clear() { return false; },
  };
}

/** Ephemeral in-memory secret store (never touches disk). Used in unit tests and non-persistent sessions. */
export function createMemorySecretStore() {
  let value = null;
  return {
    backend: 'memory',
    async set(v) { value = String(v); },
    async get() { return value; },
    async clear() { const had = value !== null; value = null; return had; },
  };
}

export async function readAuthRecord(secretStore = createOsSecretStore()) {
  try {
    const raw = await secretStore.get();
    if (!raw || typeof raw !== 'string') return null;
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    return j;
  } catch {
    return null;
  }
}

export async function clearAuthRecord(secretStore = createOsSecretStore()) {
  try {
    return Boolean(await secretStore.clear());
  } catch {
    return false;
  }
}

/** Safe, secret-free summary of stored browser OAuth state in the OS credential store. */
export async function getAuthStatus(secretStore = createOsSecretStore(), now = Date.now()) {
  const rec = await readAuthRecord(secretStore);
  const backend = secretStore?.backend || 'os-keychain';
  if (!rec || typeof rec.access_token !== 'string' || !rec.access_token) {
    return { signedIn: false, expired: false, hasRefreshToken: false, issuer: DEFAULT_ISSUER, scope: null, expiresAt: null, backend };
  }
  const expiresAt = typeof rec.expires_at === 'number' ? rec.expires_at : null;
  const expired = expiresAt !== null && expiresAt <= now;
  return {
    signedIn: !expired || Boolean(rec.refresh_token),
    expired,
    hasRefreshToken: Boolean(rec.refresh_token),
    issuer: typeof rec.issuer === 'string' ? rec.issuer : DEFAULT_ISSUER,
    scope: typeof rec.scope === 'string' ? rec.scope : null,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    backend,
  };
}

/** Discover MegaLens OAuth endpoints using RFC 9728 + RFC 8414. */
export async function discoverOAuth({ resourceUrl = DEFAULT_MCP_RESOURCE, fetchImpl = fetch } = {}) {
  const ru = assertSafeEndpointUrl(resourceUrl, 'MCP resource URL');
  const origin = ru.origin;
  const prRes = await fetchImpl(`${origin}/.well-known/oauth-protected-resource`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!prRes.ok) throw new Error(`Protected resource discovery failed (HTTP ${prRes.status}).`);
  const pr = await prRes.json();
  const authServer = Array.isArray(pr.authorization_servers) && typeof pr.authorization_servers[0] === 'string'
    ? pr.authorization_servers[0]
    : origin;
  const asOrigin = assertSafeEndpointUrl(authServer, 'Authorization server URL').origin;
  const asRes = await fetchImpl(`${asOrigin}/.well-known/oauth-authorization-server`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!asRes.ok) throw new Error(`Authorization server metadata discovery failed (HTTP ${asRes.status}).`);
  const meta = await asRes.json();
  for (const k of ['authorization_endpoint', 'token_endpoint']) {
    if (typeof meta[k] !== 'string') throw new Error(`Authorization metadata missing ${k}.`);
    assertSafeEndpointUrl(meta[k], k);
  }
  if (meta.registration_endpoint) assertSafeEndpointUrl(meta.registration_endpoint, 'registration_endpoint');
  return {
    resource: typeof pr.resource === 'string' ? pr.resource : `${origin}/api/mcp`,
    issuer: typeof meta.issuer === 'string' ? meta.issuer : asOrigin,
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: meta.registration_endpoint || null,
    revocationEndpoint: meta.revocation_endpoint || null,
    scopes: Array.isArray(pr.scopes_supported) && pr.scopes_supported.length ? pr.scopes_supported : ['mcp'],
  };
}

/** Open a URL in the user's default browser (cross-platform, no shell). */
export function openInBrowser(url, platform = process.platform) {
  assertSafeEndpointUrl(url, 'Browser URL');
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Start an ephemeral 127.0.0.1 callback server, run Dynamic Client Registration (public PKCE client),
 * open the browser to MegaLens's /oauth/authorize, exchange the code at /oauth/token, and store credentials
 * exclusively in the OS credential store (never plaintext files on disk).
 * Never returns or prints raw tokens in its summary object.
 */
export async function browserSignIn({
  resourceUrl = DEFAULT_MCP_RESOURCE,
  secretStore = createOsSecretStore(),
  fetchImpl = fetch,
  openBrowser = openInBrowser,
  timeoutMs = 180_000,
  onAuthorizeUrl = null,
} = {}) {
  const disc = await discoverOAuth({ resourceUrl, fetchImpl });
  if (!disc.registrationEndpoint) throw new Error('MegaLens OAuth server did not advertise a registration_endpoint.');

  const state = base64Url(randomBytes(24));
  const pkce = generatePkce();

  let resolveCode; let rejectCode;
  const codePromise = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });

  const server = http.createServer((req, res) => {
    try {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      if (u.pathname !== '/callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      const err = u.searchParams.get('error');
      const gotState = u.searchParams.get('state');
      const code = u.searchParams.get('code');
      if (err) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h2>MegaLens sign-in was cancelled or denied.</h2><p>You can close this tab.</p></body></html>');
        rejectCode(new Error(`Sign-in denied: ${err.slice(0, 80)}`));
        return;
      }
      if (!gotState || gotState !== state || !code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h2>Invalid sign-in response.</h2><p>State mismatch; close this tab and try again.</p></body></html>');
        rejectCode(new Error('OAuth callback state mismatch or missing authorization code.'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body><h2>Signed in to MegaLens.</h2><p>You can close this tab and return to Cursor.</p></body></html>');
      resolveCode(code);
    } catch (e) {
      rejectCode(e);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const timer = setTimeout(() => rejectCode(new Error('Timed out waiting for browser sign-in to complete.')), timeoutMs);
  timer.unref?.();

  try {
    const port = server.address().port;
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    const regRes = await fetchImpl(disc.registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'MegaLens Cursor Plugin',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!regRes.ok) throw new Error(`OAuth client registration failed (HTTP ${regRes.status}).`);
    const reg = await regRes.json();
    if (typeof reg.client_id !== 'string' || !reg.client_id) throw new Error('OAuth registration returned no client_id.');

    const authUrl = new URL(disc.authorizationEndpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', reg.client_id);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', disc.scopes.join(' '));
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', pkce.challenge);
    authUrl.searchParams.set('code_challenge_method', pkce.method);
    authUrl.searchParams.set('resource', disc.resource);

    if (typeof onAuthorizeUrl === 'function') onAuthorizeUrl(authUrl.toString());
    openBrowser(authUrl.toString());

    const code = await codePromise;

    const tokBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: reg.client_id,
      code_verifier: pkce.verifier,
      resource: disc.resource,
    });
    const tokRes = await fetchImpl(disc.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: tokBody.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!tokRes.ok) throw new Error(`OAuth token exchange failed (HTTP ${tokRes.status}).`);
    const tok = await tokRes.json();
    if (typeof tok.access_token !== 'string' || !tok.access_token) throw new Error('OAuth token response contained no access_token.');

    const expiresIn = Number(tok.expires_in);
    const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null;
    await secretStore.set(JSON.stringify({
      issuer: disc.issuer,
      resource: disc.resource,
      client_id: reg.client_id,
      token_endpoint: disc.tokenEndpoint,
      scope: typeof tok.scope === 'string' ? tok.scope : disc.scopes.join(' '),
      access_token: tok.access_token,
      refresh_token: typeof tok.refresh_token === 'string' ? tok.refresh_token : null,
      expires_at: expiresAt,
      signed_in_at: new Date().toISOString(),
    }));

    return {
      ok: true,
      issuer: disc.issuer,
      scope: typeof tok.scope === 'string' ? tok.scope : disc.scopes.join(' '),
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      backend: secretStore.backend || 'os-keychain',
    };
  } finally {
    clearTimeout(timer);
    await new Promise((r) => server.close(() => r()));
  }
}

/** Refresh an expired browser OAuth token stored in the OS credential store without prompting the user again. */
export async function refreshAuthToken({ secretStore = createOsSecretStore(), fetchImpl = fetch } = {}) {
  const rec = await readAuthRecord(secretStore);
  if (!rec || !rec.refresh_token || !rec.token_endpoint || !rec.client_id) {
    throw new Error('No refreshable MegaLens sign-in found in the OS credential store. Sign in again in the browser.');
  }
  assertSafeEndpointUrl(rec.token_endpoint, 'token_endpoint');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: rec.refresh_token,
    client_id: rec.client_id,
    ...(rec.resource ? { resource: rec.resource } : {}),
  });
  const res = await fetchImpl(rec.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`OAuth token refresh failed (HTTP ${res.status}). Sign in again in the browser.`);
  const tok = await res.json();
  if (typeof tok.access_token !== 'string' || !tok.access_token) throw new Error('OAuth refresh response contained no access_token.');
  const expiresIn = Number(tok.expires_in);
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null;
  await secretStore.set(JSON.stringify({
    ...rec,
    access_token: tok.access_token,
    refresh_token: typeof tok.refresh_token === 'string' ? tok.refresh_token : rec.refresh_token,
    expires_at: expiresAt,
    refreshed_at: new Date().toISOString(),
  }));
  return { ok: true, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null, backend: secretStore.backend || 'os-keychain' };
}
