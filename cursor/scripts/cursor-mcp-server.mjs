#!/usr/bin/env node
// MegaLens Cursor plugin stdio MCP server (`megalens-runner`, zero dependencies, self-contained inside cursor/).
// Runs reviews on the user's own GitHub Actions runner (Windows, macOS, Linux).
// Sends NO server instructions field (never prompts unasked paid runs).
// Nothing is written to stdout except newline-delimited JSON-RPC MCP messages.

import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  ACTION_GATEWAY_NOTICE,
  cursorFixPrompt,
  cursorLatestResult,
  cursorReview,
  cursorSignInStatus,
  cursorStateDir,
  cursorStatus,
} from './lib/cursor-commands.mjs';
import { createOsSecretStore } from './lib/browser-auth.mjs';
import { realExec } from './lib/gh-runner.mjs';

const log = (...a) => process.stderr.write(`[megalens-runner] ${a.join(' ')}\n`);
const { version } = JSON.parse(readFileSync(new URL('../.cursor-plugin/plugin.json', import.meta.url), 'utf8'));
const cleanEnvVar = (k) => { const v = process.env[k]; return v && !v.startsWith('${') ? v : ''; };

// Refuse to run in a folder that is certainly not the project: home directory, filesystem root, or not inside a git work tree.
export function unsafeProjectDir(dir) {
  let real; try { real = realpathSync(dir); } catch { return `Project folder ${dir} does not exist. Nothing was run.`; }
  let home = ''; try { home = realpathSync(homedir()); } catch {}
  const allowHome = process.env.MEGALENS_ALLOW_HOME === '1';
  const isHomeOrRoot = (d) => d === path.parse(d).root || d === home;
  const homeMsg = (d) => `The project folder resolved to ${d}, which is your home directory or the filesystem root, not a project. Open the project folder in Cursor, or pass cwd explicitly (MEGALENS_ALLOW_HOME=1 overrides this on purpose). Nothing was run.`;
  if (!allowHome && isHomeOrRoot(real)) return homeMsg(real);
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: real, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || r.stdout.trim() !== 'true') return `${real} is not inside a git repository, so there is no change to review. Open the project folder in Cursor, or pass cwd explicitly. Nothing was run.`;
  const t = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: real, encoding: 'utf8', windowsHide: true });
  let top = ''; try { top = realpathSync(t.stdout.trim()); } catch {}
  if (!allowHome && top && isHomeOrRoot(top)) return homeMsg(top).replace('project folder', 'git repository');
  return '';
}

export const TOOLS = [
  {
    name: 'megalens_cursor_review',
    description:
      `ONLY call this tool when the user runs /megalens-review or explicitly asks to use MegaLens. Never call it automatically or for a general code-review request: it starts a review on the user's GitHub Actions runner and spends MegaLens credits. Tell the user before calling: ${ACTION_GATEWAY_NOTICE} Proceed only once the user agrees to this transfer. Reviews the current branch or pull request (standard or deep tier) on Windows, macOS, and Linux.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['allow_gateway'],
      properties: {
        allow_gateway: { type: 'boolean', description: 'Set to true only if the user approved sending the diff and code excerpts through the MegaLens gateway to OpenAI for this review.' },
        tier: { type: 'string', enum: ['standard', 'deep'], description: 'Review tier: standard (default, 1 credit) or deep (8 credits).' },
        pr: { type: 'string', description: 'Optional pull request number (digits only, e.g. "42").' },
        base: { type: 'string', description: 'Optional base git ref or commit SHA (must be paired with head).' },
        head: { type: 'string', description: 'Optional head git ref or commit SHA (must be paired with base).' },
        cwd: { type: 'string', description: 'Optional absolute path to the git repository to review.' },
      },
    },
  },
  {
    name: 'megalens_cursor_status',
    description:
      'Check the status of the latest MegaLens GitHub-runner review (or a specific gh:<id> run). Uses zero credits.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Optional GitHub review id like gh:123456789. Omit to check the latest review for this repo.' },
        cwd: { type: 'string', description: 'Optional absolute path to the git repository.' },
      },
    },
  },
  {
    name: 'megalens_cursor_latest_result',
    description:
      'Fetch and display the latest MegaLens review result (or a specific gh:<id> run) with numbered findings ready for megalens_cursor_fix_prompt. Uses zero credits.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Optional GitHub review id like gh:123456789. Omit to show the latest review result.' },
        cwd: { type: 'string', description: 'Optional absolute path to the git repository.' },
      },
    },
  },
  {
    name: 'megalens_cursor_fix_prompt',
    description:
      'Build a fix prompt from the latest MegaLens review of the current commit or from an explicit run ID. Optionally copy it to the clipboard. Uses zero credits.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        finding: { type: 'string', description: 'Finding number (e.g. "1") or finding id (e.g. "f1"). Omit if there is only one finding or to list choices.' },
        all: { type: 'boolean', description: 'If true, output fix prompts for all findings.' },
        id: { type: 'string', description: 'Optional GitHub review id like gh:123456789.' },
        copy: { type: 'boolean', description: 'If true, also copy the plain-text fix prompt to the OS clipboard.' },
        cwd: { type: 'string', description: 'Optional absolute path to the git repository.' },
      },
    },
  },
  {
    name: 'megalens_cursor_signin_status',
    description:
      'Check MegaLens sign-in status, GitHub CLI (`gh`) login, and GitHub Actions runner readiness (workflow + MEGALENS_TOKEN name check) for this repository. Never reads or prints tokens. Uses zero credits.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: { type: 'string', description: 'Optional absolute path to the git repository.' },
      },
    },
  },
];

function fail(msg) {
  return { isError: true, content: [{ type: 'text', text: msg }] };
}

function resolveRepoCwd(args, env = process.env) {
  const raw = typeof args?.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : null;
  if (raw && raw.includes('${')) {
    return { error: `cwd arrived unexpanded ("${raw}"). Pass the workspace path and try again.` };
  }
  if (!raw && (env.MEGALENS_PROJECT_DIR || '').includes('${')) {
    return { error: `MEGALENS_PROJECT_DIR arrived unexpanded ("${env.MEGALENS_PROJECT_DIR}"). Pass cwd explicitly or open a single-root workspace.` };
  }
  const cwd = raw || cleanEnvVar('MEGALENS_PROJECT_DIR') || process.cwd();
  const bad = unsafeProjectDir(cwd);
  if (bad) return { error: bad };
  return { cwd };
}

export async function callTool(name, args = {}, ctx = {}) {
  const exec = ctx.exec || realExec;
  const env = ctx.env || process.env;
  const stateDir = ctx.stateDir || cursorStateDir();
  const secretStore = ctx.secretStore || createOsSecretStore();
  const skipCwdCheck = Boolean(ctx.skipCwdCheck);

  let cwd = ctx.cwd || null;
  if (!cwd) {
    if (skipCwdCheck) {
      cwd = args.cwd || process.cwd();
    } else {
      const resolved = resolveRepoCwd(args, env);
      if (resolved.error) return fail(resolved.error);
      cwd = resolved.cwd;
    }
  }

  if (name === 'megalens_cursor_review') {
    const r = await cursorReview({
      exec,
      cwd,
      env,
      tier: args.tier || 'standard',
      pr: args.pr ?? null,
      base: args.base ?? null,
      head: args.head ?? null,
      allowGateway: args.allow_gateway,
      stateDir,
      runnerTiming: ctx.runnerTiming,
    });
    return { ...(r.code !== 0 ? { isError: true } : {}), content: [{ type: 'text', text: r.text }] };
  }

  if (name === 'megalens_cursor_status') {
    const r = await cursorStatus({ exec, cwd, env, id: args.id ?? null, stateDir });
    return { ...(r.code !== 0 ? { isError: true } : {}), content: [{ type: 'text', text: r.text }] };
  }

  if (name === 'megalens_cursor_latest_result') {
    const r = await cursorLatestResult({ exec, cwd, env, id: args.id ?? null, stateDir });
    return { ...(r.code !== 0 ? { isError: true } : {}), content: [{ type: 'text', text: r.text }] };
  }

  if (name === 'megalens_cursor_fix_prompt') {
    const r = await cursorFixPrompt({
      exec,
      cwd,
      env,
      selector: args.finding ?? null,
      all: Boolean(args.all),
      id: args.id ?? null,
      copy: Boolean(args.copy),
      stateDir,
      ...(ctx.copyFn ? { copyFn: ctx.copyFn } : {}),
    });
    return { ...(r.code !== 0 ? { isError: true } : {}), content: [{ type: 'text', text: r.text }] };
  }

  if (name === 'megalens_cursor_signin_status') {
    const r = await cursorSignInStatus({ exec, cwd, env, secretStore });
    return { content: [{ type: 'text', text: r.text }] };
  }

  return null;
}

export async function handleRpc(msg, send, ctx = {}) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'megalens-runner', version },
      },
    });
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const res = await callTool(params?.name, params?.arguments || {}, ctx).catch((e) => fail(`internal error: ${e.message}`));
    if (res === null) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params?.name}` } });
    return send({ jsonrpc: '2.0', id, result: res });
  }
  if (id !== undefined && method) return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  const rl = readline.createInterface({ input: process.stdin });
  const pending = new Set();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const p = handleRpc(msg, send).catch((e) => log('handler error:', e.message)).finally(() => pending.delete(p));
    pending.add(p);
  });
  rl.on('close', async () => { await Promise.all([...pending]); process.exit(0); });
}
