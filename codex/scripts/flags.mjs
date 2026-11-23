// Feature flags for the MegaLens Codex plugin (CLI + desktop app).
// Default OFF until owner GO (roadmap24 rule): flag off = live behaviour unchanged.
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export { APP_PATH_ENABLED } from '../runtime/scripts/lib/gh-runner.mjs';
export { BYO_KEY_ENABLED, BYO_LOGIN_ENABLED, DOUBLE_TIER_ENABLED } from '../runtime/scripts/lib/engine-core.mjs';

export const CODEX_PLUGIN_ENABLED = false;
export const CODEX_PLUGIN_ENV_VAR = 'MEGALENS_CODEX_PLUGIN';
export const PREVIEW_OPT_IN_FILENAME = '.codex-plugin-preview-enabled';
export const CODEX_PLUGIN_OFF_MESSAGE =
  'The MegaLens Codex plugin is disabled in this build (CODEX_PLUGIN_ENABLED=false). Set MEGALENS_CODEX_PLUGIN=1 to enable it.';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OPT_IN_MARKER = path.resolve(HERE, '..', PREVIEW_OPT_IN_FILENAME);

/**
 * Read a persisted preview opt-in marker written by `install-codex.mjs` inside the user's
 * installed plugin directory (never shipped in the source repo, never read from cwd,
 * and refuses symlinks or oversized files).
 */
export function hasPersistedPreviewOptIn(markerPath = DEFAULT_OPT_IN_MARKER) {
  try {
    const st = lstatSync(markerPath);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 1024) return false;
    const doc = JSON.parse(readFileSync(markerPath, 'utf8'));
    return doc !== null && typeof doc === 'object' && doc.enabled === true;
  } catch {
    return false;
  }
}

/**
 * Determine whether the Codex plugin is enabled.
 * Precedence:
 *   1. Explicit `flags.codexPlugin` boolean (used in tests)
 *   2. Explicit `MEGALENS_CODEX_PLUGIN` env var (`1|true|on` enables; `0|false|off` disables even if opt-in file exists)
 *   3. Persisted preview opt-in file next to this installed runner (`<pluginDir>/.codex-plugin-preview-enabled`, unless `checkOptInMarker: false`)
 *   4. Compile-time default `CODEX_PLUGIN_ENABLED` (false)
 */
export function isCodexPluginEnabled(env = process.env, flags = {}, { checkOptInMarker = true, markerPath = DEFAULT_OPT_IN_MARKER } = {}) {
  if (typeof flags.codexPlugin === 'boolean') return flags.codexPlugin;
  const raw = String(env?.[CODEX_PLUGIN_ENV_VAR] ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  if (checkOptInMarker && hasPersistedPreviewOptIn(markerPath)) return true;
  return CODEX_PLUGIN_ENABLED;
}
