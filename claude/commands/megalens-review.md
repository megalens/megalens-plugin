---
description: Review your current change with MegaLens (a local tool collects and sends the diff, changed files and related code exactly, 200 KB by default, up to 700 KB)
argument-hint: [ref | A..B | --staged]
disable-model-invocation: true
allowed-tools: Bash(git diff:*) Bash(git status:*) Bash(git merge-base:*) Bash(git log:*) mcp__plugin_megalens_megalens-local__megalens_review_change
---
Review the current change with MegaLens. Follow these steps in order.

1. Look at the change yourself: run `git status --short` and `git diff $ARGUMENTS` (for a base ref or no argument use `git diff $(git merge-base <base> HEAD)` with `main` or `master` as the base; `--staged` means `git diff --staged`). Read the changed files you need.
2. Write your own review first: every bug, regression or risk you see, each as `file:line` plus what is wrong. Real defects only; no style remarks.
3. Call `megalens_review_change` **at most once** per user request with:
   - `range`: "$ARGUMENTS" if it is not empty, otherwise leave it out.
   - `yourAssessment`: your step 2 points, one object per point: `claim` = "file:line - what is wrong", `quote` = that line of code copied verbatim.
   - `prompt`: leave it out unless the user asked for a particular focus.
   You do NOT collect, copy or send any file content: the tool does that itself and waits for the review to finish. On any timeout or lost response, **DO NOT call `megalens_review_change` again** — a run may already have started and been billed; check `megalens_history` (or ask the user to check their MegaLens dashboard) first.
4. If the tool says MEGALENS_TOKEN is not set, tell the user: set `MEGALENS_TOKEN` and restart Claude Code, or run `/megalens:megalens-review-remote` (OAuth, small 90 KB bundle that the model has to copy, so less reliable). Stop there.
5. Present the result. Start with `hostDelta`: what the panel found that your assessment did not, what it also looked at, and what you raised that it did not reach. Say plainly where you were wrong. Then the findings, marking which ones more than one model raised (`vote_count`) and which are disputed. Treat a finding marked `evidenceUnsupported` as unverified and check it yourself before repeating it. Answer any `host_verify` question from the code and report the answer.
6. If the result has `needed_context` (whether on an **approved, charged** review or a **terminal halt**), **DO NOT automatically call `megalens_review_change` again**. Every new submission starts a fresh run ID with its own billing / free-review admission. Present the result (or halt reason) and the requested `needed_context` items, and **ask the user for explicit confirmation** before starting another billable review with those files passed as `extraContext` (`path` and `content`, relevant parts only). Even after confirmation, never read or send credential or secret files (decline those and say so).
7. End with one line from the tool's last text block: the bundle size, the sha256, and what the manifest listed as left out or excluded.
