import { runCli } from '../install.mjs';

export async function setupPreviewHost(host, args = process.argv.slice(2)) {
  try {
    const lines = await runCli([...args, '--host', host, '--browser-login'], { moreHosts: true });
    for (const line of lines) console.log(line);
  } catch (error) {
    console.error(`MegaLens setup: ${error.message}`);
    process.exitCode = 2;
  }
}
