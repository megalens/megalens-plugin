#!/usr/bin/env node
// MegaLens local review server (MCP over stdio, no dependencies).
// One tool, megalens_review_change: runs collect.mjs itself, sends the bundle to the remote MegaLens MCP endpoint
// over HTTPS with the bearer token from MEGALENS_TOKEN, polls to completion and returns the result unchanged.
// The model never handles the bundle, so it cannot corrupt it. Nothing is written to stdout except MCP messages.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { secretPath, secretContent, validateRange, redactSecrets } from './lib/safety.mjs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
const COLLECT = path.join(HERE, 'collect.mjs');
const DEFAULT_URL = 'https://megalens.ai/api/mcp?ide=claude-code';
const BUDGET_MAX = 700_000; // collector hard limit
const BUDGET_DEFAULT = Math.min(Number(process.env.MEGALENS_MAX_BYTES) || 200_000, BUDGET_MAX); // default keeps a review near the typical cost; the server can ask for more via needed_context
const REQUEST_LIMIT = 950_000; // server limit is 1 MB per call; leave room for the HTTP/JSON envelope
const REQUEST_TIMEOUT_MS = Number(process.env.MEGALENS_REQUEST_TIMEOUT_MS) || 90_000;
const POLL_MIN_MS = Number(process.env.MEGALENS_POLL_MIN_MS) || 2000;
const POLL_TIMEOUT_MS = Number(process.env.MEGALENS_POLL_TIMEOUT_MS) || 25 * 60 * 1000;

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
// MEGALENS_URL override (benchmark harness points the local tool at a dev server). The bearer token travels
// with every request, so only https URLs or plain http to this machine (127.0.0.1, localhost, ::1) are accepted.
export function resolveUrl(raw) {
  if (!raw) return { url: DEFAULT_URL };
  let u;
  try { u = new URL(raw); } catch { return { error: 'MEGALENS_URL is not a valid URL.' }; }
  if (u.username || u.password) return { error: 'MEGALENS_URL must not contain credentials.' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) return { url: raw };
  return { error: 'MEGALENS_URL must be https, or http only for 127.0.0.1 / localhost. The bearer token is not sent anywhere else.' };
}
const env = (k) => { const v = process.env[k]; return v && !v.startsWith('${') ? v : ''; };
const log = (...a) => process.stderr.write(`[megalens-local] ${a.join(' ')}\n`);

export const TOOL = {
  name: 'megalens_review_change',
  description: 'ONLY call this tool when the user runs /megalens:megalens-review or explicitly asks to use MegaLens. Never call it for a general code-review request: it uploads code and spends paid credits. Review the current git change with MegaLens (models from different companies). A script collects the diff, the full changed files and bounded related context itself and sends them exactly; you only supply your own assessment first. Returns the MegaLens result unchanged (lead with its hostDelta).',
  inputSchema: {
    type: 'object',
    properties: {
      range: { type: 'string', description: 'Optional: a base ref (diff vs merge-base), a range A..B or A...B, or --staged. Omit to review the working tree against the merge base with the default branch.' },
      prompt: { type: 'string', description: 'Optional short review request (one or two sentences). A default is used when omitted.' },
      yourAssessment: {
        type: 'array', description: 'Your own findings before the call, one per point.',
        items: { type: 'object', properties: { claim: { type: 'string', description: '"file:line - what is wrong"' }, quote: { type: 'string', description: 'That line of code, verbatim.' } }, required: ['claim'] },
      },
      extraContext: { type: 'array', description: 'Only after explicit user confirmation for a follow-up billable review when a previous result carried needed_context: files you read because it asked, appended to the bundle (max 100 KB in total). Never send secrets.', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
      maxBytes: { type: 'number', description: 'Optional bundle budget in bytes (default 200000, or MEGALENS_MAX_BYTES; maximum 700000). Larger bundles cost more per review.' },
    },
  },
};

function runCollector(range, maxBytes, cwd) {
  return new Promise((resolve, reject) => {
    const args = [COLLECT, '--json', '--max-bytes', String(maxBytes), ...(range ? [range] : [])];
    const p = spawn('node', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = []; const err = [];
    p.stdout.on('data', (d) => out.push(d)); p.stderr.on('data', (d) => err.push(d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(Buffer.concat(err).toString().trim() || `collector exited ${code}`));
      try { resolve(JSON.parse(Buffer.concat(out).toString())); } catch (e) { reject(new Error(`collector output unreadable: ${e.message}`)); }
    });
  });
}

async function rpc(url, token, method, params, id) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'User-Agent': 'megalens-claude-plugin/0.2' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch((e) => { throw transient(`request to MegaLens failed: ${e.name === 'TimeoutError' ? `no answer within ${REQUEST_TIMEOUT_MS} ms` : e.message}`); });
  const text = await res.text().catch((e) => { throw transient(`reading the MegaLens response failed: ${e.name === 'TimeoutError' ? 'timeout' : e.message}`); });
  if (!res.ok) { const err = new Error(`MegaLens endpoint returned HTTP ${res.status}: ${text.slice(0, 300)}`); err.transient = res.status >= 500 || res.status === 429; throw err; }
  let body = text;
  if (/^\s*(event|data):/.test(text)) body = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).pop() || '';
  if (!body.trim()) throw transient('empty response frame from MegaLens');
  let j; try { j = JSON.parse(body); } catch (e) { throw transient(`unreadable response from MegaLens: ${e.message}`); }
  if (j.error) throw new Error(`MegaLens endpoint error: ${JSON.stringify(j.error).slice(0, 300)}`);
  return j.result;
}
// Refuse to collect from a folder that is certainly not the project: the home directory, the filesystem root,
// or anything that is not inside a git work tree (a host that starts the server in $HOME must not upload it).
export function unsafeProjectDir(dir) {
  let real; try { real = realpathSync(dir); } catch { return `Project folder ${dir} does not exist. Nothing was collected.`; }
  let home = ''; try { home = realpathSync(homedir()); } catch {}
  const allowHome = process.env.MEGALENS_ALLOW_HOME === '1'; // explicit opt-in for people who really keep their home folder in git
  const isHomeOrRoot = (d) => d === path.parse(d).root || d === home;
  const homeMsg = (d) => `The project folder resolved to ${d}, which is your home directory or the filesystem root, not a project. Open the project folder in the host, or set MEGALENS_PROJECT_DIR to it (MEGALENS_ALLOW_HOME=1 overrides this on purpose). Nothing was collected.`;
  if (!allowHome && isHomeOrRoot(real)) return homeMsg(real);
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: real, encoding: 'utf8' });
  if (r.status !== 0 || r.stdout.trim() !== 'true') return `${real} is not inside a git repository, so there is no change to review. Open the project folder in the host, or set MEGALENS_PROJECT_DIR to it. Nothing was collected.`;
  const t = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: real, encoding: 'utf8' });
  let top = ''; try { top = realpathSync(t.stdout.trim()); } catch {}
  if (!allowHome && top && isHomeOrRoot(top)) return homeMsg(top).replace('project folder', 'git repository');
  return '';
}
function transient(msg) { const e = new Error(msg); e.transient = true; return e; }
const textOf = (r) => (r?.content || []).map((c) => c.text || '').join('');

export async function reviewChange(args, ctx = {}) {
  const token = env('MEGALENS_TOKEN');
  if (!token) return fail('MEGALENS_TOKEN is not set, so the local review tool cannot call MegaLens. Set MEGALENS_TOKEN (a MegaLens MCP bearer token) and restart Claude Code, or use the OAuth fallback command /megalens:megalens-review-remote (smaller 90 KB budget, the model copies the bundle).');
  const target = resolveUrl(env('MEGALENS_URL'));
  if (target.error) return fail(target.error);
  const url = target.url;
  for (const k of ['CLAUDE_PROJECT_DIR', 'MEGALENS_PROJECT_DIR']) if ((process.env[k] || '').includes('${')) return fail(`${k} arrived as "${process.env[k]}": the host did not expand it. Open a workspace folder (single-root) or set ${k} to the project path, then restart the host. Nothing was collected.`);
  const cwd = ctx.cwd || env('CLAUDE_PROJECT_DIR') || env('MEGALENS_PROJECT_DIR') || process.cwd(); // MEGALENS_PROJECT_DIR: for hosts (Cursor, VS Code) that do not start the server in the project folder
  const bad = unsafeProjectDir(cwd);
  if (bad) return fail(bad);
  let budget = Math.min(Math.max(Number(args.maxBytes) || BUDGET_DEFAULT, 5000), BUDGET_MAX);
  try { args.range = validateRange(args.range) || undefined; } catch (e) { return fail(e.message); }
  const assessment = Array.isArray(args.yourAssessment) ? args.yourAssessment.filter((x) => x && typeof x.claim === 'string').map((x) => (x.quote ? { claim: x.claim, quote: x.quote } : { claim: x.claim })) : [];

  let extra = ''; const refused = [];
  if (Array.isArray(args.extraContext)) {
    for (const f of args.extraContext) {
      if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') continue;
      const rel = f.path.replace(/\\/g, '/');
      const norm = path.posix.normalize(rel).replace(/^\.\//, '');
      const outside = rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || norm === '..' || norm.startsWith('../');
      const why = outside ? 'outside the workspace' : secretPath(norm) ? 'secret-looking file name' : (() => { const c = secretContent(f.content, norm); return c ? `secret-looking content (${c})` : null; })();
      if (why) { refused.push(`${f.path}: ${why}`); continue; }
      const red = redactSecrets(f.content, norm);
      extra += `\n=== FILE: ${f.path.replace(/[\r\n]/g, ' ')} ===\n${red.text}\n`;
    }
    if (Buffer.byteLength(extra) > 100_000) return fail('extraContext is over 100 KB; send fewer or shorter excerpts.');
  }
  let col; let body; let bundleSha; let attempts = 0;
  for (;; attempts++) {
    try { col = await runCollector(args.range, budget, cwd); } catch (e) { return fail(`Could not collect the change: ${e.message}`); }
    if (col.nothingReviewable) return { content: [{ type: 'text', text: `Nothing reviewable was sent, so MegaLens was not called and nothing was charged. Why: ${col.reason}\n\n${col.manifest}` }] };
    if (col.empty) return { content: [{ type: 'text', text: `NO CHANGES FOUND (${col.change}). Nothing to review.` }] };
    col.refused = refused; col.bundle = col.bundle + extra; col.bundleBytes = Buffer.byteLength(col.bundle);
    bundleSha = sha256(col.bundle);
    const prompt = [
      (args.prompt && String(args.prompt).trim()) || 'Review this change for bugs, regressions and security problems. Report only defects you can point to in the code.',
      col.rules ? `\nRepository review rules (.megalens/rules):\n${col.rules}` : '',
      `\n[megalens-plugin bundle sha256=${bundleSha} bytes=${col.bundleBytes}]`,
    ].join('');
    body = { prompt, fileContext: col.bundle, skill: 'diff_audit', tier: 'standard', ...(assessment.length ? { yourAssessment: assessment } : {}) };
    const size = Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'megalens_debate', arguments: body } }));
    body._size = size;
    if (size <= REQUEST_LIMIT) break;
    if (attempts >= 5) return fail(`The request is ${size} bytes even at a ${budget}-byte budget; the server limit is 1 MB. Pass a smaller maxBytes.`);
    budget = Math.floor(budget * (REQUEST_LIMIT / size) * 0.95); // JSON escaping grew it: shrink the budget and re-collect
  }
  const requestBytes = body._size; delete body._size;
  const sentSha = sha256(body.fileContext);

  let runId = null; let debateSent = false;
  try {
    await rpc(url, token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'megalens-claude-plugin', version: '0.2.0' } }, 1);
    let first;
    try { first = await rpc(url, token, 'tools/call', { name: 'megalens_debate', arguments: body }, 2); }
    catch (e) {
      if (!e.transient) throw e;
      audit({ bundle_sha256: bundleSha, filecontext_sha256_sent: sentSha, bundle_bytes: col.bundleBytes, request_bytes: requestBytes, run_id: null, budget, change: col.change, debate_call: 'uncertain: ' + e.message });
      return fail(`The megalens_debate call did not complete (${e.message}). A run may already have started and may be charged. DO NOT call this tool again for this change. No run id came back; check megalens_history on the remote megalens server (or ask the user to check their MegaLens dashboard) before doing anything else.`);
    }
    debateSent = true; let final = first;
    let firstJson = null; try { firstJson = JSON.parse(textOf(first)); } catch { /* not JSON: returned as is */ }
    if (first.isError) return { ...first, content: [...first.content, note(col, bundleSha, sentSha, requestBytes, null, budget)] };
    runId = firstJson?.run_id || null;
    let finalJson = firstJson;
    if (runId && firstJson?.terminal !== true) {
      const end = Date.now() + POLL_TIMEOUT_MS;
      for (let n = 3; ; n++) {
        let r; let j = null;
        try {
          r = await rpc(url, token, 'tools/call', { name: 'megalens_poll', arguments: { run_id: runId } }, n);
          try { j = JSON.parse(textOf(r)); } catch { /* odd text: keep polling until the deadline */ }
          final = r;
          finalJson = j;
          if (j?.terminal === true || r.isError) break;
        } catch (e) {
          if (!e.transient) throw e; // 401/403/4xx and protocol errors are final; the debate call is never repeated
          log('transient poll error:', e.message);
        }
        if (Date.now() > end) return { isError: true, content: [{ type: 'text', text: `Timed out waiting for run ${runId}; call megalens_poll with that run_id.` }, note(col, bundleSha, sentSha, requestBytes, runId, budget)] };
        await new Promise((res) => setTimeout(res, Math.min(Math.max(Number(j?.poll_after_ms) || 8000, POLL_MIN_MS), 15000)));
      }
    }
    const neededCtx = Array.isArray(finalJson?.needed_context) && finalJson.needed_context.length > 0
      ? finalJson.needed_context
      : (Array.isArray(finalJson?.result?.needed_context) && finalJson.result.needed_context.length > 0 ? finalJson.result.needed_context : null);
    const neededNote = neededCtx
      ? (finalJson?.status === 'MCP_APPROVED' || finalJson?.result?.status === 'MCP_APPROVED'
        ? '\nNOTE: needed_context was returned on an approved (charged) review. Do NOT auto-resubmit; ask the user before starting another billable review.'
        : `\nNOTE: needed_context was returned on a halted review (${finalJson?.status || finalJson?.result?.status || 'halted'}). Do NOT auto-resubmit; ask the user before starting a new review.`)
      : '';
    audit({ bundle_sha256: bundleSha, filecontext_sha256_sent: sentSha, bundle_bytes: col.bundleBytes, request_bytes: requestBytes, run_id: runId, budget, change: col.change });
    return { ...final, content: [...(final.content || []), note(col, bundleSha, sentSha, requestBytes, runId, budget, neededNote)] };
  } catch (e) {
    if (debateSent) return fail(`MegaLens call failed after the review was submitted (${e.message}). The run ${runId ? `is ${runId}; call megalens_poll with it` : 'has no known id; check megalens_history on the remote megalens server'}. DO NOT call this tool again for this change: it would start a second paid run.`);
    return fail(`MegaLens call failed: ${e.message}`);
  }
}
function note(col, bundleSha, sentSha, requestBytes, runId, budget, extraNote = '') {
  return { type: 'text', text: `[megalens-plugin] bundle_sha256=${bundleSha} sent_sha256=${sentSha} bundle_bytes=${col.bundleBytes} request_bytes=${requestBytes} budget=${budget} run_id=${runId}${col.refused?.length ? `\nextraContext refused (not sent): ${col.refused.join('; ')}` : ''}${extraNote}\n${col.manifest}` };
}
function audit(rec) {
  const f = env('MEGALENS_AUDIT_LOG'); if (!f) return;
  try { appendFileSync(f, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n'); } catch (e) { log('audit log failed:', e.message); }
}
function fail(msg) { return { isError: true, content: [{ type: 'text', text: msg }] }; }

// ---------- MCP stdio loop
async function handle(msg, send) {
  const { id, method, params } = msg;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'megalens-local', version } } });
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: [TOOL] } });
  if (method === 'tools/call') {
    if (params?.name !== TOOL.name) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params?.name}` } });
    let result; try { result = await reviewChange(params.arguments || {}); } catch (e) { result = fail(`internal error: ${e.message}`); }
    return send({ jsonrpc: '2.0', id, result });
  }
  if (id !== undefined && method) return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  const rl = readline.createInterface({ input: process.stdin });
  const pending = new Set();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg; try { msg = JSON.parse(line); } catch { return; }
    const p = handle(msg, send).catch((e) => log('handler error:', e.message)).finally(() => pending.delete(p));
    pending.add(p);
  });
  rl.on('close', async () => { await Promise.all([...pending]); process.exit(0); });
}
