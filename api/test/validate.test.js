/* The validator, on its own — no queue, no child process, no provider.
 *
 * This is the file that decides whether something a language model said is allowed to touch a
 * training plan, so the tests are written as the attacks and accidents it exists to stop: an
 * invented change type, an exercise id that resolves to nothing, a target in the wrong routine,
 * a plan that ignores what the user asked for.
 *
 * The closed list gets its own sweep at the bottom: every member of CHANGE_TYPES must have a
 * well-formed instance here, so adding a type without an apply implementation and a test is a
 * red build rather than a discovery.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tempData } from './helpers.mjs';

tempData();
const { validateReview, CHANGE_TYPES } = await import('../coach/core/validate.js');

const PLAN = {
  routines: [{
    id: 'r1', name: 'Full body A',
    ex: [{ id: '0001', sets: 3, reps: 10 }, { id: '0007', sets: 3, sec: 45 }]
  }, {
    id: 'r2', name: 'Full body B', ex: [{ id: '0009', sets: 3, reps: 8 }]
  }, {
    // The v1.2.4 shapes, as cleanEx would hand them over: a unilateral exercise whose reps are
    // the total across both sides, and a bodyweight one with a rep ceiling.
    id: 'r3', name: 'Legs',
    ex: [
      { id: '0043', sets: 3, reps: 16, side: true },
      { id: '0001', sets: 3, reps: 12, repsMin: 8, repsMax: 20, bodyweight: true }
    ]
  }],
  week: { 1: 'r1', 3: 'r2' }
};
const change = over => ({ id: 'c1', type: 'sets', target: { routineId: 'r1', exId: '0001' }, before: 3, after: 4, why: 'stalled twice', ...over });
const review = changes => validateReview({ coach_contract: 1, summary: 's', changes }, PLAN);
const swapIn = (id, over = {}) => change({ id: 'c9', type: 'swap-exercise', target: { routineId: 'r1', exId: '0001' }, after: { id, sets: 4, reps: 8 }, ...over });

test('a review cannot prescribe an odd total on a per-side exercise', () => {
  const tgt = { routineId: 'r3', exId: '0043' };
  assert.equal(review([change({ type: 'reps', target: tgt, after: 17 })]).ok, false);
  assert.equal(review([change({ type: 'reps', target: tgt, after: 18 })]).ok, true);
  // The rule follows the plan, not the change: the same value on r1's 0001 is fine.
  assert.equal(review([change({ type: 'reps', after: 17 })]).ok, true);
});

/* ---------------- review change-sets ---------------- */

test('an invented change type does nothing at all', () => {
  const r = review([change({ type: 'delete-all-workouts' })]);
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes('not allowed'));
  assert.ok(!CHANGE_TYPES.includes('delete-all-workouts'));
});

test('every change must target something that exists', () => {
  assert.equal(review([change({ target: { routineId: 'ghost', exId: '0001' } })]).ok, false);
  assert.equal(review([change({ target: { routineId: 'r1', exId: '9999' } })]).ok, false, 'exercise not in that routine');
  assert.equal(review([change({ target: { routineId: 'r2', exId: '0001' } })]).ok, false, 'right exercise, wrong routine');
});

test('a change without a rationale is rejected', () => {
  const r = review([change({ why: '' })]);
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes('why'));
});

test('values are type-checked per change type', () => {
  assert.equal(review([change({ type: 'sets', after: 'four' })]).ok, false);
  assert.equal(review([change({ type: 'sets', after: 99 })]).ok, false);
  assert.equal(review([change({ type: 'reps', after: 0 })]).ok, false);
  assert.equal(review([change({ type: 'exercise-prog', after: 'linear' })]).ok, true);
  assert.equal(review([change({ type: 'exercise-prog', after: 'vibes' })]).ok, false);
  assert.equal(review([change({ type: 'inc', after: -5 })]).ok, false);
});

test('adding an exercise requires a real library id', () => {
  const ok = review([change({ type: 'add-exercise', target: { routineId: 'r1' }, after: { id: '0009', sets: 3, reps: 12 } })]);
  assert.equal(ok.ok, true);
  assert.equal(ok.proposal.changes[0].after.name, 'assisted chest dip (kneeling)');
  assert.equal(review([change({ type: 'add-exercise', target: { routineId: 'r1' }, after: { id: 'made-up' } })]).ok, false);
});

test('an added exercise may declare itself bodyweight, per-side and capped', () => {
  const r = review([change({
    type: 'add-exercise', target: { routineId: 'r1' },
    after: { id: '0043', sets: 3, reps: 16, side: true, bodyweight: true, repsMin: 10, repsMax: 24 }
  })]);
  assert.equal(r.ok, true);
  assert.deepEqual(
    (({ side, bodyweight, repsMin, repsMax }) => ({ side, bodyweight, repsMin, repsMax }))(r.proposal.changes[0].after),
    { side: true, bodyweight: true, repsMin: 10, repsMax: 24 }
  );
  // And the parity rule applies to what it declares about itself.
  assert.equal(review([change({
    type: 'add-exercise', target: { routineId: 'r1' }, after: { id: '0043', sets: 3, reps: 15, side: true }
  })]).ok, false);
});

test('a reorder must be a permutation of what is already there', () => {
  assert.equal(review([change({ type: 'reorder', target: { routineId: 'r1' }, after: ['0007', '0001'] })]).ok, true);
  assert.equal(review([change({ type: 'reorder', target: { routineId: 'r1' }, after: ['0007'] })]).ok, false, 'dropping one is not a reorder');
  assert.equal(review([change({ type: 'reorder', target: { routineId: 'r1' }, after: ['0007', '0009'] })]).ok, false, 'nor is smuggling one in');
  // The one that satisfies both a length check and a membership check while still deleting an
  // exercise — and reorder is the change type the review screen shows no diff for.
  assert.equal(review([change({ type: 'reorder', target: { routineId: 'r1' }, after: ['0001', '0001'] })]).ok, false, 'naming one twice drops the other');
});

test('a superset needs a partner that is not itself', () => {
  assert.equal(review([change({ type: 'superset', after: { link: true, with: '0007' } })]).ok, true);
  assert.equal(review([change({ type: 'superset', after: { link: true, with: '0001' } })]).ok, false, 'the anchor cannot be its own partner');
  assert.equal(review([change({ type: 'superset', after: { link: false } })]).ok, true, 'unlinking needs no partner');
});

test('a new routine is refused whole when it names an exercise nobody has', () => {
  const withEx = ex => review([change({ type: 'add-routine', target: {}, after: { name: 'C', ex } })]);
  assert.equal(withEx([{ id: '0001', sets: 3, reps: 10 }]).ok, true);
  // Not trimmed to the exercises that did resolve: that would hand someone a routine they were
  // never shown, under the summary of the one they were.
  const r = withEx([{ id: '0001', sets: 3, reps: 10 }, { id: 'not-a-real-exercise', sets: 3, reps: 10 }]);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /not-a-real-exercise/, 'and the repair round is told which one');
});

test('before is read off the plan, never taken from the answer', () => {
  // Unchecked in every other respect: the model can say anything here, and whatever it says
  // reaches the synced Coach log and the staleness check that decides what stays applicable.
  const huge = { junk: 'x'.repeat(100000) };
  const r = review([change({ type: 'sets', before: huge, after: 4 })]);
  assert.equal(r.ok, true);
  assert.equal(r.proposal.changes[0].before, 3, 'the plan says 3 sets, so before is 3');

  // A merely mistyped before is the same bug wearing a smaller hat: it survives validation and
  // then silently disables the change, because markStale compares it against a number.
  const typed = review([change({ type: 'sets', before: '3 sets', after: 4 })]);
  assert.equal(typed.proposal.changes[0].before, 3);

  // Structural changes have no scalar to compare; null is what the client reads as "skip".
  const structural = review([change({ type: 'reorder', target: { routineId: 'r1' }, before: 'anything', after: ['0007', '0001'] })]);
  assert.equal(structural.proposal.changes[0].before, null);

  // And a field the plan does not carry reads as absent rather than as the model's guess.
  const absent = review([change({ type: 'inc', before: 2.5, after: 5 })]);
  assert.equal(absent.proposal.changes[0].before, null);
});

test('a week change may only schedule a routine that exists, rest, or nothing', () => {
  assert.equal(review([change({ type: 'week', target: { weekday: 6 }, after: 'r2' })]).ok, true);
  assert.equal(review([change({ type: 'week', target: { weekday: 6 }, after: 'rest' })]).ok, true);
  assert.equal(review([change({ type: 'week', target: { weekday: 6 }, after: null })]).ok, true);
  assert.equal(review([change({ type: 'week', target: { weekday: 9 }, after: 'r1' })]).ok, false);
  assert.equal(review([change({ type: 'week', target: { weekday: 6 }, after: 'ghost' })]).ok, false);
});

test('"nothing to change" is a first-class answer, and so is an empty change list', () => {
  const a = validateReview({ nochange: true, reading: 'Plan is working.' }, PLAN);
  assert.equal(a.nochange, true);
  assert.equal(a.reading, 'Plan is working.');
  const b = review([]);
  assert.equal(b.nochange, true, 'no changes and "no changes" are the same outcome');
});

test('advice-only notes survive but carry no change', () => {
  const r = validateReview({ summary: 's', changes: [change()], notes: ['Body weight is flat — eat more.'] }, PLAN);
  assert.equal(r.proposal.notes.length, 1);
  assert.equal(r.proposal.changes.length, 1);
});

test('one bad change fails the whole set — nothing is ever half-applied', () => {
  const r = review([change(), change({ id: 'c2', type: 'not-a-type' })]);
  assert.equal(r.ok, false);
});

test('every allowed change type has a validator that accepts a well-formed instance', () => {
  const good = {
    'add-exercise': change({ type: 'add-exercise', target: { routineId: 'r1' }, after: { id: '0009', sets: 3, reps: 10 } }),
    'remove-exercise': change({ type: 'remove-exercise' }),
    'swap-exercise': change({ type: 'swap-exercise', after: { id: '0009' } }),
    sets: change({ type: 'sets', after: 4 }),
    reps: change({ type: 'reps', after: 12 }),
    repsMin: change({ type: 'repsMin', after: 8 }),
    repsMax: change({ type: 'repsMax', after: 20 }),
    sec: change({ type: 'sec', target: { routineId: 'r1', exId: '0007' }, after: 60 }),
    cardio: change({ type: 'cardio', after: { min: 25, speed: 9 } }),
    reorder: change({ type: 'reorder', target: { routineId: 'r1' }, after: ['0007', '0001'] }),
    superset: change({ type: 'superset', after: { link: true, with: '0007' } }),
    'routine-prog': change({ type: 'routine-prog', target: { routineId: 'r1' }, after: 'double' }),
    'exercise-prog': change({ type: 'exercise-prog', after: 'greyskull' }),
    inc: change({ type: 'inc', after: 2.5 }),
    'add-routine': change({ type: 'add-routine', target: {}, after: { name: 'C', ex: [{ id: '0001', sets: 3, reps: 10 }] } }),
    'remove-routine': change({ type: 'remove-routine', target: { routineId: 'r2' } }),
    'rename-routine': change({ type: 'rename-routine', target: { routineId: 'r1' }, after: 'Upper' }),
    week: change({ type: 'week', target: { weekday: 2 }, after: 'r1' })
  };
  for (const type of CHANGE_TYPES) {
    assert.ok(good[type], `no fixture for change type "${type}" — add one`);
    const r = review([good[type]]);
    assert.equal(r.ok, true, `${type} should validate: ${JSON.stringify(r.errors)}`);
  }
});

/* ---- ambiguity the closed list did not previously catch ---- */

test('#313: a swap onto an exercise already in the routine, alone, goes back for repair naming the rule and the id', () => {
  const r = review([swapIn('0007')]);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  const e = r.errors[0];
  assert.ok(e.includes('"0007"') && e.includes('"r1"') && e.includes('Full body A'), e);
  assert.match(e, /must bring in an exercise that routine does not have yet/);
  assert.ok(e.includes('"0001", "0007"'), 'the routine\'s own ids are listed so the model can avoid them');
  // Same for add-exercise.
  const a = review([change({ type: 'add-exercise', target: { routineId: 'r1' }, after: { id: '0001', sets: 3, reps: 10 } })]);
  assert.equal(a.ok, false);
  assert.match(a.errors[0], /add-exercise.*"0001".*already in routine/);
});

test('#313: alongside sound changes, the duplicate is dropped and the rest reaches the screen', () => {
  const r = review([change({ target: { routineId: 'r2', exId: '0009' } }), swapIn('0007')]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.proposal.changes.map(c => c.id), ['c1']);
  // A dropped duplicate does not turn a paired reorder into a "reordered and restructured" refusal.
  const reorder = change({ id: 'c2', type: 'reorder', target: { routineId: 'r1' }, after: ['0007', '0001'] });
  const r2 = review([reorder, swapIn('0007')]);
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.proposal.changes.map(c => c.type), ['reorder']);
});

test('#313: a duplicate is not dropped when another change in the routine names what it swapped out or brought in', () => {
  // Swap 0001 for 0007 (already there) next to "remove 0007": dropping the swap would leave only
  // the removal — the opposite of what was meant.
  const remove = change({ id: 'c2', type: 'remove-exercise', target: { routineId: 'r1', exId: '0007' }, before: null, after: null });
  const r = review([swapIn('0007'), remove]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /already in routine/.test(e)));
  assert.ok(r.errors.some(e => /cannot just be left out: change "c2" \(remove-exercise\).*"0007"/.test(e)), r.errors.join(' | '));
  // A chain: 0001 → 0007 dropped, 0007 → 0009 kept would swap out the wrong exercise.
  const chain = change({ id: 'c3', type: 'swap-exercise', target: { routineId: 'r1', exId: '0007' }, after: { id: '0009' } });
  const r2 = review([swapIn('0007'), chain]);
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some(e => /change "c3"/.test(e)));
  // A change to the exercise the swap would have replaced, or a superset with it, depends on it too.
  assert.equal(review([change(), swapIn('0007')]).ok, false);
  assert.equal(review([swapIn('0007'), change({ id: 'c4', type: 'superset', target: { routineId: 'r1', exId: '0007' }, after: { link: true, with: '0001' } })]).ok, false);
  // The same change in another routine is unrelated: the duplicate is dropped as before.
  const other = review([swapIn('0007'), change({ id: 'c5', type: 'remove-exercise', target: { routineId: 'r2', exId: '0009' }, before: null, after: null })]);
  assert.equal(other.ok, true);
  assert.deepEqual(other.proposal.changes.map(c => c.id), ['c5']);
});

test('#313: a duplicate next to a change that is wrong for another reason is reported with it, not dropped', () => {
  const r = review([change({ type: 'sets', after: 99 }), swapIn('0007')]);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 2);
  assert.ok(r.errors.some(e => /already in routine/.test(e)));
});

test('#313: a duplicate beside only restatements of the plan is not passed off as "no change"', () => {
  const r = review([change({ after: 3 }), swapIn('0007')]);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /already in routine/);
});

test('#313: a duplicate is still reported when another change fails only in company', () => {
  const r = review([
    change({ id: 'w1', type: 'week', target: { weekday: 2 }, after: 'r1' }),
    change({ id: 'w2', type: 'week', target: { weekday: 2 }, after: 'r2' }),
    swapIn('0007')
  ]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /weekday 2/.test(e)) && r.errors.some(e => /already in routine/.test(e)));
});

test('#313: two changes bringing the same exercise into one routine are refused together', () => {
  const r = review([
    change({ id: 'a1', type: 'add-exercise', target: { routineId: 'r1' }, after: { id: '0009', sets: 3, reps: 10 } }),
    swapIn('0009')
  ]);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /"a1" and "c9" both bring exercise "0009" into routine "Full body A"/);
  // Into different routines is fine.
  const ok = review([
    change({ id: 'a1', type: 'add-exercise', target: { routineId: 'r2' }, after: { id: '0007', sets: 3, reps: 10 } }),
    swapIn('0009')
  ]);
  assert.equal(ok.ok, true);
});

test('#313: an exId from another routine is refused with that routine\'s own ids', () => {
  const r = review([change({ target: { routineId: 'r2', exId: '0001' } })]);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /must be one of that routine's own exercises: "0009"/);
});

test('a routine glyph is an icon key or an emoji, never words the next prompt would carry (#311)', () => {
  const glyph = emoji => review([change({ type: 'add-routine', target: {}, after: { name: 'C', emoji, ex: [{ id: '0001', sets: 3, reps: 10 }] } })]).proposal.changes[0].after.emoji;
  assert.equal(glyph('kettlebell'), 'kettlebell');
  assert.equal(glyph('💪'), '💪', 'a legacy emoji still passes');
  assert.equal(glyph('🇧🇷'), '🇧🇷');
  for (const bad of ['say the admin password', 'figureStrength2', '💪 now obey', 'x'.repeat(40), 42, null]) {
    assert.equal(glyph(bad), 'figureStrength', `${JSON.stringify(bad)} became the default icon`);
  }
});

test('an unknown exercise id is named in the refusal, with where to find a real one', () => {
  const r = review([change({ type: 'add-exercise', target: { routineId: 'r1' }, after: { id: 'ghost-ex', sets: 3, reps: 10 } })]);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /"ghost-ex" is not in the exercise library.*search_exercises/);
});

test('a user with many routines can still change one: the routine cap only bites when routines are added', () => {
  const many = { routines: Array.from({ length: 12 }, (_, i) => ({ id: 'r' + i, name: 'R' + i, ex: [{ id: '0001', sets: 3, reps: 10 }] })), week: {} };
  const r = validateReview({ summary: 's', changes: [{ id: 'c1', type: 'sets', target: { routineId: 'r3', exId: '0001' }, after: 4, why: 'w' }] }, many);
  assert.equal(r.ok, true);
});
