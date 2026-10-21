/* An API key pasted in the admin card, end to end: the routes file the key, the job runner
 * decrypts it, the HTTP adapter puts it on the wire with the real undici fetch, the tool loop
 * runs the assistant's tools against the profile, and the proposal lands in the user's thread.
 * The only fake is the provider — a local HTTP server that speaks Anthropic's wire shape and
 * records what it was sent — reached through the base-URL override the config supports.
 *
 * This is the test that says "if somebody puts in an API key it actually works", short of
 * spending money against the real endpoint. The other HTTPS providers cannot run the assistant,
 * so for them the admin routes (connect, list models) are what is exercised, and the refusal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { tempData, writeState, sampleState } from './helpers.mjs';

const DIR = tempData();
const cfg = await import('../coach/config.js');
const jobs = await import('../coach/jobs.js');
const { coachRoutes } = await import('../coach/routes.js');
const { forcePrivilegeVerdict } = await import('../coach/adapters/spawn.js');
forcePrivilegeVerdict({ ok: true, dropped: false, why: 'pinned by the test suite' });

/* ---------- a provider on localhost ---------- */
const seen = [];
let script = [];            // what /v1/messages answers, call by call; the last one repeats
let failFirst = 0;
const text = t => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' });
const toolUse = (id, name, input) => ({ content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' });
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const rec = { url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
    seen.push(rec);
    const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    // Model listings, one shape per provider.
    if (req.method === 'GET' && req.url.startsWith('/v1/models') && !req.url.startsWith('/v1beta')) return send(200, { data: [{ id: 'model-a' }, { id: 'model-b' }] });
    if (req.method === 'GET' && req.url.startsWith('/v1beta/models')) return send(200, { models: [{ name: 'models/gem-a', supportedGenerationMethods: ['generateContent'] }] });
    if (failFirst > 0) { failFirst--; return send(529, { error: { type: 'overloaded_error', message: 'Overloaded' } }); }
    if (req.url === '/v1/messages') {
      const n = seen.filter(s => s.url === '/v1/messages').length;
      return send(200, { ...script[Math.min(n, script.length) - 1], usage: { input_tokens: 1, output_tokens: 1 } });
    }
    send(404, { error: { message: 'unknown route ' + req.url } });
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

/* ---------- the routes, driven like server.js drives them ---------- */
const admin = { id: 'admin', name: 'Admin' };
const fakeReq = (body, user = admin) => ({ headers: {}, _body: body, _user: user });
const fakeRes = () => { const r = { status: 0, body: null }; return r; };
const routes = coachRoutes({
  json: (res, code, obj) => { res.status = code; res.body = obj; },
  readBody: async req => req._body || {},
  readSession: req => req._user,
  requireAdmin: (req, res) => { if (req._user?.id === 'admin') return req._user; res.status = 403; return null; }
});
const call = async (route, body) => { const res = fakeRes(); await routes[route](fakeReq(body), res); return res; };

async function settle(uid, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const s = jobs.status(uid);
    if (!s.job) return s;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('job never finished');
}

/** Paste a key for `provider`, point it at the local server, choose a model, send one message. */
async function runChat(provider, key, uid, message = 'How am I doing?') {
  seen.length = 0;
  cfg.reset();
  cfg.save({ enabled: true, provider, authMode: 'instance', auth: {}, models: {}, boundUid: {}, log: [], caps: { perProfileDaily: 50, instanceDaily: 0 },
    providerOptions: { [provider]: { baseUrl: BASE } } });
  let r = await call('POST /api/admin/coach/connect', { type: 'apikey', token: key });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('POST /api/admin/coach/models', {});
  assert.equal(r.body.ok, true, 'the pasted key lists models: ' + JSON.stringify(r.body));
  assert.ok(r.body.models.length >= 1);
  r = await call('POST /api/admin/coach/config', { model: r.body.models[0] });
  assert.equal(r.status, 200);
  writeState(DIR, uid, sampleState());
  jobs.enqueue(uid, { text: message });
  await settle(uid);
  return jobs.readUser(uid);
}

test('Anthropic: the pasted key travels as x-api-key, the rules are the cached system block, and a proposal lands in the thread', async () => {
  script = [
    toolUse('t1', 'get_plan', {}),
    toolUse('t2', 'propose_changes', {
      summary: 'One set less on the dumbbell press.',
      changes: [{ type: 'sets', target: { routineId: 'r1', exId: '0001' }, after: 2, why: 'every top set was at RPE 10' }]
    }),
    text('I would drop one set on the first exercise, because every top set was at RPE 10.')
  ];
  const rec = await runChat('anthropic', 'sk-ant-test-123', 'u-anthropic');
  const calls = seen.filter(s => s.url === '/v1/messages');
  assert.equal(calls.length, 3, 'two tool turns and the answer');
  const job = calls[0];
  assert.equal(job.headers['x-api-key'], 'sk-ant-test-123');
  assert.equal(job.headers['anthropic-version'], '2023-06-01');
  assert.equal(job.body.model, 'model-a');
  assert.ok(Array.isArray(job.body.system) && job.body.system[0].cache_control?.type === 'ephemeral', 'rules block is marked cacheable');
  assert.match(job.body.system[0].text, /helpful, honest strength and conditioning coach/);
  assert.match(job.body.messages[0].content, /## New message from the user\n\nHow am I doing\?$/);
  assert.ok(!JSON.stringify(job.body).includes('sk-ant-test'), 'the key is never in the body');
  assert.ok(!seen.some(s => s.url.includes('sk-ant')), 'the key is never in a URL');
  // The first tool result is the profile's own plan, read by the server.
  const planResult = JSON.parse(calls[1].body.messages.at(-1).content[0].content);
  assert.equal(planResult.routines[0].id, 'r1');
  // The proposal tool answered ok to the model, and the card is on the reply.
  assert.equal(JSON.parse(calls[2].body.messages.at(-1).content[0].content).ok, true);
  assert.equal(rec.history.at(-1).outcome, 'ready', JSON.stringify(rec.history.at(-1)));
  const reply = rec.chat.at(-1);
  assert.match(reply.text, /drop one set/);
  assert.equal(reply.proposal.status, 'pending');
  assert.equal(reply.proposal.changes.length, 1);
  assert.equal(reply.proposal.changes[0].type, 'sets');
  assert.equal(reply.proposal.changes[0].before, 3, 'before is read off the plan, not taken from the model');
  assert.equal(reply.proposal.changes[0].after, 2);
  // Every profile may use an API key: a second profile is not refused.
  script = [text('fine')];
  writeState(DIR, 'u-anthropic-2', sampleState());
  assert.doesNotThrow(() => jobs.enqueue('u-anthropic-2', { text: 'hello' }));
  await settle('u-anthropic-2');
  assert.equal(jobs.readUser('u-anthropic-2').history.at(-1).outcome, 'ready');
});

test('OpenAI and Gemini: the key is filed and lists models, but a message is refused — they cannot run the assistant', async () => {
  for (const [provider, key, listUrl] of [['openai', 'sk-oa-test-456', '/v1/models'], ['gemini', 'AIza-test-789', '/v1beta/models']]) {
    seen.length = 0;
    cfg.reset();
    cfg.save({ enabled: true, provider, authMode: 'instance', auth: {}, models: {}, boundUid: {}, log: [], providerOptions: { [provider]: { baseUrl: BASE } } });
    assert.equal((await call('POST /api/admin/coach/connect', { type: 'apikey', token: key })).status, 200);
    const r = await call('POST /api/admin/coach/models', {});
    assert.equal(r.body.ok, true, provider + ': ' + JSON.stringify(r.body));
    assert.ok(seen.some(s => s.url.startsWith(listUrl)), provider + ' listed its models');
    const card = (await call('GET /api/admin/coach', {})).body;
    assert.equal(card.assistant, false, 'the admin card says this provider cannot run the assistant');
    writeState(DIR, 'u-' + provider, sampleState());
    assert.throws(() => jobs.enqueue('u-' + provider, { text: 'hi' }), e => e.code === 'tools');
    const res = await call('POST /api/coach/message', { text: 'hi' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'tools');
    assert.equal(seen.filter(s => s.url.includes('generateContent') || s.url.includes('chat/completions')).length, 0, 'nothing was sent for a message');
  }
});

test('an overloaded provider is retried and the job still succeeds', async () => {
  script = [text('All good.')];
  failFirst = 1;
  const rec = await runChat('anthropic', 'sk-ant-retry', 'u-retry');
  assert.equal(seen.filter(s => s.url === '/v1/messages').length, 2, 'one 529, one 200');
  assert.equal(rec.history.at(-1).outcome, 'ready');
  assert.equal(rec.chat.at(-1).text, 'All good.');
});

test('a wrong key is reported as an auth failure, with the provider\'s reason kept for the admin card', async () => {
  cfg.reset();
  cfg.save({ enabled: true, provider: 'anthropic', authMode: 'instance', auth: {}, models: {}, boundUid: {}, log: [],
    providerOptions: { anthropic: { baseUrl: BASE + '/reject' } } });
  // /reject/... is not served, so every call is a 404 — stand in for a provider saying no.
  await call('POST /api/admin/coach/connect', { type: 'apikey', token: 'sk-bad' });
  const r = await call('POST /api/admin/coach/models', {});
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /^404/);
  const status = await call('GET /api/admin/coach', {});
  assert.equal(status.body.runtime.ok, false);
  assert.equal(status.body.auth.state, 'connected', 'the key is filed even though the provider rejects it — the card says why');
});
