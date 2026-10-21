/* The assistant, end to end through the real queue.
 *
 * Two kinds of fake provider. The fixture runs in-process and calls the real tools through the
 * real toolset, so every outcome the user can be shown (an answer, a proposal, a refused
 * proposal, a failure) is one FIXTURE_MODE away. A local HTTP server speaking the Anthropic wire
 * is the other: it lets a job be caught mid-call, and lets the request that left the server be
 * read back — which is where "what does the model actually receive" is answered.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tempData, writeState, sampleState } from './helpers.mjs';

const DIR = tempData();
const cfg = await import('../coach/config.js');
const jobs = await import('../coach/jobs.js');
const { forcePrivilegeVerdict } = await import('../coach/adapters/spawn.js');
const { CHANGE_KINDS } = await import('../coach/core/changes.js');

cfg.save({ enabled: true, provider: 'fixture' });

/* The privilege drop fails closed on Linux unless the server is root *and* the image has a
   `coach` user — true in the container, false on a CI runner and false on most development
   boxes. Left to the host, every test below that enqueues a spawning job would pass or fail
   depending on where it ran. So the verdict is pinned here, and the one test that cares about
   the refusal pins the opposite verdict for its own duration. */
forcePrivilegeVerdict({ ok: true, dropped: false, why: 'pinned by the test suite' });

/** Jobs are async by design; the tests wait the way the client does — by polling status. */
async function settle(uid, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const s = jobs.status(uid);
    if (!s.job) return s;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('job never finished');
}
const lastOutcome = uid => jobs.readUser(uid).history.at(-1);
const lastReply = uid => jobs.readChat(uid).at(-1);
const say = (uid, text, extra = {}) => jobs.enqueue(uid, { text, ...extra });
const withMode = async (mode, fn) => {
  process.env.FIXTURE_MODE = mode;
  try { return await fn(); } finally { delete process.env.FIXTURE_MODE; }
};

test('no consent, no job — the gate is on the server, not the screen', () => {
  const uid = 'u-noconsent';
  writeState(DIR, uid, sampleState({ coach: {} }));
  assert.throws(() => say(uid, 'hi'), e => e.code === 'consent');
  assert.deepEqual(jobs.readChat(uid), [], 'nothing was written for a refused message');
});

test('an empty message is refused before anything is spent', () => {
  const uid = 'u-empty';
  writeState(DIR, uid, sampleState());
  assert.throws(() => say(uid, '   '), e => e.code === 'empty');
  assert.throws(() => jobs.enqueue(uid, {}), e => e.code === 'empty');
  assert.equal(jobs.capState(uid).used, 0);
});

test('one message in, one answer out: both land in the thread, in order, and the status says when', async () => {
  const uid = 'u-chat';
  writeState(DIR, uid, sampleState());
  const before = jobs.status(uid).chatRev;
  const r = say(uid, 'How is my training going?');
  assert.equal(r.message.role, 'user');
  assert.equal(jobs.status(uid).job.state, 'running');
  assert.ok(jobs.status(uid).chatRev > before, 'the user line is already in the thread');
  const s = await settle(uid);
  assert.equal(lastOutcome(uid).outcome, 'ready');

  const chat = jobs.readChat(uid);
  assert.deepEqual(chat.map(m => m.role), ['user', 'assistant']);
  assert.equal(chat[0].text, 'How is my training going?');
  assert.match(chat[1].text, /You have 1 workout logged \(unit kg\)/, 'the fixture really called the tools and read what they returned');
  assert.equal(chat[1].proposal, undefined, 'a plain question gets a plain answer');
  assert.ok(s.chatRev > before + 1);
  assert.deepEqual(s.assistant, { supported: true, provider: 'fixture' });
});

test('one job per profile at a time', async () => {
  const uid = 'u-single';
  writeState(DIR, uid, sampleState());
  say(uid, 'one');
  assert.throws(() => say(uid, 'two'), e => e.code === 'busy');
  await settle(uid);
  assert.equal(jobs.readChat(uid).filter(m => m.role === 'user').length, 1, 'the refused message was not stored');
});

test('the daily cap is enforced and reported as its own failure', async () => {
  const uid = 'u-cap';
  writeState(DIR, uid, sampleState());
  cfg.save({ caps: { perProfileDaily: 1, instanceDaily: 0 } });
  say(uid, 'first');
  await settle(uid);
  assert.throws(() => say(uid, 'second'), e => e.code === 'cap');
  assert.equal(jobs.capState(uid).used, 1);
  cfg.save({ caps: { perProfileDaily: 10, instanceDaily: 0 } });
});

test('the instance cap counts every profile, and is reserved at enqueue', async () => {
  cfg.save({ caps: { perProfileDaily: 50, instanceDaily: cfg.load().daily?.date === new Date().toISOString().slice(0, 10) ? cfg.load().daily.count + 1 : 1 } });
  writeState(DIR, 'u-inst-1', sampleState());
  writeState(DIR, 'u-inst-2', sampleState());
  say('u-inst-1', 'hello');
  assert.throws(() => say('u-inst-2', 'hello'), e => e.code === 'cap', 'the job still running already counts');
  await settle('u-inst-1');
  cfg.save({ caps: { perProfileDaily: 10, instanceDaily: 0 } });
});

test('the tools are bound to the profile that asked: two profiles, two different answers', async () => {
  writeState(DIR, 'u-a', sampleState());
  const many = sampleState();
  many.workouts = [1, 2, 3].map(i => ({ ...many.workouts[0], id: 'wx' + i, d: '2026-07-0' + i }));
  many.unit = 'lb';
  writeState(DIR, 'u-b', many);
  say('u-a', 'how many workouts do I have');
  say('u-b', 'how many workouts do I have');
  await settle('u-a'); await settle('u-b');
  assert.match(lastReply('u-a').text, /You have 1 workout logged \(unit kg\)/);
  assert.match(lastReply('u-b').text, /You have 3 workouts logged \(unit lb\)/);
});

test('a proposal is validated, held on the reply with its status, and its decisions are recorded forward only', async () => {
  const uid = 'u-propose';
  writeState(DIR, uid, sampleState());
  say(uid, 'please log my weight');
  await settle(uid);
  const reply = lastReply(uid);
  assert.equal(lastOutcome(uid).outcome, 'ready');
  const p = reply.proposal;
  assert.ok(p, 'a card rides on the reply');
  assert.equal(p.status, 'pending');
  assert.ok(p.changes.length && p.changes.every(c => CHANGE_KINDS.includes(c.type)), 'every change is on the closed list');
  assert.ok(p.changes.every(c => c.why && c.id), 'every change says why');
  assert.equal(p.changes[0].type, 'bodyweight-set');
  assert.deepEqual(jobs.readState(uid).bodyweight.length, 2, 'the assistant wrote nothing to the state file');

  // Decisions move forward only: pending -> applied -> undone, or pending -> dismissed.
  assert.deepEqual(jobs.resolveProposal(uid, 'nope', 'applied'), { ok: false, code: 'unknown' });
  assert.equal(jobs.resolveProposal(uid, p.id, 'undone').code, 'state', 'cannot undo what was never applied');
  assert.equal(jobs.resolveProposal(uid, p.id, 'applied').ok, true);
  assert.equal(jobs.resolveProposal(uid, p.id, 'dismissed').code, 'state', 'cannot dismiss what was applied');
  assert.equal(jobs.resolveProposal(uid, p.id, 'undone').ok, true);
  assert.equal(jobs.resolveProposal(uid, p.id, 'applied').code, 'state');
  assert.equal(lastReply(uid).proposal.status, 'undone');
});

test('the next message is told what became of the last proposal', async () => {
  const uid = 'u-memory';
  writeState(DIR, uid, sampleState());
  const http = await anthropicServer();
  try {
    http.use();
    // Plant a conversation: an assistant reply carrying a proposal the person applied.
    fs.mkdirSync(`${DIR}/coach`, { recursive: true });
    fs.writeFileSync(`${DIR}/coach/${uid}.json`, JSON.stringify({
      chat: [
        { id: 'm1', role: 'user', kind: 'text', text: 'add a set to bench', at: 1 },
        { id: 'm2', role: 'assistant', kind: 'text', text: 'I propose one more set.', at: 2, proposal: { id: 'p1', summary: 'one more set', status: 'applied', createdAt: 2, changes: [{ type: 'sets', id: 'k0' }] } },
        { id: 'm3', role: 'assistant', kind: 'error', text: '', errorClass: 'timeout', at: 3 }
      ], rev: 3, history: []
    }));
    say(uid, 'and now squats');
    await http.until(1);
    http.answer('Sure.');
    await settle(uid);
    const prompt = http.seen[0].messages[0].content;
    assert.match(prompt, /User: add a set to bench/);
    assert.match(prompt, /Assistant: I propose one more set\./);
    assert.match(prompt, /Proposal "one more set": 1 change \(sets\) — the person applied it/);
    assert.ok(!/timeout/.test(prompt), 'a failed turn is not part of the conversation the model is shown');
    assert.match(prompt, /## New message from the user\n\nand now squats$/);
    assert.match(prompt, /Today is \d{4}-\d{2}-\d{2}\. App language: en\. Weight unit: kg\./);
  } finally { http.close(); }
});

test('the conversation the model sees is the last twenty turns, each cut short', async () => {
  const uid = 'u-window';
  writeState(DIR, uid, sampleState());
  const http = await anthropicServer();
  try {
    http.use();
    const chat = Array.from({ length: 50 }, (_, i) => ({
      id: 'm' + i, role: i % 2 ? 'assistant' : 'user', kind: 'text', text: `line ${i} ` + 'x'.repeat(5000), at: i
    }));
    fs.mkdirSync(`${DIR}/coach`, { recursive: true });
    fs.writeFileSync(`${DIR}/coach/${uid}.json`, JSON.stringify({ chat, rev: 1, history: [] }));
    say(uid, 'latest');
    await http.until(1);
    http.answer('ok');
    await settle(uid);
    const prompt = http.seen[0].messages[0].content;
    assert.ok(prompt.includes('line 49 ') && prompt.includes('line 30 '), 'the last twenty are there');
    assert.ok(!prompt.includes('line 29 '), 'the twenty-first from the end is not');
    assert.ok(prompt.length < 20 * 1700 + 2000, 'each turn is cut, so the prompt stays small');
  } finally { http.close(); }
});

test('a proposal the validator refuses is corrected inside the same job; one that is never right gives a plain answer and no card', async () => {
  writeState(DIR, 'u-fix', sampleState());
  await withMode('bad-then-good', async () => { say('u-fix', 'try'); await settle('u-fix'); });
  const fixed = lastReply('u-fix');
  assert.equal(fixed.proposal.changes[0].type, 'sets', 'the corrected proposal is the one that reaches the card');
  assert.match(fixed.text, /proposed after one correction/);

  writeState(DIR, 'u-fix2', sampleState());
  await withMode('bad-forever', async () => { say('u-fix2', 'try'); await settle('u-fix2'); });
  const never = lastReply('u-fix2');
  assert.equal(never.proposal, undefined, 'a refused proposal never becomes a card');
  assert.match(never.text, /refused: .*not-a-real-exercise.*not in the exercise library/s, 'the model was told which id was wrong');
  assert.equal(lastOutcome('u-fix2').outcome, 'ready');
});

test('an answer with no text is a failure the thread says so about, not an empty bubble', async () => {
  const uid = 'u-notext';
  writeState(DIR, uid, sampleState());
  await withMode('no-text', async () => { say(uid, 'hello'); await settle(uid); });
  assert.equal(lastOutcome(uid).outcome, 'failed');
  assert.equal(lastOutcome(uid).errorClass, 'unusable');
  const m = lastReply(uid);
  assert.equal(m.kind, 'error');
  assert.equal(m.errorClass, 'unusable');
  assert.equal(m.proposal, undefined);
});

test('a provider that crashes or times out is reported once, in the thread, and never retried', async () => {
  writeState(DIR, 'u-crash', sampleState());
  await withMode('crash', async () => { say('u-crash', 'hi'); await settle('u-crash'); });
  assert.equal(lastOutcome('u-crash').outcome, 'failed');
  assert.equal(lastReply('u-crash').errorClass, 'provider');
  assert.equal(jobs.readUser('u-crash').history.filter(h => h.outcome === 'failed').length, 1, 'exactly one attempt');

  writeState(DIR, 'u-slow', sampleState());
  await withMode('timeout', async () => { say('u-slow', 'hi'); await settle('u-slow'); });
  assert.equal(lastReply('u-slow').errorClass, 'timeout');
  // A failed turn does not poison the next one.
  say('u-slow', 'again');
  await settle('u-slow');
  assert.equal(lastOutcome('u-slow').outcome, 'ready');
});

test('the thread is bounded by count, old proposals shrink to a summary, and the newest keep their changes', () => {
  const uid = 'u-bound';
  const big = i => ({
    id: 'm' + i, role: 'assistant', kind: 'text', text: 'reply ' + i, at: i,
    proposal: { id: 'p' + i, summary: 'sum ' + i, status: i % 2 ? 'applied' : 'dismissed', createdAt: i, changes: Array.from({ length: 5 }, (_, k) => ({ id: 'k' + k, type: k % 2 ? 'sets' : 'reps', why: 'because', lines: [] })) }
  });
  const chat = jobs.boundChat(Array.from({ length: 150 }, (_, i) => big(i)));
  assert.equal(chat.length, jobs.CHAT_MAX);
  assert.equal(chat.at(-1).id, 'm149', 'the newest survive, the oldest go');
  const whole = chat.filter(m => Array.isArray(m.proposal.changes));
  assert.equal(whole.length, jobs.FULL_PROPOSALS);
  assert.equal(whole.at(-1).id, 'm149');
  const old = chat[0].proposal;
  assert.equal(old.changes, undefined);
  assert.equal(old.count, 5);
  assert.deepEqual(old.kinds, ['reps', 'sets']);
  assert.equal(old.status, 'dismissed', 'what happened to it is kept');

  // And by bytes: one enormous message cannot push the file past its budget.
  const fat = jobs.boundChat(Array.from({ length: 30 }, (_, i) => ({ id: 'f' + i, role: 'user', kind: 'text', text: 'y'.repeat(60000), at: i })));
  assert.ok(JSON.stringify(fat).length <= jobs.CHAT_BYTES_MAX + 70000);
  assert.ok(fat.length >= 4 && fat.length < 30);
});

test('a proposal nobody answered for two weeks expires on read', async () => {
  const uid = 'u-expire';
  writeState(DIR, uid, sampleState());
  say(uid, 'please log my weight');
  await settle(uid);
  const rec = jobs.readUser(uid);
  rec.chat.at(-1).proposal.createdAt = Date.now() - 15 * 86400000;
  fs.writeFileSync(`${DIR}/coach/${uid}.json`, JSON.stringify(rec));
  const m = jobs.readChat(uid).at(-1);
  assert.equal(m.proposal.status, 'expired');
  assert.equal(jobs.resolveProposal(uid, m.proposal.id, 'applied').code, 'state', 'an expired proposal can no longer be applied');
});

test('forgetting a profile leaves no server-side residue', async () => {
  const uid = 'u-forget';
  writeState(DIR, uid, sampleState());
  say(uid, 'hello');
  await settle(uid);
  assert.equal(jobs.readChat(uid).length, 2);
  jobs.clearUser(uid);
  assert.deepEqual(jobs.readChat(uid), []);
  assert.deepEqual(jobs.readUser(uid).history, []);
  // Today's job count stays (it is the spending record the cap reads); the thread does not.
  const left = fs.existsSync(`${DIR}/coach/${uid}.json`) ? JSON.parse(fs.readFileSync(`${DIR}/coach/${uid}.json`, 'utf8')) : {};
  assert.deepEqual(left.chat || [], []);
});

/* ---------- a provider on localhost, speaking Anthropic's wire ----------
   Parks every request until the test lets it answer, so a job can be caught mid-call or still
   waiting for a slot, and keeps what was sent so the request can be read back. */
async function anthropicServer() {
  const http = await import('node:http');
  const held = [], seen = [], headers = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { seen.push(JSON.parse(body || '{}')); headers.push(req.headers); held.push(res); });
    // A caller that hangs up mid-call takes its parked response with it.
    res.on('close', () => { const i = held.indexOf(res); if (i >= 0) held.splice(i, 1); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  /** Exactly n requests parked with the provider — 0 means every caller has gone. */
  const until = async n => {
    const t = Date.now() + 15000;
    while (held.length !== n && Date.now() < t) await new Promise(r => setTimeout(r, 25));
    assert.equal(held.length, n, `${n} request(s) with the provider`);
  };
  const send = (res, content, stop = 'end_turn') => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ content, stop_reason: stop }));
  };
  const answer = text => { for (const res of held.splice(0)) send(res, [{ type: 'text', text }]); };
  const use = () => {
    cfg.save({
      enabled: true, provider: 'anthropic', providerOptions: { anthropic: { baseUrl: `http://127.0.0.1:${server.address().port}` } },
      models: { anthropic: 'claude-test' },
      auth: { anthropic: { type: 'apikey', account: '', data: cfg.encrypt({ token: 'sk-ant-test' }) } }
    });
  };
  // Parked responses hold their sockets open; a failing test must not hold node --test with them.
  const close = () => { cfg.save({ provider: 'fixture' }); server.close(); server.closeAllConnections(); };
  return { seen, headers, held, until, answer, send, use, close };
}
/** The job's own end, as opposed to status() going quiet: the instance log gains its line. */
async function logged(n) {
  const t = Date.now() + 15000;
  while (cfg.load().log.length < n && Date.now() < t) await new Promise(r => setTimeout(r, 25));
  assert.equal(cfg.load().log.length, n);
}

test('forgetting a profile mid-job cancels the call and frees its slot at once', async () => {
  const p = await anthropicServer();
  const notified = [];
  jobs.setProposalHook(uid => notified.push(uid));
  try {
    p.use();
    const uid = 'u-forget-live';
    writeState(DIR, uid, sampleState());
    say(uid, 'hello');
    await p.until(1);
    assert.equal(jobs.status(uid).job.state, 'running');

    const before = cfg.load().log.length;
    const t0 = Date.now();
    jobs.clearUser(uid);
    assert.equal(jobs.status(uid).job, null);
    // The provider is never answered: the call goes with the record, so the job drains now
    // rather than when the provider gets round to it or the five-minute timeout does.
    await logged(before + 1);
    assert.ok(Date.now() - t0 < 5000, `drained in ${Date.now() - t0} ms`);
    await p.until(0);
    assert.equal(cfg.load().log.at(-1).outcome, 'failed', 'the job ran and is counted');
    assert.equal(cfg.load().log.at(-1).errorClass, 'forgotten', 'the log names the cancellation, not a provider timeout');
    assert.deepEqual(jobs.readChat(uid), [], 'nothing is held for someone who asked to be forgotten');
    assert.deepEqual(jobs.readUser(uid).history, [], 'the record is not recreated');
    assert.deepEqual(notified, [], 'nobody is told about it');
    assert.equal(jobs.capState(uid).used, 1);

    // Single-flight went with the job: the profile can ask again straight away.
    assert.doesNotThrow(() => say(uid, 'again'), 'the slot is free again');
    await p.until(1);
    p.answer('Hi again.');
    await settle(uid);
    assert.equal(lastReply(uid).text, 'Hi again.');
  } finally {
    jobs.setProposalHook(null);
    p.close();
  }
});

test('forgetting a profile whose job is still queued drops it before anything leaves', async () => {
  const p = await anthropicServer();
  try {
    p.use();
    // Two other profiles hold both execution slots, so the third waits.
    for (const u of ['u-slot-1', 'u-slot-2']) { writeState(DIR, u, sampleState()); say(u, 'hold'); }
    await p.until(2);
    const uid = 'u-forget-queued';
    writeState(DIR, uid, sampleState());
    say(uid, 'secret question');
    assert.equal(jobs.status(uid).job.state, 'queued');

    jobs.clearUser(uid);
    assert.equal(jobs.status(uid).job, null);
    p.answer('ok');
    await settle('u-slot-1'); await settle('u-slot-2');
    await new Promise(r => setTimeout(r, 200));       // a job still queued would have started by now
    assert.equal(p.seen.length, 2, 'the forgotten profile\'s message never reached the provider');
    assert.deepEqual(jobs.readChat(uid), []);

    // Single-flight was released with the job, so the profile can ask again.
    say(uid, 'again');
    await p.until(1);
    p.answer('fine');
    await settle(uid);
    assert.equal(lastReply(uid).text, 'fine');
  } finally { p.close(); }
});

test('consent withdrawn, or the Coach switched off, while a job waits: nothing leaves', async () => {
  const p = await anthropicServer();
  try {
    p.use();
    for (const u of ['u-slot-3', 'u-slot-4']) { writeState(DIR, u, sampleState()); say(u, 'hold'); }
    await p.until(2);
    writeState(DIR, 'u-revoked', sampleState());
    writeState(DIR, 'u-switched-off', sampleState());
    say('u-revoked', 'x');
    say('u-switched-off', 'x');
    assert.equal(jobs.status('u-switched-off').job.state, 'queued');

    // Consent gone from the synced state — no forget call, so the record itself stays and says
    // what happened. Then the admin switches the Coach off before a slot frees.
    writeState(DIR, 'u-revoked', sampleState({ coach: {} }));
    cfg.save({ enabled: false });
    p.answer('ok');
    await settle('u-revoked'); await settle('u-switched-off');
    assert.equal(p.seen.length, 2, 'neither queued job reached the provider');
    assert.equal(lastOutcome('u-revoked').errorClass, 'consent');
    assert.equal(lastReply('u-revoked').errorClass, 'consent');
    assert.equal(lastOutcome('u-switched-off').errorClass, 'off');
  } finally { cfg.save({ enabled: true }); p.close(); }
});

test('the Anthropic provider runs the tool loop through the queue, with the key as a header and nobody\'s uid anywhere', async () => {
  const p = await anthropicServer();
  forcePrivilegeVerdict({ ok: false, dropped: false, why: 'no `coach` user exists in this image' });
  try {
    p.use();
    const uid = 'u-secret-uid-123';
    writeState(DIR, uid, sampleState());
    say(uid, 'what is my unit?');
    await p.until(1);
    // Turn one: the model asks for a tool. The server runs it against this profile only.
    p.send(p.held.splice(0)[0], [{ type: 'text', text: 'looking' }, { type: 'tool_use', id: 't1', name: 'get_profile', input: {} }], 'tool_use');
    await p.until(1);
    p.answer('You use kilograms.');
    await settle(uid);

    assert.equal(lastReply(uid).text, 'You use kilograms.');
    assert.equal(p.headers[0]['x-api-key'], 'sk-ant-test');
    assert.deepEqual(p.seen[0].tools.map(t => t.name), ['get_profile', 'get_plan', 'list_workouts', 'get_workout', 'search_exercises', 'get_my_exercises', 'get_bodyweight', 'get_stats', 'propose_changes']);
    assert.ok(p.seen[0].system[0].text.includes('openGym'), 'the assistant prompt is the system block');
    const toolResult = p.seen[1].messages.at(-1).content[0];
    assert.equal(toolResult.type, 'tool_result');
    assert.equal(JSON.parse(toolResult.content).unit, 'kg', 'the result is the profile\'s own data');
    for (const body of p.seen) assert.ok(!JSON.stringify(body).includes(uid), 'the uid never reaches the provider');

    // And the same host refuses a runtime-backed provider, so the gate itself is intact.
    cfg.save({ provider: 'claude', auth: { claude: { type: 'cli-token', account: '', data: cfg.encrypt({ token: 't' }) } } });
    writeState(DIR, 'u-https-2', sampleState());
    assert.throws(() => say('u-https-2', 'hi'), e => e.code === 'unprivileged');
  } finally {
    forcePrivilegeVerdict({ ok: true, dropped: false, why: 'pinned by the test suite' });
    p.close();
  }
});

test('a provider that cannot run the tool loop is refused up front, naming the reason', () => {
  cfg.save({
    enabled: true, provider: 'openai', models: { openai: 'gpt-x' },
    auth: { openai: { type: 'apikey', account: '', data: cfg.encrypt({ token: 'sk-oa' }) } }
  });
  try {
    writeState(DIR, 'u-openai', sampleState());
    assert.throws(() => say('u-openai', 'hello'), e => e.code === 'tools' && /Claude/.test(e.message));
    assert.equal(jobs.capState('u-openai').used, 0, 'nothing was spent');
    assert.deepEqual(jobs.readChat('u-openai'), []);
    assert.deepEqual(jobs.status('u-openai').assistant, { supported: false, provider: 'openai' });
  } finally { cfg.save({ provider: 'fixture' }); }
});

test('a job is refused outright when the privilege drop cannot be performed', () => {
  cfg.save({ provider: 'claude', auth: { claude: { type: 'cli-token', account: '', data: cfg.encrypt({ token: 't' }) } } });
  const uid = 'u-priv';
  writeState(DIR, uid, sampleState());
  // The refusal is the assertion, so it is pinned rather than hoped for.
  forcePrivilegeVerdict({ ok: false, dropped: false, why: 'no `coach` user exists in this image' });
  try {
    assert.throws(() => say(uid, 'hi'), e => e.code === 'unprivileged');
  } finally {
    forcePrivilegeVerdict({ ok: true, dropped: false, why: 'pinned by the test suite' });
    cfg.save({ provider: 'fixture' });
  }
});

test('a message is cut to the admin\'s configured max, not the old 1000-character default (issue #267)', async () => {
  const p = await anthropicServer();
  try {
    p.use();
    cfg.save({ maxMessageLen: 2500 });
    const uid = 'u-note-len';
    writeState(DIR, uid, sampleState());
    const r = say(uid, 'x'.repeat(3000));
    assert.equal(r.message.text.length, 2500);
    await p.until(1);
    const sent = p.seen[0].messages[0].content;
    assert.match(sent, /## New message from the user\n\nx{2500}$/);
    p.answer('ok');
    await settle(uid);
  } finally { cfg.save({ maxMessageLen: 1000 }); p.close(); }
});

test('a job sends the admin\'s configured output cap, so a reasoning model is not cut off', async () => {
  const p = await anthropicServer();
  try {
    p.use();
    cfg.save({ maxOutputTokens: 48000 });
    const uid = 'u-max-output';
    writeState(DIR, uid, sampleState());
    say(uid, 'hi');
    await p.until(1);
    assert.equal(p.seen[0].max_tokens, 48000, 'the configured ceiling rode on the request');
    p.answer('ok');
    await settle(uid);
  } finally { cfg.save({ maxOutputTokens: 16000 }); p.close(); }
});

test('a wrong key is an auth failure in the thread, with the provider\'s reason kept for the admin card', async () => {
  const p = await anthropicServer();
  try {
    p.use();
    const uid = 'u-badkey';
    writeState(DIR, uid, sampleState());
    const before = cfg.load().log.length;
    say(uid, 'hi');
    await p.until(1);
    const res = p.held.splice(0)[0];
    res.statusCode = 401; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { message: 'invalid x-api-key' } }));
    await settle(uid);
    assert.equal(lastOutcome(uid).errorClass, 'auth');
    assert.equal(lastReply(uid).kind, 'error');
    assert.equal(lastReply(uid).text, '', 'the provider\'s words are not in the thread');
    assert.match(cfg.load().log.slice(before).at(-1).detail, /invalid x-api-key/, 'they go to the instance log');
  } finally { p.close(); }
});

test('a job interrupted by a restart is reported as failed in the thread, not left spinning', () => {
  const uid = 'u-restart';
  fs.mkdirSync(`${DIR}/coach`, { recursive: true });
  fs.writeFileSync(`${DIR}/coach/${uid}.json`, JSON.stringify({
    current: { id: 'j1', state: 'running', startedAt: Date.now() - 60000 },
    chat: [{ id: 'm1', role: 'user', kind: 'text', text: 'hello', at: 1 }], history: []
  }));
  jobs.recoverOnBoot();
  assert.equal(jobs.status(uid).job, null);
  assert.equal(lastOutcome(uid).errorClass, 'restart');
  assert.equal(lastReply(uid).errorClass, 'restart');
});

test('the admin test-run completes a round trip without a user to spend', async () => {
  const r = await jobs.testRun();
  assert.equal(r.ok, true, r.error || 'the round trip failed');
  assert.equal(r.version, 'fixture');
  assert.equal(r.assistant, true);
});
