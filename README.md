# MegaLens plugins

Ask MegaLens to review your code from the tool you already use. You can read the findings in your editor or terminal and decide which changes to make.

## Install for your tool

Run the command for your tool from the root of this checkout. You need Node.js 18 or later. Open a project in your tool after setup.

### Claude Code

```sh
claude --plugin-dir ./claude
```

Run `/megalens:review` in Claude Code. For account setup and review options, see the [Claude Code guide](docs/claude-code.md).

### Codex

```sh
node codex/scripts/setup.mjs
```

This installs the preview for the CLI and desktop app and opens sign in. Have the Codex CLI on your path. Restart Codex, then run `$megalens-review`. For GitHub reviews, see [GitHub Actions setup](#github-actions-setup). [Codex guide](codex/GUIDE.md)

### Cursor

```sh
node cursor/scripts/cursor-cli.mjs install --local-plugin
```

Restart Cursor. Run `/megalens-login` to check setup, then run `/megalens-review`. For GitHub reviews, see [GitHub Actions setup](#github-actions-setup). [Cursor guide](cursor/GUIDE.md)

### GitHub Copilot

```sh
node copilot/setup.mjs
```

Sign in and confirm your account in the terminal. Restart VS Code or Copilot CLI and ask “Review my changes with MegaLens.”

### OpenCode

```sh
node opencode/setup.mjs
```

Sign in and confirm your account in the terminal. Restart OpenCode and run `/megalens-review`.

### Antigravity

```sh
node antigravity/setup.mjs
```

Sign in and confirm your account in the terminal. Restart Antigravity and ask “Review my changes with MegaLens.”

The Copilot, OpenCode and Antigravity commands install the preview from this checkout. [Preview details](docs/more-hosts-later.md)

## GitHub Actions setup

Use the [dispatch workflow](templates/megalens-dispatch.yml) for Claude Code, Codex or Cursor. Add it as `.github/workflows/megalens-dispatch.yml` on the default branch of the repository you want to review. Sign in with the GitHub CLI using `gh auth login`.

To add the repository secret through your browser, run `npx megalens-review init` in the repository. It sends the credential to `gh` on stdin. Decline the separate pull request for automatic reviews. If browser setup is unavailable, run `gh secret set MEGALENS_TOKEN` and enter an Action token at the private prompt.

The diff and code excerpts pass through the MegaLens gateway to OpenAI. MegaLens does not store your code. Approve that transfer when your tool asks.

Claude Code also supports the MegaLens GitHub App. The Double tier is planned for later. [Engine and service requirements](PLUGIN-NEEDS.md)

## Tests

```sh
npm test
```

Run `npm run sync:release` after changing the [release pins](release/pins.json) or the source files shipped with Claude Code. [Changelog](CHANGELOG.md)
