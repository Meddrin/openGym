// The AI Coach, on the client side: what a proposal looks like on a card, and the plan appliers.
//
// The assistant never writes into your state. Its proposals arrive in the chat as change sets;
// applying one is ordinary local editing — snapshot, mutate the draft, log — which is what makes
// it work offline, sync like every other change, and stay reversible without the server knowing
// anything about it. That engine is lib/coach-changes.js. This file is the light half that the
// rest of the app may import without dragging the exercise catalogue along: the gate, the consent
// wording, the plan appliers (one per plan change type) and the words for a card.
//
// Every applier is pure over a draft state `s` (call it inside store.update), so the interesting
// parts are testable without a browser, a server or an AI account. That matters more here than
// elsewhere in the app: this is the code that edits a plan on the strength of something a
// language model said, and "it looked right on my phone" is not a standard.

import { EXIDX, canonicalExId } from './exercises.js'
import { cleanupSg } from './history.js'
import { uid, DAYN, fmtDate } from './format.js'
import { deleteRoutine } from './routines.js'
import { POLICIES } from './progression.js'
import { t } from './i18n.js'

// Bumping this re-prompts everyone: it means what we share, or who we share it with, changed.
// 2: the training line names the session notes, which the payload carries and version 1 never
// mentioned.
// 3: the Coach is an assistant now. Nothing is sent up front; it looks things up as it answers,
// through tools, and it keeps a conversation with you. The screen says so in new words.
export const CONSENT_VERSION = 3

// Bounds. The whole state has to stay inside the server's 5 MB body limit, and a Coach log
// that grows forever is exactly the kind of thing that eats it invisibly. The namespace guard is
// the backstop for the case nobody predicted.
export const SNAPSHOT_MAX = 3
export const LOG_MAX = 50
const NAMESPACE_MAX = 256 * 1024

export const emptyCoach = () => ({
  consent: null, profile: null, log: [], snapshots: []
})
const coachOf = s => (s.coach = s.coach || emptyCoach())

/* ============================ gating ============================ */

// One predicate, one place. Every Coach entry point in the UI is behind it, which is what
// makes "an instance with no provider is byte-identical to before" a claim worth testing.
//
// The demo build is the one exception, and it is deliberate: it has no backend and no
// account, but it does have a canned assistant, and hiding the app's most interesting feature
// from the page people are sent to look at it on would be a strange choice.
//
// The mobile build has two ways in, both chosen in Settings (views/CoachSetup.jsx): a phone
// paired to a self-hosted server is an ordinary signed-in profile and takes the web rule; a
// phone that brought its own API key runs the Coach itself (lib/coach-local.js). Nothing
// chosen means nothing shown — the same "invisible unless configured" promise the web keeps.
export const coachAvailable = (config, user, { demo, mobile, coachMode } = {}) =>
  mobile ? (coachMode === 'byok' || !!(config?.coach?.enabled && user))
    : demo ? true : !!(config?.coach?.enabled && user)

// What each data category means, in the user's words. Rendered from the same list the server
// defines (api/coach/core/categories.js), so the screen cannot promise less than can leave.
// Each entry returns [title, detail] in the current language, through literal t() calls so
// check-source-strings sees every key.
export const CATEGORY_TEXT = {
  plan: () => [t('Your plan'), t('Routines, exercises, sets and reps, your weekly schedule and progression settings.')],
  training: () => [t('Your logged training'), t('Workouts it looks up while it answers: weights, reps, times, effort ratings, how long sessions took, and your session notes.')],
  bodyweight: () => [t('Body weight'), t('Weigh-ins, and your goal weight if you set one.')],
  profile: () => [t('What you tell the Coach'), t('Your intake answers, including any limitations or injuries you describe, your own exercises and your notes on exercises.')],
  prefs: () => [t('A few preferences'), t('Your unit, your language, which effort scale you log, and rest timers.')],
  chat: () => [t('Your conversation'), t('What you write to it, and what it answered recently, so it can follow the thread.')]
}
export const hasConsent = S => !!S?.coach?.consent?.agreedAt && S.coach.consent.version === CONSENT_VERSION

/* ============================ plan changes ============================ */

const findRoutine = (S, id) => (S.routines || []).find(r => r.id === id) || null
const findEx = (routine, id) => (routine?.ex || []).find(e => e.id === id) || null

// The Coach reads a routine's name cut at 80 characters (NAME_MAX in api/coach/core/payload.js),
// and the server copies that cut name into a rename's `before`. Compared whole, a longer name
// never matched, and every rename of it was shown as already overtaken by an edit. Not imported
// from payload.js, which would pull the exercise catalogue into the main bundle; coach.test.js
// pins the two together.
export const ROUTINE_NAME_SEEN = 80

const clone = o => JSON.parse(JSON.stringify(o))

// One implementation per allowed type. The object is the closed list on this side of the
// wire: a type with no entry here cannot be applied, whatever the server let through.
const CHANGE_APPLY = {
  'add-exercise': (s, c) => {
    const r = need(findRoutine(s, c.target.routineId))
    const a = c.after || {}
    // A drawing's id the Coach may have picked up names the exercise it draws.
    const e = { id: canonicalExId(a.id), sets: a.sets || 3, mode: a.mode || 'reps' }
    if (e.mode === 'cardio') { e.min = a.min || 20; e.speed = a.speed || 8 }
    else if (e.mode === 'time') e.sec = a.sec || 45
    else e.reps = a.reps || 10
    if (a.weight > 0) e.weight = a.weight
    if (POLICIES.includes(a.prog)) e.prog = a.prog
    if (Number.isInteger(a.repsMin)) e.repsMin = a.repsMin
    if (Number.isInteger(a.repsMax)) e.repsMax = a.repsMax
    if (Number.isInteger(a.setsMax)) e.setsMax = a.setsMax   // triple progression's set ceiling
    // Only when the Coach disagreed with the catalogue: an absent flag has always meant
    // "whatever the exercise says", and writing one out would freeze today's dataset into
    // the plan.
    if (a.bodyweight != null) e.bodyweight = !!a.bodyweight
    if (a.side) e.side = true
    const at = Number.isInteger(a.position) ? Math.min(a.position, r.ex.length) : r.ex.length
    r.ex.splice(at, 0, e)
    cleanupSg(r.ex)
  },
  'remove-exercise': (s, c) => {
    const r = need(findRoutine(s, c.target.routineId))
    r.ex = r.ex.filter(e => e.id !== c.target.exId)
    cleanupSg(r.ex)
  },
  'swap-exercise': (s, c) => {
    const r = need(findRoutine(s, c.target.routineId))
    const i = r.ex.findIndex(e => e.id === c.target.exId)
    if (i < 0) throw new Error('missing exercise')
    const old = r.ex[i], a = c.after || {}
    // Keep the old prescription unless the Coach deliberately changed it: a swap is about the
    // movement, and silently resetting sets and reps would be a second change nobody approved.
    //
    // The two v1.2.4 flags are the exception, and they have to be: they describe the *movement*,
    // not the prescription. Carrying `side: true` from a lunge onto a leg press would make the
    // app halve a rep count that was never per-side, so an explicit flag is dropped and the new
    // exercise goes back to whatever the catalogue says about it.
    const { bodyweight, side, ...keep } = old
    r.ex[i] = { ...keep, id: canonicalExId(a.id), ...(a.sets ? { sets: a.sets } : {}), ...(a.reps ? { reps: a.reps } : {}), ...(a.weight > 0 ? { weight: a.weight } : {}) }
  },
  sets: (s, c) => { need(findExIn(s, c)).sets = c.after },
  reps: (s, c) => { need(findExIn(s, c)).reps = c.after },
  repsMin: (s, c) => { need(findExIn(s, c)).repsMin = c.after },
  repsMax: (s, c) => { need(findExIn(s, c)).repsMax = c.after },
  sec: (s, c) => { need(findExIn(s, c)).sec = c.after },
  cardio: (s, c) => {
    const e = need(findExIn(s, c))
    if (c.after?.min != null) e.min = c.after.min
    if (c.after?.speed != null) e.speed = c.after.speed
  },
  inc: (s, c) => { need(findExIn(s, c)).inc = c.after },
  'exercise-prog': (s, c) => { need(findExIn(s, c)).prog = c.after },
  'routine-prog': (s, c) => { need(findRoutine(s, c.target.routineId)).prog = c.after },
  reorder: (s, c) => {
    const r = need(findRoutine(s, c.target.routineId))
    const by = new Map(r.ex.map(e => [e.id, e]))
    const next = c.after.map(id => by.get(id)).filter(Boolean)
    // Distinct exercises, not just the right count: an order naming one id twice maps to the
    // same object twice and still counts right, which drops an exercise and leaves the
    // survivor aliased into two slots that then edit each other.
    if (next.length !== r.ex.length || new Set(next).size !== r.ex.length) throw new Error('incomplete reorder')
    r.ex = next
    cleanupSg(r.ex)
  },
  superset: (s, c) => {
    const r = need(findRoutine(s, c.target.routineId))
    const i = r.ex.findIndex(e => e.id === c.target.exId)
    if (i < 0) throw new Error('missing exercise')
    if (!c.after?.link) { delete r.ex[i].sg; cleanupSg(r.ex); return }
    // Splicing the partner out from under the anchor when they are the same exercise leaves
    // nothing to tag; refuse rather than reorder the routine on the way to a TypeError.
    if (c.after.with === c.target.exId) throw new Error('superset with itself')
    const j = r.ex.findIndex(e => e.id === c.after.with)
    if (j < 0) throw new Error('missing partner')
    // Supersets are a property of adjacency in this app; move the partner next to it first.
    const [partner] = r.ex.splice(j, 1)
    const at = r.ex.findIndex(e => e.id === c.target.exId)
    r.ex.splice(at + 1, 0, partner)
    const tag = uid().slice(0, 6)
    r.ex[at].sg = tag
    r.ex[at + 1].sg = tag
  },
  'add-routine': (s, c) => {
    const a = c.after
    s.routines.push({
      id: uid(), name: a.name, emoji: a.emoji || '🏋️',
      ...(POLICIES.includes(a.prog) ? { prog: a.prog } : {}),
      ex: a.ex.map(e => ({
        id: canonicalExId(e.id), sets: e.sets || 3, mode: e.mode || 'reps',
        ...(e.mode === 'time' ? { sec: e.sec || 45 } : { reps: e.reps || 10 }),
        ...(Number.isInteger(e.repsMax) ? { repsMax: e.repsMax } : {}),
        ...(Number.isInteger(e.setsMax) ? { setsMax: e.setsMax } : {}),
        ...(e.bodyweight != null ? { bodyweight: !!e.bodyweight } : {}),
        ...(e.side ? { side: true } : {})
      }))
    })
  },
  'remove-routine': (s, c) => {
    // The same delete as Plan and RoutineEdit. It used to compare each weekday with ===, which
    // missed a combined day (a list) and left the deleted id on it. The week and the reschedules
    // come back from the snapshot on an Undo.
    // The dropped reschedules are not lost: remove-routine snapshots the whole dayPlan first
    // (lib/coach-changes.js), which is what an Undo puts back.
    deleteRoutine(s, c.target.routineId)
  },
  'rename-routine': (s, c) => { need(findRoutine(s, c.target.routineId)).name = c.after },
  week: (s, c) => {
    // A single-routine op: the slot is a list, but the Coach only ever names one routine (or
    // rest), and it replaces the day. This collapses a combined day to one routine — the same
    // stated limitation as a DayOverride (see docs/dev/COMBINE_ROUTINES.md §8).
    const d = c.target.weekday
    if (c.after == null || c.after === 'rest') delete s.week[d]
    else s.week[d] = [c.after]
  }
}
export const CHANGE_TYPES = Object.keys(CHANGE_APPLY)

function findExIn(s, c) { return findEx(findRoutine(s, c.target.routineId), c.target.exId) }
function need(x) { if (!x) throw new Error('missing target'); return x }


/** Apply one plan change to the draft `s`. Throws when its target is gone, which discards the
 *  whole set when this runs inside store.update. */
export function applyPlanChange(s, c) {
  const fn = CHANGE_APPLY[c.type]
  if (!fn) throw new Error('unknown change type ' + c.type)
  fn(s, c)
}

/* ============================ the log ============================ */

export function appendLog(s, entry) {
  const c = coachOf(s)
  const e = { id: entry.id || uid(), ...entry }
  c.log = [...(c.log || []), e].slice(-LOG_MAX)
  trim(s)
  return e.id
}
export const logEntry = (S, id) => (S?.coach?.log || []).find(e => e.id === id) || null

/**
 * Last line of defence for the 5 MB sync body: if the Coach namespace ever outgrows its
 * budget, drop the oldest history rather than let a PUT start failing for reasons nobody
 * would connect to this feature. The newest snapshot is what an Undo needs, so it goes last.
 */
export function trim(s) {
  const c = coachOf(s)
  let guard = 0
  while (JSON.stringify(c).length > NAMESPACE_MAX && guard++ < 60) {
    if ((c.log || []).length > 1) c.log.shift()
    else if ((c.snapshots || []).length > 1) c.snapshots.shift()
    else break
  }
}

/** The snapshots, newest last. Kept here so the light half can say whether an Undo exists. */
export const snapshotsOf = S => (S?.coach?.snapshots || [])
/** Whether the proposal with this id is the one an Undo would put back (the newest apply). */
export const canUndo = (S, proposalId) => {
  const snaps = snapshotsOf(S)
  return !!snaps.length && snaps[snaps.length - 1].proposalId === proposalId
}
export const setSnapshots = (s, list) => { coachOf(s).snapshots = list.slice(-SNAPSHOT_MAX) }
export const pushRawSnapshot = (s, snap) => {
  const c = coachOf(s)
  c.snapshots = [...(c.snapshots || []), snap].slice(-SNAPSHOT_MAX)
  trim(s)
}
export const popSnapshot = s => (coachOf(s).snapshots || []).pop() || null

/* ============================ display helpers ============================ */

export const exName = id => EXIDX[id]?.n || t('Unknown exercise')
// Catalogue names are lower-case; a title reads better with each word capitalised, and doing it
// here rather than with CSS keeps a German sentence around the name from being Title Cased too.
const cap = s => String(s || '').replace(/(^|\s)(\p{L})/gu, (m, sp, ch) => sp + ch.toUpperCase())
export const exTitle = id => cap(exName(id))

/** Human label for a plan change, used on the card and in the log. */
export function changeTitle(c, S) {
  const ex = c.target?.exId ? exTitle(c.target.exId) : null
  switch (c.type) {
    case 'add-exercise': return t('Add {0}', exTitle(c.after?.id))
    case 'remove-exercise': return t('Remove {0}', ex)
    case 'swap-exercise': return t('Swap {0} for {1}', ex, exTitle(c.after?.id))
    case 'sets': return t('{0}: sets', ex)
    case 'reps': return t('{0}: reps', ex)
    case 'repsMin': return t('{0}: rep-range floor', ex)
    case 'repsMax': return t('{0}: rep-range ceiling', ex)
    case 'sec': return t('{0}: hold time', ex)
    case 'cardio': return t('{0}: duration & pace', ex)
    case 'inc': return t('{0}: load step', ex)
    case 'exercise-prog': return t('{0}: progression', ex)
    case 'routine-prog': return t('Routine progression')
    case 'reorder': return t('Reorder exercises')
    case 'superset': return c.after?.link ? t('Superset {0} with {1}', ex, exTitle(c.after.with)) : t('Unlink superset on {0}', ex)
    case 'add-routine': return t('Add routine “{0}”', c.after?.name)
    case 'remove-routine': return t('Remove a routine')
    case 'rename-routine': return t('Rename routine to “{0}”', c.after)
    case 'week': return Number.isInteger(c.target?.weekday) ? t('{0}: what’s planned', t(DAYN[c.target.weekday])) : t('Change what’s planned on one day')
    default: return c.type
  }
}

/** Short before/after strings for the diff column. */
export function changeValues(c, S) {
  const routineName = id => (S?.routines || []).find(r => r.id === id)?.name || id
  const fmt = v => {
    // `week` first — its value is a routine-id list (an array is also an object, so it has to
    // win before the generic branches). Render as " + "-joined routine names; null / empty /
    // "rest" all read as Rest.
    if (c.type === 'week') {
      const ids = [].concat(v ?? []).filter(x => x && x !== 'rest')
      return ids.length ? ids.map(routineName).join(' + ') : t('Rest')
    }
    if (v == null) return '–'
    if (typeof v === 'object') return v.id ? exTitle(v.id) : v.name || JSON.stringify(v)
    if (Array.isArray(v)) return v.length + ''
    return String(v)
  }
  if (['add-exercise', 'add-routine', 'reorder'].includes(c.type)) return null
  if (['remove-exercise', 'remove-routine'].includes(c.type)) return null
  return { before: fmt(c.before), after: fmt(c.after) }
}

/* ============================ the card ============================ */

const KIND_TITLE = {
  dayplan: c => t('Plan for {0}', fmtDate(c.target?.date)),
  'workout-add': c => t('Log a workout on {0}', fmtDate(c.after?.d)),
  'workout-edit': c => t('Edit the workout of {0}', fmtDate(c.workoutDate)),
  'workout-delete': c => t('Delete the workout of {0}', fmtDate(c.workoutDate)),
  'bodyweight-set': c => t('Body weight on {0}', fmtDate(c.target?.date)),
  'bodyweight-delete': c => t('Delete the weigh-in of {0}', fmtDate(c.target?.date)),
  'exnote-set': c => t('Note on {0}', exTitle(c.target?.exId)),
  'custom-ex-add': c => t('New exercise “{0}”', c.after?.n),
  'custom-ex-edit': c => t('Edit your exercise “{0}”', c.lines?.[0]?.k?.split(':')[0] || ''),
  'custom-ex-delete': c => t('Delete your exercise “{0}”', c.before),
  setting: c => t('Setting: {0}', c.target?.key),
  'profile-set': () => t('Your coach profile')
}
export const isPlanChange = c => !!c && !KIND_TITLE[c.type]

/**
 * A change as the card shows it: a title, and rows of before/after. Plan changes read their
 * values off the live plan (names, not ids); every other kind carries its own `lines`, plain
 * strings the server worked out, which keeps reading right after the data has moved on.
 */
export function describeChange(c, S) {
  if (KIND_TITLE[c.type]) {
    return { title: KIND_TITLE[c.type](c), rows: (c.lines || []).map(l => ({ label: l.k, before: l.before, after: l.after })) }
  }
  const v = changeValues(c, S)
  return { title: changeTitle(c, S), rows: v ? [{ label: null, before: v.before, after: v.after }] : [] }
}
