---
name: megalens-status
description: Check the status of the latest MegaLens review for this repository (or a specific review id). Use ONLY when the user explicitly invokes $megalens-status ($megalens:megalens-status) or asks for MegaLens review status.
---

Resolve the bundled MegaLens runner from **this installed skill/plugin directory** (`<SKILL_DIR>/../../scripts/codex-review.mjs`, resolving relative to the absolute directory containing this loaded `SKILL.md` file) — **never** resolve or run any script inside the repository under review.

If the user did not supply a review id, run `node "<SKILL_DIR>/../../scripts/codex-review.mjs" status` in the repository under review to check the latest MegaLens review for this repository.

If the user supplied a review id, first verify it is exactly one id matching `rv_` followed by 6 to 64 letters, digits, `_` or `-`, or `gh:` followed by digits only, or `app:` followed by digits only, and nothing else. If it is not, say so and stop; run nothing. Otherwise run `node "<SKILL_DIR>/../../scripts/codex-review.mjs" status <review-id>`.

Report what the script printed:
- If it is still running, say so and do not guess at findings.
- If it has finished, point to `$megalens-result`.
- If the state is failed, cancelled, or partial, say that in the first sentence: the review did not complete and is not a clean review. Never describe a failed, cancelled, partial, or unknown review as having no issues.
