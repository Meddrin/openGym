import { describe, it, expect } from 'vitest'
import {
  applyPlanChange, coachAvailable, hasConsent, changeValues, changeTitle, describeChange, isPlanChange,
  CHANGE_TYPES, CATEGORY_TEXT, CONSENT_VERSION, ROUTINE_NAME_SEEN, LOG_MAX, SNAPSHOT_MAX,
  appendLog, logEntry, canUndo, pushRawSnapshot, popSnapshot, snapshotsOf, trim
} from './coach.js'

// The two runtimes share no build step, so what the client assumes of the server is checked
// against the server's actual source rather than against a transcribed expectation.
import * as serverPayload from '../../../api/coach/core/payload.js'
import { DATA_CATEGORIES } from '../../../api/coach/core/categories.js'

const state = (over = {}) => ({
  unit: 'kg', lang: 'en', customEx: [], workouts: [], bodyweight: [], exWeights: {}, dayPlan: {},
  routines: [{
    id: 'r1', name: 'Full body A', emoji: '💪', prog: 'linear',
    ex: [
      { id: '0001', sets: 3, reps: 10, mode: 'reps', weight: 20, prog: 'linear' },
      { id: '0007', sets: 3, sec: 45, mode: 'time' },
      { id: '0009', sets: 3, reps: 12, mode: 'reps' }
    ]
  }, { id: 'r2', name: 'Full body B', ex: [{ id: '0002', sets: 4, reps: 6, mode: 'reps' }] }],
  week: { 1: 'r1', 3: 'r2', 5: 'r1' },
  coach: { consent: { agreedAt: '2026-07-01T00:00:00Z', version: CONSENT_VERSION }, log: [], snapshots: [] },
  ...over
})

const change = over => ({ id: 'c1', type: 'sets', target: { routineId: 'r1', exId: '0001' }, before: 3, after: 4, why: 'stalled twice', ...over })
/** Apply one plan change to a throwaway draft, the way the store hands one over. */
const apply = (S, c) => { const s = JSON.parse(JSON.stringify(S)); applyPlanChange(s, c); return s }

describe('gating', () => {
  it('shows nothing unless the instance offers it and someone is signed in', () => {
    expect(coachAvailable(null, { id: 'u' })).toBe(false)
    expect(coachAvailable({}, { id: 'u' })).toBe(false)
    expect(coachAvailable({ coach: null }, { id: 'u' })).toBe(false)
    expect(coachAvailable({ coach: { enabled: true } }, null)).toBe(false)
    expect(coachAvailable({ coach: { enabled: true } }, { id: 'u' })).toBe(true)
  })

  it('is off in the mobile build until a mode is chosen in Settings', () => {
    expect(coachAvailable(null, null, { mobile: true, coachMode: 'off' })).toBe(false)
    expect(coachAvailable(null, null, { mobile: true })).toBe(false)
    expect(coachAvailable(null, null, { mobile: true, coachMode: 'byok' })).toBe(true)
  })

  it('a phone paired to a server takes the web rule — the server must offer the Coach', () => {
    expect(coachAvailable({ coach: { enabled: true } }, { id: 'u' }, { mobile: true, coachMode: 'server' })).toBe(true)
    expect(coachAvailable({ coach: null }, { id: 'u' }, { mobile: true, coachMode: 'server' })).toBe(false)
    expect(coachAvailable({ coach: { enabled: true } }, null, { mobile: true, coachMode: 'server' })).toBe(false)
  })

  it('is on in the demo build, which fakes the model locally', () => {
    expect(coachAvailable(null, null, { demo: true })).toBe(true)
  })

  it('treats an older consent version as no consent — the wording changed when the Coach became an assistant', () => {
    expect(CONSENT_VERSION).toBeGreaterThanOrEqual(3)
    expect(hasConsent(state())).toBe(true)
    const old = state(); old.coach.consent.version = 2
    expect(hasConsent(old)).toBe(false)
    expect(hasConsent({ coach: {} })).toBe(false)
    expect(hasConsent(null)).toBe(false)
  })

  it('the consent screen has words for every category the server can return, and for nothing else', () => {
    expect(Object.keys(CATEGORY_TEXT).sort()).toEqual([...DATA_CATEGORIES].sort())
    for (const k of DATA_CATEGORIES) {
      const [title, detail] = CATEGORY_TEXT[k]()
      expect(title && detail, k).toBeTruthy()
    }
  })
})

describe('the plan appliers', () => {
  it('have an implementation for every plan type the server can send, and none it cannot', async () => {
    const { CHANGE_TYPES: serverTypes } = await import('../../../api/coach/core/validate.js')
    expect([...CHANGE_TYPES].sort()).toEqual([...serverTypes].sort())
    expect(CHANGE_TYPES).toHaveLength(18)
  })

  it('refuse a type nobody implemented', () => {
    expect(() => apply(state(), change({ type: 'drop-everything' }))).toThrow(/unknown change type/)
  })

  it('sets, reps, rep floor, rep ceiling, hold time, load step and policies', () => {
    const S = state()
    expect(apply(S, change({ type: 'sets', after: 4 })).routines[0].ex[0].sets).toBe(4)
    expect(apply(S, change({ type: 'reps', after: 12 })).routines[0].ex[0].reps).toBe(12)
    expect(apply(S, change({ type: 'repsMin', after: 8 })).routines[0].ex[0].repsMin).toBe(8)
    expect(apply(S, change({ type: 'repsMax', before: null, after: 20 })).routines[0].ex[0].repsMax).toBe(20)
    expect(apply(S, change({ type: 'sec', target: { routineId: 'r1', exId: '0007' }, before: 45, after: 60 })).routines[0].ex[1].sec).toBe(60)
    expect(apply(S, change({ type: 'inc', before: null, after: 5 })).routines[0].ex[0].inc).toBe(5)
    expect(apply(S, change({ type: 'exercise-prog', before: 'linear', after: 'double' })).routines[0].ex[0].prog).toBe('double')
    expect(apply(S, change({ type: 'routine-prog', target: { routineId: 'r1' }, before: 'linear', after: 'greyskull' })).routines[0].prog).toBe('greyskull')
    expect(apply(S, change({ type: 'cardio', after: { min: 25, speed: 9 } })).routines[0].ex[0]).toMatchObject({ min: 25, speed: 9 })
  })

  it('a target that is gone throws, so the store discards the whole set', () => {
    expect(() => apply(state(), change({ target: { routineId: 'nope', exId: '0001' } }))).toThrow('missing target')
    expect(() => apply(state(), change({ target: { routineId: 'r1', exId: '9999' } }))).toThrow('missing target')
  })

  it('adds an exercise at the position asked for', () => {
    const out = apply(state(), change({ type: 'add-exercise', target: { routineId: 'r1' }, before: null, after: { id: '0002', sets: 3, reps: 8, mode: 'reps', position: 1 } }))
    expect(out.routines[0].ex.map(e => e.id)).toEqual(['0001', '0002', '0007', '0009'])
    expect(out.routines[0].ex[1].sets).toBe(3)
  })

  it('carries a rep ceiling and the two flags onto an added exercise, and only when set', () => {
    const withFlags = apply(state(), change({
      type: 'add-exercise', target: { routineId: 'r1' }, before: null,
      after: { id: '0002', sets: 3, reps: 16, mode: 'reps', repsMin: 10, repsMax: 24, bodyweight: true, side: true }
    })).routines[0].ex.at(-1)
    expect(withFlags).toMatchObject({ repsMin: 10, repsMax: 24, bodyweight: true, side: true })
    const plain = apply(state(), change({ type: 'add-exercise', target: { routineId: 'r1' }, before: null, after: { id: '0002', sets: 3, reps: 8, mode: 'reps' } })).routines[0].ex.at(-1)
    // Absent means "whatever the catalogue says". Writing a flag out would freeze today's dataset into the plan.
    expect(plain.bodyweight).toBeUndefined()
    expect(plain.side).toBeUndefined()
  })

  it('drops an exercise without touching the rest', () => {
    expect(apply(state(), change({ type: 'remove-exercise' })).routines[0].ex.map(e => e.id)).toEqual(['0007', '0009'])
  })

  it('keeps the prescription when swapping the movement, and drops the flags that described the old one', () => {
    const e = apply(state(), change({ type: 'swap-exercise', after: { id: '0002' } })).routines[0].ex[0]
    expect(e).toMatchObject({ id: '0002', sets: 3, reps: 10 })   // not silently reset — that would be a change nobody approved
    const S = state()
    S.routines[0].ex[0] = { ...S.routines[0].ex[0], side: true, reps: 16, bodyweight: true }
    const swapped = apply(S, change({ type: 'swap-exercise', after: { id: '0002' } })).routines[0].ex[0]
    expect(swapped.side).toBeUndefined()
    expect(swapped.bodyweight).toBeUndefined()
    expect(swapped.reps).toBe(16)
  })

  it('reorders only with a complete permutation', () => {
    const out = apply(state(), change({ type: 'reorder', target: { routineId: 'r1' }, after: ['0009', '0001', '0007'] }))
    expect(out.routines[0].ex.map(e => e.id)).toEqual(['0009', '0001', '0007'])
    expect(() => apply(state(), change({ type: 'reorder', target: { routineId: 'r1' }, after: ['0009'] }))).toThrow()
    expect(() => apply(state(), change({ type: 'reorder', target: { routineId: 'r1' }, after: ['0009', '0009', '0001'] }))).toThrow()
  })

  it('supersets by moving the partner adjacent and tagging both; refuses a superset with itself; unlinks', () => {
    expect(() => apply(state(), change({ type: 'superset', after: { link: true, with: '0001' } }))).toThrow('superset with itself')
    const ex = apply(state(), change({ type: 'superset', after: { link: true, with: '0009' } })).routines[0].ex
    expect(ex[0].id).toBe('0001'); expect(ex[1].id).toBe('0009')
    expect(ex[0].sg).toBeTruthy(); expect(ex[0].sg).toBe(ex[1].sg)
    const S = state()
    S.routines[0].ex[0].sg = 'a'; S.routines[0].ex[1].sg = 'a'
    const out = apply(S, change({ type: 'superset', after: { link: false } }))
    expect(out.routines[0].ex[0].sg).toBeUndefined()
    expect(out.routines[0].ex[1].sg).toBeUndefined()
  })

  it('adds, renames and removes routines, clearing any day that pointed at one', () => {
    const added = apply(state(), change({ type: 'add-routine', target: {}, before: null, after: { name: 'Full body C', ex: [{ id: '0001', sets: 3, reps: 10, mode: 'reps' }] } }))
    expect(added.routines).toHaveLength(3)
    expect(added.routines[2].id).not.toBe('r1')
    expect(apply(state(), change({ type: 'rename-routine', target: { routineId: 'r1' }, before: 'Full body A', after: 'Upper' })).routines[0].name).toBe('Upper')
    const removed = apply(state(), change({ type: 'remove-routine', target: { routineId: 'r2' } }))
    expect(removed.routines.map(r => r.id)).toEqual(['r1'])
    expect(removed.week[3]).toBeUndefined()      // Wednesday pointed at r2
  })

  it('moves a day, clears one, and collapses a combined day to the single routine named', () => {
    expect(apply(state(), change({ type: 'week', target: { weekday: 6 }, before: null, after: 'r1' })).week[6]).toEqual(['r1'])
    expect(apply(state(), change({ type: 'week', target: { weekday: 1 }, before: 'r1', after: 'rest' })).week[1]).toBeUndefined()
    const S = state(); S.week = { ...S.week, 3: ['r2', 'r1'] }
    expect(apply(S, change({ type: 'week', target: { weekday: 3 }, before: ['r2', 'r1'], after: 'r1' })).week[3]).toEqual(['r1'])
  })

  it('never touches history, weigh-ins or settings', () => {
    const S = state({ workouts: [{ id: 'w1', d: '2026-07-20', entries: [] }], bodyweight: [{ d: '2026-07-20', w: 80 }], exWeights: { '0001': { w: 20 } }, restSec: 90 })
    const out = apply(S, change({ type: 'sets', after: 4 }))
    expect(out.workouts).toEqual(S.workouts)
    expect(out.bodyweight).toEqual(S.bodyweight)
    expect(out.exWeights).toEqual(S.exWeights)
    expect(out.restSec).toBe(90)
  })
})

describe('what a card says', () => {
  it('renders a combined-day before/after as joined routine names, not a count', () => {
    const S = state()
    expect(changeValues({ type: 'week', target: { weekday: 3 }, before: ['r1', 'r2'], after: 'r1' }, S)).toEqual({ before: 'Full body A + Full body B', after: 'Full body A' })
    expect(changeValues({ type: 'week', target: { weekday: 3 }, before: ['r1', 'r2'], after: 'rest' }, S).after).toBe('Rest')
    expect(changeValues({ type: 'week', target: { weekday: 3 }, before: null, after: 'r2' }, S).before).toBe('Rest')
  })

  it('a plan change reads its values off the live plan; every other kind carries its own lines', () => {
    const S = state()
    const plan = describeChange(change({ before: 3, after: 4 }), S)
    expect(plan.title).toMatch(/sets/i)
    expect(plan.rows).toEqual([{ label: null, before: '3', after: '4' }])
    const bw = describeChange({ type: 'bodyweight-set', target: { date: '2026-10-20' }, before: null, after: 79.4, lines: [{ k: '2026-10-20', before: null, after: '79.4' }] }, S)
    expect(bw.title).toMatch(/Body weight on/)
    expect(bw.rows).toEqual([{ label: '2026-10-20', before: null, after: '79.4' }])
    expect(isPlanChange(change())).toBe(true)
    expect(isPlanChange({ type: 'workout-edit' })).toBe(false)
  })

  it('has a title for every kind the server can send', async () => {
    const { CHANGE_KINDS } = await import('../../../api/coach/core/changes.js')
    const S = state()
    for (const type of CHANGE_KINDS) {
      const d = describeChange({ type, id: 'x', target: { routineId: 'r1', exId: '0001', weekday: 1, date: '2026-10-20', workoutId: 'w', key: 'restSec' }, after: { id: '0002', name: 'x', n: 'y', ex: [], d: '2026-10-20' }, before: null, lines: [], workoutDate: '2026-10-20' }, S)
      expect(d.title, type).toBeTruthy()
      expect(d.title, type).not.toBe(type)
    }
    expect(changeTitle({ type: 'nope' }, S)).toBe('nope')
  })

  it('the routine name the server cut is the length the client compares', () => {
    expect(ROUTINE_NAME_SEEN).toBe(serverPayload.NAME_MAX)
  })
})

describe('snapshots and the log', () => {
  it('keeps a bounded number of snapshots, and says which proposal an Undo would put back', () => {
    const s = state()
    for (let i = 0; i < SNAPSHOT_MAX + 2; i++) pushRawSnapshot(s, { proposalId: 'p' + i, keys: {}, lists: {}, v: 2 })
    expect(snapshotsOf(s)).toHaveLength(SNAPSHOT_MAX)
    expect(canUndo(s, 'p' + (SNAPSHOT_MAX + 1))).toBe(true)
    expect(canUndo(s, 'p0')).toBe(false)
    expect(popSnapshot(s).proposalId).toBe('p' + (SNAPSHOT_MAX + 1))
    expect(canUndo(s, 'p' + (SNAPSHOT_MAX + 1))).toBe(false)
    expect(popSnapshot({ coach: {} })).toBe(null)
    expect(canUndo(null, 'x')).toBe(false)
  })

  it('the log is bounded and stays well inside the sync budget even when full', () => {
    const s = state()
    for (let i = 0; i < LOG_MAX + 10; i++) appendLog(s, { kind: 'assistant', at: i, summary: 'x'.repeat(500), changes: Array.from({ length: 25 }, () => ({ type: 'sets', target: { routineId: 'r1', exId: '0001' }, why: 'y'.repeat(600) })) })
    expect(s.coach.log.length).toBeLessThanOrEqual(LOG_MAX)
    expect(JSON.stringify(s.coach).length).toBeLessThan(256 * 1024 + 4000)
  })

  it('finds a log entry by id', () => {
    const s = state()
    const id = appendLog(s, { kind: 'assistant', at: 1, summary: 's' })
    expect(logEntry(s, id).summary).toBe('s')
    expect(logEntry(s, 'nope')).toBe(null)
  })

  it('trim drops the oldest log lines before the newest snapshot, which an Undo needs', () => {
    const s = state()
    pushRawSnapshot(s, { proposalId: 'p1', keys: { routines: [{ big: 'z'.repeat(300 * 1024) }] }, lists: {}, v: 2 })
    s.coach.log = [{ id: 'a' }, { id: 'b' }]
    trim(s)
    expect(s.coach.log.length).toBeLessThan(2)
    expect(snapshotsOf(s)).toHaveLength(1)
  })
})
