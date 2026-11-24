# Changelog

## 0.2.0

* The repository now includes MegaLens for Claude Code, Codex, Cursor, GitHub Copilot, OpenCode and Antigravity.
* Codex and the three hosted editor setups have explicit preview commands. Codex setup opens browser sign in for the CLI and desktop app.
* Claude Code, Codex and Cursor share a GitHub Actions workflow. It checks approval before starting a review and retries an unsuccessful findings upload once.
* One test command covers all six hosts. The workflow and release versions come from the same [release file](release/pins.json).
