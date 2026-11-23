---
description: Check the status of the latest MegaLens review for this repository (or a specific review id)
argument-hint: [review-id]
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/engine.mjs status:*)
---
If `$ARGUMENTS` is empty, run `node ${CLAUDE_PLUGIN_ROOT}/scripts/engine.mjs status` to check the latest MegaLens review for this repository.

Otherwise, first check that `$ARGUMENTS` is exactly one review id of the form `rv_` followed by 6 to 64 letters, digits, `_` or `-`, or `gh:` followed by digits only, or `app:` followed by digits only, and nothing else. If it is not, say so and stop; run nothing. Then run `node ${CLAUDE_PLUGIN_ROOT}/scripts/engine.mjs status $ARGUMENTS`.

Tell the user what the script printed. If it is still running, say so and do not guess at findings. If it has finished, point to `/megalens:result`. If the state is failed, cancelled or partial, say that in the first sentence: the review did not complete and is not a clean review. Never describe a failed, cancelled, partial or unknown review as having no issues.
