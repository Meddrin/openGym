/* The server keeps small duplicates of what the app computes, because the api image carries
   nothing from the frontend. Each one is pinned here against the frontend's own implementation,
   so the copy cannot drift silently. frontend/src/lib/coach-parity.test.js pins modeOf, isBw and
   isPerSide from the other side; this file covers the rest, and has to be a node:test file
   because it imports the frontend's modules, which a vitest test cannot do for a node:test one.
   The frontend imports below are safe under plain node: they have no Vite- or React-only syntax,
   the same reason mcp/'s own tests import frontend/src/lib directly. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempData } from './helpers.mjs';
import { isWarmupRow } from '../../frontend/src/lib/workout-model.js';
import { FORMULAS, REP_CAP } from '../../frontend/src/lib/onerm.js';
import { NOTE_MAX as frontendNoteMax } from '../../frontend/src/lib/history.js';

tempData();
const payload = await import('../coach/core/payload.js');
const stats = await import('../coach/assistant/stats.js');

/* A session note is bounded at the app's own cap, so a note the app let the athlete write is
   never cut on its way to the model, and a note the assistant writes is never one the app
   would refuse. */
test('the server\'s NOTE_MAX is the app\'s NOTE_MAX', () => {
  assert.equal(payload.NOTE_MAX, frontendNoteMax);
});

test('isWarmupSet agrees with the frontend isWarmupRow', () => {
  const cases = [
    {}, null, undefined,
    { warmup: true }, { warmup: false }, { warmup: 'true' },
    { phase: 'warmup' }, { phase: 'warm-up' }, { phase: 'warm_up' }, { phase: 'WARMUP' },
    { phase: 'work' }, { phase: '' }, { phase: 'bogus' },
    { phase: 'warmup', warmup: false }, { phase: 'work', warmup: true },
  ];
  for (const c of cases) assert.equal(payload.isWarmupSet(c), isWarmupRow(c), JSON.stringify(c));
});

test('the estimated one-rep max is Epley, capped where the app caps it', () => {
  assert.equal(stats.REP_CAP, REP_CAP);
  for (const [w, r] of [[100, 1], [60, 5], [42.5, 8], [20, 12]]) {
    assert.ok(Math.abs(stats.epley(w, r) - FORMULAS.epley(w, r)) < 1e-9, `${w}x${r}`);
  }
  for (const [w, r] of [[100, 13], [100, 0], [0, 5], [-5, 5], [100, 5.5]]) assert.equal(stats.epley(w, r), null, `${w}x${r} is not estimated`);
});

test('the limits on what the assistant writes are the limits the app\'s screens enforce', async () => {
  const fs = await import('node:fs');
  const intake = fs.readFileSync(new URL('../../frontend/src/views/CoachIntake.jsx', import.meta.url), 'utf8');
  for (const [field, max] of Object.entries(payload.PROFILE_TEXT_MAX)) {
    const m = intake.match(new RegExp('maxLength=\\{(\\d+)\\} value=\\{p\\.' + field + '\\}'));
    assert.ok(m, field + ' has a maxLength on the intake screen');
    assert.equal(Number(m[1]), max, field);
  }
});
