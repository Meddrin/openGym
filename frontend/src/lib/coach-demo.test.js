// The assistant in the demo build: canned words, real proposals. What is faked is the model;
// what it proposes is built from the demo profile and checked by the server's own validator, so
// the whole apply/undo path above it is the real one.
import { describe, it, expect, beforeEach } from 'vitest'
import { CONSENT_VERSION } from './coach.js'
import { todayISO } from './format.js'

const demo = await import('./coach-demo.js')
const { applyProposal, undoProposal, checkProposal } = await import('./coach-changes.js')

const state = () => ({
  unit: 'kg', lang: 'en', customEx: [], workouts: [], dayPlan: {}, exWeights: {},
  bodyweight: [{ d: '2026-01-05', w: 81.2, t: 1 }],
  routines: [{ id: 'r1', name: 'Full body A', ex: [{ id: '0001', sets: 3, reps: 10, mode: 'reps' }, { id: '0007', sets: 3, sec: 45, mode: 'time' }] }],
  week: { 1: ['r1'] },
  coach: { consent: { agreedAt: 'x', version: CONSENT_VERSION }, log: [], snapshots: [] }
})

const waitFor = async (fn, ms = 6000) => {
  const until = Date.now() + ms
  while (Date.now() < until) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 20)) }
  throw new Error('timed out')
}
const idle = () => !demo.demoStatus().job

beforeEach(() => demo._resetDemo())

describe('the demo assistant', () => {
  it('answers a message after a pause, with the job visible while it thinks', async () => {
    const S = state()
    const r = demo.demoSend(() => S, 'hello there')
    expect(r.message).toMatchObject({ role: 'user', text: 'hello there' })
    expect(demo.demoStatus().job).toMatchObject({ state: 'running' })
    expect(demo.demoStatus().assistant).toEqual({ supported: true, provider: 'demo' })
    expect(() => demo.demoSend(() => S, 'again')).toThrow(/already thinking/)
    await waitFor(idle)
    const chat = demo.demoChat().chat
    expect(chat.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(chat[1].text).toMatch(/demo/)
    expect(chat[1].proposal).toBeUndefined()
    expect(demo.demoStatus().chatRev).toBe(demo.demoChat().chatRev)
  }, 15000)

  it('refuses an empty message', () => {
    expect(() => demo.demoSend(() => state(), '   ')).toThrow(/Write a message/)
    expect(demo.demoStatus().job).toBe(null)
  })

  it('proposes a weigh-in for "log my weight", a real one the ordinary engine applies and undoes', async () => {
    const S = state()
    demo.demoSend(() => S, 'please log my weight')
    await waitFor(idle)
    const p = demo.demoChat().chat[1].proposal
    expect(p.status).toBe('pending')
    expect(p.changes[0]).toMatchObject({ type: 'bodyweight-set', target: { date: todayISO() }, after: 81.2 })
    expect(checkProposal(S, p).ok).toBe(true)
    applyProposal(S, p)
    expect(S.bodyweight.at(-1)).toMatchObject({ d: todayISO(), w: 81.2 })
    expect(undoProposal(S, p.id)).toBe(true)
    expect(S.bodyweight).toHaveLength(1)
  }, 15000)

  it('proposes one more set for a message about the plan', async () => {
    const S = state()
    demo.demoSend(() => S, 'what should I change in my plan?')
    await waitFor(idle)
    const p = demo.demoChat().chat[1].proposal
    expect(p.changes[0]).toMatchObject({ type: 'sets', target: { routineId: 'r1', exId: '0001' }, before: 3, after: 4 })
    applyProposal(S, p)
    expect(S.routines[0].ex[0].sets).toBe(4)
  }, 15000)

  it('records decisions forward only, the way the server does', async () => {
    const S = state()
    demo.demoSend(() => S, 'log my weight')
    await waitFor(idle)
    const id = demo.demoChat().chat[1].proposal.id
    expect(demo.demoResolve('nope', 'applied')).toEqual({ ok: false, code: 'unknown' })
    expect(demo.demoResolve(id, 'undone').code).toBe('state')
    expect(demo.demoResolve(id, 'applied')).toEqual({ ok: true, status: 'applied' })
    expect(demo.demoChat().chat[1].proposal.status).toBe('applied')
    expect(demo.demoResolve(id, 'dismissed').code).toBe('state')
  }, 15000)

  it('a builder that throws still ends the job, in an error line, and the next message is not refused', async () => {
    demo.demoSend(() => { throw new Error('profile data is odd') }, 'hello')
    await waitFor(idle)
    expect(demo.demoChat().chat.at(-1)).toMatchObject({ role: 'assistant', kind: 'error', errorClass: 'nostate' })
    expect(() => demo.demoSend(() => state(), 'again')).not.toThrow()
    demo.demoForget()
  }, 15000)

  it('says what it can reach in the same words as the server', () => {
    const d = demo.demoDisclosure()
    expect(d.categories).toEqual(['plan', 'training', 'bodyweight', 'profile', 'prefs', 'chat'])
    expect(d.flow).toBe('tools')
    expect(demo.demoCohort(state())).toMatchObject({ ok: true, enabled: true, people: 5 })
  })
})
