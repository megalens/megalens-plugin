---
description: OAuth fallback for /megalens-review (no token): the model copies a small 90 KB bundle into the call itself, which can corrupt it. Prefer /megalens-review with MEGALENS_TOKEN.
argument-hint: [ref | A..B | --staged]
disable-model-invocation: true
allowed-tools: Bash(node *collect.mjs*) Bash(sleep:*) mcp__plugin_megalens_megalens__megalens_debate mcp__plugin_megalens_megalens__megalens_poll
---
Review the change below with MegaLens. Follow these steps in order. Do not skip or reorder them.

## Collected change (produced by a script, identical on every run)

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/collect.mjs" --args-stdin <<'MEGALENS_ARGS_END_7f3a91c2'
$ARGUMENTS
MEGALENS_ARGS_END_7f3a91c2
```

## Steps

1. If the output says NO CHANGES FOUND, tell the user and stop.
2. Read the diff in the bundle. Write your own review first: every bug, regression or risk you see, each as `file:line` plus what is wrong. Keep to real defects; no style remarks.
3. Call `megalens_debate` exactly once with:
   - `prompt`: "Review this change for bugs, regressions and security problems. Report only defects you can point to in the code." Followed, if the output has a RULES block, by a blank line, the heading "Repository review rules (.megalens/rules):" and the RULES text verbatim.
   - `fileContext`: everything between `<<<BUNDLE START` and `<<<BUNDLE END`, copied byte for byte, nothing added, nothing removed. Never replace a file or the diff with a placeholder, a summary or an excerpt; if you cannot copy it all, tell the user instead of sending part of it.
   - `skill`: "diff_audit".
   - `yourAssessment`: your step 2 points, one object per point: `claim` = "file:line - what is wrong", `quote` = that line of code copied verbatim from the diff or a file.
   Do not pass `files` or `repositoryFiles`.
4. The call returns a `run_id`. Call `megalens_poll` with it; while the status is not finished, wait (`sleep 20` in Bash if that is allowed, otherwise just poll again) and poll again. Stop polling when the run is complete or failed.
5. Present the result. Start with `hostDelta`: what the panel found that your assessment did not, what it also looked at, and what you raised that it did not reach. Say plainly where you were wrong. Then the findings, marking which ones more than one model raised (`vote_count`) and which are disputed. Treat a finding marked `evidenceUnsupported` as unverified and check it yourself before repeating it. Answer any `host_verify` question from the code and report the answer.
6. If the result has `needed_context`, read the files it names (never credential or secret files; decline those and say so), then call `megalens_debate` ONE more time with the same arguments plus those files appended to `fileContext` as `=== FILE: path ===` blocks. Poll it as in step 4. Never make a third call. Tell the user what changed between the two results.
7. End with one line saying which files and context were included and what the manifest listed as left out or excluded.
