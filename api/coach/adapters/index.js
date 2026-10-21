/* Provider adapters. Everything above this layer speaks one interface:
 *
 *   check(cfg, env)                                  → { ok, version?, error? }
 *   invoke({ prompt, system, tools, jobDir, env, model, timeoutMs }) → { code, text, stderr, timedOut, spawnError }
 *   spawns                                             true when a job runs a child process
 *   tools                                              true when invoke can run the assistant's tool loop
 *
 * `tools` is the job's toolset (assistant/tools.js). An adapter that cannot run a tool loop says
 * `tools: false` and the server refuses to start an assistant job on it, rather than answering
 * from nothing; the Coach screen then tells the person which provider the assistant needs.
 *
 * `spawns` decides whether the privilege drop is required before a job may run. The three
 * runtime-backed adapters say true; the HTTPS ones in ../core/adapters say false, because a
 * fetch has no process to drop privileges on and must not be refused for lacking one.
 *
 * Adding a provider is a file here plus a row in config.PROVIDERS. Nothing else in the
 * codebase — routes, jobs, payload, validation, UI — knows which one is configured.
 */
import fixture from './fixture.js';
import claude from './claude.js';
import codex from './codex.js';
import anthropic from '../core/adapters/anthropic.js';
import openai from '../core/adapters/openai.js';
import gemini from '../core/adapters/gemini.js';
import compatible from '../core/adapters/compatible.js';

/* claude is registered unconditionally, and that is safe because claude.js imports the SDK
   lazily: on the default image the module loads, check() reports the runtime as absent, and
   isConnected() keeps the Coach out of /api/config entirely. Codex is here too, and unlike
   the SDK its runtime is a CLI binary, so its absence shows up as a spawn error from check(). */
const ADAPTERS = { fixture, claude, codex, anthropic, openai, gemini, compatible };
export const adapterFor = provider => ADAPTERS[provider] || null;
export default ADAPTERS;
