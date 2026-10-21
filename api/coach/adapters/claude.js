/* Claude Agent SDK adapter.
 *
 * Deliberately the SDK rather than a hand-rolled `claude --print`: it brings its own matching
 * runtime, takes the owner's credential only through the child environment, and exposes the
 * switches that keep the model inside the lane this app gives it.
 *
 * The lane is a tool loop over an in-process MCP server that exposes ONLY the openGym tools
 * (assistant/tools.js). Those tools are bound to one profile, read it and nothing else, and
 * never write: the model's only way to change anything is propose_changes, which records a
 * proposal for the person to apply. Everything else the SDK could give a model is switched off,
 * each by a documented option rather than a hopeful one:
 *
 *   tools: []          — "Disable all built-in tools" (SDK Options). No Read, no Bash, no Grep,
 *                        no WebFetch; the model has no filesystem or network tool at all,
 *                        however it is prompted.
 *   allowedTools       — exactly the openGym tools, nothing else is pre-approved.
 *   permissionMode     — 'dontAsk': anything not pre-approved is denied, nothing ever prompts
 *                        (there is nobody to prompt).
 *   disallowedTools    — the built-ins by name, a second lock on the door `tools: []` closes.
 *   settingSources: [] — no user/project/local settings file is loaded, so nothing on the host
 *                        can widen the lines above after the fact.
 *   skills: []         — same reasoning, for skills.
 *   strictMcpConfig    — no MCP server can arrive from ambient config; ours is the only one.
 *   persistSession     — nothing is written to disk for the next job to find.
 *
 * They are exported as LOCKDOWN / allowedTools and asserted by value in adapters.test.js, so
 * widening one is a red build rather than a quiet capability grant.
 *
 * The import is lazy on purpose. The default image ships without the SDK (see api/Dockerfile),
 * and an absent runtime has to be an ordinary reportable state — check() says so, isConnected()
 * goes false, and no Coach UI is mounted — rather than a boot crash for every instance that
 * never asked for the feature. `zod`, which the SDK's tool() takes its schemas in, is an
 * optional peer of the SDK and arrives with it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { unprivilegedIds } from './spawn.js';
import { SYSTEM_PROMPT } from '../assistant/prompt.js';
import { TOOL_NAMES } from '../assistant/tools.js';

const PKG = '@anthropic-ai/claude-agent-sdk';
const require_ = createRequire(import.meta.url);
// Read rather than hardcoded: the fork's copy still identified itself as 1.2.3 two releases
// later, which is the failure mode of every version string typed by hand.
const CLIENT_APP = `opengym-coach/${(() => {
  try { return require_('../../package.json').version; } catch { return '0' }
})()}`;
const OUTPUT_CAP = 4 * 1024 * 1024;

/** The name the in-process server is registered under; tool names reach the model prefixed with it. */
export const MCP_SERVER = 'opengym';
/** Turns the model gets for one message: a handful of lookups, a proposal, a fix, the answer. */
export const MAX_TURNS = 12;

/** The options that make this adapter safe. Exported so a test can assert them by value. */
export const LOCKDOWN = Object.freeze({
  tools: [],
  settingSources: [],
  skills: [],
  strictMcpConfig: true,
  persistSession: false,
  permissionMode: 'dontAsk',
  maxTurns: MAX_TURNS
});

/** The SDK's built-in tools, named so they can be refused twice: once by `tools: []`, once here. */
export const BUILTIN_TOOLS = Object.freeze([
  'Bash', 'BashOutput', 'KillShell', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'Task', 'Agent', 'TodoWrite', 'Skill', 'SlashCommand', 'ExitPlanMode', 'AskUserQuestion'
]);

/** The only tool names the model may call, as the SDK spells them. */
export const ALLOWED_TOOLS = Object.freeze(TOOL_NAMES.map(n => `mcp__${MCP_SERVER}__${n}`));

/**
 * Everything query() is given except the process plumbing. Pure, so the test reads the real
 * thing rather than a copy: `mcpServer` is the SDK server object (or null for a round trip that
 * needs no tools, which then also gets a single turn and no allowed tools at all).
 */
export function queryOptions({ mcpServer, env, model, cwd, abortController, stderr, spawnClaudeCodeProcess }) {
  const withTools = !!mcpServer;
  return {
    ...LOCKDOWN,
    maxTurns: withTools ? MAX_TURNS : 1,
    allowedTools: withTools ? [...ALLOWED_TOOLS] : [],
    disallowedTools: [...BUILTIN_TOOLS],
    mcpServers: withTools ? { [MCP_SERVER]: mcpServer } : {},
    abortController,
    cwd,
    // `env` REPLACES the child environment rather than extending it — which is exactly the
    // contract config.jobEnv() was written to. It builds from nothing, so RP_ID, ADMIN_UIDS
    // and the VAPID keys cannot reach the model process by inheritance.
    env: { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP },
    model: model || undefined,
    systemPrompt: SYSTEM_PROMPT,
    stderr,
    spawnClaudeCodeProcess
  };
}

/** A tool's parameter spec (assistant/tools.js) as a zod shape, which is what the SDK takes. */
export function zodShape(z, params) {
  const out = {};
  for (const [name, spec] of Object.entries(params)) {
    let s;
    if (spec.type === 'string') s = spec.enum ? z.enum(spec.enum) : z.string();
    else if (spec.type === 'integer') { s = z.number().int(); if (spec.min != null) s = s.min(spec.min); if (spec.max != null) s = s.max(spec.max); }
    else if (spec.type === 'number') s = z.number();
    else if (spec.type === 'boolean') s = z.boolean();
    else if (spec.type === 'array') s = z.array(z.record(z.string(), z.any()));
    else s = z.any();
    if (spec.description) s = s.describe(spec.description);
    out[name] = spec.optional ? s.optional() : s;
  }
  return out;
}

let cached;
/** Resolve the SDK (and zod, which it needs for tool schemas), or null when this image was built without them. */
async function sdk() {
  if (cached !== undefined) return cached;
  try { cached = { ...(await import(PKG)), z: (await import('zod')).z }; } catch { cached = null; }
  return cached;
}

/* The package does not expose ./package.json through its exports map, so ask the resolver where
   the entry point landed and read the manifest sitting next to it. Best-effort by design: the
   admin card shows the version when it can be had, and "installed" is a fine answer when not. */
function installedVersion() {
  try {
    const entry = fileURLToPath(import.meta.resolve(PKG));
    return JSON.parse(fs.readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8')).version || null;
  } catch { return null; }
}

/* The SDK owns the protocol; the Coach still owns the process boundary. Its runtime is launched
   as the same unprivileged `coach` user as every other provider, so dropping privileges is not
   something an adapter can forget to do. */
function spawnAsCoach({ command, args, cwd, env, signal }) {
  const ids = unprivilegedIds();
  return spawn(command, args, { cwd, env, signal, stdio: ['pipe', 'pipe', 'pipe'], ...(ids || {}) });
}

/** The in-process MCP server for one job's toolset. */
export function buildServer(m, toolset) {
  return m.createSdkMcpServer({
    name: MCP_SERVER,
    version: '1.0.0',
    tools: toolset.tools.map(t => m.tool(t.name, t.description, zodShape(m.z, t.params), async args => {
      const out = toolset.call(t.name, args || {});
      return { content: [{ type: 'text', text: JSON.stringify(out) }], isError: !!(out && (out.error || out.ok === false)) };
    }))
  });
}

export default {
  id: 'claude',
  spawns: true,
  /** Whether this adapter can run the assistant's tool loop. */
  tools: true,
  runtime: 'Claude Agent SDK',

  /* Importing the package is the check: it is exactly what a job will do, and it is the one
     difference between the two build targets. The credential is deliberately not probed here —
     that is testRun()'s job, which does a real round trip rather than inspecting a token this
     module never reads. */
  async check() {
    const m = await sdk();
    if (!m) return { ok: false, error: `the Claude runtime is not installed in this image (${PKG})` };
    const v = installedVersion();
    return { ok: true, version: v ? `Claude Agent SDK ${v}` : 'Claude Agent SDK' };
  },

  async invoke({ prompt, jobDir, env, model, timeoutMs, tools }) {
    const m = await sdk();
    if (!m) return { code: -1, text: '', stderr: `${PKG} is not installed`, timedOut: false, spawnError: true };

    let text = '', stderr = '', failure = '', timedOut = false;
    const abortController = new AbortController();
    const timer = setTimeout(() => { timedOut = true; abortController.abort(); }, timeoutMs);

    try {
      const options = queryOptions({
        mcpServer: tools ? buildServer(m, tools) : null,
        env, model, cwd: jobDir, abortController,
        stderr: data => { if (stderr.length < OUTPUT_CAP) stderr += data; },
        spawnClaudeCodeProcess: spawnAsCoach
      });
      for await (const message of m.query({ prompt, options })) {
        if (message.type !== 'result') continue;
        if (message.subtype === 'success') text = message.result;
        // A non-success result carries its reason in `subtype` (error_during_execution,
        // error_max_turns, …) and `stop_reason`. There is no error list on it — do not invent one.
        else failure = `the Agent SDK stopped: ${message.subtype}${message.stop_reason ? ` (${message.stop_reason})` : ''}`;
      }
    } catch (e) {
      if (timedOut) return { code: -1, text: '', stderr: 'the Agent SDK timed out', timedOut: true, spawnError: false };
      const why = stderr || (e instanceof Error ? e.message : String(e));
      // The runtime started and the account said no (a rejected key, a signed-out token): that
      // is an authentication failure to report as one, not a binary that failed to launch.
      if (/api key|auth|log ?in|credential|token|unauthori|401|403/i.test(why) && !/native binary|libc|ENOENT|EACCES/i.test(why)) {
        return { code: 1, text: '', stderr: why, timedOut: false, spawnError: false };
      }
      return { code: -1, text: '', stderr: why, timedOut: false, spawnError: true };
    } finally {
      clearTimeout(timer);
    }

    if (timedOut) return { code: -1, text: '', stderr: 'the Agent SDK timed out', timedOut: true, spawnError: false };
    if (failure) return { code: 1, text: '', stderr: failure, timedOut: false, spawnError: false };
    if (!text) return { code: 1, text: '', stderr: stderr || 'the Agent SDK returned no result', timedOut: false, spawnError: false };
    return { code: 0, text, stderr, timedOut: false, spawnError: false };
  }
};
