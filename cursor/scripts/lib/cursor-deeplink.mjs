// Cursor MCP install deeplink builder and decoder.
// Official spec: https://cursor.com/docs/mcp/install-links
// Format: cursor://anysphere.cursor-deeplink/mcp/install?name=$NAME&config=$BASE64_ENCODED_CONFIG
// Note: Cursor MCP install links register a single MCP server only (not commands, rules, or skills).

export const DEEPLINK_PREFIX = 'cursor://anysphere.cursor-deeplink/mcp/install';
export const DEFAULT_REMOTE_MCP_URL = 'https://megalens.ai/api/mcp?ide=cursor';

/**
 * Build a Cursor MCP install deeplink for a single server config object
 * (the inner config object for that server, e.g. { url: "..." } or { command: "node", args: [...] }).
 */
export function buildMcpDeeplink(name, config) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) {
    throw new Error('MCP server name must be a short identifier (letters, digits, hyphens, underscores, dots).');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('MCP server config must be a JSON object.');
  }
  const encoded = Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
  return `${DEEPLINK_PREFIX}?name=${encodeURIComponent(name)}&config=${encodeURIComponent(encoded)}`;
}

/** Decode and verify a Cursor MCP install deeplink (useful for validation and tests). */
export function parseMcpDeeplink(link) {
  if (typeof link !== 'string' || !link.startsWith(`${DEEPLINK_PREFIX}?`)) {
    throw new Error('Not a valid Cursor MCP install deeplink.');
  }
  const query = link.slice(DEEPLINK_PREFIX.length + 1);
  const params = new URLSearchParams(query);
  const name = params.get('name');
  const rawConfig = params.get('config');
  if (!name || !rawConfig) throw new Error('Deeplink is missing name or config query parameter.');
  let config;
  try {
    config = JSON.parse(Buffer.from(rawConfig, 'base64').toString('utf8'));
  } catch (e) {
    throw new Error(`Deeplink config is not valid base64 JSON: ${e.message}`);
  }
  return { name, config };
}

/**
 * One-click hosted MCP server sign-in deeplink for `megalens` (OAuth endpoint only).
 * Does NOT install the local GitHub-runner server, slash commands, rule, or skill.
 */
export function megalensRemoteDeeplink(url = DEFAULT_REMOTE_MCP_URL) {
  return buildMcpDeeplink('megalens', { url });
}

/**
 * Single-server MCP deeplink for the local `megalens-runner` stdio server in an existing checkout.
 * Does NOT install slash commands, rule, or skill; use `install --local-plugin` or `install --project` for the full plugin.
 */
export function megalensRunnerDeeplink(serverScriptPath) {
  if (typeof serverScriptPath !== 'string' || !serverScriptPath.trim()) {
    throw new Error('serverScriptPath is required for the local runner deeplink.');
  }
  return buildMcpDeeplink('megalens-runner', {
    type: 'stdio',
    command: 'node',
    args: [serverScriptPath],
  });
}
