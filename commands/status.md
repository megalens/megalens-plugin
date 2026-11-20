---
description: Check a MegaLens background (deep) review by id
argument-hint: <review-id>
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/engine.mjs status:*)
---
Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/engine.mjs status $ARGUMENTS` and tell the user what it printed. A review id looks like `rv_...`. If it is still running, say so and do not guess at findings. If it has finished, point to `/megalens:result <id>`.
