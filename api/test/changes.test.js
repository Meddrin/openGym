/* Change sets: the closed list of what the assistant may ask for, the checks on each, and the
 * pure appliers that carry the non-plan kinds out.
 *
 * Written as the accidents and attacks the validator exists to stop: an exercise id nobody has,
 * a target that is not there, a set with nonsense numbers, two changes that disagree. The
 * closed list gets its own sweep: every kind must have a well-formed instance here, so adding a
 * kind without a validator, an applier and a test is a red build rather than a discovery. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tempData } from './helpers.mjs';

tempData();
const {
  validateChangeSet, applyDataChange, touchedKeys, currentOfData, workoutHash, setsLine,
  CHANGE_KINDS, PLAN_TYPES, DATA_TYPES, MAX_CHANGES, SETTINGS
} = await import('../coach/core/changes.js');

const TODAY = '2026-10-21';
const ctx = { today: TODAY, newId: () => 'newid1', now: 1_700_000_000_000 };
const state = () => ({
  unit: 'kg', restSec: 90,
  coach: { profile: { goal: 'muscle', experience: 'regular', daysPerWeek: 3 } },
  routines: [
    { id: 'r1', name: 'Full body A', ex: [{ id: '0001', sets: 3, reps: 10, weight: 20 }, { id: '0007', sets: 3, sec: 45, mode: 'time' }] },
    { id: 'r2', name: 'Pull', ex: [{ id: '0009', sets: 3, reps: 8 }] }
  ],
  week: { 1: ['r1'], 3: ['r2'] }, dayPlan: {},
  exNotes: { '0001': 'seat 4' }, favEx: ['cx1'], exWeights: { '0001': { w: 20, d: '2026-10-19' } },
  customEx: [{ id: 'cx1', n: 'Sandbag carry', bp: 'back', tg: 'lats', eq: 'custom', custom: true }],
  bodyweight: [{ d: '2026-10-19', w: 80, t: 1 }],
  workouts: [{
    id: 'w1', d: '2026-10-19', name: 'Full body A', start: 1_000_000, end: 1_000_000 + 45 * 60000, vol: 600, prs: [], bw: 80,
    entries: [
      { id: '0001', target: { sets: 3, reps: 10 }, sets: [
        { w: 20, r: 10, done: true, rpe: 8, at: 111 }, { w: 20, r: 9, done: true, rpe: 9 },
        { w: 20, r: 8, done: true, sides: { L: { r: 4, w: 10 }, R: { r: 4, w: 10 } } }
      ] },
      { id: '0007', note: 'wrists sore', sets: [{ sec: 45, done: true }] }
    ]
  }],
  active: null
});
const ok = (S, changes) => { const r = validateChangeSet(S, { summary: 's', changes }, ctx); assert.equal(r.ok, true, JSON.stringify(r.errors)); return r; };
const bad = (S, changes, re) => {
  const r = validateChangeSet(S, { summary: 's', changes }, ctx);
  assert.equal(r.ok, false, 'should have been refused: ' + JSON.stringify(changes));
  if (re) assert.match(r.errors.join(' | '), re);
  return r;
};
const why = 'because the numbers say so';

/* ---------- the shape of a proposal ---------- */

test('a proposal is an array of at most 25 changes, each a known kind with a reason', () => {
  const S = state();
  bad(S, undefined, /array/);
  assert.equal(validateChangeSet(S, { changes: 'sets' }, ctx).ok, false);
  bad(S, [], /empty/);
  bad(S, Array.from({ length: MAX_CHANGES + 1 }, () => ({ type: 'setting', target: { key: 'restSec' }, after: 60, why })), /too many/);
  bad(S, [{ type: 'drop-database', why }], /"drop-database" is not allowed/);
  bad(S, [{ type: 'setting', target: { key: 'restSec' }, after: 60 }], /why is required/);
  bad(S, [null], /not an object/);
});

test('the closed list is the plan family plus twelve more kinds, and nothing else', () => {
  assert.equal(PLAN_TYPES.length, 18);
  assert.deepEqual(DATA_TYPES, ['dayplan', 'workout-add', 'workout-edit', 'workout-delete', 'bodyweight-set', 'bodyweight-delete', 'exnote-set', 'custom-ex-add', 'custom-ex-edit', 'custom-ex-delete', 'setting', 'profile-set']);
  assert.deepEqual(CHANGE_KINDS, [...PLAN_TYPES, ...DATA_TYPES]);
});

/* ---------- every kind: a good instance validates, applies, and says what it touches ---------- */

const GOOD = {
  // plan family
  'add-exercise': { type: 'add-exercise', target: { routineId: 'r1' }, after: { id: '0009', sets: 3, reps: 10 } },
  'remove-exercise': { type: 'remove-exercise', target: { routineId: 'r1', exId: '0001' } },
  'swap-exercise': { type: 'swap-exercise', target: { routineId: 'r1', exId: '0001' }, after: { id: '0009' } },
  sets: { type: 'sets', target: { routineId: 'r1', exId: '0001' }, after: 4 },
  reps: { type: 'reps', target: { routineId: 'r1', exId: '0001' }, after: 12 },
  repsMin: { type: 'repsMin', target: { routineId: 'r1', exId: '0001' }, after: 8 },
  repsMax: { type: 'repsMax', target: { routineId: 'r1', exId: '0001' }, after: 15 },
  sec: { type: 'sec', target: { routineId: 'r1', exId: '0007' }, after: 60 },
  cardio: { type: 'cardio', target: { routineId: 'r1', exId: '0001' }, after: { min: 25, speed: 9 } },
  reorder: { type: 'reorder', target: { routineId: 'r1' }, after: ['0007', '0001'] },
  superset: { type: 'superset', target: { routineId: 'r1', exId: '0001' }, after: { link: true, with: '0007' } },
  'routine-prog': { type: 'routine-prog', target: { routineId: 'r1' }, after: 'double' },
  'exercise-prog': { type: 'exercise-prog', target: { routineId: 'r1', exId: '0001' }, after: 'greyskull' },
  inc: { type: 'inc', target: { routineId: 'r1', exId: '0001' }, after: 2.5 },
  'add-routine': { type: 'add-routine', target: {}, after: { name: 'Legs', ex: [{ id: '0001', sets: 3, reps: 10 }] } },
  'remove-routine': { type: 'remove-routine', target: { routineId: 'r2' } },
  'rename-routine': { type: 'rename-routine', target: { routineId: 'r1' }, after: 'Upper' },
  week: { type: 'week', target: { weekday: 5 }, after: 'r2' },
  // everything else
  dayplan: { type: 'dayplan', target: { date: '2026-10-23' }, after: 'rest' },
  'workout-add': { type: 'workout-add', target: {}, after: { d: '2026-10-20', name: 'Pull', entries: [{ id: '0009', sets: [{ r: 8, w: 40 }, { r: 8, w: 40, rpe: 9 }] }] } },
  'workout-edit': { type: 'workout-edit', target: { workoutId: 'w1' }, after: { name: 'Push day', note: 'felt strong' } },
  'workout-delete': { type: 'workout-delete', target: { workoutId: 'w1' } },
  'bodyweight-set': { type: 'bodyweight-set', target: { date: '2026-10-21' }, after: 79.4 },
  'bodyweight-delete': { type: 'bodyweight-delete', target: { date: '2026-10-19' } },
  'exnote-set': { type: 'exnote-set', target: { exId: '0007' }, after: 'pin 7' },
  'custom-ex-add': { type: 'custom-ex-add', target: {}, after: { n: 'Zercher carry', bp: 'back', tg: 'lats' } },
  'custom-ex-edit': { type: 'custom-ex-edit', target: { exId: 'cx1' }, after: { n: 'Sandbag walk' } },
  'custom-ex-delete': { type: 'custom-ex-delete', target: { exId: 'cx1' } },
  setting: { type: 'setting', target: { key: 'restSec' }, after: 120 },
  'profile-set': { type: 'profile-set', target: {}, after: { limitations: 'left shoulder clicks overhead', daysPerWeek: 4 } }
};

test('every allowed kind has a good instance that validates, and each data kind applies to a throwaway copy', () => {
  for (const type of CHANGE_KINDS) {
    assert.ok(GOOD[type], `no fixture for "${type}" — add one`);
    const S = state();
    const r = ok(S, [{ ...GOOD[type], why }]);
    const c = r.changes[0];
    assert.equal(c.type, type);
    assert.ok(c.why && c.id, type);
    assert.ok(touchedKeys([c]).length >= 1, `${type} says what it touches`);
    if (DATA_TYPES.includes(type)) {
      assert.ok(Array.isArray(c.lines) && c.lines.length, `${type} carries lines for the card`);
      const draft = structuredClone(S);
      applyDataChange(draft, c, ctx);
      assert.notDeepEqual(draft, S, `${type} changed something`);
    }
  }
});

test('a validated change set validates again to the same thing — which is how the client checks it before applying', () => {
  for (const type of CHANGE_KINDS) {
    const S = state();
    const first = ok(S, [{ ...GOOD[type], why }]);
    const again = validateChangeSet(S, { summary: 's', changes: first.changes }, { ...ctx, newId: () => 'a-different-id' });
    assert.equal(again.ok, true, `${type}: ${JSON.stringify(again.errors)}`);
    assert.deepEqual(again.changes, first.changes, type);
  }
  // …including a workout edit whose patch adds an exercise and edits sets, and a workout that is added.
  const S = state();
  const r = ok(S, [
    { type: 'workout-edit', target: { workoutId: 'w1' }, why, after: { note: 'n', entries: [{ index: 0, sets: [{ index: 0, r: 11, rpe: null }, { index: 1 }, { index: 2 }, { r: 6, w: 20, warmup: true }], note: 'x' }, { id: '0009', sets: [{ r: 8, w: 40 }] }] } },
    { ...GOOD['workout-add'], why }
  ]);
  assert.deepEqual(validateChangeSet(S, { changes: r.changes }, ctx).changes, r.changes);
  // A state that has moved on is visible as a different `before`, never as a quiet success.
  const moved = structuredClone(S);
  moved.workouts[0].entries[0].sets[0].r = 3;
  const stale = validateChangeSet(moved, { changes: r.changes }, ctx);
  assert.equal(stale.ok, true);
  assert.notDeepEqual(stale.changes[0].before, r.changes[0].before);
});

test('before is read off the state, never taken from the model', () => {
  const S = state();
  const r = ok(S, [
    { ...GOOD.sets, before: 99, why },
    { ...GOOD.setting, before: 'whatever', why },
    { ...GOOD['bodyweight-set'], before: 1, why }
  ]);
  assert.deepEqual(r.changes.map(c => c.before), [3, 90, null]);
});

/* ---------- the plan family goes through the plan validator ---------- */

test('plan changes are refused for a routine or exercise that is not there, and for an id nobody has', () => {
  const S = state();
  bad(S, [{ type: 'sets', target: { routineId: 'nope', exId: '0001' }, after: 4, why }], /routineId "nope" is not one of the routines/);
  bad(S, [{ type: 'sets', target: { routineId: 'r1', exId: '0009' }, after: 4, why }], /exId "0009" is not in routine/);
  bad(S, [{ type: 'add-exercise', target: { routineId: 'r1' }, after: { id: 'ghost-ex', sets: 3, reps: 10 }, why }], /"ghost-ex" is not in the exercise library.*search_exercises/);
  bad(S, [{ type: 'sets', target: { routineId: 'r1', exId: '0001' }, after: 99, why }], /sets/);
  // A custom exercise the person owns is a real id.
  ok(S, [{ type: 'add-exercise', target: { routineId: 'r1' }, after: { id: 'cx1', sets: 3, reps: 10 }, why }]);
});

test('a plan change that restates the plan is left out, and a set with nothing left is refused as "nothing to change"', () => {
  const S = state();
  bad(S, [{ type: 'sets', target: { routineId: 'r1', exId: '0001' }, after: 3, why }], /nothing to change/);
  const r = ok(S, [{ type: 'sets', target: { routineId: 'r1', exId: '0001' }, after: 3, why }, { ...GOOD.setting, why }]);
  assert.equal(r.changes.length, 1);
  assert.equal(r.skipped.length, 1);
});

test('a user with more than a handful of routines can still change one', () => {
  const S = state();
  S.routines = Array.from({ length: 12 }, (_, i) => ({ id: 'r' + i, name: 'R' + i, ex: [{ id: '0001', sets: 3, reps: 10 }] }));
  ok(S, [{ type: 'reps', target: { routineId: 'r5', exId: '0001' }, after: 12, why }]);
});

/* ---------- logged workouts ---------- */

test('workout-add: real exercises, real dates, real sets', () => {
  const S = state();
  const add = after => [{ type: 'workout-add', target: {}, after, why }];
  const entries = [{ id: '0009', sets: [{ r: 8, w: 40 }] }];
  bad(S, add({ d: '2026-10-20', entries: [{ id: 'ghost', sets: [{ r: 8, w: 40 }] }] }), /entries\[0\]\.id "ghost" is not in the exercise library/);
  bad(S, add({ d: '2026-10-30', entries }), /in the future/);
  bad(S, add({ d: '21/10/2026', entries }), /ISO date/);
  bad(S, add({ d: '2026-02-31', entries }), /ISO date/);
  bad(S, add({ d: '2026-10-20', entries: [] }), /at least one exercise/);
  bad(S, add({ d: '2026-10-20' }), /at least one exercise/);
  bad(S, add({ d: '2026-10-20', entries: [{ id: '0009', sets: [] }] }), /sets must list at least one set/);
  bad(S, add({ d: '2026-10-20', entries: [{ id: '0009', sets: [{ r: -3, w: 40 }] }] }), /sets\[0\]\.r must be a whole number from 0 to 1000/);
  bad(S, add({ d: '2026-10-20', entries: [{ id: '0009', sets: [{ r: 8.5, w: 40 }] }] }), /whole number/);
  bad(S, add({ d: '2026-10-20', entries: [{ id: '0009', sets: [{ r: '8', w: 40 }] }] }), /whole number/);
  bad(S, add({ d: '2026-10-20', entries: [{ id: '0009', sets: [{ w: 40 }, { rpe: 8 }] }] }), /at least one of r/);
  bad(S, add({ d: '2026-10-20', entries: [{ id: '0009', sets: [{ r: 8, w: 40, rir: 2, rpe: 8 }] }] }), /both rir and rpe/);
  bad(S, add({ d: '2026-10-20', entries: [{ id: '0009', sets: [{ r: 8, w: 99999 }] }] }), /w must be a number from 0 to 2000/);
  bad(S, add({ d: '2026-10-20', startTime: '25:00', entries }), /HH:MM/);
  bad(S, add({ d: '2026-10-20', routineId: 'nope', entries }), /routineId/);
  bad(S, add({ d: '2026-10-20', entries: [{ id: '0009', sets: [{ r: 8, w: 40, warmup: true }] }] }), /completed working set/);
  bad(S, add({ d: '2026-10-20', entries: [{ id: '0009', sets: [{ r: 8, w: 40, done: false }] }] }), /completed working set/);
  bad(S, add('a workout'), /object/);
  // The person's own exercise counts.
  ok(S, add({ d: '2026-10-20', entries: [{ id: 'cx1', sets: [{ r: 1, w: 60 }] }] }));
});

test('workout-add: the record the client writes has what the app would have written', () => {
  const S = state();
  const r = ok(S, [{ ...GOOD['workout-add'], why }]);
  assert.equal(r.changes[0].after.id, 'newid1', 'the id is minted at validation, so the card and the apply agree');
  const draft = structuredClone(S);
  applyDataChange(draft, r.changes[0], ctx);
  const w = draft.workouts.find(x => x.id === 'newid1');
  assert.equal(w.d, '2026-10-20');
  assert.equal(w.name, 'Pull');
  assert.equal(w.bw, 80, 'the latest body weight rides along, as a finished workout\'s does');
  assert.deepEqual(w.prs, []);
  assert.equal(w.vol, 40 * 8 * 2);
  assert.equal(w.end - w.start, 60 * 60000);
  assert.equal(w.entries[0].topW, 40);
  assert.deepEqual(w.entries[0].sets.map(s => s.done), [true, true]);
  assert.deepEqual(draft.workouts.map(x => x.d), ['2026-10-19', '2026-10-20'], 'kept in date order');
});

test('workout-edit: only a workout with an id, only exercises and sets that exist, never one without a working set', () => {
  const S = state();
  const edit = (after, id = 'w1') => [{ type: 'workout-edit', target: { workoutId: id }, after, why }];
  bad(S, edit({ name: 'x' }, 'nope'), /workoutId "nope" is not a workout you can edit/);
  bad(S, edit({ entries: [{ index: 7 }] }), /index 7 is not an existing exercise of this workout/);
  bad(S, edit({ entries: [{ index: 0, sets: [{ index: 9, r: 1 }] }] }), /index 9 is not an existing set/);
  bad(S, edit({ entries: [{ index: 0, sets: [{ index: 0, r: 5 }, { index: 0, r: 6 }] }] }), /named twice/);
  bad(S, edit({ entries: [{ index: 0, id: '0009' }] }), /does not match the exercise at index 0/);
  bad(S, edit({ entries: [{ id: 'ghost', sets: [{ r: 5, w: 5 }] }] }), /"ghost" is not in the exercise library/);
  bad(S, edit({ entries: [{ index: 0, sets: [{ index: 0, r: -1 }] }] }), /r must be a whole number/);
  bad(S, edit({ entries: [] }), /entries must list the exercises that remain/);
  bad(S, edit({ entries: [{ index: 0, sets: [{ index: 0, done: false }, { index: 1, done: false }, { index: 2, done: false }] }, { index: 1, sets: [{ index: 0, done: false }] }] }), /no completed working set/);
  bad(S, edit({ d: '2027-01-01' }), /not in the future/);
  bad(S, edit({ note: 'x'.repeat(501) }), /longer than 500/);
  bad(S, edit({ name: '' }), /name must be a non-empty string/);
  // Nothing actually different reads as nothing to change.
  bad(S, edit({ name: 'Full body A' }), /nothing to change/);
});

test('workout-edit: untouched details survive, an exercise left out is removed, a set patch keeps what it does not name', () => {
  const S = state();
  const r = ok(S, [{
    type: 'workout-edit', target: { workoutId: 'w1' }, why,
    after: { entries: [{ index: 0, sets: [{ index: 0, r: 11 }, { index: 2 }, { r: 7, w: 20, rir: 1 }] }] }   // entry 1 (0007) left out; set 1 dropped; set 3 is new
  }]);
  const draft = structuredClone(S);
  applyDataChange(draft, r.changes[0], ctx);
  const w = draft.workouts[0];
  assert.equal(w.entries.length, 1, 'the exercise that was left out is gone');
  const sets = w.entries[0].sets;
  assert.equal(sets.length, 3);
  assert.deepEqual({ w: sets[0].w, r: sets[0].r, rpe: sets[0].rpe, at: sets[0].at }, { w: 20, r: 11, rpe: 8, at: 111 }, 'a patched set keeps its effort and timestamp');
  assert.deepEqual(sets[1].sides, { L: { r: 4, w: 10 }, R: { r: 4, w: 10 } }, 'a set kept as is keeps its per-side rows');
  assert.deepEqual(sets[2], { r: 7, w: 20, rir: 1, done: true });
  assert.equal(w.entries[0].target.reps, 10, 'the plan target stays');
  assert.equal(w.vol, 20 * 11 + 20 * 8 + 20 * 7, 'the volume is worked out again');
});

test('workout-edit: a field set to null is removed, a note can be cleared, a date move shifts start and end', () => {
  const S = state();
  S.workouts[0].note = 'old note';
  const r = ok(S, [{
    type: 'workout-edit', target: { workoutId: 'w1' }, why,
    after: { d: '2026-10-18', note: '', entries: [{ index: 0, sets: [{ index: 0, rpe: null }, { index: 1 }, { index: 2 }] }, { index: 1, note: '' }] }
  }]);
  const draft = structuredClone(S);
  applyDataChange(draft, r.changes[0], ctx);
  const w = draft.workouts[0];
  assert.equal(w.d, '2026-10-18');
  assert.equal(w.start, 1_000_000 - 86400000);
  assert.equal(w.end - w.start, 45 * 60000);
  assert.equal(w.note, undefined);
  assert.equal('rpe' in w.entries[0].sets[0], false);
  assert.equal(w.entries[1].note, undefined);
});

test('workout-delete, and at most one change to a workout', () => {
  const S = state();
  bad(S, [{ type: 'workout-delete', target: { workoutId: 'ghost' }, why }], /not a workout you can delete/);
  bad(S, [{ ...GOOD['workout-edit'], why }, { ...GOOD['workout-delete'], why }], /both change workout w1/);
  const r = ok(S, [{ ...GOOD['workout-delete'], why }]);
  const draft = structuredClone(S);
  applyDataChange(draft, r.changes[0], ctx);
  assert.deepEqual(draft.workouts, []);
  assert.ok(touchedKeys(r.changes).includes('exWeights'), 'kept working weights may need lowering');
});

test('a workout that has no id of its own can be read but not changed', () => {
  const S = state();
  delete S.workouts[0].id;
  bad(S, [{ type: 'workout-edit', target: { workoutId: 'undefined' }, after: { name: 'x' }, why }], /not a workout you can edit/);
  bad(S, [{ type: 'workout-delete', target: { workoutId: '' }, why }], /not a workout you can delete/);
});

test('a workout\'s hash moves with what it logged, and with nothing else', () => {
  const a = state().workouts[0];
  const b = structuredClone(a);
  b._ts = 999; b.vol = 1; b.entries[0].sets[0].at = 5;
  assert.equal(workoutHash(a), workoutHash(b), 'stamps, volume and timestamps are not the log');
  b.entries[0].sets[1].r = 5;
  assert.notEqual(workoutHash(a), workoutHash(b));
  const c = structuredClone(a); c.note = 'hello';
  assert.notEqual(workoutHash(a), workoutHash(c));
  assert.equal(workoutHash(null), null);
  assert.match(setsLine(a.entries[0].sets), /^3 sets: 20x10 @RPE8, 20x9 @RPE9, /);
});

/* ---------- body weight, notes, own exercises, settings, profile, calendar ---------- */

test('body weight: a real date, a plausible number, something to delete', () => {
  const S = state();
  bad(S, [{ type: 'bodyweight-set', target: { date: '2026-10-30' }, after: 80, why }], /not in the future/);
  bad(S, [{ type: 'bodyweight-set', target: { date: 'yesterday' }, after: 80, why }], /not in the future|ISO/);
  bad(S, [{ type: 'bodyweight-set', target: { date: '2026-10-20' }, after: 'heavy', why }], /number in the profile unit/);
  bad(S, [{ type: 'bodyweight-set', target: { date: '2026-10-20' }, after: 3, why }], /10-1500/);
  bad(S, [{ type: 'bodyweight-set', target: { date: '2026-10-19' }, after: 80, why }], /already reads 80/);
  bad(S, [{ type: 'bodyweight-delete', target: { date: '2026-10-01' }, why }], /no weigh-in on 2026-10-01/);
  const r = ok(S, [{ type: 'bodyweight-set', target: { date: '2026-10-19' }, after: 80.555, why }]);
  const draft = structuredClone(S);
  applyDataChange(draft, r.changes[0], ctx);
  assert.deepEqual(draft.bodyweight, [{ d: '2026-10-19', w: 80.56, t: ctx.now }], 'an existing day is replaced, not duplicated');
});

test('exercise notes: a known exercise, a bounded text, "" removes', () => {
  const S = state();
  bad(S, [{ type: 'exnote-set', target: { exId: 'ghost' }, after: 'x', why }], /not in the exercise library/);
  bad(S, [{ type: 'exnote-set', target: { exId: '0001' }, after: 'x'.repeat(501), why }], /longer than 500/);
  bad(S, [{ type: 'exnote-set', target: { exId: '0001' }, after: { a: 1 }, why }], /note text/);
  const r = ok(S, [{ type: 'exnote-set', target: { exId: '0001' }, after: '', why }]);
  const draft = structuredClone(S);
  applyDataChange(draft, r.changes[0], ctx);
  assert.equal('0001' in draft.exNotes, false);
});

test('own exercises: a known body part, no duplicate name, and a delete cleans up after itself', () => {
  const S = state();
  bad(S, [{ type: 'custom-ex-add', target: {}, after: { n: 'Thing', bp: 'elbows' }, why }], /bp must be one of/);
  bad(S, [{ type: 'custom-ex-add', target: {}, after: { n: 'sandbag CARRY', bp: 'back' }, why }], /already have a custom exercise/);
  bad(S, [{ type: 'custom-ex-add', target: {}, after: { n: 'Thing', bp: 'back', tg: 'wings' }, why }], /not a muscle the app knows/);
  bad(S, [{ type: 'custom-ex-add', target: {}, after: { n: 'Thing', bp: 'back', id: '0001' }, why }], /must start with "c"/);
  bad(S, [{ type: 'custom-ex-add', target: {}, after: { n: 'Thing', bp: 'back', id: 'cx1' }, why }], /already taken/);
  bad(S, [{ type: 'custom-ex-edit', target: { exId: '0001' }, after: { n: 'x' }, why }], /not one of your own exercises/);
  bad(S, [{ type: 'custom-ex-delete', target: { exId: '0001' }, why }], /not one of your own exercises/);
  const withActive = state(); withActive.active = { entries: [{ id: 'cx1' }] };
  bad(withActive, [{ type: 'custom-ex-delete', target: { exId: 'cx1' }, why }], /running right now/);

  const del = state();
  del.routines[0].ex.push({ id: 'cx1', sets: 3, reps: 10 });
  del.workouts[0].entries.push({ id: 'cx1', sets: [{ r: 5, w: 10, done: true }] });
  const r = ok(del, [{ type: 'custom-ex-delete', target: { exId: 'cx1' }, why }]);
  assert.match(r.changes[0].lines[0].before, /used in: Full body A/);
  applyDataChange(del, r.changes[0], ctx);
  assert.deepEqual(del.customEx, []);
  assert.equal(del.routines[0].ex.some(e => e.id === 'cx1'), false);
  assert.deepEqual(del.favEx, []);
  assert.equal(del.workouts[0].entries.at(-1).n, 'Sandbag carry', 'logged sets keep the exercise\'s name');

  // The chosen id is honoured, so a workout in the same set can name the new exercise.
  const both = ok(state(), [
    { type: 'custom-ex-add', target: {}, after: { id: 'cnew1', n: 'Zercher carry', bp: 'back' }, why },
    { type: 'workout-add', target: {}, after: { d: '2026-10-20', entries: [{ id: 'cnew1', sets: [{ r: 1, w: 50 }] }] }, why }
  ]);
  assert.equal(both.changes.length, 2, 'a workout may use an exercise the same set adds');
  const draft = state();
  for (const c of both.changes) applyDataChange(draft, c, ctx);
  assert.ok(draft.customEx.some(x => x.id === 'cnew1') && draft.workouts.some(w => w.entries[0].id === 'cnew1'));
});

test('settings: only the allowlist, with a range each, and never the weight unit', () => {
  const S = state();
  bad(S, [{ type: 'setting', target: { key: 'unit' }, after: 'lb', why }], /not a setting you can change.*weight unit is changed in Settings/);
  bad(S, [{ type: 'setting', target: { key: 'theme' }, after: 'dark', why }], /not a setting you can change/);
  bad(S, [{ type: 'setting', target: { key: '__proto__' }, after: {}, why }], /not a setting you can change/);
  bad(S, [{ type: 'setting', target: { key: 'restSec' }, after: 2, why }], /whole seconds 5-900/);
  bad(S, [{ type: 'setting', target: { key: 'restSec' }, after: '120', why }], /whole seconds/);
  bad(S, [{ type: 'setting', target: { key: 'effort' }, after: 'rpm', why }], /one of none, rir, rpe/);
  bad(S, [{ type: 'setting', target: { key: 'restSec' }, after: 90, why }], /already is 90/);
  assert.ok(!('unit' in SETTINGS));
  S.targetW = 80;
  for (const [key, v] of [['restSec', 75], ['effort', 'rir'], ['weekStart', 0], ['wdec', 2], ['targetW', null], ['targetW', 78.5], ['sound', false], ['oneRmFormula', 'brzycki'], ['speedUnit', 'mph']]) {
    const r = ok(S, [{ type: 'setting', target: { key }, after: v, why }]);
    const draft = structuredClone(S);
    applyDataChange(draft, r.changes[0], ctx);
    assert.deepEqual(draft[key], v, key);
  }
});

test('the coach profile: only its own fields, enums and ranges, merged over what is there', () => {
  const S = state();
  bad(S, [{ type: 'profile-set', target: {}, after: { goal: 'bulk' }, why }], /goal must be one of/);
  bad(S, [{ type: 'profile-set', target: {}, after: { daysPerWeek: 9 }, why }], /1-7/);
  bad(S, [{ type: 'profile-set', target: {}, after: { consent: null }, why }], /not a coach-profile field/);
  bad(S, [{ type: 'profile-set', target: {}, after: { preferredDays: [1, 9] }, why }], /weekday numbers/);
  bad(S, [{ type: 'profile-set', target: {}, after: {}, why }], /some of/);
  const r = ok(S, [{ type: 'profile-set', target: {}, after: { equipment: ['dumbbell', 'barbell'], limitations: 'x'.repeat(900), goal: 'strength' }, why }]);
  assert.equal(r.changes[0].after.limitations.length, 600, 'cut to what the intake screen allows');
  const draft = structuredClone(S);
  applyDataChange(draft, r.changes[0], ctx);
  assert.equal(draft.coach.profile.goal, 'strength');
  assert.equal(draft.coach.profile.experience, 'regular', 'what is not named stays');
  assert.equal(draft.coach.consent, undefined);
  assert.deepEqual(touchedKeys(r.changes), ['coach.profile'], 'the undo never rolls back the snapshots themselves');
});

test('the calendar: a routine that exists, or rest, or nothing; not a year-old date', () => {
  const S = state();
  bad(S, [{ type: 'dayplan', target: { date: '2026-10-23' }, after: 'nope', why }], /routine id from the plan/);
  bad(S, [{ type: 'dayplan', target: { date: '2020-01-01' }, after: 'rest', why }], /outside the window/);
  bad(S, [{ type: 'dayplan', target: { date: '2026-10-23' }, after: null, why }], /already reads that way/);
  const r = ok(S, [{ type: 'dayplan', target: { date: '2026-10-23' }, after: 'r1', why }]);
  const draft = structuredClone(S);
  applyDataChange(draft, r.changes[0], ctx);
  assert.equal(draft.dayPlan['2026-10-23'], 'r1');
  const clear = ok(draft, [{ type: 'dayplan', target: { date: '2026-10-23' }, after: null, why }]);
  applyDataChange(draft, clear.changes[0], ctx);
  assert.deepEqual(draft.dayPlan, {});
});

/* ---------- a set is all or nothing, and has to make sense as a whole ---------- */

test('one bad change fails the whole set — nothing partial comes back', () => {
  const r = bad(state(), [{ ...GOOD.setting, why }, { ...GOOD['workout-delete'], target: { workoutId: 'ghost' }, why }], /workoutId "ghost"/);
  assert.equal(r.changes, undefined);
});

test('changes that are fine alone but not together are refused', () => {
  const S = state();
  bad(S, [{ ...GOOD['bodyweight-set'], target: { date: '2026-10-19' }, after: 79, why }, { type: 'bodyweight-delete', target: { date: '2026-10-19' }, why }], /both change the weigh-in on 2026-10-19/);
  bad(S, [{ ...GOOD.setting, why }, { ...GOOD.setting, after: 100, why }], /both change setting restSec/);
  bad(S, [{ ...GOOD['custom-ex-delete'], why }, { type: 'workout-add', target: {}, after: { d: '2026-10-20', entries: [{ id: 'cx1', sets: [{ r: 1, w: 5 }] }] }, why }], /which another change deletes/);
  bad(S, [{ type: 'dayplan', target: { date: '2026-10-23' }, after: 'r2', why }, { ...GOOD['remove-routine'], why }], /schedules a routine that another change removes/);
  bad(S, [{ ...GOOD['profile-set'], why }, { ...GOOD['profile-set'], after: { notes: 'x' }, why }], /both change the coach profile/);
});

test('a plan change and a data change travel together, in the order they were written', () => {
  const r = ok(state(), [{ ...GOOD['bodyweight-set'], why }, { ...GOOD.sets, why }, { ...GOOD.setting, why }]);
  assert.deepEqual(r.changes.map(c => c.type), ['bodyweight-set', 'sets', 'setting']);
  assert.deepEqual(r.changes.map(c => c.id), ['k0', 'k1', 'k2']);
  assert.deepEqual(touchedKeys(r.changes).sort(), ['bodyweight', 'restSec', 'routines']);
});

test('currentOfData reads the live value a change\'s before should still match', () => {
  const S = state();
  const r = ok(S, [{ ...GOOD['bodyweight-set'], target: { date: '2026-10-19' }, after: 79, why }, { ...GOOD['exnote-set'], target: { exId: '0001' }, why }, { ...GOOD.setting, why }, { ...GOOD['workout-edit'], why }, { ...GOOD['custom-ex-edit'], why }]);
  for (const c of r.changes) assert.deepEqual(currentOfData(S, c), c.before, c.type);
  S.restSec = 100; S.bodyweight[0].w = 79.5; S.workouts[0].note = 'changed elsewhere';
  assert.notDeepEqual(currentOfData(S, r.changes[0]), r.changes[0].before, 'an edit made since is visible');
  assert.notDeepEqual(currentOfData(S, r.changes[2]), r.changes[2].before);
  assert.notDeepEqual(currentOfData(S, r.changes[3]), r.changes[3].before);
});

test('applying onto a state where the target has since gone throws, so the store discards the whole set', () => {
  const S = state();
  const r = ok(S, [{ ...GOOD['bodyweight-delete'], why }, { ...GOOD['workout-delete'], why }]);
  const gone = structuredClone(S);
  gone.workouts = [];
  assert.throws(() => { for (const c of r.changes) applyDataChange(gone, c, ctx); }, /gone/);
});
