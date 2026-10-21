// Applying what the assistant proposed, and taking it back.
//
// The server checked the change set before it reached the chat. This module checks it again, on
// this device, against the state as it is right now, with the very same code
// (api/coach/core/changes.js): a proposal that validates again to exactly what was shown is
// still true, and anything else — a workout deleted on another device, a weigh-in edited since,
// a routine renamed — means the card is out of date and nothing is applied. All or nothing: Apply
// runs every change or none, because it runs inside store.update, whose draft is thrown away if
// anything throws.
//
// An apply is ordinary local editing. It takes an undo snapshot of every top-level key it is
// about to touch, edits the draft the way a person would, and logs a line; the sync carries it
// like any other change, and Undo puts the snapshot back. A list that can be large (workouts,
// weigh-ins, own exercises) is snapshotted per record rather than whole, so an apply that edits
// one workout does not put the whole history into the synced state.
//
// This file is imported lazily by the chat: it brings the exercise catalogue with it (the server's
// validator needs it to say an id is real), and the rest of the app has no use for that.
import {
  validateChangeSet, applyDataChange, touchedKeys, DATA_TYPES, workoutHash
} from '../../../api/coach/core/changes.js'
import { applyPlanChange, appendLog, pushRawSnapshot, popSnapshot, snapshotsOf, exTitle } from './coach.js'
import { stampWorkout } from './sync-merge.js'
import { workoutVolume, cleanupSg } from './history.js'
import { rebuildPrHistory } from './workout-date.js'
import { lowerKeptWeights } from './session-edit.js'
import { exerciseMuscleSnapshot } from './muscles.js'
import { todayISO } from './format.js'
import { t } from './i18n.js'

export { workoutHash }

const clone = o => JSON.parse(JSON.stringify(o))
const list = v => (Array.isArray(v) ? v : [])
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const LIST_KEYS = ['workouts', 'bodyweight', 'customEx']

/**
 * Is this proposal still true of the state? `{ ok: true, changes }` with the changes as they
 * read now, or `{ ok: false, reason }` — `invalid` (it cannot be read at all, or no longer
 * applies) or `stale` (it reads, but the data it was written against has moved).
 */
export function checkProposal(S, proposal) {
  if (!proposal || !Array.isArray(proposal.changes) || !proposal.changes.length) return { ok: false, reason: 'invalid', errors: ['nothing to apply'] }
  const ids = proposal.changes.filter(c => c && c.type === 'workout-add').map(c => c.after && c.after.id)
  let k = 0
  const fresh = validateChangeSet(S, { summary: proposal.summary, changes: proposal.changes }, {
    today: todayISO(),
    // A workout that is added keeps the id it was shown with; the server minted it.
    newId: () => ids[k++] || 'w' + Date.now().toString(36)
  })
  // Everything it asks for is already so (done by hand, or by another device): out of date, not wrong.
  if (!fresh.ok) return { ok: false, reason: fresh.unchanged ? 'stale' : 'invalid', errors: fresh.errors }
  if (fresh.changes.length !== proposal.changes.length) return { ok: false, reason: 'stale', errors: fresh.skipped }
  for (let i = 0; i < fresh.changes.length; i++) {
    const a = fresh.changes[i], b = proposal.changes[i]
    if (a.type !== b.type || !same(a.before, b.before) || !same(a.after, b.after)) return { ok: false, reason: 'stale', errors: [a.type] }
  }
  return { ok: true, changes: fresh.changes }
}

/* ---------- the undo snapshot ---------- */

// Which records of each list a change set touches.
function touchedRecords(S, changes) {
  const workouts = new Set(), bodyweight = new Set(), customEx = new Set()
  for (const c of changes) {
    if (c.type === 'workout-add') workouts.add(String(c.after.id))
    else if (c.type === 'workout-edit' || c.type === 'workout-delete') workouts.add(String(c.target.workoutId))
    else if (c.type === 'bodyweight-set' || c.type === 'bodyweight-delete') bodyweight.add(c.target.date)
    else if (c.type === 'custom-ex-add') customEx.add(c.after.id)
    else if (c.type === 'custom-ex-edit' || c.type === 'custom-ex-delete') customEx.add(c.target.exId)
    // Deleting an own exercise writes its name into every logged entry that used it.
    if (c.type === 'custom-ex-delete') {
      for (const w of list(S.workouts)) if (list(w?.entries).some(e => e?.id === c.target.exId)) workouts.add(String(w.id))
    }
  }
  return { workouts, bodyweight, customEx }
}
const idOf = { workouts: w => String(w?.id), bodyweight: b => b?.d, customEx: x => x?.id }

/** The snapshot an Undo puts back: every touched top-level key, whole for the small ones and
 *  per record for the lists. `{ absent: true }` stands for a key that did not exist. */
export function takeSnapshot(S, proposalId, label, changes, now = Date.now()) {
  const keys = {}
  for (const k of touchedKeys(changes)) {
    if (LIST_KEYS.includes(k)) continue
    if (k === 'coach.profile') keys[k] = S.coach && S.coach.profile !== undefined ? clone(S.coach.profile) : { absent: true }
    else keys[k] = S[k] === undefined ? { absent: true } : clone(S[k])
  }
  const lists = {}
  const rec = touchedRecords(S, changes)
  for (const name of LIST_KEYS) {
    if (!rec[name].size) continue
    lists[name] = {}
    for (const id of rec[name]) {
      const found = list(S[name]).find(x => idOf[name](x) === id)
      lists[name][id] = found ? clone(found) : null
    }
  }
  // Back-dating or editing a workout can grant or revoke the personal-record badges of the ones
  // around it (rebuildPrHistory), so the badges of every workout are part of what an Undo restores.
  const prs = {}
  if (lists.workouts || touchedKeys(changes).includes('workouts')) {
    for (const w of list(S.workouts)) if (w && w.id != null && list(w.prs).length) prs[String(w.id)] = clone(w.prs)
  }
  return { v: 2, at: now, proposalId, label, keys, lists, ...(Object.keys(prs).length || lists.workouts ? { prs } : {}) }
}

const sortWorkouts = ws => ws.sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : (x.start || 0) - (y.start || 0)))

/** Put one snapshot back onto the draft `s`. */
export function restoreSnapshot(s, snap, now = Date.now()) {
  if (!snap.v) {
    // Before the assistant a snapshot held the plan and nothing else.
    s.routines = clone(snap.routines || [])
    s.week = clone(snap.week || {})
    if (snap.dayPlanRestore) Object.assign(s.dayPlan = s.dayPlan || {}, snap.dayPlanRestore)
    return
  }
  for (const [k, v] of Object.entries(snap.keys || {})) {
    if (k === 'coach.profile') {
      s.coach = s.coach || {}
      if (v && v.absent) delete s.coach.profile; else s.coach.profile = clone(v)
    } else if (v && v.absent && Object.keys(v).length === 1) delete s[k]
    else s[k] = clone(v)
  }
  for (const [name, byId] of Object.entries(snap.lists || {})) {
    s[name] = list(s[name])
    for (const [id, record] of Object.entries(byId)) {
      const i = s[name].findIndex(x => idOf[name](x) === id)
      if (record === null) { if (i >= 0) s[name].splice(i, 1); continue }
      const back = clone(record)
      // A restored record is a change like any other, newer than the one it undoes: an old stamp
      // would lose to the edit on every device that already has it.
      if (name === 'workouts') stampWorkout(back, now)
      if (name === 'bodyweight') back.t = now
      if (i >= 0) s[name][i] = back; else s[name].push(back)
    }
    if (name === 'workouts') sortWorkouts(s.workouts)
    if (name === 'bodyweight') s.bodyweight.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
  }
  // The badges of the workouts that were not touched, as they were.
  if (snap.prs) {
    for (const w of list(s.workouts)) {
      if (!w || w.id == null || snap.lists?.workouts?.[String(w.id)] !== undefined) continue
      const was = snap.prs[String(w.id)]
      if (was) w.prs = clone(was)
      else if (list(w.prs).length) w.prs = []
    }
  }
}

/* ---------- apply and undo ---------- */

/** What a saved workout needs beyond its data: its volume, its badges, the kept working weights. */
function workoutHooks(now) {
  return {
    now,
    afterWorkouts(s, ids, old) {
      const touched = ids.map(id => list(s.workouts).find(w => String(w?.id) === id)).filter(Boolean)
      for (const w of touched) { w.vol = Math.round(workoutVolume(w)); stampWorkout(w, now) }
      const exIds = [...new Set([...list(old?.entries), ...touched.flatMap(w => list(w.entries))].map(e => e?.id).filter(id => id != null))]
      s.workouts = rebuildPrHistory(s.workouts, exIds, touched[0] || null)
      // A kept working weight that came from the session is lowered only when the edit or the
      // delete took it away; one added after the fact never raises it.
      if (old) lowerKeptWeights(s, exIds, old, touched[0] ? s.workouts.find(w => String(w?.id) === String(touched[0].id)) : null)
    },
    muscleSnapshot: exerciseMuscleSnapshot,
    cleanupSg
  }
}

/** The short form kept in the log: enough to read back, never the data itself. */
const brief = c => ({ type: c.type, target: c.target || null, why: c.why })

/**
 * Apply a proposal to the draft `s` (call it inside store.update). Throws, and so discards
 * everything, when the proposal is no longer true. Returns { applied, logId }.
 */
export function applyProposal(s, proposal, now = Date.now()) {
  const chk = checkProposal(s, proposal)
  if (!chk.ok) throw Object.assign(new Error(chk.reason), { reason: chk.reason, errors: chk.errors })
  const { changes } = chk
  pushRawSnapshot(s, takeSnapshot(s, proposal.id, t('Before the assistant’s changes'), changes, now))
  const hooks = workoutHooks(now)
  for (const c of changes) {
    if (DATA_TYPES.includes(c.type)) applyDataChange(s, c, hooks)
    else applyPlanChange(s, c)
  }
  const logId = appendLog(s, {
    kind: 'assistant', at: now, proposalId: proposal.id, summary: proposal.summary || '',
    changes: changes.map(brief)
  })
  return { applied: changes.length, logId }
}

/** Put back what the newest apply changed. False when that is not this proposal's. */
export function undoProposal(s, proposalId, now = Date.now()) {
  const snaps = snapshotsOf(s)
  const last = snaps[snaps.length - 1]
  if (!last || last.proposalId !== proposalId) return false
  popSnapshot(s)
  restoreSnapshot(s, last, now)
  appendLog(s, { kind: 'revert', at: now, proposalId, summary: t('Undid the assistant’s changes.') })
  return true
}

export { exTitle }
