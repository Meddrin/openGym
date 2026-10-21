/* What bounds the assistant's spend, pinned against the real queue and the fixture provider.
 *
 * Forget keeps today's per-profile count. The instance count is reserved at enqueue and is
 * not read off the capped job log. Every message costs one job: there is no scheduled review
 * left that could spend while nobody is looking. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tempData, writeState, sampleState } from './helpers.mjs';

const DIR = tempData();
const cfg = await import('../coach/config.js');
const jobs = await import('../coach/jobs.js');
const { forcePrivilegeVerdict } = await import('../coach/adapters/spawn.js');

cfg.save({ enabled: true, provider: 'fixture' });
forcePrivilegeVerdict({ ok: true, dropped: false, why: 'pinned by the test suite' });

const today = new Date().toISOString().slice(0, 10);
const userFile = uid => `${DIR}/coach/${uid}.json`;

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

/* ---------- the per-profile cap survives forget ---------- */

test('forgetting a profile does not hand it a fresh daily cap', async () => {
  const uid = 'u-forget-cap';
  writeState(DIR, uid, sampleState());
  cfg.save({ caps: { perProfileDaily: 1, instanceDaily: 0 } });
  try {
    jobs.enqueue(uid, { text: 'hi' });
    await settle(uid);
    assert.equal(jobs.capState(uid).used, 1);

    jobs.clearUser(uid);
    const s = jobs.status(uid);
    assert.deepEqual(jobs.readChat(uid), [], 'the conversation is gone');
    assert.deepEqual(jobs.readUser(uid).history, [], 'the history is gone');
    assert.equal(s.cap.used, 1, 'the day\'s count is a spending record, not the profile\'s data');
    assert.throws(() => jobs.enqueue(uid, { text: 'hi' }), e => e.code === 'cap');
  } finally {
    cfg.save({ caps: { perProfileDaily: 10, instanceDaily: 0 } });
  }
});

test('with nothing spent today, forget leaves no file at all', () => {
  const uid = 'u-forget-empty';
  jobs.setShare(uid, true);
  assert.ok(fs.existsSync(userFile(uid)));
  jobs.clearUser(uid);
  assert.equal(fs.existsSync(userFile(uid)), false);

  // Yesterday's count is already worth nothing to the cap, so it does not keep the file either.
  fs.writeFileSync(userFile(uid), JSON.stringify({ daily: { date: '2000-01-01', count: 5 }, history: [] }));
  jobs.clearUser(uid);
  assert.equal(fs.existsSync(userFile(uid)), false);
});

/* ---------- the instance cap ---------- */

test('the instance cap is reserved at enqueue, so a job still running already counts', async () => {
  cfg.save({ caps: { perProfileDaily: 10, instanceDaily: 1 }, daily: null, log: [] });
  try {
    writeState(DIR, 'u-inst-1', sampleState());
    writeState(DIR, 'u-inst-2', sampleState());
    jobs.enqueue('u-inst-1', { text: 'hi' });
    assert.ok(jobs.status('u-inst-1').job, 'the first job is on its way');
    assert.throws(() => jobs.enqueue('u-inst-2', { text: 'hi' }), e => e.code === 'cap',
      'the second profile is refused before the first job has finished');
    await settle('u-inst-1');
    assert.equal(lastOutcome('u-inst-1').outcome, 'ready');
    assert.deepEqual(cfg.load().daily, { date: today, count: 1 });
  } finally {
    cfg.save({ caps: { perProfileDaily: 10, instanceDaily: 0 } });
  }
});

test('the instance count is not bounded by the length of the job log', () => {
  const uid = 'u-inst-150';
  writeState(DIR, uid, sampleState());
  cfg.save({ caps: { perProfileDaily: 10, instanceDaily: 150 }, daily: { date: today, count: 150 }, log: [] });
  try {
    assert.throws(() => jobs.enqueue(uid, { text: 'hi' }), e => e.code === 'cap',
      'a hundred and fifty jobs today trip a cap of a hundred and fifty, empty log or not');
    // Yesterday's count is nobody's business today.
    cfg.save({ daily: { date: '2000-01-01', count: 150 } });
    assert.doesNotThrow(() => jobs.enqueue(uid, { text: 'hi' }));
    assert.deepEqual(cfg.load().daily, { date: today, count: 1 });
  } finally {
    cfg.save({ caps: { perProfileDaily: 10, instanceDaily: 0 } });
  }
  return settle(uid);
});
