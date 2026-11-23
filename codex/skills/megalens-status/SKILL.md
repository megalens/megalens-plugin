---
name: megalens-status
description: Check the status of the latest MegaLens review for this repository (or a specific review id). Use ONLY when the user explicitly invokes $megalens-status or asks for MegaLens review status.
---

If the user did not supply a review id, run `node "codex/scripts/codex-review.mjs" status` to check the latest MegaLens review for this repository.

If the user supplied a review id, first verify it is exactly one id matching `rv_` followed by 6 to 64 letters, digits, `_` or `-`, or `gh:` followed by digits only, or `app:` followed by digits only, and nothing else. If it is not, say so and stop; run nothing. Otherwise run `node "codex/scripts/codex-review.mjs" status <review-id>`.

Report what the script printed:
- If it is still running, say so and do not guess at findings.
- If it has finished, point to `$megalens-result`.
- If the state is failed, cancelled, or partial, say that in the first sentence: the review did not complete and is not a clean review. Never describe a failed, cancelled, partial, or unknown review as having no issues.
