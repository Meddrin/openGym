/* The assistant's tools: bound to one profile, read-only, bounded.
 *
 * The property that matters most is the first: a toolset is built for one uid, and nothing the
 * model sends can name another. The tests look at it from three sides — the parameters (none of
 * them is a profile, a file or a path), the behaviour (arguments that try anyway are ignored, and
 * the state reader is only ever asked for the one uid), and the output (a marker planted in a
 * neighbour's data never shows up). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tempData, writeState } from './helpers.mjs';

const DIR = tempData();
const { createToolset, TOOL_NAMES, MAX_RESULT_CHARS, todayFor, jsonSchema } = await import('../coach/assistant/tools.js');
const jobs = await import('../coach/jobs.js');
const stats = await import('../coach/assistant/stats.js');

const NOW = new Date('2026-10-21T10:00:00Z');
const iso = d => d.toISOString().slice(0, 10);
const daysAgo = n => iso(new Date(NOW.getTime() - n * 86400000));
const set = (w, r, extra = {}) => ({ w, r, done: true, ...extra });

/** A profile with a plan, some history, body weight, notes and an exercise of its own. */
function rich(marker = 'ALICE') {
  return {
    unit: 'kg', lang: 'en', effort: 'rir', targetW: 78, weekStart: 1, restSec: 90,
    reminder: { tz: 'Europe/Budapest' },
    coach: { consent: { agreedAt: 'x' }, profile: { goal: 'muscle', experience: 'regular', daysPerWeek: 3, equipment: ['barbell', 'dumbbell'], limitations: 'left shoulder clicks overhead ' + marker } },
    routines: [{ id: 'r1', name: 'Push ' + marker, ex: [{ id: '0001', sets: 3, reps: 10, weight: 20, prog: 'linear' }, { id: '0007', sets: 3, sec: 45, mode: 'time' }] }, { id: 'r2', name: 'Pull', ex: [{ id: '0009', sets: 3, reps: 8 }] }],
    week: { 1: ['r1'], 3: ['r2'], 5: ['r1'] }, dayPlan: { [daysAgo(-2)]: 'rest', [daysAgo(60)]: 'r2' },
    exNotes: { '0001': 'seat 4 ' + marker },
    favEx: ['cx1'], customEx: [{ id: 'cx1', n: 'Sandbag carry', bp: 'back', tg: 'lats', eq: 'custom', desc: 'hug it', custom: true }],
    bodyweight: [0, 7, 14, 21].map((n, i) => ({ d: daysAgo(n), w: 80 - i * 0.5, t: 1 })),
    workouts: [
      { id: 'w3', d: daysAgo(1), name: 'Push ' + marker, start: 1_000_000, end: 1_000_000 + 50 * 60000, note: 'good session ' + marker, entries: [
        { id: '0001', sets: [set(20, 10, { rir: 2 }), set(20, 9, { rir: 1 }), set(20, 8, { rir: 0 }), set(10, 12, { phase: 'warmup' })] },
        { id: 'cx1', sets: [set(40, 20)] }
      ] },
      { id: 'w2', d: daysAgo(4), name: 'Pull', start: 5, end: 5 + 40 * 60000, entries: [{ id: '0009', sets: [set(50, 8), set(50, 7, { rir: 3 })] }] },
      { id: 'w1', d: daysAgo(9), name: 'Push ' + marker, start: 7, end: 7 + 40 * 60000, entries: [{ id: '0001', sets: [set(17.5, 10), set(17.5, 10), set(17.5, 9)] }] }
    ],
    active: null
  };
}

const toolsFor = (uid, S) => createToolset({ uid, readState: u => (u === uid ? S : null), now: () => NOW });
const out = (ts, name, args) => ts.call(name, args);

/* ---------- bound to one profile ---------- */

test('the toolset is exactly the nine tools, and none of them takes a profile, a file or a path', () => {
  const ts = toolsFor('u1', rich());
  assert.deepEqual(ts.names, TOOL_NAMES);
  assert.equal(ts.tools.length, 9);
  const params = ts.tools.flatMap(t => Object.keys(t.params));
  assert.ok(params.length > 0);
  for (const name of params) assert.doesNotMatch(name, /uid|user|profile|account|owner|path|file|dir|folder|url|host|handle|token|key/i, `parameter "${name}" must not be able to name somebody or somewhere`);
  // Every tool also describes itself without promising anything outside the profile.
  for (const t of ts.tools) assert.ok(t.description.length > 20, t.name);
  // The JSON Schemas providers get are built from the same specs, so they carry the same names.
  const schemaNames = ts.tools.flatMap(t => Object.keys(jsonSchema(t.params).properties));
  assert.deepEqual(schemaNames, params);
});

test('a tool reads only the profile it was built for, whatever arguments it is handed', () => {
  const asked = [];
  const A = rich('ALICE'), B = rich('BOBBY');
  const ts = createToolset({ uid: 'alice', readState: u => { asked.push(u); return u === 'alice' ? A : u === 'bob' ? B : null; }, now: () => NOW });
  for (const t of ts.tools) {
    const args = { uid: 'bob', userId: 'bob', profile: 'bob', path: '/data/state-bob.json', file: '../state-bob.json', id: 'w1', exerciseId: '0001', query: 'squat', topic: 'summary', summary: 's', changes: [] };
    ts.call(t.name, args);
  }
  assert.ok(asked.length >= 9);
  assert.deepEqual([...new Set(asked)], ['alice'], 'the state reader was only ever asked for the one uid');
  const everything = JSON.stringify(TOOL_NAMES.map(n => ts.call(n, { id: 'w1', query: 'squat', uid: 'bob', path: 'x' })));
  assert.ok(!everything.includes('BOBBY'), 'nothing of the neighbour');
  assert.ok(everything.includes('ALICE'), 'and plenty of the profile itself');
});

test('two toolsets over one data directory each see their own profile and nobody else\'s', () => {
  writeState(DIR, 'ann', rich('ANN-MARK'));
  writeState(DIR, 'ben', rich('BEN-MARK'));
  const mk = uid => createToolset({ uid, readState: jobs.readState, now: () => NOW });
  const a = mk('ann'), b = mk('ben');
  const dump = ts => JSON.stringify([
    ts.call('get_profile'), ts.call('get_plan'), ts.call('list_workouts', { limit: 60 }), ts.call('get_workout', { id: 'w3' }),
    ts.call('get_my_exercises'), ts.call('get_bodyweight'), ts.call('get_stats'), ts.call('search_exercises', { query: 'sand' })
  ]);
  assert.ok(dump(a).includes('ANN-MARK') && !dump(a).includes('BEN-MARK'));
  assert.ok(dump(b).includes('BEN-MARK') && !dump(b).includes('ANN-MARK'));
  // A uid that is not a profile gets nothing, and a path-shaped uid cannot reach a file.
  const ghost = mk('../state-ann');
  assert.match(JSON.stringify(ghost.call('get_profile')), /no data for this profile/);
  assert.ok(!JSON.stringify(ghost.call('get_plan')).includes('ANN-MARK'));
});

test('a toolset needs a uid, and unknown tools and missing arguments are answers, not crashes', () => {
  assert.throws(() => createToolset({ readState: () => null }), /uid/);
  assert.throws(() => createToolset({ uid: 'x' }), /readState/);
  const ts = toolsFor('u1', rich());
  assert.match(ts.call('rm_rf', {}).error, /unknown tool/);
  assert.match(ts.call('get_workout', {}).error, /missing argument "id"/);
  assert.match(ts.call('get_workout', { id: 'nope' }).error, /no workout with id "nope"/);
  assert.match(ts.call('list_workouts', { from: 'last week' }).error, /YYYY-MM-DD/);
  const crashing = createToolset({ uid: 'u', readState: () => { throw new Error('disk on fire'); } });
  assert.match(crashing.call('get_profile').error, /tool failed: disk on fire/);
  assert.deepEqual(ts.calls().map(c => c.ok), [false, false, false], 'each real tool call is counted; an unknown name is not a tool');
});

test('the tools never write: the state they read is untouched, whatever is called', () => {
  const S = rich();
  const before = JSON.stringify(S);
  const ts = toolsFor('u1', S);
  for (const n of TOOL_NAMES.filter(n => n !== 'propose_changes')) ts.call(n, { id: 'w3', query: 'squat', topic: 'strength' });
  ts.call('propose_changes', { summary: 's', changes: [{ type: 'bodyweight-set', target: { date: daysAgo(0) }, after: 79, why: 'w' }] });
  assert.equal(JSON.stringify(S), before, 'even propose_changes only records a proposal');
});

/* ---------- what each tool says ---------- */

test('get_profile: settings, the intake, totals, and the profile\'s own calendar day', () => {
  const p = toolsFor('u1', rich()).call('get_profile');
  assert.equal(p.today, '2026-10-21');
  assert.equal(p.weekday, 'Wednesday');
  assert.equal(p.unit, 'kg');
  assert.equal(p.effortScale, 'rir');
  assert.equal(p.goalWeight, 78);
  assert.equal(p.settings.restSec, 90);
  assert.ok('effort' in p.settings && !('unit' in p.settings), 'the settings it may change are listed, the unit is not among them');
  assert.equal(p.intake.goal, 'muscle');
  assert.deepEqual(p.intake.equipment, ['barbell', 'dumbbell']);
  assert.equal(p.totals.workouts, 3);
  assert.equal(p.totals.firstWorkout, daysAgo(9));
  assert.equal(p.totals.customExercises, 1);
  assert.equal(p.totals.latestWeight.date, daysAgo(0));
  // The reminder's time zone decides the day: late evening UTC is already tomorrow in Budapest.
  assert.equal(todayFor({ reminder: { tz: 'Europe/Budapest' } }, new Date('2026-10-21T23:30:00Z')), '2026-10-22');
  assert.equal(todayFor({}, new Date('2026-10-21T23:30:00Z')), '2026-10-21');
  assert.equal(todayFor({ reminder: { tz: 'Not/AZone' } }, new Date('2026-10-21T23:30:00Z')), '2026-10-21');
});

test('get_plan: routines with names, the week by weekday name, and recent overrides only', () => {
  const p = toolsFor('u1', rich()).call('get_plan');
  assert.equal(p.routines.length, 2);
  assert.equal(p.routines[0].exercises[0].id, '0001');
  assert.ok(p.routines[0].exercises[0].name, 'exercise names are resolved from the library');
  assert.deepEqual(p.week.Monday, [{ id: 'r1', name: p.routines[0].name }]);
  assert.deepEqual(Object.keys(p.week), ['Monday', 'Wednesday', 'Friday']);
  assert.equal(p.dateOverrides.length, 1, 'an override from two months ago is not offered');
  assert.equal(p.dateOverrides[0].plan, 'rest');
});

test('list_workouts and get_workout: short form first, then every set with its index', () => {
  const ts = toolsFor('u1', rich());
  const l = ts.call('list_workouts', { limit: 2 });
  assert.equal(l.matching, 3);
  assert.deepEqual(l.workouts.map(w => w.id), ['w3', 'w2'], 'newest first');
  assert.deepEqual(l.workouts[0], { id: 'w3', date: daysAgo(1), name: l.workouts[0].name, minutes: 50, workingSets: 4, volume: 20 * 10 + 20 * 9 + 20 * 8 + 40 * 20, exercises: [l.workouts[0].exercises[0], 'Sandbag carry'], note: l.workouts[0].note, editable: true });
  assert.equal(ts.call('list_workouts', { exerciseId: '0009' }).matching, 1);
  assert.equal(ts.call('list_workouts', { from: daysAgo(5), to: daysAgo(2) }).matching, 1);
  const w = ts.call('get_workout', { id: 'w3' });
  assert.equal(w.entries[0].index, 0);
  assert.deepEqual(w.entries[0].sets[0], { index: 0, reps: 10, weight: 20, rir: 2, done: true });
  assert.deepEqual(w.entries[0].sets[3], { index: 3, reps: 12, weight: 10, warmup: true, done: true });
  assert.equal(w.entries[1].name, 'Sandbag carry');
  assert.ok(Array.isArray(w.summary) && w.summary.length === 2);
  // A workout with no id is listed but not editable.
  const S = rich(); delete S.workouts[0].id;
  assert.equal(toolsFor('u1', S).call('list_workouts').workouts.find(x => x.date === daysAgo(1)).editable, false);
});

test('search_exercises: needs a filter, finds by words, equipment and muscle, flags and puts the person\'s own first', () => {
  const ts = toolsFor('u1', rich());
  assert.match(ts.call('search_exercises', {}).error, /at least one/);
  const sq = ts.call('search_exercises', { query: 'squat', equipment: 'barbell' });
  assert.ok(sq.matching >= 3 && sq.exercises.every(e => /squat/.test(e.name) && e.equipment === 'barbell'));
  assert.ok(sq.exercises.length <= 15);
  assert.ok(sq.exercises[0].name.length <= sq.exercises.at(-1).name.length, 'plainest names first');
  const mine = ts.call('search_exercises', { query: 'sandbag' });
  assert.deepEqual([mine.exercises[0].id, mine.exercises[0].custom], ['cx1', true], 'an own exercise comes first');
  assert.ok(mine.exercises.slice(1).every(e => !e.custom));
  assert.ok(ts.call('search_exercises', { muscle: 'lats' }).exercises.some(e => e.id === 'cx1'), 'own exercises are searched by muscle too');
  assert.equal(ts.call('search_exercises', { query: 'zzzzqx' }).matching, 0);
  assert.equal(ts.call('search_exercises', { bodyPart: 'cardio', limit: 3 }).exercises.length, 3);
  assert.equal(ts.call('search_exercises', { query: 'a', limit: 500 }).exercises.length, 40, 'the limit is capped');
});

test('get_my_exercises and get_bodyweight', () => {
  const ts = toolsFor('u1', rich());
  const m = ts.call('get_my_exercises');
  assert.equal(m.customExercises[0].name, 'Sandbag carry');
  assert.equal(m.notes[0].exerciseId, '0001');
  assert.deepEqual(m.favourites.map(f => f.exerciseId), ['cx1']);
  const b = ts.call('get_bodyweight');
  assert.equal(b.unit, 'kg');
  assert.equal(b.goal, 78);
  assert.deepEqual(b.entries.map(e => e.weight), [78.5, 79, 79.5, 80], 'oldest first');
  assert.equal(b.change, 1.5, 'last minus first');
  assert.equal(b.weeklyMeans.length, 4);
  assert.equal(ts.call('get_bodyweight', { limit: 2 }).entries.length, 2);
  assert.equal(ts.call('get_bodyweight', { from: daysAgo(8) }).entries.length, 2);
});

test('get_stats: estimated one-rep maxes, weekly hard sets per muscle, adherence', () => {
  const ts = toolsFor('u1', rich());
  const s = ts.call('get_stats', { topic: 'strength' });
  const bench = s.strength.find(x => x.id === '0001');
  assert.equal(bench.sessions, 2);
  // Best Epley set: 20 x 10 -> 26.7 (17.5 x 10 -> 23.3; warm-ups never count).
  assert.deepEqual(bench.bestE1rm, { e1rm: 26.7, d: daysAgo(1), w: 20, r: 10 });
  assert.equal(ts.call('get_stats', { topic: 'strength', exerciseId: '0009' }).strength.length, 1);
  assert.deepEqual(ts.call('get_stats', { topic: 'strength', exerciseId: 'nope' }).strength, []);

  const v = ts.call('get_stats', { topic: 'volume', weeks: 2 }).volume;
  assert.equal(v.weeks.length, 2);
  const thisWeek = v.weeks.at(-1).muscles;
  const all = Object.values(thisWeek).reduce((n, m) => n + m.sets, 0);
  assert.ok(all >= 3, 'this week has the push session');
  assert.ok(Object.values(thisWeek).some(m => m.hardSets >= 2), 'RIR 1 and 0 are hard sets');
  assert.ok(v.ratedShare > 0 && v.ratedShare <= 1);

  const a = ts.call('get_stats', { topic: 'adherence', weeks: 3 }).adherence;
  assert.equal(a.plannedDaysPerWeek, 3);
  assert.equal(a.weeks.length, 3);
  assert.ok(a.weeks.at(-1).current);
  assert.equal(Object.keys(ts.call('get_stats')).sort().join(), 'adherence,strength,unit,weeklyVolume');
});

test('weekly volume counts the right week, for a week that starts on Sunday too', () => {
  const S = { weekStart: 0, workouts: [{ d: '2026-10-18', entries: [{ id: '0001', sets: [set(20, 10, { rir: 1 })] }] }, { d: '2026-10-17', entries: [{ id: '0001', sets: [set(20, 10)] }] }], customEx: [] };
  const v = stats.weeklyVolume(S, { weeks: 2, today: '2026-10-21' });
  assert.deepEqual(v.weeks.map(w => w.start), ['2026-10-11', '2026-10-18'], 'Sunday-first weeks');
  const tg = Object.keys(v.weeks[1].muscles)[0];
  assert.equal(v.weeks[1].muscles[tg].sets, 1, 'the 18th is this week');
  assert.equal(v.weeks[0].muscles[tg].sets, 1, 'the 17th is last week');
});

/* ---------- bounded, whatever the state holds ---------- */

test('a hostile state cannot make a tool answer with a megabyte, or carry a name longer than a name', () => {
  const HUGE = 'x'.repeat(300_000);
  const S = rich();
  S.routines[0].name = HUGE;
  S.workouts[0].name = HUGE;
  S.workouts[0].note = HUGE;
  S.workouts[0].entries[0].note = HUGE;
  S.customEx[0].n = HUGE; S.customEx[0].desc = HUGE;
  S.exNotes['0001'] = HUGE;
  S.coach.profile.limitations = HUGE; S.coach.profile.notes = HUGE;
  S.equipProfiles = [{ id: 'e', name: HUGE, equipment: Array.from({ length: 500 }, (_, i) => 'eq' + i) }]; S.activeEquipId = 'e';
  const ts = toolsFor('u1', S);
  for (const [name, args] of [['get_profile'], ['get_plan'], ['list_workouts', { limit: 60 }], ['get_workout', { id: 'w3' }], ['get_my_exercises'], ['search_exercises', { query: 'sand' }]]) {
    const r = ts.call(name, args || {});
    const len = JSON.stringify(r).length;
    assert.ok(len <= MAX_RESULT_CHARS, `${name}: ${len}`);
    assert.ok(len < 12000, `${name} stays small on its own bounds (${len})`);
  }
});

/* ---------- propose_changes through the tool ---------- */

const bw = (date, w) => ({ type: 'bodyweight-set', target: { date }, after: w, why: 'asked' });

test('propose_changes: refusals come back as messages the model can act on, and nothing is kept', () => {
  const ts = toolsFor('u1', rich());
  let r = ts.call('propose_changes', { summary: 's', changes: [{ type: 'add-exercise', target: { routineId: 'r1' }, after: { id: 'made-up', sets: 3, reps: 10 }, why: 'new' }] });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /"made-up" is not in the exercise library/);
  assert.match(r.hint, /call propose_changes again/);
  r = ts.call('propose_changes', { summary: 's', changes: [{ type: 'sets', target: { routineId: 'gone', exId: '0001' }, after: 4, why: 'w' }] });
  assert.match(r.errors[0], /routineId "gone" is not one of the routines/);
  r = ts.call('propose_changes', { summary: 's', changes: [{ type: 'workout-edit', target: { workoutId: 'gone' }, after: { name: 'x' }, why: 'w' }] });
  assert.match(r.errors[0], /workoutId "gone" is not a workout you can edit/);
  r = ts.call('propose_changes', { summary: 's', changes: [{ type: 'workout-add', target: {}, after: { d: daysAgo(1), entries: [{ id: '0009', sets: [{ r: -1, w: 5 }] }] }, why: 'w' }] });
  assert.match(r.errors[0], /r must be a whole number/);
  r = ts.call('propose_changes', { summary: 's', changes: 'a pile of changes' });
  assert.equal(r.ok, false);
  assert.equal(ts.proposal(), null, 'a refused proposal is never kept');
});

test('propose_changes: an accepted set is kept on the toolset, a later accepted set replaces it, a refused one does not', () => {
  const ts = toolsFor('u1', rich());
  assert.equal(ts.proposal(), null);
  const first = ts.call('propose_changes', { summary: 'one', changes: [bw(daysAgo(0), 79)] });
  assert.equal(first.ok, true);
  assert.match(first.next, /Nothing has changed yet/);
  const p1 = ts.proposal();
  assert.equal(p1.summary, 'one');
  assert.equal(p1.changes[0].type, 'bodyweight-set');
  assert.equal(p1.changes[0].before, 80, 'before is the weigh-in that is there now');
  assert.ok(p1.id && p1.createdAt);

  assert.equal(ts.call('propose_changes', { summary: 'bad', changes: [bw('nonsense', 1)] }).ok, false);
  assert.equal(ts.proposal().summary, 'one', 'a refused call leaves the accepted one alone');

  assert.equal(ts.call('propose_changes', { summary: 'two', changes: [bw(daysAgo(0), 78.8), { type: 'setting', target: { key: 'restSec' }, after: 120, why: 'longer rests for heavy sets' }] }).ok, true);
  assert.equal(ts.proposal().summary, 'two');
  assert.equal(ts.proposal().changes.length, 2);
  assert.notEqual(ts.proposal().id, p1.id);
  assert.deepEqual(ts.calls().map(c => c.ok), [true, false, true]);
});

test('propose_changes: what it leaves out as already true is said, and a set that is all of that is refused', () => {
  const ts = toolsFor('u1', rich());
  const r = ts.call('propose_changes', { summary: 's', changes: [{ type: 'setting', target: { key: 'restSec' }, after: 90, why: 'same' }, bw(daysAgo(0), 79)] });
  assert.equal(r.ok, true);
  assert.equal(r.changes, 1);
  assert.match(r.leftOut[0], /restSec already is 90/);
  const none = toolsFor('u1', rich()).call('propose_changes', { summary: 's', changes: [{ type: 'setting', target: { key: 'restSec' }, after: 90, why: 'same' }] });
  assert.equal(none.ok, false);
  assert.match(none.errors[0], /nothing to change/);
});

test('propose_changes: a toolset over a profile with no data says so instead of proposing into the void', () => {
  const ts = createToolset({ uid: 'nobody', readState: () => null, now: () => NOW });
  const r = ts.call('propose_changes', { summary: 's', changes: [bw(daysAgo(0), 79)] });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /no data for this profile/);
  assert.equal(ts.proposal(), null);
});
