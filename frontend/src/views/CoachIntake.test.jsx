// @vitest-environment happy-dom
//
// The coach profile editor: what used to be the gate in front of the Coach is now an optional
// edit of the answers the assistant keeps in mind. Every step can be skipped, the last one saves,
// and the route only opens with ?edit=1 for somebody who has agreed.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({ nav: vi.fn(), search: 'edit=1' }))
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.nav, useSearchParams: () => [new URLSearchParams(mocks.search)] }))
vi.mock('../lib/api.js', () => ({ api: vi.fn(() => Promise.reject(new Error('offline'))), IS_APPLE: false, IS_ANDROID: false, BIO: 'b', webauthnOK: () => false }))

const { useStore } = await import('../store/useStore.js')
const { useUI } = await import('../store/useUI.js')
const { CONSENT_VERSION } = await import('../lib/coach.js')
const CoachIntake = (await import('./CoachIntake.jsx')).default

let host, root
const state = (coach = { consent: { agreedAt: 'x', version: CONSENT_VERSION }, profile: { goal: 'muscle', experience: 'regular', daysPerWeek: 4, limitations: 'left shoulder' }, log: [], snapshots: [] }) => ({
  unit: 'kg', lang: 'en', routines: [], week: {}, workouts: [], bodyweight: [], customEx: [], coach
})
async function mount(S = state()) {
  useStore.setState({ S, user: { id: 'u1' }, ready: true, config: { coach: { enabled: true } }, coachLocal: null })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(React.createElement(CoachIntake)) })
}
const button = re => [...host.querySelectorAll('button')].find(b => re.test(b.textContent || b.getAttribute('aria-label') || ''))
const click = async el => { expect(el).toBeTruthy(); await act(async () => { el.click() }) }

beforeEach(() => { mocks.nav.mockClear(); mocks.search = 'edit=1'; useUI.setState({ sheets: [] }); document.body.innerHTML = '' })
afterEach(async () => { if (root) { await act(async () => { root.unmount() }); root = null } })

describe('edit the coach profile', () => {
  it('starts on the goal with the saved answer chosen, and says it is context, not a gate', async () => {
    await mount()
    expect(host.textContent).toContain('What are you training for?')
    expect(host.textContent).toContain('The Coach keeps this in mind when it answers.')
    expect(host.querySelector('.ob-choice.on').textContent).toContain('Build muscle')
    expect(host.textContent).not.toContain('Build my plan')
    expect(host.textContent).not.toContain('Before we start')
  })

  it('every step can be skipped, and the last one saves what is there and returns to the chat', async () => {
    await mount()
    for (let i = 0; i < 6; i++) await click(button(/^Continue$/))
    expect(host.textContent).toContain('Anything else?')
    await click(button(/^Save$/))
    expect(useStore.getState().S.coach.profile).toMatchObject({ goal: 'muscle', experience: 'regular', daysPerWeek: 4, limitations: 'left shoulder' })
    expect(mocks.nav).toHaveBeenLastCalledWith('/coach')
  })

  it('an edit is saved: a new goal, and a note about limits', async () => {
    await mount()
    await click([...host.querySelectorAll('.ob-choice')].find(b => /Get stronger/.test(b.textContent)))
    for (let i = 0; i < 5; i++) await click(button(/^Continue$/))
    expect(host.textContent).toContain('Anything to work around?')
    const ta = host.querySelector('textarea')
    await act(async () => {
      Object.getOwnPropertyDescriptor(ta.constructor.prototype, 'value').set.call(ta, 'no overhead pressing')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(button(/^Continue$/))
    await click(button(/^Save$/))
    expect(useStore.getState().S.coach.profile).toMatchObject({ goal: 'strength', limitations: 'no overhead pressing' })
  })

  it('the text fields are bounded to what the server reads', async () => {
    await mount()
    for (let i = 0; i < 5; i++) await click(button(/^Continue$/))
    expect(host.querySelector('textarea').maxLength).toBe(600)
  })

  it('goes back to the chat from the first step, and without ?edit=1 or without consent there is nothing to ask', async () => {
    await mount()
    await click(button(/^Back$/))
    expect(mocks.nav).toHaveBeenLastCalledWith('/coach')
    await act(async () => { root.unmount() }); root = null
    mocks.nav.mockClear()

    mocks.search = ''
    await mount()
    expect(mocks.nav).toHaveBeenCalledWith('/coach', { replace: true })
    expect(host.textContent).toBe('')
    await act(async () => { root.unmount() }); root = null

    mocks.search = 'edit=1'; mocks.nav.mockClear()
    await mount(state({}))
    expect(mocks.nav).toHaveBeenCalledWith('/coach', { replace: true })
  })
})
