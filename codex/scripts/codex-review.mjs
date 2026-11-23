#!/usr/bin/env node
// Codex front end for MegaLens one-command reviews (Codex CLI + Codex desktop app).
// Uses the bundled runtime under ../runtime/ (same runner order, APP_PATH_ENABLED=false,
// 20-minute wait loop, latest-review bookmarking, secret scrubbing) so cached plugin installs
// work standalone from any unrelated repository without external relative imports.
// Gated behind CODEX_PLUGIN_ENABLED (default false; enable with MEGALENS_CODEX_PLUGIN=1 or
// explicit opt-in via install-codex.mjs).
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as engineMain } from '../runtime/scripts/engine.mjs';
import { APP_PATH_ENABLED, MSG, realExec } from '../runtime/scripts/lib/gh-runner.mjs';
import { REVIEW_ID_RE } from '../runtime/scripts/lib/engine-core.mjs';
import { CODEX_PLUGIN_OFF_MESSAGE, isCodexPluginEnabled } from './flags.mjs';

const VALID_GH_ID = /^gh:[1-9][0-9]{0,17}$/;
const VALID_APP_ID = /^app:[1-9][0-9]{0,17}$/;
const SELF_PATH = fileURLToPath(import.meta.url);

export const CODEX_WORKFLOW_SETUP_NOTE =
  'Note: the MegaLens GitHub App runner is disabled in this build (APP_PATH_ENABLED=false).\n'
  + 'To run GitHub reviews today, set up the GitHub Actions workflow on your repository:\n'
  + '1. Authenticate GitHub CLI: `gh auth login`\n'
  + '2. Add `.github/workflows/megalens-dispatch.yml` on your default branch (run `$megalens-review --runner github` to print the template).\n'
  + '3. Set repository secret `MEGALENS_TOKEN` (`gh secret set MEGALENS_TOKEN`). `codex mcp login megalens` configures only Codex MCP OAuth, not GitHub Actions secrets; zero-copy GitHub setup is blocked until the GitHub App on-demand endpoints or a no-copy secret flow ship.';

/** Strict validation for an optional review id passed to status/result. */
export function isValidCodexReviewId(id) {
  return typeof id === 'string' && (REVIEW_ID_RE.test(id) || VALID_GH_ID.test(id) || VALID_APP_ID.test(id));
}

/**
 * Rewrite only MegaLens plugin UX command hints from Claude Code slash syntax
 * to Codex skill syntax. Leaves model findings, code snippets, and URLs intact.
 */
export function adaptCodexOutput(text) {
  let out = String(text ?? '')
    .replaceAll('Run /megalens:result to see it.', 'Run $megalens-result to see it.')
    .replaceAll('Run /megalens:review to start one.', 'Run $megalens-review to start one.')
    .replaceAll('Run /megalens:review to start a new review.', 'Run $megalens-review to start a new review.')
    .replaceAll('Run /megalens:review to try again.', 'Run $megalens-review to try again.')
    .replaceAll('Run /megalens:review for Standard', 'Run $megalens-review for Standard')
    .replaceAll('run /megalens:review again.', 'run $megalens-review again.')
    .replaceAll('run /megalens:review without --base/--head.', 'run $megalens-review without --base/--head.')
    .replaceAll('for /megalens:review.', 'for $megalens-review.')
    .replaceAll('Use: /megalens:review [deep]', 'Use: $megalens-review [deep]')
    .replaceAll('Check again with /megalens:status ', 'Check again with $megalens-status ')
    .replaceAll('Check with /megalens:status.', 'Check with $megalens-status.')
    .replaceAll('Check with /megalens:status ', 'Check with $megalens-status ')
    .replaceAll('or run /megalens:status in a moment', 'or run $megalens-status in a moment')
    .replaceAll('with /megalens:status and /megalens:result.', 'with $megalens-status and $megalens-result.')
    .replaceAll('Fetch it with /megalens:result ', 'Fetch it with $megalens-result ')
    .replaceAll('Fetch what exists with /megalens:result ', 'Fetch what exists with $megalens-result ')
    .replaceAll('retrieved with /megalens:result ', 'retrieved with $megalens-result ')
    .replace(/\/megalens:result (gh:[0-9]+|app:[0-9]+|rv_[A-Za-z0-9_-]{6,64}) shows/g, '$megalens-result $1 shows')
    .replaceAll('restart Claude Code', 'restart Codex')
    .replaceAll('started Claude Code from', 'started Codex from')
    .replaceAll(
      '/megalens:megalens-review (the bundle route) still works with a token.',
      'Or run `codex mcp login megalens` to connect MegaLens MCP via browser OAuth.',
    )
    .replaceAll(
      'Without a repo or without the engine installed, /megalens:megalens-review still works with a token.',
      'Or run `codex mcp login megalens` to connect MegaLens MCP via browser OAuth.',
    )
    .replaceAll('node scripts/engine.mjs install', `node "${SELF_PATH}" install`)
    .replaceAll('usage: engine.mjs ', 'usage: codex-review.mjs ');

  if (!APP_PATH_ENABLED && out === `${MSG.notSetup}\n`) {
    out = `GitHub Actions workflow setup required (${MSG.notSetup.match(/https:\/\/\S+/)?.[0] ?? 'https://megalens.ai/app/start'}).\n${CODEX_WORKFLOW_SETUP_NOTE}\n`;
  }
  if (out === `${MSG.noSecret}\n`) {
    out = 'The repository secret MEGALENS_TOKEN is missing. No review was started.\n'
      + 'Zero-copy GitHub setup is blocked. `codex mcp login megalens` signs in to the editor only.\n'
      + 'Ask a repository administrator to configure the Actions secret with `gh secret set MEGALENS_TOKEN`, then run $megalens-review again.\n';
  }
  return out;
}

function isMainModule(metaUrl, argv1) {
  if (!argv1) return false;
  const self = fileURLToPath(metaUrl);
  try {
    return realpathSync(argv1) === realpathSync(self);
  } catch {
    return path.resolve(argv1) === self;
  }
}

export async function main(argv, {
  env = process.env,
  cwd = process.cwd(),
  out = (s) => process.stdout.write(s),
  err = (s) => process.stderr.write(s),
  stdin,
  flags = {},
  exec = realExec,
  signal = null,
} = {}) {
  if (!isCodexPluginEnabled(env, flags)) {
    out(`${CODEX_PLUGIN_OFF_MESSAGE}\n`);
    return 4;
  }

  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    out(
      'Usage: codex-review.mjs review [deep] [--runner github|local] [--base REF --head REF] [--quiet] [--no-wait]\n'
      + '       codex-review.mjs status [review-id]\n'
      + '       codex-review.mjs result [review-id]\n'
      + '       codex-review.mjs install | verify\n'
      + '\n'
      + 'Sign in via browser OAuth (Codex CLI + Desktop App MCP): codex mcp login megalens\n'
      + `GitHub App path enabled: ${APP_PATH_ENABLED} (GitHub Actions workflow .github/workflows/megalens-dispatch.yml + gh auth login + MEGALENS_TOKEN secret required for GitHub runs)\n`,
    );
    return cmd ? 0 : 4;
  }

  if ((cmd === 'status' || cmd === 'result') && rest.length === 1 && !isValidCodexReviewId(rest[0])) {
    if (rest[0].startsWith('app:')) {
      out('that is not a MegaLens App review id (they look like app:123456789)\n');
    } else if (rest[0].startsWith('gh:')) {
      out('that is not a GitHub review id (they look like gh:123456789)\n');
    } else {
      out('that is not a review id (expected rv_..., gh:<digits>, or app:<digits>)\n');
    }
    return 4;
  }

  if (!['review', 'status', 'result', 'install', 'verify'].includes(cmd)) {
    out('usage: codex-review.mjs review|status|result|install|verify ...\n');
    return 4;
  }

  return await engineMain(argv, {
    env,
    cwd,
    out: (s) => out(adaptCodexOutput(s)),
    err: (s) => err(adaptCodexOutput(s)),
    stdin,
    flags: { ...flags, reportGitHubSetupErrors: true },
    exec,
    signal,
  });
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const ac = new AbortController();
  process.once('SIGINT', () => ac.abort());
  process.once('SIGTERM', () => ac.abort());
  process.exitCode = await main(process.argv.slice(2), { signal: ac.signal });
}
