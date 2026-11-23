// Feature flags for the MegaLens Codex plugin (CLI + desktop app).
// Default OFF until owner GO (roadmap24 rule): flag off = live behaviour unchanged.
export { APP_PATH_ENABLED } from '../../scripts/lib/gh-runner.mjs';
export { BYO_KEY_ENABLED, BYO_LOGIN_ENABLED, DOUBLE_TIER_ENABLED } from '../../scripts/lib/engine-core.mjs';

export const CODEX_PLUGIN_ENABLED = false;
export const CODEX_PLUGIN_ENV_VAR = 'MEGALENS_CODEX_PLUGIN';
export const CODEX_PLUGIN_OFF_MESSAGE =
  'The MegaLens Codex plugin is disabled in this build (CODEX_PLUGIN_ENABLED=false). Set MEGALENS_CODEX_PLUGIN=1 to enable it.';

/**
 * Determine whether the Codex plugin is enabled.
 * Explicit `flags.codexPlugin` (used in tests) takes precedence, then `MEGALENS_CODEX_PLUGIN`,
 * then the compile-time default `CODEX_PLUGIN_ENABLED` (false).
 */
export function isCodexPluginEnabled(env = process.env, flags = {}) {
  if (typeof flags.codexPlugin === 'boolean') return flags.codexPlugin;
  const raw = String(env?.[CODEX_PLUGIN_ENV_VAR] ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  return CODEX_PLUGIN_ENABLED;
}
