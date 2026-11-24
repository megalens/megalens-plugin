// Host instruction text, shared by the installer. No secrets, no host-specific tool prefixes.
export const TOOL = 'megalens_review_change';

export function reviewSteps(rangeNote) {
  return `Review the current change with MegaLens. Follow these steps in order.

1. Look at the change yourself: run \`git status --short\` and \`git diff\` (against the merge base with \`main\` or \`master\`; ${rangeNote}). Read the changed files you need.
2. Write your own review first: every bug, regression or risk you see, each as \`file:line\` plus what is wrong. Real defects only; no style remarks.
3. Call the MegaLens tool \`${TOOL}\` (server \`megalens-local\`) **at most once** per user request with:
   - \`range\`: only if the user gave one (a base ref, \`A..B\`, or \`--staged\`); otherwise leave it out.
   - \`yourAssessment\`: your step 2 points, one object per point: \`claim\` = "file:line - what is wrong", \`quote\` = that line of code copied verbatim.
   - \`prompt\`: leave it out unless the user asked for a particular focus.
   You do NOT collect, copy or send any file content: the tool does that itself and waits for the review to finish. This can take several minutes; wait for it. If the tool times out or drops without returning a result, **DO NOT call \`${TOOL}\` again** — a run may already have started and been billed or consumed the free review; check \`megalens_history\` (or ask the user to check their MegaLens dashboard) first.
4. If the tool says MEGALENS_TOKEN is not set, tell the user to set it (see the MegaLens README for this host) and restart the host. Stop there.
5. Present the result. Start with \`hostDelta\`: what the panel found that your assessment did not, what it also looked at, and what you raised that it did not reach. Say plainly where you were wrong. Then the findings, marking which ones more than one model raised (\`vote_count\`) and which are disputed. Treat a finding marked \`evidenceUnsupported\` as unverified and check it yourself before repeating it. Answer any \`host_verify\` question from the code and report the answer.
6. If the result has \`needed_context\` (whether on an **approved, charged** review or a **terminal halt**), **DO NOT automatically call \`${TOOL}\` again**. Every new submission starts a fresh run ID with its own billing / free-review admission. Present the result (or halt reason) and the requested \`needed_context\` items, and **ask the user for explicit confirmation** before starting another billable review with those files passed as \`extraContext\` (\`path\` and \`content\`, relevant parts only). Even after confirmation, never read or send credential or secret files (decline those and say so).
7. End with one line from the tool's last text block: the bundle size, the sha256, and what the manifest listed as left out or excluded.`;
}

const GUARD = `Only do this when the user asks for a MegaLens review. It uploads code and spends paid credits.`;

export const codexPrompt = () => `---
description: Review your current change with MegaLens (local tool, exact bundle)
argument-hint: [ref | A..B | --staged]
---
${GUARD}

${reviewSteps('the user\'s arguments, if any, are the range: $ARGUMENTS')}
`;

export const agentsSnippet = () => `## MegaLens review

When the user asks for a MegaLens review (for example "/prompts:megalens-review" or "review this with MegaLens"), follow this. ${GUARD}

${reviewSteps('the user may name a range')}`;

export const cursorRule = () => `---
description: Use only when the user asks for a MegaLens review of the current change. Calls the local megalens_review_change tool once.
alwaysApply: false
---
${GUARD}

${reviewSteps('the user may name a range')}
`;

export const cursorCommand = () => `${GUARD}

${reviewSteps('any text the user typed after the command is the range')}
`;

export const copilotPrompt = () => `---
description: Review your current change with MegaLens (local tool, exact bundle)
agent: agent
---
${GUARD}

${reviewSteps('any text the user typed after the command is the range')}
`;

export const codexSkill = () => `---
name: megalens-review
description: Review the current git change with MegaLens (models from different companies) through the local megalens_review_change tool. Use ONLY when the user explicitly asks for a MegaLens review. Do not use for ordinary code review: it uploads code and spends paid credits.
---
${GUARD}

${reviewSteps('the user may name a range')}
`;

// Codex skill metadata: keep the skill explicit-only so it never starts a paid run on its own
export const codexSkillPolicy = () => `policy:
  allow_implicit_invocation: false
`;

export function mcpToolSteps(rangeNote, { mode = 'local', collectPath = 'scripts/collect.mjs', hasArguments = false } = {}) {
  const isHosted = mode === 'hosted';
  const quotedCollect = JSON.stringify(collectPath);
  const collectCmd = hasArguments
    ? `\`node ${quotedCollect} --max-bytes 90000 --args-stdin <<'MEGALENS_ARGS_END_7f3a91c2'\n$ARGUMENTS\nMEGALENS_ARGS_END_7f3a91c2\``
    : `\`node ${quotedCollect} --max-bytes 90000\` (pass any user range via \`--args-stdin\` in a single-quoted heredoc, never raw shell interpolation)`;
  const collectStep = isHosted
    ? `1. Collect the change using the deterministic guarded collector (${rangeNote}):
   - Run ${collectCmd}. It enforces repository boundaries, skips \`.env\`/credentials/lockfiles/binaries/symlinks, and redacts secret values (including on removed diff lines).
   - If the collector outputs \`NO CHANGES FOUND\` or \`NOTHING REVIEWABLE\`, tell the user and stop without calling \`megalens_debate\`.
   - **No-shell / no-collector fallback:** If this host cannot run shell commands and neither \`${TOOL}\` (\`megalens-local\`) nor another trusted deterministic tool that enforces repository boundaries, byte limits, and secret redaction is available, **STOP before uploading** and tell the user why. Never copy raw \`git diff\` output or workspace files directly into \`fileContext\`.`
    : `1. Inspect the change yourself (${rangeNote}) to write your own assessment first; do not read \`.env\`, credential files, or secrets. The local tool \`${TOOL}\` (\`megalens-local\`) runs \`collect.mjs\` itself to enforce repository boundaries, byte limits, and deterministic secret redaction. If \`${TOOL}\` is unavailable and you fall back to hosted \`megalens_debate\`, run ${collectCmd} instead of raw \`git diff\` (and if you cannot run shell commands or a trusted sanitizing tool, **STOP before uploading**).`;
  const callStep = isHosted
    ? `3. Submit the review **at most once** per user request using the hosted MegaLens MCP tools (\`megalens_debate\` and \`megalens_poll\` on server \`megalens\`):
   - \`prompt\`: "Review this change for bugs, regressions and security problems. Report only defects you can point to in the code." If the collector emitted a \`<<<RULES START\` .. \`<<<RULES END\` block, append it verbatim under "Repository review rules (.megalens/rules):".
   - \`fileContext\`: everything between \`<<<BUNDLE START\` and \`<<<BUNDLE END\` from the guarded collector, copied byte for byte (never raw \`git diff\` or unredacted files).
   - \`skill\`: \`"diff_audit"\`.
   - \`yourAssessment\`: your step 2 points (\`claim\` = "file:line - what is wrong", \`quote\` = verbatim line).
   - Poll \`megalens_poll\` with the returned \`run_id\` until \`terminal\` is true.
   - **Lost response / timeout:** If \`megalens_debate\` times out, drops, or returns without a \`run_id\`, **DO NOT call \`megalens_debate\` again** — a run may already have started and been billed or consumed the free review. Call \`megalens_history\` to find the \`run_id\` and poll \`megalens_poll\`.`
    : `3. Call \`${TOOL}\` (server \`megalens-local\`) **at most once** per user request with \`range\` (if given), \`yourAssessment\`, and optional \`prompt\`. It collects and uploads the guarded bundle itself and polls to completion. If \`${TOOL}\` is unavailable, use the guarded collector output with \`megalens_debate\` + \`megalens_poll\` (polling until \`terminal\` is true). On any timeout or lost response without a \`run_id\`, **DO NOT call again** — check \`megalens_history\` first because a run may already have started and been billed.`;
  return `Review the current change with MegaLens. Follow these steps in order.

${collectStep}
2. Write your own review first from the guarded diff: every bug, regression or risk you see, each as \`file:line\` plus what is wrong. Real defects only; no style remarks.
${callStep}
4. If the tool reports missing credentials or an invalid token, tell the user to run MegaLens setup (or set \`MEGALENS_TOKEN\`) and restart the host. Stop there.
5. Present the result. Start with \`hostDelta\`: what the panel found that your assessment did not, what it also looked at, and what you raised that it did not reach. Say plainly where you were wrong. Then list findings, marking \`vote_count\` and disputed items. Treat \`evidenceUnsupported\` as unverified and verify it against the code yourself. Answer any \`host_verify\` question from the code.
6. If the result carries \`needed_context\` (whether on an **approved, charged** review or a **terminal halt**), **DO NOT automatically call \`megalens_debate\` or \`${TOOL}\` again**. Every new submission starts a fresh run ID with its own billing / free-review admission. Present the result (or halt reason) and the requested \`needed_context\` items, and **ask the user for explicit confirmation** before starting another billable review with those files. Even after confirmation, never read or send credential or secret files.
7. End with one line noting the bundle size / files included and anything skipped, redacted, or excluded by the collector manifest.`;
}

export const copilotSkill = (mode = 'local', opts = {}) => `---
name: megalens-review
description: Review the current git change with MegaLens using the ${mode === 'hosted' ? 'hosted megalens' : 'local megalens-local'} MCP server. Use ONLY when the user explicitly asks for a MegaLens review (for example "review my changes with MegaLens"). Do not use for ordinary code review: it uploads code and spends paid credits.
---
${GUARD}

${mcpToolSteps('the user may name a range', { ...opts, mode })}
`;

export const copilotInstructionsSnippet = (mode = 'local', opts = {}) => `## MegaLens review

When the user explicitly asks for a MegaLens review (for example "review my changes with MegaLens"), follow this. ${GUARD}

${mcpToolSteps('the user may name a range', { ...opts, mode })}`;

export const opencodeCommand = (mode = 'local', opts = {}) => `---
description: Review your current change with MegaLens (multi-model code review)
---
${GUARD}

${mcpToolSteps('the user arguments, if any, are the range: $ARGUMENTS', { ...opts, mode, hasArguments: true })}
`;

export const opencodeAgentsSnippet = (mode = 'local', opts = {}) => `## MegaLens review

When the user explicitly asks for a MegaLens review (for example "review my changes with MegaLens" or \`/megalens-review\`), follow this. ${GUARD}

${mcpToolSteps('the user may name a range', { ...opts, mode })}`;

export const antigravitySkill = (mode = 'local', opts = {}) => `---
name: megalens-review
description: Review the current git change with MegaLens using the MegaLens MCP tools. Use ONLY when the user explicitly asks for a MegaLens review (e.g. "review my changes with MegaLens"). Do not use for ordinary code review: it uploads code and spends paid credits.
---
${GUARD}

${mcpToolSteps('the user may name a range', { ...opts, mode })}
`;

export const antigravityRule = (mode = 'local', opts = {}) => `---
trigger: model_decision
description: Use ONLY when the user explicitly asks for a MegaLens review (e.g. "review my changes with MegaLens").
---
${GUARD}

${mcpToolSteps('the user may name a range', { ...opts, mode })}
`;

export const antigravityGeminiSnippet = (mode = 'local', opts = {}) => `## MegaLens review

When the user explicitly asks for a MegaLens review (for example "review my changes with MegaLens"), follow this. ${GUARD}

${mcpToolSteps('the user may name a range', { ...opts, mode })}`;

export const codexHostedSkill = (opts = {}) => `---
name: megalens-review
description: Review the current git change with MegaLens using the hosted megalens MCP server. Use ONLY when the user explicitly asks for a MegaLens review. Do not use for ordinary code review: it uploads code and spends paid credits.
---
${GUARD}

${mcpToolSteps('the user may name a range', { ...opts, mode: 'hosted' })}
`;

export const codexHostedPrompt = (opts = {}) => `---
description: Review your current change with MegaLens (hosted MCP, guarded collector)
argument-hint: [ref | A..B | --staged]
---
${GUARD}

${mcpToolSteps('the user\'s arguments, if any, are the range: $ARGUMENTS', { ...opts, mode: 'hosted', hasArguments: true })}
`;

export const codexHostedAgentsSnippet = (opts = {}) => `## MegaLens review

When the user explicitly asks for a MegaLens review (for example "review my changes with MegaLens"), follow this. ${GUARD}

${mcpToolSteps('the user may name a range', { ...opts, mode: 'hosted' })}`;

export const cursorHostedCommand = (opts = {}) => `${GUARD}

${mcpToolSteps('any text the user typed after the command is the range', { ...opts, mode: 'hosted' })}
`;

export const cursorHostedRule = (opts = {}) => `---
description: Use only when the user explicitly asks for a MegaLens review of the current change. Uses hosted megalens MCP with the guarded collector.
alwaysApply: false
---
${GUARD}

${mcpToolSteps('the user may name a range', { ...opts, mode: 'hosted' })}
`;
