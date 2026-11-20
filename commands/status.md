---
description: Check a MegaLens background (deep) review by id
argument-hint: <review-id>
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/engine.mjs status:*)
---
First check that `$ARGUMENTS` is exactly one review id of the form `rv_` followed by 6 to 64 letters, digits, `_` or `-`, and nothing else. If it is not, say so and stop; run nothing. Then run `node ${CLAUDE_PLUGIN_ROOT}/scripts/engine.mjs status $ARGUMENTS` and tell the user what it printed. A review id looks like `rv_...`. If it is still running, say so and do not guess at findings. If it has finished, point to `/megalens:result <id>`. If the state is failed, cancelled or partial, say that in the first sentence: the review did not complete and is not a clean review. Never describe a failed, cancelled, partial or unknown review as having no issues.
