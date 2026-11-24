import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { installCodex, parseArgs, resolveCodexHome } from './install-codex.mjs';

try {
  const options = parseArgs(process.argv.slice(2));
  const result = installCodex({ ...options, withOauthMcp: true }, { flags: { codexPlugin: true } });
  for (const line of result.report) console.log(line);
  process.exitCode = result.code;
  if (result.code === 0 && !options.dryRun) {
    const codexHome = resolveCodexHome(process.env, options.home || homedir(), options.codexHome);
    const login = spawnSync('codex', ['mcp', 'login', 'megalens'], {
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (login.error) throw login.error;
    process.exitCode = login.status ?? 2;
  }
} catch (error) {
  console.error(`MegaLens setup: ${error.message}`);
  process.exitCode = 2;
}
