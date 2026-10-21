import { describe, it, expect } from 'vitest'
import { checkProposal, applyProposal, undoProposal, takeSnapshot, restoreSnapshot } from './coach-changes.js'
import { canUndo, snapshotsOf, CONSENT_VERSION, SNAPSHOT_MAX } from './coach.js'
import { workoutVolume } from './history.js'
import { validateChangeSet, CHANGE_KINDS } from '../../../api/coach/core/changes.js'
import { todayISO } from './format.js'

const TODAY = todayISO()
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10) }
const why = 'because the numbers say so'

const state = () => ({
  unit: 'kg', lang: 'en', restSec: 90, targetW: 80,
  routines: [
    { id: 'r1', name: 'Full body A', ex: [{ id: '0001', sets: 3, reps: 10, weight: 20 }, { id: '0007', sets: 3, sec: 45, mode: 'time' }] },
    { id: 'r2', name: 'Pull', ex: [{ id: '0009', sets: 3, reps: 8 }] }
  ],
  week: { 1: ['r1'], 3: ['r2'] }, dayPlan: {}, exNotes: { '0001': 'seat 4' }, favEx: ['cx1'],
  exWeights: { '0001': { w: 20, d: daysAgo(3) } },
  customEx: [{ id: 'cx1', n: 'Sandbag carry', bp: 'back', tg: 'lats', eq: 'custom', custom: true }],
  bodyweight: [{ d: daysAgo(3), w: 80, t: 1 }],
  workouts: [
    { id: 'w0', d: daysAgo(10), name: 'Full body A', start: 1_000, end: 1_000 + 40 * 60000, vol: 200, prs: ['0001'], bw: 80, entries: [{ id: '0001', topW: 20, sets: [{ w: 20, r: 10, done: true }] }] },
    {
      id: 'w1', d: daysAgo(3), name: 'Full body A', start: 2_000_000, end: 2_000_000 + 45 * 60000, vol: 600, prs: [], bw: 80, _ts: 5,
      entries: [
        { id: '0001', topW: 20, target: { sets: 3, reps: 10 }, sets: [{ w: 20, r: 10, done: true, rpe: 8 }, { w: 20, r: 9, done: true }, { w: 20, r: 8, done: true }] },
        { id: '0007', note: 'wrists', sets: [{ sec: 45, done: true }] }
      ]
    }
  ],
  active: null,
  coach: { consent: { agreedAt: 'x', version: CONSENT_VERSION }, profile: { goal: 'muscle', daysPerWeek: 3 }, log: [], snapshots: [] }
})

/** A proposal exactly as the server would hand one over. */
function propose(S, changes, id = 'p1') {
  const v = validateChangeSet(S, { summary: 'a set', changes: changes.map(c => ({ why, ...c })) }, { today: TODAY })
  expect(v.ok, JSON.stringify(v.errors)).toBe(true)
  return { id, summary: v.summary, status: 'pending', createdAt: 1, changes: v.changes }
}
const clone = o => JSON.parse(JSON.stringify(o))

/** The state apart from what an apply writes about itself: the log, the snapshots and the stamps. */
function bare(S) {
  const o = clone(S)
  if (o.coach) { delete o.coach.log; delete o.coach.snapshots }
  for (const w of o.workouts || []) delete w._ts
  for (const b of o.bodyweight || []) delete b.t
  return o
}

const KINDS = {
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
  dayplan: { type: 'dayplan', target: { date: daysAgo(-2) }, after: 'rest' },
  'workout-add': { type: 'workout-add', target: {}, after: { d: daysAgo(5), name: 'Pull', entries: [{ id: '0009', sets: [{ r: 8, w: 40 }, { r: 8, w: 40, rpe: 9 }] }] } },
  'workout-edit': { type: 'workout-edit', target: { workoutId: 'w1' }, after: { name: 'Push day', note: 'strong', entries: [{ index: 0, sets: [{ index: 0, r: 11 }, { index: 1 }, { index: 2 }] }] } },
  'workout-delete': { type: 'workout-delete', target: { workoutId: 'w1' } },
  'bodyweight-set': { type: 'bodyweight-set', target: { date: TODAY }, after: 79.4 },
  'bodyweight-delete': { type: 'bodyweight-delete', target: { date: daysAgo(3) } },
  'exnote-set': { type: 'exnote-set', target: { exId: '0007' }, after: 'pin 7' },
  'custom-ex-add': { type: 'custom-ex-add', target: {}, after: { n: 'Zercher carry', bp: 'back', tg: 'lats' } },
  'custom-ex-edit': { type: 'custom-ex-edit', target: { exId: 'cx1' }, after: { n: 'Sandbag walk' } },
  'custom-ex-delete': { type: 'custom-ex-delete', target: { exId: 'cx1' } },
  setting: { type: 'setting', target: { key: 'restSec' }, after: 120 },
  'profile-set': { type: 'profile-set', target: {}, after: { limitations: 'left shoulder clicks overhead', daysPerWeek: 4 } }
}

describe('applying a proposal, and undoing it', () => {
  it('has a fixture for every kind the server can send', () => {
    for (const k of CHANGE_KINDS) expect(KINDS[k], k).toBeTruthy()
  })

  it.each(CHANGE_KINDS)('%s: applies, changes something, and Undo puts every touched key back exactly', kind => {
    const S = state()
    const p = propose(S, [KINDS[kind]])
    const s = clone(S)
    const before = bare(S)
    const res = applyProposal(s, p, 1_800_000_000_000)
    expect(res.applied).toBe(1)
    expect(bare(s), kind + ' changed nothing').not.toEqual(before)
    expect(canUndo(s, p.id)).toBe(true)
    expect(s.coach.log.at(-1)).toMatchObject({ kind: 'assistant', proposalId: p.id })

    expect(undoProposal(s, p.id, 1_800_000_001_000)).toBe(true)
    expect(bare(s)).toEqual(before)
    expect(canUndo(s, p.id)).toBe(false)
    expect(s.coach.log.at(-1).kind).toBe('revert')
  })

  it('a mixed set across the plan, workouts, weight, notes, exercises, settings and profile applies whole and undoes whole', () => {
    const S = state()
    const p = propose(S, [KINDS.sets, KINDS['workout-add'], KINDS['bodyweight-set'], KINDS['exnote-set'], KINDS['custom-ex-add'], KINDS.setting, KINDS['profile-set'], KINDS.dayplan, KINDS.week])
    const s = clone(S)
    applyProposal(s, p)
    expect(s.routines[0].ex[0].sets).toBe(4)
    expect(s.workouts).toHaveLength(3)
    expect(s.bodyweight.at(-1)).toMatchObject({ d: TODAY, w: 79.4 })
    expect(s.exNotes['0007']).toBe('pin 7')
    expect(s.customEx.map(c => c.n)).toContain('Zercher carry')
    expect(s.restSec).toBe(120)
    expect(s.coach.profile).toMatchObject({ goal: 'muscle', daysPerWeek: 4, limitations: 'left shoulder clicks overhead' })
    expect(s.dayPlan[daysAgo(-2)]).toBe('rest')
    expect(s.week[5]).toEqual(['r2'])
    undoProposal(s, p.id)
    expect(bare(s)).toEqual(bare(S))
  })

  it('the snapshot of a big list holds only the records the change touched, never the whole history', () => {
    const S = state()
    S.workouts = Array.from({ length: 400 }, (_, i) => ({ id: 'x' + i, d: daysAgo(500 - i), name: 'n', start: i, end: i + 60000, entries: [{ id: '0009', sets: [{ w: 40, r: 8, done: true }] }] })).concat(S.workouts)
    S.bodyweight = Array.from({ length: 400 }, (_, i) => ({ d: daysAgo(900 - i), w: 80, t: 1 })).concat(S.bodyweight)
    const p = propose(S, [KINDS['workout-edit'], KINDS['bodyweight-set']])
    const snap = takeSnapshot(S, p.id, 'x', p.changes)
    expect(Object.keys(snap.lists.workouts)).toEqual(['w1'])
    expect(Object.keys(snap.lists.bodyweight)).toEqual([TODAY])
    expect(snap.lists.bodyweight[TODAY]).toBe(null)    // a day that had no entry: Undo removes it
    expect(JSON.stringify(snap).length).toBeLessThan(40_000)
    expect(snap.keys.workouts).toBeUndefined()
    expect(snap.keys.bodyweight).toBeUndefined()
  })

  it('only the newest apply can be undone, and an older proposal\'s Undo does nothing', () => {
    const S = state()
    const s = clone(S)
    const p1 = propose(s, [KINDS.sets], 'p1')
    applyProposal(s, p1)
    const p2 = propose(s, [{ ...KINDS.setting }], 'p2')
    applyProposal(s, p2)
    expect(canUndo(s, 'p1')).toBe(false)
    expect(canUndo(s, 'p2')).toBe(true)
    const before = clone(s)
    expect(undoProposal(s, 'p1')).toBe(false)
    expect(s).toEqual(before)
    expect(undoProposal(s, 'p2')).toBe(true)
    expect(s.restSec).toBe(90)
    expect(s.routines[0].ex[0].sets).toBe(4)      // the first apply stands until it is undone itself
    expect(canUndo(s, 'p1')).toBe(true)
    expect(undoProposal(s, 'p1')).toBe(true)
    expect(bare(s)).toEqual(bare(S))
  })

  it('keeps a bounded number of snapshots: the oldest undo is the one that goes', () => {
    const s = clone(state())
    for (let i = 0; i < SNAPSHOT_MAX + 2; i++) applyProposal(s, propose(s, [{ type: 'setting', target: { key: 'restSec' }, after: 100 + i }], 'p' + i))
    expect(snapshotsOf(s)).toHaveLength(SNAPSHOT_MAX)
    expect(canUndo(s, 'p' + (SNAPSHOT_MAX + 1))).toBe(true)
  })

  it('a snapshot from before the assistant (the plan and nothing else) still restores', () => {
    const s = clone(state())
    const old = { at: 1, proposalId: 'old', label: '', routines: [{ id: 'z', name: 'Old', ex: [] }], week: { 2: ['z'] }, dayPlanRestore: { '2099-01-01': 'z' } }
    s.coach.snapshots = [old]
    expect(undoProposal(s, 'old')).toBe(true)
    expect(s.routines.map(r => r.id)).toEqual(['z'])
    expect(s.week).toEqual({ 2: ['z'] })
    expect(s.dayPlan['2099-01-01']).toBe('z')
  })
})

describe('what an apply does beyond the data', () => {
  it('a workout that is added is a finished workout: volume, record badge, stamp, the weight it was logged at', () => {
    const S = state()
    const p = propose(S, [KINDS['workout-add']])
    const s = clone(S)
    applyProposal(s, p, 1_800_000_000_000)
    const w = s.workouts.find(x => x.id === p.changes[0].after.id)
    expect(w).toBeTruthy()
    expect(w.vol).toBe(Math.round(workoutVolume(w)))
    expect(w.vol).toBe(40 * 8 * 2)
    expect(w._ts).toBe(1_800_000_000_000)
    expect(w.bw).toBe(80)
    expect(w.prs).toEqual(['0009'], 'the first time this lift is logged, it leads everything before it')
    expect(w.end - w.start).toBe(60 * 60000)
  })

  it('an edited workout is stamped, its volume worked out again, and its details kept', () => {
    const S = state()
    const s = clone(S)
    applyProposal(s, propose(S, [KINDS['workout-edit']]), 1_800_000_000_000)
    const w = s.workouts.find(x => x.id === 'w1')
    expect(w._ts).toBe(1_800_000_000_000)
    expect(w.name).toBe('Push day')
    expect(w.note).toBe('strong')
    expect(w.vol).toBe(20 * 11 + 20 * 9 + 20 * 8)
    expect(w.entries[0].target).toEqual({ sets: 3, reps: 10 })
    expect(w.entries).toHaveLength(1)
    expect(w.entries[0].sets[0].rpe).toBe(8)
  })

  it('deleting a workout takes its kept working weight with it when it was the source, and Undo brings both back', () => {
    const S = state()
    S.workouts = S.workouts.filter(w => w.id === 'w1')          // w1 is the only session of 0001 now
    const s = clone(S)
    applyProposal(s, propose(S, [KINDS['workout-delete']]))
    expect(s.workouts).toHaveLength(0)
    expect(s.exWeights['0001']).toBeUndefined()
    undoProposal(s, 'p1')
    expect(s.workouts.map(w => w.id)).toEqual(['w1'])
    expect(s.exWeights['0001']).toEqual({ w: 20, d: daysAgo(3) })
  })

  it('back-dating a heavier session revokes a later badge, and Undo gives it back', () => {
    const S = state()
    S.workouts[0].prs = []                                       // w0 (10 days ago) holds no badge
    S.workouts[1].prs = ['0001']                                 // w1 (3 days ago) holds the 0001 record
    const p = propose(S, [{ type: 'workout-add', target: {}, after: { d: daysAgo(6), name: 'Heavy', entries: [{ id: '0001', sets: [{ r: 5, w: 60 }] }] } }])
    const s = clone(S)
    applyProposal(s, p)
    expect(s.workouts.find(w => w.id === 'w1').prs).toEqual([])
    undoProposal(s, p.id)
    expect(s.workouts.find(w => w.id === 'w1').prs).toEqual(['0001'])
  })

  it('a weigh-in and a restored record carry a time newer than what they replaced, so another device keeps the change', () => {
    const S = state()
    const s = clone(S)
    applyProposal(s, propose(S, [{ type: 'bodyweight-set', target: { date: daysAgo(3) }, after: 79 }]), 1_800_000_000_000)
    expect(s.bodyweight.find(b => b.d === daysAgo(3))).toMatchObject({ w: 79, t: 1_800_000_000_000 })
    undoProposal(s, 'p1', 1_800_000_005_000)
    expect(s.bodyweight.find(b => b.d === daysAgo(3))).toMatchObject({ w: 80, t: 1_800_000_005_000 })
  })

  it('an own exercise that is deleted keeps its name on the sets already logged, and Undo restores the exercise and the routines', () => {
    const S = state()
    S.routines[0].ex.push({ id: 'cx1', sets: 3, reps: 10 })
    S.workouts[1].entries.push({ id: 'cx1', sets: [{ w: 10, r: 5, done: true }] })
    const s = clone(S)
    applyProposal(s, propose(S, [KINDS['custom-ex-delete']]))
    expect(s.customEx).toEqual([])
    expect(s.routines[0].ex.some(e => e.id === 'cx1')).toBe(false)
    expect(s.workouts[1].entries.at(-1).n).toBe('Sandbag carry')
    expect(s.favEx).toEqual([])
    undoProposal(s, 'p1')
    expect(s.customEx.map(c => c.id)).toEqual(['cx1'])
    expect(s.routines[0].ex.some(e => e.id === 'cx1')).toBe(true)
    expect(s.workouts[1].entries.at(-1).n).toBeUndefined()
    expect(s.favEx).toEqual(['cx1'])
  })

  it('removing a routine takes its per-date reschedules and a combined day\'s entry with it, and Undo puts them back whole', () => {
    const S = state()
    S.dayPlan = { '2099-01-01': 'r2', '2099-01-02': 'r1' }
    S.week = { 1: ['r1', 'r2'], 3: ['r2'] }
    const s = clone(S)
    applyProposal(s, propose(S, [KINDS['remove-routine']]))
    expect(s.dayPlan).toEqual({ '2099-01-02': 'r1' })
    expect(s.week[1]).toEqual(['r1'])
    expect(s.week[3]).toBeUndefined()
    undoProposal(s, 'p1')
    expect(s.dayPlan).toEqual(S.dayPlan)
    expect(s.week).toEqual(S.week)
  })
})

describe('checking a proposal before it is applied', () => {
  it('a fresh proposal is still true', () => {
    const S = state()
    const p = propose(S, [KINDS.sets, KINDS['workout-edit'], KINDS['bodyweight-set'], KINDS.setting, KINDS['workout-add']])
    const r = checkProposal(S, p)
    expect(r.ok).toBe(true)
    expect(r.changes).toHaveLength(5)
    // The workout that is added keeps the id it was shown with.
    expect(r.changes.find(c => c.type === 'workout-add').after.id).toBe(p.changes.find(c => c.type === 'workout-add').after.id)
  })

  it('anything the proposal was written against that has moved makes it stale', () => {
    const S = state()
    const stale = (mutate, changes) => { const p = propose(S, changes); const moved = clone(S); mutate(moved); return checkProposal(moved, p) }
    expect(stale(m => { m.routines[0].ex[0].sets = 5 }, [KINDS.sets])).toMatchObject({ ok: false, reason: 'stale' })
    expect(stale(m => { m.restSec = 100 }, [KINDS.setting])).toMatchObject({ ok: false, reason: 'stale' })
    expect(stale(m => { m.workouts[1].note = 'edited on the other phone' }, [KINDS['workout-edit']])).toMatchObject({ ok: false, reason: 'stale' })
    expect(stale(m => { m.workouts[1].entries[0].sets[0].r = 3 }, [KINDS['workout-delete']])).toMatchObject({ ok: false, reason: 'stale' })
    expect(stale(m => { m.bodyweight[0].w = 79.9 }, [KINDS['bodyweight-delete']])).toMatchObject({ ok: false, reason: 'stale' })
    expect(stale(m => { m.exNotes['0007'] = 'pin 7' }, [KINDS['exnote-set']])).toMatchObject({ ok: false, reason: 'stale' })   // already says it
    expect(stale(m => { m.week[5] = ['r2'] }, [KINDS.week])).toMatchObject({ ok: false, reason: 'stale' })
    expect(stale(m => { m.customEx[0].n = 'Renamed' }, [KINDS['custom-ex-edit']])).toMatchObject({ ok: false, reason: 'stale' })
    expect(stale(m => { m.coach.profile.daysPerWeek = 4; m.coach.profile.limitations = 'left shoulder clicks overhead' }, [KINDS['profile-set']])).toMatchObject({ ok: false, reason: 'stale' })
  })

  it('a target that is gone, or an id nobody has, makes it invalid', () => {
    const S = state()
    const p = propose(S, [KINDS['workout-delete'], KINDS.sets])
    const gone = clone(S); gone.workouts = gone.workouts.filter(w => w.id !== 'w1')
    expect(checkProposal(gone, p)).toMatchObject({ ok: false, reason: 'invalid' })
    const tampered = propose(S, [KINDS['bodyweight-set']])
    tampered.changes[0].after = 5          // below any plausible body weight: the check is the server's own
    expect(checkProposal(S, tampered)).toMatchObject({ ok: false, reason: 'invalid' })
    const ghost = propose(S, [KINDS.sets])
    ghost.changes[0].type = 'drop-database'
    expect(checkProposal(S, ghost)).toMatchObject({ ok: false, reason: 'invalid' })
    expect(checkProposal(S, { id: 'x', changes: [] })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(checkProposal(S, null)).toMatchObject({ ok: false, reason: 'invalid' })
    // A compact old proposal has no changes to apply.
    expect(checkProposal(S, { id: 'x', count: 3, kinds: ['sets'] })).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('a change somebody already made by hand reads as stale, not as a quiet success', () => {
    const S = state()
    const p = propose(S, [KINDS.sets])
    const done = clone(S); done.routines[0].ex[0].sets = 4
    expect(checkProposal(done, p).reason).toBe('stale')
  })

  it('applyProposal refuses what the check refuses, and writes nothing', () => {
    const S = state()
    const p = propose(S, [KINDS.sets, KINDS['bodyweight-set']])
    const moved = clone(S); moved.bodyweight[0].w = 1.5; moved.bodyweight[0].d = TODAY
    const s = clone(moved)
    expect(() => applyProposal(s, p)).toThrow('stale')
    expect(s).toEqual(moved)
    try { applyProposal(s, p) } catch (e) { expect(e.reason).toBe('stale') }
  })

  it('restoreSnapshot on a state that lost a key puts it back', () => {
    const S = state()
    const p = propose(S, [KINDS.setting])
    const snap = takeSnapshot(S, p.id, 'x', p.changes)
    const s = clone(S); delete s.restSec
    restoreSnapshot(s, snap)
    expect(s.restSec).toBe(90)
    const absent = clone(S); delete absent.restSec
    const snap2 = takeSnapshot(absent, p.id, 'x', validateChangeSet(absent, { changes: [{ type: 'setting', target: { key: 'restSec' }, after: 100, why }] }, { today: TODAY }).changes)
    const t = clone(absent); t.restSec = 100
    restoreSnapshot(t, snap2)
    expect('restSec' in t).toBe(false)
  })
})
