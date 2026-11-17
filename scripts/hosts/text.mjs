// Host instruction text, shared by the installer. No secrets, no host-specific tool prefixes.
export const TOOL = 'megalens_review_change';

export function reviewSteps(rangeNote) {
  return `Review the current change with MegaLens. Follow these steps in order.

1. Look at the change yourself: run \`git status --short\` and \`git diff\` (against the merge base with \`main\` or \`master\`; ${rangeNote}). Read the changed files you need.
2. Write your own review first: every bug, regression or risk you see, each as \`file:line\` plus what is wrong. Real defects only; no style remarks.
3. Call the MegaLens tool \`${TOOL}\` (server \`megalens-local\`) exactly once with:
   - \`range\`: only if the user gave one (a base ref, \`A..B\`, or \`--staged\`); otherwise leave it out.
   - \`yourAssessment\`: your step 2 points, one object per point: \`claim\` = "file:line - what is wrong", \`quote\` = that line of code copied verbatim.
   - \`prompt\`: leave it out unless the user asked for a particular focus.
   You do NOT collect, copy or send any file content: the tool does that itself and waits for the review to finish. This can take several minutes; wait for it.
4. If the tool says MEGALENS_TOKEN is not set, tell the user to set it (see the MegaLens README for this host) and restart the host. Stop there.
5. Present the result. Start with \`hostDelta\`: what the panel found that your assessment did not, what it also looked at, and what you raised that it did not reach. Say plainly where you were wrong. Then the findings, marking which ones more than one model raised (\`vote_count\`) and which are disputed. Treat a finding marked \`evidenceUnsupported\` as unverified and check it yourself before repeating it. Answer any \`host_verify\` question from the code and report the answer.
6. If the result has \`needed_context\`, read the files it names (never credential or secret files; decline those and say so), then call \`${TOOL}\` ONE more time with the same arguments and pass those files as \`extraContext\` (\`path\` and \`content\`, relevant parts only). Never make a third call. Tell the user what changed between the two results.
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
