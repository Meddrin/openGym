// The assistant, in the demo build.
//
// The GitHub Pages demo has no backend at all, so there is nothing to run a model and nothing
// to poll. Rather than hide the feature there — it is the most interesting thing the app
// does — the demo answers the same calls locally with a canned assistant.
//
// What it says is canned, what it proposes is not: each proposal is built from the demo
// profile's actual routines and body weight and then checked by the very validator the server
// uses (api/coach/core/changes.js), so every id resolves, the before/after values are real, and
// applying it exercises exactly the same code path as a live instance: check, snapshot, apply,
// log, undo. What is faked is the model, not the feature.
//
// Nothing here ships in a self-hosted bundle: every entry point is behind DEMO, which Vite
// replaces at build time.

import { EXIDX } from './exercises.js'
import { workoutAt } from './history.js'
import { best1RM } from './onerm.js'
import { todayISO } from './format.js'
import { validateChangeSet } from '../../../api/coach/core/changes.js'
import { DATA_CATEGORIES } from '../../../api/coach/core/categories.js'
import { t } from './i18n.js'

const DELAY = 1800      // long enough to see "thinking", short enough to forgive

let job = null
let chat = []
let rev = 0
let timer = null

const id = () => Math.random().toString(36).slice(2, 10)
const push = m => { chat = [...chat, m]; rev++ }

/** What the canned assistant proposes for a message, checked like a real proposal; or nothing. */
export function buildProposal(S, text) {
  const wantsWeight = /weigh|weight|kg|lb|scale|mérleg|súly/i.test(text)
  const wantsPlan = /plan|set|sets|volume|routine|squat|press|bench|edz/i.test(text)
  const changes = []
  if (wantsWeight) {
    changes.push({
      type: 'bodyweight-set', target: { date: todayISO() }, after: lastWeight(S) || 80,
      why: t('You asked me to log your weight. I used your latest weigh-in as the number: change it if the scale said something else.')
    })
  } else if (wantsPlan) {
    const r = (S.routines || []).find(x => (x.ex || []).length)
    const ex = r && r.ex.find(e => e.sets && (e.reps || e.sec))
    if (ex) {
      changes.push({
        type: 'sets', target: { routineId: r.id, exId: ex.id }, after: Math.min(10, (ex.sets || 3) + 1),
        why: t('This is the lift where you ask for the most volume, and your last sessions on it were clean. One more set is the smallest useful step up.')
      })
    }
  }
  if (!changes.length) return null
  const v = validateChangeSet(S, { summary: wantsWeight ? t('Log a weigh-in for today.') : t('One more set on a lift that is going well.'), changes }, { today: todayISO() })
  if (!v.ok) return null
  return { id: 'demo-' + id(), summary: v.summary, createdAt: Date.now(), status: 'pending', changes: v.changes }
}
const lastWeight = S => {
  const w = (S.bodyweight || []).filter(b => b && b.d && Number(b.w) > 0).sort((a, b) => (a.d < b.d ? -1 : 1)).at(-1)
  return w ? Number(w.w) : null
}

function reply(S, text) {
  const proposal = buildProposal(S, text)
  const named = proposal && proposal.changes[0].type === 'sets' ? EXIDX[proposal.changes[0].target.exId]?.n : null
  if (proposal && proposal.changes[0].type === 'bodyweight-set') return { text: t('Sure. I would log today’s weigh-in. Have a look at the card and tap Apply if it is right; you can undo it afterwards.'), proposal }
  if (proposal) return { text: t('Here is what I would change{0}. The reason is on the card, and nothing happens until you tap Apply.', named ? ` (${named})` : ''), proposal }
  return { text: t('This is a demo: I answer from a script. Try “log my weight” or “add a set to my plan” and I will propose a real change you can apply and undo. On your own server I answer anything about your training, from your own data.') }
}

/** What "the room" would say on a busy instance — five people, plausible medians, your real bests. */
export function demoCohort(S) {
  const since = Date.now() - 56 * 864e5
  const you = Math.round((S.workouts || []).filter(w => workoutAt(w) > since).length / 8 * 10) / 10
  const ids = [...new Set((S.routines || []).flatMap(r => (r.ex || []).map(e => e.id)))].slice(0, 5)
  const exercises = ids.map(id => {
    const b = best1RM(S, id)
    const mine = b ? Math.round(b.est * 10) / 10 : null
    return { id, name: EXIDX[id]?.n || id, people: 4, median: mine ? Math.round(mine * 0.92) : 60, you: mine }
  })
  return { ok: true, enabled: true, sharing: true, people: 5, minPeople: 3, unit: S.unit, sessionsPerWeek: { median: 3, you }, exercises, rankPct: 62 }
}

/* ---------------- the API surface the demo stands in for ---------------- */

export const demoStatus = () => ({ job, cap: { used: 0, limit: 0 }, last: null, chatRev: rev, assistant: { supported: true, provider: 'demo' } })
export const demoChat = () => ({ chat, chatRev: rev })

export function demoSend(getS, text) {
  if (job) throw Object.assign(new Error(t('The Coach is already thinking about your training.')), { status: 409, code: 'busy' })
  const clean = String(text || '').trim().slice(0, 1000)
  if (!clean) throw Object.assign(new Error(t('Write a message first.')), { status: 400, code: 'empty' })
  const message = { id: id(), role: 'user', kind: 'text', text: clean, at: Date.now() }
  push(message)
  job = { id: 'demo-' + id(), state: 'running', startedAt: Date.now() }
  clearTimeout(timer)
  // A builder that throws still has to end the job: left uncaught, one throw would keep `job` at
  // 'running' for ever and every later message would answer 409 until the page was reloaded.
  timer = setTimeout(() => {
    try { push({ id: id(), role: 'assistant', kind: 'text', at: Date.now(), ...reply(getS(), clean) }) }
    catch { push({ id: id(), role: 'assistant', kind: 'error', text: '', errorClass: 'nostate', at: Date.now() }) }
    finally { job = null }
  }, DELAY)
  return { job: { id: job.id }, message }
}

const NEXT = { pending: ['applied', 'dismissed'], applied: ['undone'] }
export function demoResolve(pid, status) {
  const i = chat.findIndex(m => m.proposal && m.proposal.id === pid)
  if (i < 0) return { ok: false, code: 'unknown' }
  const p = chat[i].proposal
  if (!(NEXT[p.status] || []).includes(status)) return { ok: false, code: 'state', status: p.status }
  chat = chat.map((m, k) => (k === i ? { ...m, proposal: { ...p, status, decidedAt: Date.now() } } : m))
  rev++
  return { ok: true, status }
}
export const demoForget = () => { clearTimeout(timer); job = null; chat = []; rev++; return { ok: true } }
export const demoDisclosure = () => ({
  provider: 'demo', providerLabel: t('the configured AI provider'),
  categories: DATA_CATEGORIES, flow: 'tools', version: 2
})

// Test seam.
export function _resetDemo() { clearTimeout(timer); job = null; chat = []; rev = 0 }
