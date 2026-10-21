/* The provider adapters, and the options that make the Claude one safe.
 *
 * These assertions are deliberately about the object the adapter passes to the SDK rather than
 * about observed model behaviour: the point is that re-enabling a tool is a red build, and a
 * test that needed a real account to run would never guard anything in CI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tempData } from './helpers.mjs';

tempData();
const { adapterFor, default: ADAPTERS } = await import('../coach/adapters/index.js');
const claudeMod = await import('../coach/adapters/claude.js');
const { LOCKDOWN, ALLOWED_TOOLS, BUILTIN_TOOLS, MCP_SERVER, MAX_TURNS, queryOptions, zodShape } = claudeMod;
const { TOOL_NAMES, createToolset } = await import('../coach/assistant/tools.js');
const { argvFor } = await import('../coach/adapters/codex.js');
const cfg = await import('../coach/config.js');

test('every provider the config offers has an adapter, and vice versa', () => {
  assert.deepEqual(Object.keys(ADAPTERS).sort(), Object.keys(cfg.PROVIDERS).sort());
  for (const id of Object.keys(cfg.PROVIDERS)) assert.ok(adapterFor(id), `no adapter for "${id}"`);
  assert.equal(adapterFor('not-a-provider'), null);
});

test('the Claude adapter is locked out of every tool the SDK could give it', () => {
  // `tools: []` is the SDK's documented "disable all built-in tools" — no Read, no Bash, no
  // Grep, no WebFetch — and the others stop anything on the host widening that afterwards, or a
  // prompt for permission ever being waited on. If one of these ever has to change, it should
  // be a decision with a diff, not a default that drifted.
  assert.deepEqual(LOCKDOWN.tools, [], 'no built-in tools');
  assert.deepEqual(LOCKDOWN.settingSources, [], 'no settings files may be loaded');
  assert.deepEqual(LOCKDOWN.skills, [], 'no skills may be loaded');
  assert.equal(LOCKDOWN.strictMcpConfig, true, 'no MCP server may arrive from ambient config');
  assert.equal(LOCKDOWN.persistSession, false, 'no session history is written anywhere');
  assert.equal(LOCKDOWN.permissionMode, 'dontAsk', 'nothing is ever asked — unlisted tools are denied');
  assert.equal(LOCKDOWN.maxTurns, MAX_TURNS);
  assert.ok(MAX_TURNS >= 8 && MAX_TURNS <= 16, 'a handful of lookups, a proposal, a fix and the answer — not an open-ended loop');
});

const fakeServer = { type: 'sdk', name: MCP_SERVER, instance: {} };
const baseArgs = { mcpServer: fakeServer, env: { PATH: '/bin', HOME: '/tmp/j' }, model: 'm', cwd: '/tmp/j', abortController: new AbortController(), stderr() {}, spawnClaudeCodeProcess() {} };

test('the assistant job allows only the openGym tools, through one in-process server', () => {
  const o = queryOptions(baseArgs);
  // Exactly the nine tools, spelled the way the SDK spells an MCP tool — nothing built in.
  assert.deepEqual([...o.allowedTools].sort(), TOOL_NAMES.map(n => `mcp__${MCP_SERVER}__${n}`).sort());
  assert.deepEqual(o.allowedTools, [...ALLOWED_TOOLS]);
  for (const t of o.allowedTools) assert.match(t, /^mcp__opengym__[a-z_]+$/);
  assert.deepEqual(Object.keys(o.mcpServers), [MCP_SERVER], 'the one server we built, no other');
  assert.equal(o.mcpServers[MCP_SERVER], fakeServer);
  // No built-in can be among the allowed, and every common one is also named as refused.
  for (const b of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Skill']) {
    assert.ok(!o.allowedTools.includes(b), `${b} is not allowed`);
    assert.ok(o.disallowedTools.includes(b), `${b} is refused by name too`);
  }
  assert.deepEqual(o.disallowedTools, [...BUILTIN_TOOLS]);
  assert.equal(o.tools.length, 0);
  assert.equal(o.permissionMode, 'dontAsk');
  assert.equal(o.maxTurns, MAX_TURNS);
  assert.equal(o.persistSession, false);
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.strictMcpConfig, true);
  assert.equal(typeof o.spawnClaudeCodeProcess, 'function', 'the unprivileged spawn is still the one used');
  assert.ok(o.systemPrompt.includes('propose_changes'), 'the assistant prompt is the system prompt');
});

test('a round trip with no tools gets no server, no allowed tools and a single turn', () => {
  const o = queryOptions({ ...baseArgs, mcpServer: null });
  assert.deepEqual(o.allowedTools, []);
  assert.deepEqual(o.mcpServers, {});
  assert.equal(o.maxTurns, 1);
});

test('the job environment is the one built from nothing, plus the client name and no more', () => {
  const env = { PATH: '/bin', HOME: '/tmp/j', TMPDIR: '/tmp/j', ANTHROPIC_API_KEY: 'k' };
  const o = queryOptions({ ...baseArgs, env });
  assert.deepEqual(Object.keys(o.env).sort(), [...Object.keys(env), 'CLAUDE_AGENT_SDK_CLIENT_APP'].sort());
  assert.match(o.env.CLAUDE_AGENT_SDK_CLIENT_APP, /^opengym-coach\//);
  // …and config.jobEnv really is built from nothing: none of the server's own variables leak in.
  process.env.RP_ID = 'secret.example'; process.env.ADMIN_UIDS = 'a,b'; process.env.VAPID_PRIVATE_KEY = 'vapid';
  cfg.save({ enabled: true, provider: 'claude' });
  const built = cfg.jobEnv('/tmp/j', { ok: true, type: 'apikey', auth: { token: 'tok' } });
  for (const k of ['RP_ID', 'ADMIN_UIDS', 'VAPID_PRIVATE_KEY', 'DATA_DIR']) assert.equal(built[k], undefined, k);
  assert.equal(built.ANTHROPIC_API_KEY, 'tok');
  assert.equal(queryOptions({ ...baseArgs, env: built }).env.RP_ID, undefined);
});

test('the tool server really is built from the toolset, and its handlers run the same code', async t => {
  let m;
  try { m = { ...(await import('@anthropic-ai/claude-agent-sdk')), z: (await import('zod')).z }; } catch { return t.skip('the Agent SDK is not installed here'); }
  const S = { unit: 'lb', routines: [], workouts: [], bodyweight: [], customEx: [] };
  const toolset = createToolset({ uid: 'u1', readState: uid => (uid === 'u1' ? S : null) });
  const server = claudeMod.buildServer(m, toolset);
  assert.equal(server.type, 'sdk');
  const reg = server.instance._registeredTools;
  assert.deepEqual(Object.keys(reg).sort(), [...TOOL_NAMES].sort());
  const out = await reg.get_profile.handler({}, {});
  assert.equal(JSON.parse(out.content[0].text).unit, 'lb');
  assert.equal(out.isError, false);
  const bad = await reg.get_workout.handler({ id: 'nope' }, {});
  assert.equal(bad.isError, true);
});

test('a tool parameter spec becomes the zod shape the SDK takes', async t => {
  let z;
  try { z = (await import('zod')).z; } catch { return t.skip('zod is not installed here'); }
  const shape = zodShape(z, {
    a: { type: 'string', description: 'd' },
    b: { type: 'integer', optional: true, min: 1, max: 5 },
    c: { type: 'string', enum: ['x', 'y'] },
    d: { type: 'array' }
  });
  const schema = z.object(shape);
  assert.ok(schema.safeParse({ a: 's', c: 'x', d: [{ any: 1 }] }).success);
  assert.ok(!schema.safeParse({ a: 's', b: 9, c: 'x', d: [] }).success, 'max is enforced');
  assert.ok(!schema.safeParse({ a: 's', c: 'z', d: [] }).success, 'enum is enforced');
  assert.ok(!schema.safeParse({ c: 'x', d: [] }).success, 'required is enforced');
});

test('an image built without the AI runtime reports it rather than crashing', async () => {
  // The default build target has no SDK. check() is what the admin card renders, and it has to
  // answer honestly on both targets — this asserts the shape either way, so the test is not
  // hostage to which target the suite happens to run on.
  const r = await adapterFor('claude').check();
  assert.equal(typeof r.ok, 'boolean');
  if (r.ok) assert.match(r.version, /Claude Agent SDK/);
  else assert.match(r.error, /not installed/);
});

test('the fixture provider needs no credential and the Claude one names both it accepts', () => {
  assert.equal(cfg.PROVIDERS.fixture.apiKeyEnv, null);
  assert.equal(cfg.PROVIDERS.fixture.oauthEnv, null);
  // The two variables the runtime reads. jobEnv() injects the credential under one of them and
  // nothing else, which is what makes the sanitised environment the only channel it travels.
  assert.equal(cfg.PROVIDERS.claude.oauthEnv, 'CLAUDE_CODE_OAUTH_TOKEN');
  assert.equal(cfg.PROVIDERS.claude.apiKeyEnv, 'ANTHROPIC_API_KEY');
  assert.equal(cfg.PROVIDERS.claude.setupToken, true);
});

test('the Codex credential cache is a sibling of ./data, never inside it', () => {
  // The documented backup is `tar czf … data/`. A refresh token under ./data would ride along in
  // every archive an owner is told to make, and keep working wherever that archive is copied.
  const home = cfg.CREDENTIAL_HOME;
  assert.ok(home, 'a provider that writes a credential cache needs somewhere to write it');
  assert.equal(home.startsWith(process.env.DATA_DIR + '/'), false, `${home} is inside ./data`);

  // …and it is actually handed to the runtime, under the variable that provider declares.
  cfg.reset();
  cfg.save({ enabled: true, provider: 'codex' });
  assert.equal(cfg.jobEnv('/tmp/job', { ok: true }).CODEX_HOME, home);

  // A provider with no cache of its own is given no such variable at all.
  cfg.reset();
  cfg.save({ enabled: true, provider: 'claude' });
  assert.equal(cfg.jobEnv('/tmp/job', { ok: true }).CODEX_HOME, undefined);
});

test('the Codex adapter runs with the three flags that keep host state out of a job', () => {
  // Same reasoning as the Claude lockdown above: these are not stylistic. --ignore-user-config
  // stops $CODEX_HOME/config.toml being an admin-invisible input to every job, --ephemeral stops
  // session files being written, and --skip-git-repo-check is what lets the bare mkdtemp job dir
  // run at all. Dropping any of them was a green build before this test existed.
  assert.deepEqual(argvFor(null), [
    'exec', '-', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config'
  ]);
});

test('a configured model is appended, and nothing else is', () => {
  assert.deepEqual(argvFor('o4-mini').slice(-2), ['--model', 'o4-mini']);
  assert.equal(argvFor('o4-mini').length, argvFor(null).length + 2);
});

test('which adapters can run the assistant is stated, and agrees with what the config says', () => {
  const can = Object.entries(ADAPTERS).filter(([, a]) => a.tools === true).map(([id]) => id).sort();
  assert.deepEqual(can, ['anthropic', 'claude', 'fixture']);
  for (const id of ['codex', 'openai', 'gemini', 'compatible']) assert.notEqual(ADAPTERS[id].tools, true, id);
  // The config's public block tells the screens, so they can name the provider the assistant needs.
  for (const id of ['claude', 'anthropic', 'codex', 'openai']) {
    cfg.reset(); cfg.save({ enabled: true, provider: id });
    if (cfg.isConnected()) assert.equal(cfg.publicConfig().assistant, ADAPTERS[id].tools === true, id);
  }
});

test('every adapter states whether it spawns a process — the privilege gate reads that, not an absence', () => {
  for (const [id, a] of Object.entries(ADAPTERS)) assert.equal(typeof a.spawns, 'boolean', `${id}.spawns`);
  for (const id of ['claude', 'codex']) assert.equal(ADAPTERS[id].spawns, true, id);
  // The fixture is in-process: there is no model to sandbox.
  assert.equal(ADAPTERS.fixture.spawns, false);
  for (const id of ['anthropic', 'openai', 'gemini', 'compatible']) {
    assert.equal(ADAPTERS[id].spawns, false, id);
    assert.equal(cfg.PROVIDERS[id].http, true, id);
    assert.equal(cfg.PROVIDERS[id].credentialHomeEnv, undefined, `${id} keeps no credential cache`);
    assert.equal(typeof ADAPTERS[id].models, 'function', `${id} can list models`);
  }
});
