// Talking to the assistant endpoints, and knowing when to stop.
//
// A message is a job and jobs are minutes-scale at worst, so the client polls. The one rule worth
// stating: polling only runs while a Coach surface is on screen or a job is known to be in
// flight. An app that pings the server every thirty seconds forever because a feature exists is
// an app that costs battery for a feature nobody is using.
//
// The conversation lives with whoever runs the assistant: on the server for a signed-in profile
// (GET /api/coach/chat), in the phone's own device file for a phone that brought an Anthropic key
// (lib/coach-local.js), in memory for the demo. The status poll carries `chatRev`, which moves
// whenever the thread does, so the thread is read only when there is something new in it.

import { useEffect, useState, useCallback, useRef } from 'react'
import { api } from './api.js'
import { DEMO } from './demo.js'
import { MOBILE } from './mobile.js'
import { t, getLang } from './i18n.js'
import { useStore } from '../store/useStore.js'

const POLL_MS = 3000        // a job is running: often enough to feel live
const IDLE_MS = 60000       // a Coach screen is open but nothing is running

// The demo build has no backend, so it answers these locally with a canned assistant built from
// its own seeded profile (lib/coach-demo.js). Everything downstream — validation, apply, undo, the
// log — runs unchanged; only the provider is faked. The module is imported dynamically so none of
// it lands in a self-hosted bundle.
let demoMod = null
const demo = async () => (demoMod = demoMod || await import('./coach-demo.js'))
const S = () => useStore.getState().S

// The mobile build's third answer: a phone that brought its own Anthropic key runs the assistant
// itself (lib/coach-local.js — the same tools and the same loop the server runs, imported lazily so
// the catalogue only ever loads on a phone that chose this). A paired phone takes the api()
// branch like the web app does; nothing on the web or demo builds reaches this.
let localMod = null
const LOCAL = () => MOBILE && useStore.getState().coachLocal?.mode === 'byok'
const local = async () => (localMod = localMod || await import('./coach-local.js'))

export const coachStatus = async () => DEMO ? (await demo()).demoStatus() : LOCAL() ? (await local()).localStatus() : api('/api/coach/status')
export const coachChat = async () => DEMO ? (await demo()).demoChat() : LOCAL() ? (await local()).localChat() : api('/api/coach/chat')
export const sendMessage = async text => DEMO ? (await demo()).demoSend(S, text)
  : LOCAL() ? (await local()).localSend(S, text)
    : api('/api/coach/message', { method: 'POST', body: JSON.stringify({ text, lang: getLang() }) })
/** Tell whoever holds the thread what the person did with a proposal: applied, dismissed or undone. */
export const resolveProposal = async (id, status) => DEMO ? (await demo()).demoResolve(id, status)
  : LOCAL() ? (await local()).localResolve(id, status)
    : api('/api/coach/proposal/resolve', { method: 'POST', body: JSON.stringify({ id, status }) })
// The room: anonymous medians across the profiles on this instance that opted in. Only a
// server has a room; a phone with its own key and the demo both answer locally.
export const cohortStats = async () => DEMO ? (await demo()).demoCohort(S()) : LOCAL() ? { ok: false, enabled: false } : api('/api/coach/cohort')
export const setCohortShare = async share => (DEMO || LOCAL()) ? { ok: true, sharing: !!share } : api('/api/coach/cohort/share', { method: 'POST', body: JSON.stringify({ share: !!share }) })
export const forgetCoach = async () => DEMO ? (await demo()).demoForget() : LOCAL() ? (await local()).localForget() : api('/api/coach/forget', { method: 'POST', body: '{}' })
export const disclosure = async () => DEMO ? (await demo()).demoDisclosure() : LOCAL() ? (await local()).localDisclosure() : api('/api/coach/disclosure')

/* Whose provider account this profile is about to spend. Its own call because the constraint is
   that the Coach screen states it too, not just the admin card — and because in instance mode a
   second profile is refused outright, which is something the user has to be able to read before
   they ask for anything rather than after a job is turned down. */
export const coachAccount = async () =>
  DEMO ? { mode: 'instance', provider: 'demo', providerLabel: 'Demo', account: null, connected: true, reason: null, message: null }
    : LOCAL() ? { mode: 'device', provider: useStore.getState().coachLocal.provider, providerLabel: null, account: null, connected: true, reason: null, message: null }
      : api('/api/coach/account')

/* Admin-only. The token is write-only from the client's side: it goes up once and is never
   read back, so there is deliberately no "show me the current credential" call to pair with it. */
export const connectCredential = body => api('/api/admin/coach/connect', { method: 'POST', body: JSON.stringify(body) })
export const disconnectCredential = () => api('/api/admin/coach/disconnect', { method: 'POST', body: '{}' })

/**
 * The conversation and the job state, live.
 *
 * `active` lets a caller subscribe only while it is mounted and visible; everything else keeps
 * the poll off. Errors are swallowed on purpose — a status call failing while you are mid-workout
 * is not something to interrupt anyone about. Returns the status fields, `chat` (oldest first),
 * and `refresh()` for a manual re-read, e.g. right after a message was sent.
 */
export function useCoachChat(active = true) {
  const [state, setState] = useState({ job: null, cap: null, assistant: null, last: null, loading: true })
  const [chat, setChat] = useState([])
  const timer = useRef(null)
  const loop = useRef(null)   // the running poll loop's `tick`, so a manual refresh can re-pace it
  const seq = useRef(0)       // which status request is the newest one
  const rev = useRef(null)    // the chatRev the thread on screen was read at

  const refresh = useCallback(async () => {
    const mine = ++seq.current
    try {
      const s = await coachStatus()
      // An answer that arrives after a newer request was sent is older than what that request
      // will bring: the idle poll in flight when a message is sent must not land after the
      // refresh that follows the send, putting back the state from before.
      if (mine !== seq.current) return s
      if (s.chatRev !== rev.current) {
        const c = await coachChat()
        if (mine !== seq.current) return s
        rev.current = c.chatRev ?? s.chatRev
        setChat(c.chat || [])
      }
      setState({ ...s, loading: false })
      // A refresh that finds a job in flight — the one the caller just started — must not leave
      // the loop asleep on its idle cadence: without this the screen sits on "thinking" long
      // after the answer arrived.
      if (s?.job && loop.current) { clearTimeout(timer.current); timer.current = setTimeout(loop.current, POLL_MS) }
      return s
    } catch {
      if (mine === seq.current) setState(v => ({ ...v, loading: false }))
      return null
    }
  }, [])

  useEffect(() => {
    if (!active) return
    let stopped = false
    const tick = async () => {
      const s = await refresh()
      if (stopped) return
      clearTimeout(timer.current)
      timer.current = setTimeout(tick, s?.job ? POLL_MS : IDLE_MS)
    }
    loop.current = tick
    tick()
    return () => { stopped = true; loop.current = null; clearTimeout(timer.current) }
  }, [active, refresh])

  return { ...state, chat, refresh }
}

// Server failure classes, in the app's voice. The provider's own words go to the admin card;
// what a lifter needs is what it means for them and whether trying again will help.
//
// Each line is a getter, so it is translated when it is read, not when this module loads: the
// module loads once, in English, before any locale pack has arrived, and a language picked later
// would otherwise never reach these lines. The lookup is still JOB_ERRORS[cls].
export const JOB_ERRORS = {
  get off() { return t('The Coach isn’t set up on this instance.') },
  get busy() { return t('The Coach is already thinking about your training.') },
  get cap() { return t('The Coach is taking a rest day. Try again tomorrow.') },
  get consent() { return t('The Coach needs your go-ahead first.') },
  // Per-profile mode, and this profile has not connected its own account yet. Points at the row.
  get account() { return t('Connect your own account first: Coach menu → Your account.') },
  get timeout() { return t('The Coach took too long and gave up.') },
  get auth() { return t('The Coach couldn’t sign in to its provider. The instance owner needs to check its setup.') },
  get missing() { return t('The Coach isn’t installed properly on this instance.') },
  get provider() { return t('The Coach couldn’t run. The instance owner needs to check its setup.') },
  get unusable() { return t('The Coach answered with something the app couldn’t use.') },
  get restart() { return t('The server restarted while the Coach was thinking.') },
  get nostate() { return t('The Coach couldn’t read your training data.') },
  // The refusal at enqueue when the process cannot drop privileges (api/coach/jobs.js). The same
  // words as api/coach/routes.js USER_ERROR.unprivileged; what to fix goes to the admin card.
  get unprivileged() { return t('The Coach is switched off on this instance for safety reasons.') },
  get internal() { return t('Something went wrong on the server.') }
}

// Failure classes the assistant added. Kept apart from the maps above, which every locale pack is
// held to: these read in English until a pack catches up, which beats a blank bubble.
export const ASSISTANT_ERRORS = {
  get tools() { return t('The assistant needs the Claude provider or the Anthropic API. This instance uses another one: ask its owner to switch.') },
  get empty() { return t('Write a message first.') },
  get forgotten() { return t('That conversation was cleared.') }
}

// The same failures on a phone that brought its own key: there is no instance owner to
// check anything, the person reading this is the operator, and the provider's own words
// are the only thing that lets them fix it (a spent quota, a wrong model, a rejected key).
export const BYOK_ERRORS = {
  get auth() { return t('Your AI provider rejected the key on this phone. Check it under Settings → AI Coach.') },
  get missing() { return t('The Coach isn’t set up on this phone. Check Settings → AI Coach.') },
  get provider() { return t('Your AI provider couldn’t answer.') },
  get unusable() { return t('The Coach answered with something the app couldn’t use.') },
  get internal() { return t('Something went wrong on this phone.') }
}

/** The line the person sees for a failed job — with the reason attached where they can act on it. */
export function jobErrorText(cls, detail) {
  const own = MOBILE && useStore.getState().coachLocal?.mode === 'byok'
  const base = (own && BYOK_ERRORS[cls]) || JOB_ERRORS[cls] || ASSISTANT_ERRORS[cls] || (own ? BYOK_ERRORS.internal : JOB_ERRORS.internal)
  const why = own && detail ? String(detail).trim().slice(0, 300) : ''
  return why ? `${base}\n${why}` : base
}
