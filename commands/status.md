---
description: Check a MegaLens background (deep) review by id
argument-hint: <review-id or gh:run-id>
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/engine.mjs status:*)
---
First check that `$ARGUMENTS` is exactly one review id and nothing else: either `rv_` followed by 6 to 64 letters, digits, `_` or `-` (local engine), or `gh:` followed by digits only (a review on the user's GitHub runner). If it is not, say so and stop; run nothing. Then run `node ${CLAUDE_PLUGIN_ROOT}/scripts/engine.mjs status $ARGUMENTS` and tell the user what it printed. A review id looks like `rv_...` or `gh:123456789`; `gh:` ids need the `gh` CLI logged in and the same repository as the current folder. If it is still running, say so and do not guess at findings. If it has finished, point to `/megalens:result <id>`. If the state is failed, cancelled or partial, say that in the first sentence: the review did not complete and is not a clean review. Never describe a failed, cancelled, partial or unknown review as having no issues.
