// @vitest-environment happy-dom
//
// The conversation with the Coach, mounted against the real store: the consent screen as its
// first state, a thread of prose and cards, and the card's three buttons doing real edits (plan,
// workout, body weight) that sync like any other change, with an Undo that puts them back, and an
// Apply that is all or nothing. Only the transport is faked: what the server would answer, and
// the decisions the screen reports back.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  chat: [], job: null, cap: null, assistant: { supported: true, provider: 'claude' },
  sent: [], resolved: [], nav: vi.fn(), bump: null, boom: false, account: null
}))

vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.nav }))
vi.mock('../lib/api.js', () => ({
  api: vi.fn(() => Promise.reject(Object.assign(new Error('offline'), { status: 0 }))),
  IS_APPLE: false, IS_ANDROID: false, BIO: 'biometrics', webauthnOK: () => false
}))
vi.mock('../lib/coach-api.js', async importOriginal => {
  const orig = await importOriginal()
  const React = await import('react')
  return {
    ...orig,
    useCoachChat: () => {
      const [, tick] = React.useState(0)
      mocks.bump = () => tick(n => n + 1)
      return { job: mocks.job, cap: mocks.cap, assistant: mocks.assistant, chat: mocks.chat, last: null, loading: false, maxMessageLen: 1500, refresh: async () => { mocks.bump() } }
    },
    sendMessage: vi.fn(async text => { mocks.sent.push(text); return { job: { id: 'j1' }, message: { id: 'u', role: 'user', text } } }),
    resolveProposal: vi.fn(async (id, status) => { mocks.resolved.push([id, status]); const m = mocks.chat.find(x => x.proposal?.id === id); if (m) m.proposal = { ...m.proposal, status }; return { ok: true, status } }),
    disclosure: vi.fn(async () => ({ provider: 'claude', providerLabel: 'Claude (Anthropic)', categories: ['plan', 'training', 'bodyweight', 'profile', 'prefs', 'chat'], flow: 'tools', version: 2 })),
    cohortStats: vi.fn(async () => ({ ok: false })), setCohortShare: vi.fn(async () => ({ ok: true }))
  }
})
vi.mock('../lib/coach-account.js', () => ({
  useCoachAccount: () => ({ account: mocks.account, refresh: vi.fn() }),
  needsOwnAccount: a => !!a && a.mode === 'profile',
  fetchAccount: vi.fn(async () => mocks.account), connectOwn: vi.fn(), disconnectOwn: vi.fn(), testOwn: vi.fn()
}))
// One failure, on demand, in the middle of an apply: the way to see that a set is all or nothing.
vi.mock('../../../api/coach/core/changes.js', async importOriginal => {
  const m = await importOriginal()
  return { ...m, applyDataChange: (s, c, h) => { if (mocks.boom && c.type === 'setting') throw new Error('disk on fire'); return m.applyDataChange(s, c, h) } }
})

const { useStore } = await import('../store/useStore.js')
const { useUI } = await import('../store/useUI.js')
const { CONSENT_VERSION } = await import('../lib/coach.js')
const { validateChangeSet } = await import('../../../api/coach/core/changes.js')
const { todayISO } = await import('../lib/format.js')
const { sendMessage, resolveProposal } = await import('../lib/coach-api.js')
const CoachChat = (await import('./CoachChat.jsx')).default

const TODAY = todayISO()
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10) }

const baseState = () => ({
  unit: 'kg', lang: 'en', restSec: 90, targetW: 80, effort: 'rir',
  routines: [
    { id: 'r1', name: 'Full body A', ex: [{ id: '0001', sets: 3, reps: 10, weight: 20 }, { id: '0007', sets: 3, sec: 45, mode: 'time' }] },
    { id: 'r2', name: 'Pull', ex: [{ id: '0009', sets: 3, reps: 8 }] }
  ],
  week: { 1: ['r1'], 3: ['r2'] }, dayPlan: {}, exNotes: {}, favEx: [], exWeights: { '0001': { w: 20, d: daysAgo(3) } }, customEx: [],
  bodyweight: [{ d: daysAgo(3), w: 80, t: 1 }],
  workouts: [{
    id: 'w1', d: daysAgo(3), name: 'Full body A', start: 2_000_000, end: 2_000_000 + 45 * 60000, vol: 600, prs: [], bw: 80,
    entries: [{ id: '0001', topW: 20, sets: [{ w: 20, r: 10, done: true, rpe: 8 }, { w: 20, r: 9, done: true }] }]
  }],
  active: null,
  coach: { consent: { agreedAt: '2026-08-01T00:00:00Z', version: CONSENT_VERSION }, profile: { goal: 'muscle' }, log: [], snapshots: [] }
})

let host, root
const why = 'because the numbers say so'
const S = () => useStore.getState().S
function proposal(changes, id = 'p1', over = {}) {
  const v = validateChangeSet(S(), { summary: 'A suggestion', changes: changes.map(c => ({ why, ...c })) }, { today: TODAY })
  expect(v.ok, JSON.stringify(v.errors)).toBe(true)
  return { id, summary: v.summary, status: 'pending', createdAt: Date.now(), changes: v.changes, ...over }
}
const assistant = (text, p, id = 'a' + Math.random()) => ({ id, role: 'assistant', kind: 'text', text, at: Date.now(), ...(p ? { proposal: p } : {}) })

async function mount(over = {}) {
  useStore.setState({ S: { ...baseState(), ...over }, user: { id: 'u1' }, ready: true, config: { coach: { enabled: true, providerLabel: 'Claude (Anthropic)' } }, coachLocal: null })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(React.createElement(CoachChat)) })
}
const rerender = () => act(async () => { mocks.bump && mocks.bump() })
const text = () => host.textContent
const button = re => [...host.querySelectorAll('button')].find(b => re.test(b.textContent || b.getAttribute('aria-label') || ''))
async function click(el) { expect(el, 'button not found').toBeTruthy(); await act(async () => { el.click() }) }
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 400)) })
const typeIn = (el, value) => {
  Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  useStore.setState({ S: baseState(), user: { id: 'u1' }, ready: true, config: { coach: { enabled: true, providerLabel: 'Claude (Anthropic)' } }, coachLocal: null })
  mocks.chat = []; mocks.job = null; mocks.cap = null; mocks.assistant = { supported: true, provider: 'claude' }
  mocks.sent = []; mocks.resolved = []; mocks.boom = false; mocks.account = null
  mocks.nav.mockClear(); vi.mocked(sendMessage).mockClear(); vi.mocked(resolveProposal).mockClear()
  useUI.setState({ sheets: [] })
  document.body.innerHTML = ''
})
afterEach(async () => { if (root) { await act(async () => { root.unmount() }); root = null } })

describe('the consent screen is the first state', () => {
  it('is shown to someone who has not agreed, says what moves and how, and does not open the chat', async () => {
    await mount({ coach: {} })
    await settle()
    expect(text()).toContain('Meet your Coach')
    expect(text()).toContain('Nothing is sent up front')
    expect(text()).toContain('Your conversation')
    expect(host.querySelector('.composer')).toBeNull()
    await click(button(/Not now/))
    expect(mocks.nav).toHaveBeenCalledWith('/plan')
  })

  it('agreeing records the current consent version and opens the chat', async () => {
    await mount({ coach: {} })
    await click(button(/let’s go/))
    expect(S().coach.consent.version).toBe(CONSENT_VERSION)
    expect(S().coach.consent.agreedAt).toBeTruthy()
    expect(host.querySelector('.composer')).toBeTruthy()
  })

  it('an older consent is asked for again, and the profile is kept', async () => {
    const s = baseState(); s.coach.consent.version = 1
    await mount({ coach: s.coach })
    expect(text()).toContain('Meet your Coach')
    await click(button(/let’s go/))
    expect(S().coach.consent.version).toBe(CONSENT_VERSION)
    expect(S().coach.profile).toEqual({ goal: 'muscle' })
  })
})

describe('the thread', () => {
  it('greets, offers starters on an empty thread, and sends one as a message', async () => {
    await mount()
    expect(text()).toContain('I look things up in your own data')
    const starters = host.querySelectorAll('.chips-row .qchip')
    expect(starters.length).toBe(4)
    await click(starters[2])
    expect(mocks.sent).toEqual(['Log my weight for today'])
  })

  it('renders the user\'s words as text and the assistant\'s as safe markdown', async () => {
    mocks.chat = [
      { id: 'u1', role: 'user', kind: 'text', text: '<b>bold?</b> how am I doing', at: 1 },
      assistant('You are **close**. Next:\n\n- add *one* set\n- keep `RIR 2`\n\n<img src=x onerror="window.pwned=1"> [guide](https://example.com/g) [bad](javascript:alert(1))')
    ]
    await mount()
    expect(host.querySelector('.msg.user .bub').textContent).toBe('<b>bold?</b> how am I doing')
    expect(host.querySelector('.msg.user .bub b')).toBeNull()
    const md = host.querySelector('.md')
    expect(md.querySelector('strong').textContent).toBe('close')
    expect(md.querySelectorAll('li')).toHaveLength(2)
    expect(md.querySelector('code').textContent).toBe('RIR 2')
    expect(host.querySelector('img')).toBeNull()
    expect(md.textContent).toContain('<img src=x onerror="window.pwned=1">')
    const links = [...md.querySelectorAll('a')]
    expect(links.map(a => a.getAttribute('href'))).toEqual(['https://example.com/g'])
    expect(links[0].getAttribute('rel')).toMatch(/noopener/)
    expect(md.textContent).toContain('[bad](javascript:alert(1))')
    expect(globalThis.pwned).toBeUndefined()
    // Starters are for an empty thread only.
    expect(host.querySelector('.chips-row')).toBeNull()
  })

  it('shows the dots and a running count while a job runs, and does not let a second message in', async () => {
    mocks.job = { id: 'j', state: 'running', startedAt: Date.now() - 12_000 }
    await mount()
    expect(host.querySelector('.typing')).toBeTruthy()
    expect(host.querySelector('.typing-eta').textContent).toMatch(/Looking it up/)
    expect(host.querySelector('.typing-eta').textContent).toMatch(/1[2-9] s/)
    expect(host.querySelector('textarea').disabled).toBe(true)
    expect(host.querySelector('.send').disabled).toBe(true)
    expect(host.querySelector('.chat-st').textContent).toBe('thinking…')
  })

  it('sends the typed message with Enter, clears the box, and asks the thread to refresh', async () => {
    await mount()
    const ta = host.querySelector('textarea')
    await act(async () => { typeIn(ta, 'what should I change?') })
    expect(host.querySelector('.send').disabled).toBe(false)
    await act(async () => { ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await settle()
    expect(mocks.sent).toEqual(['what should I change?'])
    expect(host.querySelector('textarea').value).toBe('')
    expect(host.querySelector('textarea').maxLength).toBe(1500)
  })

  it('says why a message was refused, in the app\'s own words, and keeps what was typed', async () => {
    vi.mocked(sendMessage).mockRejectedValueOnce(Object.assign(new Error('the Coach is taking a rest day'), { data: { code: 'cap' } }))
    await mount()
    const toasts = []
    await act(async () => { useUI.setState({ toast: m => toasts.push(m) }) })
    const ta = host.querySelector('textarea')
    await act(async () => { typeIn(ta, 'hello') })
    await click(host.querySelector('.send'))
    expect(toasts.at(-1)).toMatch(/rest day/)
    expect(host.querySelector('textarea').value).toBe('hello')
  })

  it('shows a failed job as one error bubble in the app\'s voice, never the provider\'s words', async () => {
    mocks.chat = [{ id: 'u', role: 'user', kind: 'text', text: 'hi', at: 1 }, { id: 'e', role: 'assistant', kind: 'error', text: '', errorClass: 'timeout', at: 2 }, { id: 'e2', role: 'assistant', kind: 'error', text: '', errorClass: 'tools', at: 3 }]
    await mount()
    const errs = [...host.querySelectorAll('.bub.err')]
    expect(errs).toHaveLength(2)
    expect(errs[0].textContent).toBe('The Coach took too long and gave up.')
    expect(errs[1].textContent).toMatch(/needs the Claude provider or the Anthropic API/)
  })

  it('on a provider that cannot run the assistant it says which one it needs, and offers no chat', async () => {
    mocks.assistant = { supported: false, provider: 'openai' }
    await mount()
    await act(async () => {})
    expect(host.querySelector('[role="status"]').textContent).toMatch(/needs the Claude provider or the Anthropic API, and this one uses Claude \(Anthropic\)/)
    expect(host.querySelector('textarea').disabled).toBe(true)
    expect(host.querySelector('.send').disabled).toBe(true)
    expect(host.querySelector('.chips-row')).toBeNull()
  })

  it('the menu offers the account row only where each profile brings its own, and the profile editor always', async () => {
    mocks.account = { mode: 'profile', connected: false, provider: 'claude' }
    await mount()
    await click(button(/More/))
    const sheet = useUI.getState().sheets.at(-1)
    const m = document.createElement('div'); document.body.appendChild(m)
    const r2 = createRoot(m)
    await act(async () => { r2.render(sheet.render(() => {})) })
    expect(m.textContent).toContain('Your account')
    expect(m.textContent).toContain('Edit my coach profile')
    expect(m.textContent).toContain('Everything the Coach changed')
    expect(m.textContent).not.toContain('Compare with others')
    await act(async () => { r2.unmount() })
    mocks.account = null
  })
})

describe('a proposal card', () => {
  it('shows each change with its before, its after and its reason, and Apply / Dismiss', async () => {
    const p = proposal([
      { type: 'sets', target: { routineId: 'r1', exId: '0001' }, after: 4 },
      { type: 'bodyweight-set', target: { date: TODAY }, after: 79.4 }
    ])
    mocks.chat = [assistant('Here is what I suggest.', p)]
    await mount()
    await settle()
    const card = host.querySelector('.pcard')
    expect(card.textContent).toContain('Suggested changes')
    expect(card.textContent).toContain('A suggestion')
    expect(card.textContent).toContain('2 changes')
    const rows = [...card.querySelectorAll('.pchg')]
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector('.pchg-b').textContent).toBe('3')
    expect(rows[0].querySelector('.pchg-a').textContent).toBe('4')
    expect(rows[0].querySelector('.pchg-w').textContent).toBe(why)
    expect(rows[1].textContent).toContain('79.4')
    expect(button(/^Apply/).disabled).toBe(false)
    expect(button(/Dismiss/)).toBeTruthy()
  })

  it('Apply edits the plan on this device, snapshots it, logs it, and tells whoever holds the thread', async () => {
    const p = proposal([{ type: 'sets', target: { routineId: 'r1', exId: '0001' }, after: 4 }])
    mocks.chat = [assistant('One more set.', p)]
    await mount()
    await settle()
    await click(button(/^Apply/))
    await settle()
    expect(S().routines[0].ex[0].sets).toBe(4)
    expect(S().coach.snapshots).toHaveLength(1)
    expect(S().coach.log.at(-1)).toMatchObject({ kind: 'assistant', proposalId: 'p1' })
    expect(mocks.resolved).toEqual([['p1', 'applied']])
    expect(host.querySelector('.pcard-eyebrow').textContent).toBe('Applied')
    expect(button(/^Undo/)).toBeTruthy()
    expect(button(/^Apply/)).toBeUndefined()
  })

  it('Undo puts the plan back exactly, and the card says it was applied then undone', async () => {
    const before = JSON.stringify(baseState().routines)
    const p = proposal([{ type: 'sets', target: { routineId: 'r1', exId: '0001' }, after: 4 }])
    mocks.chat = [assistant('One more set.', p)]
    await mount()
    await settle()
    await click(button(/^Apply/)); await settle()
    await click(button(/^Undo/)); await settle()
    expect(JSON.stringify(S().routines.map(r => ({ id: r.id, name: r.name, ex: r.ex })))).toBe(JSON.stringify(JSON.parse(before)))
    expect(S().routines[0].ex[0].sets).toBe(3)
    expect(S().coach.snapshots).toHaveLength(0)
    expect(mocks.resolved).toEqual([['p1', 'applied'], ['p1', 'undone']])
    expect(host.querySelector('.pcard-eyebrow').textContent).toBe('Applied, then undone')
    expect(button(/^Undo/)).toBeUndefined()
  })

  it('a workout is added, edited and deleted through the same card, stamped for the sync, and Undo brings each back', async () => {
    const p = proposal([
      { type: 'workout-add', target: {}, after: { d: daysAgo(1), name: 'Pull', entries: [{ id: '0009', sets: [{ r: 8, w: 40 }, { r: 8, w: 40 }] }] } },
      { type: 'workout-edit', target: { workoutId: 'w1' }, after: { note: 'felt strong', entries: [{ index: 0, sets: [{ index: 0, r: 11 }, { index: 1 }] }] } }
    ])
    mocks.chat = [assistant('I would log the pull day and fix a typo.', p)]
    await mount()
    await settle()
    await click(button(/^Apply/)); await settle()
    const ws = S().workouts
    expect(ws).toHaveLength(2)
    const added = ws.find(w => w.name === 'Pull')
    expect(added.vol).toBe(640)
    expect(added._ts).toBeGreaterThan(0)
    expect(ws.find(w => w.id === 'w1')).toMatchObject({ note: 'felt strong' })
    expect(ws.find(w => w.id === 'w1').entries[0].sets[0].r).toBe(11)
    await click(button(/^Undo/)); await settle()
    expect(S().workouts.map(w => w.id)).toEqual(['w1'])
    expect(S().workouts[0].note).toBeUndefined()
    expect(S().workouts[0].entries[0].sets[0].r).toBe(10)

    // And a deletion: the store notes it, so another device cannot bring the workout back.
    mocks.chat = [assistant('Delete it?', proposal([{ type: 'workout-delete', target: { workoutId: 'w1' } }], 'p2'))]
    await rerender(); await settle()
    await click(button(/^Apply/)); await settle()
    expect(S().workouts).toEqual([])
    expect(Number(S().deleted?.workouts?.w1)).toBeGreaterThan(0)
    await click(button(/^Undo/)); await settle()
    expect(S().workouts.map(w => w.id)).toEqual(['w1'])
    expect(Number(S().deleted?.workouts?.w1)).toBeLessThan(0)    // marked as added back
  })

  it('a weigh-in is logged and taken back, and the weigh-in of the same day is replaced, not duplicated', async () => {
    const p = proposal([{ type: 'bodyweight-set', target: { date: daysAgo(3) }, after: 79.2 }])
    mocks.chat = [assistant('Corrected.', p)]
    await mount()
    await settle()
    await click(button(/^Apply/)); await settle()
    expect(S().bodyweight).toHaveLength(1)
    expect(S().bodyweight[0]).toMatchObject({ d: daysAgo(3), w: 79.2 })
    expect(S().bodyweight[0].t).toBeGreaterThan(1)
    await click(button(/^Undo/)); await settle()
    expect(S().bodyweight[0]).toMatchObject({ d: daysAgo(3), w: 80 })
    expect(S().bodyweight[0].t).toBeGreaterThan(1)       // a restored record is newer than the edit it undoes
  })

  it('applies all or nothing: a change that fails in the middle leaves the state exactly as it was', async () => {
    const p = proposal([
      { type: 'sets', target: { routineId: 'r1', exId: '0001' }, after: 4 },
      { type: 'bodyweight-set', target: { date: TODAY }, after: 79.4 },
      { type: 'setting', target: { key: 'restSec' }, after: 120 }
    ])
    mocks.chat = [assistant('Three things.', p)]
    await mount()
    await settle()
    const before = JSON.stringify(S())
    mocks.boom = true
    const toasts = []
    await act(async () => { useUI.setState({ toast: m => toasts.push(m) }) })
    await click(button(/^Apply/)); await settle()
    expect(JSON.stringify(S())).toBe(before)
    expect(S().routines[0].ex[0].sets).toBe(3)
    expect(S().bodyweight).toHaveLength(1)
    expect(S().restSec).toBe(90)
    expect(S().coach.snapshots).toHaveLength(0)
    expect(toasts.at(-1)).toMatch(/disk on fire/)
    expect(mocks.resolved).toEqual([])            // nothing happened, so nothing is reported
    // Once the failure is gone the same card applies, whole.
    mocks.boom = false
    await click(button(/^Apply/)); await settle()
    expect(S().routines[0].ex[0].sets).toBe(4)
    expect(S().restSec).toBe(120)
    expect(S().bodyweight).toHaveLength(2)
  })

  it('a card whose data has moved cannot be applied, says so, and can still be dismissed', async () => {
    const p = proposal([{ type: 'sets', target: { routineId: 'r1', exId: '0001' }, after: 4 }, { type: 'setting', target: { key: 'restSec' }, after: 120 }])
    mocks.chat = [assistant('Two things.', p)]
    await mount()
    await settle()
    expect(button(/^Apply/).disabled).toBe(false)
    // Another device changes a rest timer the card was written against.
    await act(async () => { useStore.getState().update(s => { s.restSec = 100 }) })
    await settle()
    expect(button(/^Apply/).disabled).toBe(true)
    expect(host.querySelector('.pcard-note').textContent).toMatch(/Your data has changed since this was suggested/)
    expect(S().routines[0].ex[0].sets).toBe(3)
    await click(button(/Dismiss/)); await settle()
    expect(mocks.resolved).toEqual([['p1', 'dismissed']])
    expect(S().routines[0].ex[0].sets).toBe(3)
    expect(host.querySelector('.pcard-eyebrow').textContent).toBe('Dismissed')
  })

  it('only the newest applied card offers Undo', async () => {
    const p1 = proposal([{ type: 'sets', target: { routineId: 'r1', exId: '0001' }, after: 4 }], 'p1')
    mocks.chat = [assistant('First.', p1)]
    await mount()
    await settle()
    await click(button(/^Apply/)); await settle()
    const p2 = proposal([{ type: 'setting', target: { key: 'restSec' }, after: 120 }], 'p2')
    mocks.chat = [...mocks.chat, assistant('Second.', p2)]
    await rerender(); await settle()
    await click(button(/^Apply/)); await settle()
    expect([...host.querySelectorAll('.pcard')].map(c => !![...c.querySelectorAll('button')].find(b => /Undo/.test(b.textContent)))).toEqual([false, true])
  })

  it('an old proposal that kept only its summary is shown as that, with what became of it', async () => {
    mocks.chat = [assistant('Earlier.', { id: 'old', summary: 'Rest longer', status: 'applied', createdAt: 1, count: 3, kinds: ['setting', 'sets'] })]
    await mount()
    const card = host.querySelector('.pcard')
    expect(card.textContent).toContain('Applied')
    expect(card.textContent).toContain('Rest longer')
    expect(card.textContent).toContain('3 changes')
    expect(card.textContent).toContain('setting, sets')
    expect(button(/^Apply/)).toBeUndefined()
  })

  it('an expired or dismissed card keeps its changes behind one tap', async () => {
    const p = proposal([{ type: 'sets', target: { routineId: 'r1', exId: '0001' }, after: 4 }], 'p1', { status: 'expired' })
    mocks.chat = [assistant('Old.', p)]
    await mount()
    expect(host.querySelector('.pchg')).toBeNull()
    await click(button(/Show the changes/))
    expect(host.querySelector('.pchg')).toBeTruthy()
    expect(button(/^Apply/)).toBeUndefined()
  })
})
