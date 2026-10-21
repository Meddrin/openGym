/* Change sets: what the assistant may ask for, how that is checked, and how it is carried out.
 *
 * The assistant never writes anybody's state. It proposes a change set (the `propose_changes`
 * tool), the server checks it against the profile it was written for, and the client shows it
 * as a card. Tapping Apply runs it on the client as ordinary local edits, so the existing sync
 * and merge carry it like any other change, and Undo puts back what it touched.
 *
 * This module is the one place that defines the closed list of change types. It is pure over a
 * plain state object `S` — no file, no clock it was not handed, no DOM — so the server runs it
 * to refuse a bad proposal before the user ever sees it, and the client runs the very same code
 * again before applying. Two copies of "what is allowed" would be two places to disagree.
 *
 * Two families:
 *   · plan changes — the 18 types the plan-review engine always had (add-exercise, sets, week,
 *     ...). They are checked by validateReview (validate.js) and applied by the client's own
 *     engine in frontend/src/lib/coach.js; this file only routes them there.
 *   · everything else the person can edit in the app (the kinds below). Those are checked and
 *     applied here, which is what lets the server prove on a throwaway copy that a change set
 *     applies cleanly before it is offered.
 *
 * Errors are collected rather than thrown one at a time: the model reads them in the same job
 * and fixes its proposal, and a list of four problems gives a better second attempt than one.
 */
import { validateReview, CHANGE_TYPES as PLAN_TYPES } from './validate.js';
import { LIBRARY, LIB_BY_ID, libraryHas } from './library.js';
import { cleanPlan, isWarmupSet, NOTE_MAX, NAME_MAX } from './payload.js';

export { PLAN_TYPES };

/** The kinds that are not plan changes. */
export const DATA_TYPES = [
  'dayplan',
  'workout-add', 'workout-edit', 'workout-delete',
  'bodyweight-set', 'bodyweight-delete',
  'exnote-set',
  'custom-ex-add', 'custom-ex-edit', 'custom-ex-delete',
  'setting', 'profile-set'
];
export const CHANGE_KINDS = [...PLAN_TYPES, ...DATA_TYPES];

export const MAX_CHANGES = 25;
export const WHY_MAX = 600;

/* ---------- small readers ---------- */

const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v);
const list = v => (Array.isArray(v) ? v : []);
const isStr = v => typeof v === 'string' && v.trim().length > 0;
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const clamp = (v, n) => String(v == null ? '' : v).slice(0, n);
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const RESERVED = ['__proto__', 'constructor', 'prototype'];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const validDate = s => {
  if (typeof s !== 'string' || !ISO.test(s)) return false;
  const t = Date.parse(s + 'T12:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
};
const dayDiff = (a, b) => Math.round((Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 86400000);
const addDays = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const todayOf = ctx => ctx?.today || new Date().toISOString().slice(0, 10);

const customList = S => list(S.customEx).filter(c => c && typeof c === 'object' && c.id != null);
const customById = (S, id) => customList(S).find(c => c.id === id) || null;
/** An exercise id the person can use: the catalogue, or one of their own. */
export const exerciseKnown = (S, id, ctx) => typeof id === 'string' && (libraryHas(id) || !!customById(S, id) || !!(ctx && ctx.extraIds && ctx.extraIds.has(id)));
export const exerciseName = (S, id) => LIB_BY_ID.get(id)?.n || customById(S, id)?.n || null;
const exerciseRow = (S, id) => LIB_BY_ID.get(id) || customById(S, id) || null;

/* A workout is named by its id. One logged before ids existed has none, and the app freezes a
   key for it the first time it is edited (lib/session-edit.js) — which is the app's job, not the
   assistant's. Such a workout can be read but not changed. */
export const workoutRef = w => (w && w.id != null ? String(w.id) : null);
export const findWorkout = (S, id) => list(S.workouts).find(w => w && w.id != null && String(w.id) === String(id)) || null;

/* ---------- logged sets ---------- */

const SET_FIELDS = ['r', 'w', 'sec', 'min', 'speed', 'rir', 'rpe'];
const SET_LIMITS = {
  r: [0, 1000, true], w: [0, 2000, false], sec: [0, 86400, true], min: [0, 1440, false], speed: [0, 60, false],
  rir: [0, 10, false], rpe: [1, 10, false]
};

const checkField = (k, v, where, errors) => {
  const [lo, hi, int] = SET_LIMITS[k];
  if (!isNum(v) || v < lo || v > hi || (int && !Number.isInteger(v))) {
    errors.push(`${where}.${k} must be ${int ? 'a whole number' : 'a number'} from ${lo} to ${hi}`);
    return false;
  }
  return true;
};
const hasWork = s => ['r', 'w', 'sec', 'min'].some(k => s[k] != null);

/** One new set as the model wrote it -> one set as the app stores it, or a reason it cannot be. */
function cleanSet(raw, where, errors) {
  if (!isMap(raw)) { errors.push(`${where} is not an object`); return null; }
  const out = {};
  for (const k of SET_FIELDS) {
    if (raw[k] == null) continue;
    if (!checkField(k, raw[k], where, errors)) return null;
    out[k] = raw[k];
  }
  if (!hasWork(out)) { errors.push(`${where} needs at least one of r (reps), w (weight), sec, min`); return null; }
  if (out.rir != null && out.rpe != null) { errors.push(`${where} carries both rir and rpe — give one`); return null; }
  out.done = raw.done === false ? false : true;
  // `phase: 'warmup'` is the stored form, so a change that was validated once validates again.
  if (raw.warmup === true || raw.phase === 'warmup') out.phase = 'warmup';
  else if (raw.failure === true) out.failure = true;
  return out;
}

/** An existing set, edited: what the patch leaves out keeps its value, including the details a
 *  typed set cannot carry (per-side rows, drops, timestamps). A field set to null is removed. */
function patchSet(old, patch, where, errors) {
  const merged = { ...old };
  for (const k of SET_FIELDS) {
    if (patch[k] === undefined) continue;
    if (patch[k] === null) { delete merged[k]; continue; }
    if (!checkField(k, patch[k], where, errors)) return null;
    merged[k] = patch[k];
  }
  if (patch.rir != null) delete merged.rpe;
  if (patch.rpe != null) delete merged.rir;
  if (patch.done !== undefined) merged.done = patch.done !== false;
  if (patch.warmup !== undefined) { if (patch.warmup) merged.phase = 'warmup'; else { delete merged.phase; delete merged.warmup; } }
  if (patch.failure !== undefined) { if (patch.failure) merged.failure = true; else delete merged.failure; }
  if (!hasWork(merged)) { errors.push(`${where} would be left with no reps, weight, sec or min`); return null; }
  return merged;
}

const PATCH_KEYS = [...SET_FIELDS, 'done', 'warmup', 'failure'];
const pick = (raw, keys) => Object.fromEntries(keys.filter(k => raw[k] !== undefined).map(k => [k, raw[k]]));

/**
 * The sets of one entry, as { finished, patch }, or null when the list itself is unusable.
 * `base` is the entry's existing sets when it is being edited. `patch` is the cleaned form of
 * what was asked for (an edit of an existing set keeps its `index`, a new set is whole): it is
 * what a change stores, so applying later works from the live workout and validating it again
 * gives the same answer.
 */
function mergeSets(rawSets, base, where, errors) {
  if (!Array.isArray(rawSets) || !rawSets.length) { errors.push(`${where}.sets must list at least one set`); return null; }
  if (rawSets.length > 30) { errors.push(`${where}.sets lists more than 30 sets`); return null; }
  const finished = [], patch = [];
  const used = new Set();
  rawSets.forEach((raw, i) => {
    const w = `${where}.sets[${i}]`;
    if (isMap(raw) && raw.index != null) {
      const old = base ? base[raw.index] : null;
      if (!Number.isInteger(raw.index) || !isMap(old) || used.has(raw.index)) {
        errors.push(`${w}.index ${JSON.stringify(raw.index)} is not an existing set of this exercise, or is named twice (it has ${base ? base.length : 0} sets, indices from 0)`);
        return;
      }
      used.add(raw.index);
      const fields = pick(raw, PATCH_KEYS);
      if (!Object.keys(fields).length) { finished.push(old); patch.push({ index: raw.index }); return; }
      const merged = patchSet(old, fields, w, errors);
      if (merged) { finished.push(merged); patch.push({ index: raw.index, ...fields }); }
      return;
    }
    const cleaned = cleanSet(raw, w, errors);
    if (cleaned) { finished.push(cleaned); patch.push(cleaned); }
  });
  return { finished, patch };
}

/**
 * The entries of a workout after an edit, as { finished, patch }. `rawEntries` lists EVERY
 * exercise that should remain: `{index}` keeps or edits an existing one, `{id, sets}` adds one,
 * and one left out is removed. Run by validation, and again by the apply on the live workout.
 */
function buildEntries(S, w, rawEntries, ctx, bad) {
  const have = list(w.entries);
  const seen = new Set();
  const finished = [], patch = [];
  rawEntries.slice(0, 30).forEach((e, i) => {
    const where = `after.entries[${i}]`;
    if (!isMap(e)) { bad.push(`${where} is not an object`); return; }
    if (e.index != null) {
      const old = have[e.index];
      if (!Number.isInteger(e.index) || !isMap(old) || seen.has(e.index)) { bad.push(`${where}.index ${JSON.stringify(e.index)} is not an existing exercise of this workout, or is named twice (it has ${have.length}, indices from 0)`); return; }
      if (e.id != null && e.id !== old.id) { bad.push(`${where}.id "${e.id}" does not match the exercise at index ${e.index} ("${old.id}") — omit id when editing an existing exercise`); return; }
      seen.add(e.index);
      const kept = { ...old };
      const item = { index: e.index };
      if (e.sets !== undefined) {
        const r = mergeSets(e.sets, list(old.sets), where, bad);
        if (!r) return;
        kept.sets = r.finished;
        item.sets = r.patch;
      }
      if (e.note !== undefined) {
        const n = e.note == null ? '' : String(e.note).trim().slice(0, NOTE_MAX);
        item.note = n;
        if (n) kept.note = n; else { delete kept.note; delete kept.notePin; }
      }
      finished.push(kept); patch.push(item);
    } else {
      if (!isStr(e.id) || !exerciseKnown(S, e.id, ctx)) { bad.push(`${where}.id "${e.id}" is not in the exercise library or your own exercises`); return; }
      const r = mergeSets(e.sets, null, where, bad);
      if (!r) return;
      const note = isStr(e.note) ? clamp(e.note.trim(), NOTE_MAX) : null;
      finished.push({ id: e.id, sets: r.finished, target: null, ...(note ? { note } : {}) });
      patch.push({ id: e.id, sets: r.patch, ...(note ? { note } : {}) });
    }
  });
  return { finished, patch };
}

/** What the person did with an exercise, in one short line: "3 sets: 60x8, 60x8, 60x7". */
export function setsLine(sets) {
  const parts = list(sets).filter(isMap).map(s => {
    const eff = s.rir != null ? ' @RIR' + s.rir : s.rpe != null ? ' @RPE' + s.rpe : '';
    const wu = isWarmupSet(s) ? ' (warm-up)' : '';
    if (s.sec != null && s.r == null) return (s.w ? s.w + 'x' : '') + s.sec + 's' + eff + wu;
    if (s.min != null && s.r == null) return s.min + 'min' + (s.speed != null ? '/' + s.speed : '') + eff + wu;
    return (s.w != null && s.w !== 0 ? s.w + 'x' : '') + (s.r != null ? s.r : '?') + eff + wu + (s.done === false ? ' (not done)' : '');
  });
  return list(sets).length + ' set' + (list(sets).length === 1 ? '' : 's') + (parts.length ? ': ' + parts.join(', ') : '');
}
const entryLine = (S, e) => `${exerciseName(S, e.id) || e.id}: ${setsLine(e.sets)}${e.note ? ' [note]' : ''}`;
export const workoutLines = (S, w) => list(w.entries).filter(isMap).map(e => entryLine(S, e));

/** A workout reduced to what decides whether it changed: the staleness check on both sides. */
export function workoutFp(w) {
  if (!w) return null;
  return JSON.stringify([w.d, w.name || '', w.note || '', list(w.entries).map(e => [e?.id, e?.note || '',
    list(e?.sets).map(s => SET_FIELDS.map(k => s?.[k] ?? null).concat([s?.done ? 1 : 0, isWarmupSet(s) ? 1 : 0, s?.failure ? 1 : 0]))])]);
}
const hash = str => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
};
export const workoutHash = w => (w ? hash(workoutFp(w)) : null);

/* ---------- settings the assistant may change ---------- */

const bool = v => typeof v === 'boolean';
/** Key → [check, human description]. A weight unit is deliberately absent: switching it
 *  converts every logged weight, which is a data migration with its own confirmation in Settings,
 *  not a value to flip inside an undoable change set. */
export const SETTINGS = {
  restSec: [v => isInt(v, 5, 900), 'rest between sets, whole seconds 5-900'],
  restPauseSec: [v => isInt(v, 3, 120), 'rest inside a rest-pause set, whole seconds 3-120'],
  sound: [bool, 'true or false'],
  keepAwake: [bool, 'true or false'],
  timedSetOvertime: [bool, 'true or false'],
  effort: [v => ['none', 'rir', 'rpe'].includes(v), 'one of none, rir, rpe'],
  weekStart: [v => v === 0 || v === 1 || v === 6, '0 (Sunday), 1 (Monday) or 6 (Saturday)'],
  wdec: [v => v === 1 || v === 2, '1 or 2 decimals on weights'],
  targetW: [v => v === null || (isNum(v) && v >= 20 && v <= 1500), 'goal body weight in the profile unit (20-1500), or null to clear'],
  oneRmFormula: [v => ['epley', 'brzycki', 'lombardi', 'oconner', 'mayhew', 'wathan', 'lander', 'weighted'].includes(v), 'one of epley, brzycki, lombardi, oconner, mayhew, wathan, lander, weighted'],
  speedUnit: [v => v === null || v === 'kmh' || v === 'mph', 'kmh, mph, or null to follow the weight unit'],
  equipFilterOn: [bool, 'true or false']
};

const PROFILE_ENUMS = {
  goal: ['strength', 'muscle', 'general', 'fatloss', 'endurance'],
  experience: ['new', 'returning', 'regular']
};
const PROFILE_TEXT = { limitations: 600, likes: 300, dislikes: 300, notes: 600 };
export const PROFILE_KEYS = ['goal', 'experience', 'daysPerWeek', 'preferredDays', 'sessionMin', 'equipment', 'limitations', 'likes', 'dislikes', 'notes'];

const BODY_PARTS = [...new Set([...LIBRARY.map(e => e.bp), 'cardio'])].sort();
const TARGETS = new Set(LIBRARY.map(e => e.tg).filter(Boolean));

/* ---------- reading what a change is about ---------- */

const lastBodyweight = S => {
  const all = list(S.bodyweight).filter(b => b && b.d && Number(b.w) > 0).sort((a, b) => (a.d < b.d ? -1 : 1));
  return all.length ? Number(all[all.length - 1].w) : null;
};
const bwOn = (S, d) => list(S.bodyweight).find(b => b && b.d === d) || null;

/* ---------- validation of the non-plan kinds ---------- */

/* Each validator returns { change } or { error }. `change` carries `before` read off the
   state (never taken from the model — it is the one field on a change nothing else constrains),
   the normalised `after`, the target, and `lines` (what the card shows, before and after, as
   plain strings that read the same in any language). */
const V = {
  dayplan(S, c, ctx) {
    const date = c.target?.date;
    if (!validDate(date)) return { error: 'target.date must be an ISO date (YYYY-MM-DD)' };
    const today = todayOf(ctx);
    if (date < addDays(today, -30) || date > addDays(today, 400)) return { error: `target.date ${date} is outside the window from 30 days ago to 400 days ahead` };
    const a = c.after;
    if (a != null && a !== 'rest' && !list(S.routines).some(r => r && r.id === a)) return { error: 'after must be a routine id from the plan, "rest", or null (to clear the override)' };
    const before = S.dayPlan?.[date] ?? null;
    if (same(before, a ?? null)) return { skip: `${date} already reads that way` };
    const name = id => (id === 'rest' ? 'Rest' : id == null ? 'as scheduled' : list(S.routines).find(r => r?.id === id)?.name || id);
    return { change: { type: 'dayplan', target: { date }, before, after: a ?? null, lines: [{ k: date, before: name(before), after: name(a ?? null) }] } };
  },

  'workout-add'(S, c, ctx, errors) {
    const a = c.after;
    if (!isMap(a)) return { error: 'after must be an object describing the workout' };
    if (!validDate(a.d)) return { error: 'after.d must be the ISO date the session happened on (YYYY-MM-DD)' };
    const today = todayOf(ctx);
    if (a.d > addDays(today, 1)) return { error: 'after.d is in the future — only sessions that already happened can be logged' };
    if (a.d < '2000-01-01') return { error: 'after.d is implausibly old' };
    if (a.startTime != null && !HHMM.test(a.startTime)) return { error: 'after.startTime must be HH:MM, 24-hour' };
    if (a.durationMin != null && !isInt(a.durationMin, 1, 600)) return { error: 'after.durationMin must be whole minutes 1-600' };
    if (a.routineId != null && !list(S.routines).some(r => r?.id === a.routineId)) return { error: 'after.routineId is not one of the routines in the plan' };
    const entries = [];
    const bad = [];
    (Array.isArray(a.entries) ? a.entries : []).slice(0, 20).forEach((e, i) => {
      const where = `after.entries[${i}]`;
      if (!isMap(e) || !isStr(e.id)) { bad.push(`${where}.id is required`); return; }
      if (!exerciseKnown(S, e.id, ctx)) { bad.push(`${where}.id "${e.id}" is not in the exercise library or your own exercises — find one with search_exercises`); return; }
      const r = mergeSets(e.sets, null, where, bad);
      if (!r) return;
      entries.push({ id: e.id, ...(isStr(e.note) ? { note: clamp(e.note.trim(), NOTE_MAX) } : {}), sets: r.finished });
    });
    if (!Array.isArray(a.entries) || !a.entries.length) bad.push('after.entries must list at least one exercise');
    if (bad.length) { errors.push(...bad); return { handled: true }; }
    if (!entries.some(e => e.sets.some(s => s.done && !isWarmupSet(s)))) return { error: 'a logged workout needs at least one completed working set' };
    // The id is minted here, so the card, the server's record and the client's apply agree on it.
    // One that is already there (a proposal validated again on the client) is kept.
    const id = typeof a.id === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(a.id) && !findWorkout(S, a.id) ? a.id
      : ctx.newId ? ctx.newId() : 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const after = {
      id, d: a.d,
      name: isStr(a.name) ? clamp(a.name.trim(), NAME_MAX) : (a.routineId ? list(S.routines).find(r => r.id === a.routineId)?.name || 'Workout' : 'Workout'),
      ...(isStr(a.note) ? { note: clamp(a.note.trim(), NOTE_MAX) } : {}),
      startTime: a.startTime || '18:00', durationMin: a.durationMin || 60,
      ...(a.routineId ? { routineId: a.routineId } : {}),
      entries
    };
    return {
      change: {
        type: 'workout-add', target: {}, before: null, after,
        lines: [{ k: `${after.d} ${after.name}`, before: null, after: entries.map(e => entryLine(S, e)).join('\n') }]
      }
    };
  },

  'workout-edit'(S, c, ctx, errors) {
    const id = c.target?.workoutId;
    const w = isStr(id) ? findWorkout(S, id) : null;
    if (!w) return { error: `target.workoutId "${id}" is not a workout you can edit — use an id from list_workouts` };
    const a = c.after;
    if (!isMap(a)) return { error: 'after must be an object with the fields to change' };
    const out = {};
    const bad = [];
    if (a.d !== undefined) {
      if (!validDate(a.d) || a.d > addDays(todayOf(ctx), 1)) bad.push('after.d must be an ISO date that is not in the future');
      else if (a.d !== w.d) out.d = a.d;
    }
    if (a.name !== undefined) {
      if (!isStr(a.name)) bad.push('after.name must be a non-empty string'); else if (clamp(a.name.trim(), NAME_MAX) !== (w.name || '')) out.name = clamp(a.name.trim(), NAME_MAX);
    }
    if (a.note !== undefined) {
      const n = a.note == null ? '' : String(a.note).trim();
      if (n.length > NOTE_MAX) bad.push(`after.note is longer than ${NOTE_MAX} characters`);
      else if (n !== (w.note || '').trim()) out.note = n;   // '' clears
    }
    let finishedEntries = null;
    if (a.entries !== undefined) {
      if (!Array.isArray(a.entries) || !a.entries.length) bad.push('after.entries must list the exercises that remain (to remove the whole workout use workout-delete)');
      else {
        const built = buildEntries(S, w, a.entries, ctx, bad);
        if (!bad.length) {
          if (!built.finished.some(e => list(e.sets).some(s => s.done && !isWarmupSet(s)))) bad.push('the edited workout would have no completed working set — use workout-delete to remove it');
          else if (!same(built.finished, list(w.entries))) { out.entries = built.patch; finishedEntries = built.finished; }
        }
      }
    }
    if (bad.length) { errors.push(...bad); return { handled: true }; }
    if (!Object.keys(out).length) return { skip: `workout ${id} already reads that way` };
    // What is stored is the cleaned patch, not the finished entries: applying works from the live
    // workout (its `before` hash says it has not moved), and validating again gives this answer.
    const lines = [];
    if (out.d) lines.push({ k: 'date', before: w.d, after: out.d });
    if (out.name) lines.push({ k: 'name', before: w.name || '', after: out.name });
    if (out.note !== undefined) lines.push({ k: 'note', before: w.note || '', after: out.note || '(cleared)' });
    if (out.entries) lines.push({ k: 'exercises', before: workoutLines(S, w).join('\n'), after: workoutLines(S, { entries: finishedEntries }).join('\n') });
    return { change: { type: 'workout-edit', target: { workoutId: String(w.id) }, before: workoutHash(w), after: out, lines, workoutName: w.name || null, workoutDate: w.d } };
  },

  'workout-delete'(S, c) {
    const id = c.target?.workoutId;
    const w = isStr(id) ? findWorkout(S, id) : null;
    if (!w) return { error: `target.workoutId "${id}" is not a workout you can delete — use an id from list_workouts` };
    return {
      change: {
        type: 'workout-delete', target: { workoutId: String(w.id) }, before: workoutHash(w), after: null,
        lines: [{ k: `${w.d} ${w.name || 'Workout'}`, before: workoutLines(S, w).join('\n'), after: '(deleted)' }],
        workoutName: w.name || null, workoutDate: w.d
      }
    };
  },

  'bodyweight-set'(S, c, ctx) {
    const date = c.target?.date;
    if (!validDate(date) || date > addDays(todayOf(ctx), 1) || date < '1990-01-01') return { error: 'target.date must be an ISO date that is not in the future' };
    if (!isNum(c.after) || c.after < 10 || c.after > 1500) return { error: 'after must be the body weight as a number in the profile unit (10-1500)' };
    const have = bwOn(S, date);
    const after = Math.round(c.after * 100) / 100;
    if (have && Number(have.w) === after) return { skip: `the weigh-in on ${date} already reads ${after}` };
    return { change: { type: 'bodyweight-set', target: { date }, before: have ? Number(have.w) : null, after, lines: [{ k: date, before: have ? String(have.w) : null, after: String(after) }] } };
  },

  'bodyweight-delete'(S, c) {
    const date = c.target?.date;
    const have = validDate(date) ? bwOn(S, date) : null;
    if (!have) return { error: `there is no weigh-in on ${date} to delete — see get_bodyweight` };
    return { change: { type: 'bodyweight-delete', target: { date }, before: Number(have.w), after: null, lines: [{ k: date, before: String(have.w), after: '(deleted)' }] } };
  },

  'exnote-set'(S, c, ctx) {
    const id = c.target?.exId;
    if (!exerciseKnown(S, id, ctx)) return { error: `target.exId "${id}" is not in the exercise library or your own exercises` };
    const a = c.after == null ? '' : typeof c.after === 'string' ? c.after.trim() : null;
    if (a === null) return { error: 'after must be the note text, or "" / null to remove the note' };
    if (a.length > NOTE_MAX) return { error: `after is longer than ${NOTE_MAX} characters` };
    const before = S.exNotes?.[id] ? String(S.exNotes[id]) : null;
    if ((before || '') === a) return { skip: `the note for ${exerciseName(S, id)} already reads that way` };
    return { change: { type: 'exnote-set', target: { exId: id }, before, after: a || null, lines: [{ k: exerciseName(S, id) || id, before, after: a || '(removed)' }] } };
  },

  'custom-ex-add'(S, c) {
    const a = c.after;
    if (!isMap(a) || !isStr(a.n)) return { error: 'after.n (the exercise name) is required' };
    const n = clamp(a.n.trim(), NAME_MAX);
    if (!BODY_PARTS.includes(a.bp)) return { error: `after.bp must be one of ${BODY_PARTS.join(', ')}` };
    if (a.tg != null && a.tg !== '' && !TARGETS.has(a.tg)) return { error: `after.tg "${a.tg}" is not a muscle the app knows (examples: ${[...TARGETS].slice(0, 8).join(', ')})` };
    if (customList(S).some(x => String(x.n || '').trim().toLowerCase() === n.toLowerCase())) return { error: `you already have a custom exercise called "${n}"` };
    let id = a.id != null ? String(a.id) : null;
    if (id != null && (!/^c[A-Za-z0-9_-]{2,40}$/.test(id) || RESERVED.includes(id))) return { error: 'after.id must start with "c" and use letters, digits, - or _ (or be omitted)' };
    if (id && (exerciseKnown(S, id))) return { error: `after.id "${id}" is already taken` };
    if (!id) id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const after = {
      id, n, bp: a.bp, tg: a.tg || '', eq: isStr(a.eq) ? clamp(a.eq.trim(), 40) : '',
      desc: isStr(a.desc) ? clamp(a.desc.trim(), 1000) : ''
    };
    return { change: { type: 'custom-ex-add', target: {}, before: null, after, lines: [{ k: n, before: null, after: [a.bp, after.tg, after.eq].filter(Boolean).join(' · ') }] } };
  },

  'custom-ex-edit'(S, c) {
    const id = c.target?.exId;
    const cur = customById(S, id);
    if (!cur) return { error: `target.exId "${id}" is not one of your own exercises (see get_my_exercises) — catalogue exercises cannot be edited` };
    const a = c.after;
    if (!isMap(a)) return { error: 'after must be an object with the fields to change' };
    const out = {};
    if (a.n !== undefined) { if (!isStr(a.n)) return { error: 'after.n must be a non-empty name' }; out.n = clamp(a.n.trim(), NAME_MAX); }
    if (a.bp !== undefined) { if (!BODY_PARTS.includes(a.bp)) return { error: `after.bp must be one of ${BODY_PARTS.join(', ')}` }; out.bp = a.bp; }
    if (a.tg !== undefined) { if (a.tg && !TARGETS.has(a.tg)) return { error: `after.tg "${a.tg}" is not a muscle the app knows` }; out.tg = a.tg || ''; }
    if (a.eq !== undefined) out.eq = clamp(String(a.eq || '').trim(), 40);
    if (a.desc !== undefined) out.desc = clamp(String(a.desc || '').trim(), 1000);
    for (const k of Object.keys(out)) if (same(out[k], cur[k] ?? '')) delete out[k];
    if (!Object.keys(out).length) return { skip: `exercise ${cur.n} already reads that way` };
    const before = {};
    for (const k of Object.keys(out)) before[k] = cur[k] ?? '';
    return { change: { type: 'custom-ex-edit', target: { exId: id }, before, after: out, lines: Object.keys(out).map(k => ({ k: `${cur.n}: ${k}`, before: String(before[k]), after: String(out[k]) })) } };
  },

  'custom-ex-delete'(S, c) {
    const id = c.target?.exId;
    const cur = customById(S, id);
    if (!cur) return { error: `target.exId "${id}" is not one of your own exercises (see get_my_exercises)` };
    if (list(S.active?.entries).some(e => e?.id === id)) return { error: `"${cur.n}" is in the workout that is running right now — it cannot be deleted until that is finished` };
    const used = list(S.routines).filter(r => list(r?.ex).some(e => e?.id === id)).map(r => r.name);
    return {
      change: {
        type: 'custom-ex-delete', target: { exId: id }, before: cur.n, after: null,
        lines: [{ k: cur.n, before: used.length ? `used in: ${used.join(', ')}` : 'not in any routine', after: '(deleted; removed from routines, logged sets keep the name)' }]
      }
    };
  },

  setting(S, c) {
    const key = c.target?.key;
    const spec = typeof key === 'string' && Object.hasOwn(SETTINGS, key) ? SETTINGS[key] : null;
    if (!spec) return { error: `target.key "${key}" is not a setting you can change — allowed: ${Object.keys(SETTINGS).join(', ')} (the weight unit is changed in Settings, because it converts every logged weight)` };
    if (!spec[0](c.after)) return { error: `after for "${key}" must be ${spec[1]}` };
    const before = S[key] ?? null;
    if (same(before, c.after)) return { skip: `${key} already is ${JSON.stringify(c.after)}` };
    return { change: { type: 'setting', target: { key }, before, after: c.after, lines: [{ k: key, before: before == null ? null : String(before), after: c.after == null ? '(none)' : String(c.after) }] } };
  },

  'profile-set'(S, c) {
    const a = c.after;
    if (!isMap(a) || !Object.keys(a).length) return { error: `after must be an object with some of: ${PROFILE_KEYS.join(', ')}` };
    const out = {};
    for (const [k, v] of Object.entries(a)) {
      if (!PROFILE_KEYS.includes(k)) return { error: `after.${k} is not a coach-profile field (allowed: ${PROFILE_KEYS.join(', ')})` };
      if (PROFILE_ENUMS[k]) { if (!PROFILE_ENUMS[k].includes(v)) return { error: `after.${k} must be one of ${PROFILE_ENUMS[k].join(', ')}` }; out[k] = v; }
      else if (k === 'daysPerWeek') { if (!isInt(v, 1, 7)) return { error: 'after.daysPerWeek must be 1-7' }; out[k] = v; }
      else if (k === 'sessionMin') { if (!isInt(v, 10, 360)) return { error: 'after.sessionMin must be whole minutes 10-360' }; out[k] = v; }
      else if (k === 'preferredDays') {
        if (!Array.isArray(v) || v.some(d => !isInt(d, 0, 6))) return { error: 'after.preferredDays must be weekday numbers 0 (Sunday) to 6' };
        out[k] = [...new Set(v)].sort();
      } else if (k === 'equipment') {
        if (!Array.isArray(v) || v.some(e => !isStr(e))) return { error: 'after.equipment must be a list of equipment names' };
        out[k] = v.slice(0, 40).map(e => clamp(e.trim(), 40));
      } else {
        if (typeof v !== 'string') return { error: `after.${k} must be text` };
        out[k] = clamp(v.trim(), PROFILE_TEXT[k]);
      }
    }
    const cur = isMap(S.coach?.profile) ? S.coach.profile : {};
    for (const k of Object.keys(out)) if (same(out[k], cur[k] ?? (Array.isArray(out[k]) ? [] : ''))) delete out[k];
    if (!Object.keys(out).length) return { skip: 'the coach profile already reads that way' };
    const before = {};
    for (const k of Object.keys(out)) before[k] = cur[k] ?? null;
    const show = v => (v == null ? null : Array.isArray(v) ? v.join(', ') : String(v));
    return { change: { type: 'profile-set', target: {}, before, after: out, lines: Object.keys(out).map(k => ({ k, before: show(before[k]), after: show(out[k]) })) } };
  }
};

/* ---------- what each change touches, for the undo snapshot ---------- */

const PLAN_ROUTINES = ['add-exercise', 'remove-exercise', 'swap-exercise', 'sets', 'reps', 'repsMin', 'repsMax', 'sec', 'cardio', 'reorder', 'superset', 'routine-prog', 'exercise-prog', 'inc', 'add-routine', 'rename-routine'];
/** The top-level keys of the state a change set writes to. `coach.profile` is its own entry:
 *  `coach` also holds the snapshots themselves, which must never be rolled back by an undo. */
export function touchedKeys(changes) {
  const keys = new Set();
  for (const c of changes) {
    const t = c.type;
    if (PLAN_ROUTINES.includes(t)) keys.add('routines');
    else if (t === 'remove-routine') ['routines', 'week', 'dayPlan', 'queue'].forEach(k => keys.add(k));
    else if (t === 'week') keys.add('week');
    else if (t === 'dayplan') keys.add('dayPlan');
    else if (t.startsWith('workout-')) { keys.add('workouts'); keys.add('exWeights'); }
    else if (t.startsWith('bodyweight-')) keys.add('bodyweight');
    else if (t === 'exnote-set') keys.add('exNotes');
    else if (t === 'custom-ex-add' || t === 'custom-ex-edit') keys.add('customEx');
    else if (t === 'custom-ex-delete') ['customEx', 'routines', 'workouts', 'exWeights', 'favEx'].forEach(k => keys.add(k));
    else if (t === 'setting') keys.add(c.target.key);
    else if (t === 'profile-set') keys.add('coach.profile');
  }
  return [...keys];
}

/* ---------- validating a whole proposal ---------- */

/**
 * Check a proposed change set against the profile's state.
 *
 * `input` is what the model sent: `{ summary?, changes: [{ type, target?, after?, why }] }`.
 * Returns `{ ok:true, summary, changes }` with every change normalised (`id`, `before` read off
 * the state, `after` cleaned, `lines`, `why`), or `{ ok:false, errors }`.
 *
 * `ctx.today` and `ctx.newId` are test seams; the server leaves both alone.
 */
export function validateChangeSet(S, input, ctx = {}) {
  const errors = [];
  if (!isMap(input) || !Array.isArray(input.changes)) return { ok: false, errors: ['changes must be an array of change objects'] };
  if (!input.changes.length) return { ok: false, errors: ['changes is empty — propose at least one change, or just answer in text'] };
  if (input.changes.length > MAX_CHANGES) return { ok: false, errors: [`too many changes (${input.changes.length}); send at most ${MAX_CHANGES} in one proposal`] };
  const state = isMap(S) ? S : {};

  // An exercise this same set adds can be used by the rest of it (a new custom exercise, then a
  // workout that names it), so its id counts as known while the others are checked.
  const extraIds = new Set(input.changes.filter(c => isMap(c) && c.type === 'custom-ex-add' && isMap(c.after)
    && typeof c.after.id === 'string' && /^c[A-Za-z0-9_-]{2,40}$/.test(c.after.id)).map(c => c.after.id));
  ctx = { ...ctx, extraIds };

  // Ids are assigned here, by position, whatever the model wrote: they only have to be unique,
  // and the plan validator below keeps them.
  const all = input.changes.map((c, i) => ({ i, raw: isMap(c) ? c : null }));
  const planIn = [];
  const results = new Array(all.length).fill(null);
  const skipped = [];
  all.forEach(({ i, raw }) => {
    const where = `changes[${i}]`;
    if (!raw) { errors.push(`${where} is not an object`); return; }
    if (!CHANGE_KINDS.includes(raw.type)) { errors.push(`${where}.type "${raw.type}" is not allowed — use one of: ${CHANGE_KINDS.join(', ')}`); return; }
    if (!isStr(raw.why)) { errors.push(`${where}.why is required — say in a sentence why this change is a good idea`); return; }
    if (PLAN_TYPES.includes(raw.type)) { planIn.push({ ...raw, id: 'k' + i, _i: i }); return; }
    const sub = [];
    const r = V[raw.type](state, raw, ctx, sub);
    if (sub.length) { sub.forEach(m => errors.push(`${where}: ${m}`)); return; }
    if (r.error) { errors.push(`${where} (${raw.type}): ${r.error}`); return; }
    if (r.skip) { skipped.push(`${where}: ${r.skip}`); return; }
    if (r.handled) return;
    results[i] = { id: 'k' + i, why: clamp(raw.why, WHY_MAX), ...r.change };
  });

  // The plan family goes through the plan validator, which reads the plan the way the model saw it.
  if (planIn.length) {
    const plan = cleanPlan(state);
    const verdict = validateReview(
      { summary: clamp(input.summary || '', 1200), changes: planIn.map(({ _i, ...c }) => c) },
      plan,
      { customIds: [...customList(state).map(c => c.id), ...extraIds] }
    );
    if (!verdict.ok) verdict.errors.forEach(e => errors.push(e));
    else if (verdict.nochange) skipped.push('the plan changes you proposed already match the plan');
    else {
      const byId = new Map(verdict.proposal.changes.map(c => [c.id, c]));
      for (const p of planIn) {
        const kept = byId.get(p.id);
        if (kept) results[p._i] = kept;
        else skipped.push(`changes[${p._i}]: already matches the plan`);
      }
    }
  }
  if (errors.length) return { ok: false, errors };

  const changes = results.filter(Boolean);
  // `unchanged` tells a client that checks a proposal again that it was not wrong, just already done.
  if (!changes.length) return { ok: false, unchanged: true, errors: ['nothing to change — every change already matches the current state (' + skipped.join('; ') + '). Answer in text instead.'] };

  // Company: each change is fine alone; together they must still make sense.
  const seen = new Map();
  const claim = (key, c) => {
    if (seen.has(key)) errors.push(`changes "${seen.get(key)}" and "${c.id}" both change ${key} — keep one, or merge them into one change`);
    else seen.set(key, c.id);
  };
  const removedRoutines = new Set(changes.filter(c => c.type === 'remove-routine').map(c => c.target.routineId));
  for (const c of changes) {
    if (c.type === 'dayplan') claim('the day plan of ' + c.target.date, c);
    else if (c.type.startsWith('workout-') && c.type !== 'workout-add') claim('workout ' + c.target.workoutId, c);
    else if (c.type.startsWith('bodyweight-')) claim('the weigh-in on ' + c.target.date, c);
    else if (c.type === 'exnote-set') claim('the note of ' + c.target.exId, c);
    else if (c.type === 'custom-ex-edit' || c.type === 'custom-ex-delete') claim('custom exercise ' + c.target.exId, c);
    else if (c.type === 'setting') claim('setting ' + c.target.key, c);
    else if (c.type === 'profile-set') claim('the coach profile', c);
    if (c.type === 'dayplan' && c.after && c.after !== 'rest' && removedRoutines.has(c.after)) errors.push(`change "${c.id}" schedules a routine that another change removes`);
  }
  const deleted = new Set(changes.filter(c => c.type === 'custom-ex-delete').map(c => c.target.exId));
  for (const c of changes) {
    const ids = c.type === 'workout-add' ? c.after.entries.map(e => e.id) : c.type === 'exnote-set' ? [c.target.exId] : [];
    ids.filter(id => deleted.has(id)).forEach(id => errors.push(`change "${c.id}" uses exercise "${id}", which another change deletes`));
  }
  if (errors.length) return { ok: false, errors };

  // The last word: carry the whole set out on a throwaway copy. A set that cannot apply is
  // refused here, with the model still in the job, instead of failing on somebody's phone.
  const draft = structuredClone(state);
  try {
    for (const c of changes) if (DATA_TYPES.includes(c.type)) applyDataChange(draft, c, ctx);
  } catch (e) {
    return { ok: false, errors: ['the change set does not apply cleanly: ' + (e && e.message ? e.message : String(e))] };
  }

  return { ok: true, summary: clamp(input.summary || '', 1200), changes, skipped };
}

/* ---------- carrying out the non-plan kinds ---------- */

const nowOf = ctx => (ctx && ctx.now) || Date.now();

function startOf(d, hhmm, durationMin) {
  const [h, m] = (hhmm || '18:00').split(':').map(Number);
  const [y, mo, da] = d.split('-').map(Number);
  const start = new Date(y, mo - 1, da, h, m, 0, 0).getTime();
  return { start, end: start + durationMin * 60000 };
}
const topWeight = sets => {
  let best = 0;
  for (const s of list(sets)) if (s && s.done && !isWarmupSet(s) && Number(s.w) > best) best = Number(s.w);
  return best || null;
};
const volumeOf = entries => list(entries).reduce((sum, e) => sum + list(e?.sets).reduce((v, s) => (s && s.done && !isWarmupSet(s) ? v + (Number(s.w) || 0) * (Number(s.r) || 0) : v), 0), 0);

/**
 * Apply one non-plan change to `S`, in place. Throws when its target is gone — the caller runs
 * a change set inside the store's draft, where a throw discards everything already done.
 *
 * `ctx.afterWorkouts(S, ids)` is the client's hook for what a saved workout needs beyond its
 * data (volume, personal-record badges, kept working weights); the server passes none.
 */
export function applyDataChange(S, c, ctx = {}) {
  const need = (x, what) => { if (!x) throw new Error(`${what} is gone`); return x; };
  switch (c.type) {
    case 'dayplan': {
      S.dayPlan = isMap(S.dayPlan) ? S.dayPlan : {};
      if (c.after == null) delete S.dayPlan[c.target.date]; else S.dayPlan[c.target.date] = c.after;
      return;
    }
    case 'workout-add': {
      const a = c.after;
      if (list(S.workouts).some(w => w && String(w.id) === a.id)) throw new Error('a workout with this id already exists');
      const { start, end } = startOf(a.d, a.startTime, a.durationMin);
      const entries = a.entries.map(e => ({
        id: e.id, sets: structuredClone(e.sets), topW: topWeight(e.sets), target: null,
        ...(e.note ? { note: e.note } : {})
      }));
      const rec = {
        id: a.id, d: a.d, start, end,
        routineIds: a.routineId ? [a.routineId] : [], routineId: a.routineId || null,
        name: a.name, bw: lastBodyweight(S), entries, prs: [], vol: Math.round(volumeOf(entries)),
        ...(a.note ? { note: a.note } : {})
      };
      S.workouts = list(S.workouts);
      S.workouts.push(rec);
      S.workouts.sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : (x.start || 0) - (y.start || 0)));
      if (ctx.afterWorkouts) ctx.afterWorkouts(S, [a.id]);
      return;
    }
    case 'workout-edit': {
      const i = list(S.workouts).findIndex(w => w && w.id != null && String(w.id) === c.target.workoutId);
      const w = need(S.workouts[i], 'the workout');
      const a = c.after;
      const next = { ...w };
      if (a.d) {
        const shift = dayDiff(a.d, w.d) * 86400000;
        next.d = a.d;
        if (Number.isFinite(w.start)) next.start = w.start + shift;
        if (Number.isFinite(w.end)) next.end = w.end + shift;
      }
      if (a.name) next.name = a.name;
      if (a.note !== undefined) { if (a.note) next.note = a.note; else delete next.note; }
      if (a.entries) {
        const bad = [];
        const built = buildEntries(S, w, a.entries, {}, bad);
        if (bad.length) throw new Error(bad[0]);
        next.entries = structuredClone(built.finished).map(e => ({ ...e, topW: topWeight(e.sets) }));
        next.vol = Math.round(volumeOf(next.entries));
      }
      S.workouts[i] = next;
      if (a.d) S.workouts.sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : (x.start || 0) - (y.start || 0)));
      if (ctx.afterWorkouts) ctx.afterWorkouts(S, [String(w.id)], w);
      return;
    }
    case 'workout-delete': {
      const w = need(findWorkout(S, c.target.workoutId), 'the workout');
      S.workouts = S.workouts.filter(x => x !== w);
      if (ctx.afterWorkouts) ctx.afterWorkouts(S, [], w);
      return;
    }
    case 'bodyweight-set': {
      S.bodyweight = list(S.bodyweight);
      const have = S.bodyweight.find(b => b && b.d === c.target.date);
      if (have) { have.w = c.after; have.t = nowOf(ctx); }
      else S.bodyweight.push({ d: c.target.date, w: c.after, t: nowOf(ctx) });
      S.bodyweight.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
      return;
    }
    case 'bodyweight-delete': {
      need(bwOn(S, c.target.date), 'the weigh-in');
      S.bodyweight = S.bodyweight.filter(b => b.d !== c.target.date);
      return;
    }
    case 'exnote-set': {
      S.exNotes = isMap(S.exNotes) ? S.exNotes : {};
      if (c.after) S.exNotes[c.target.exId] = c.after; else delete S.exNotes[c.target.exId];
      return;
    }
    case 'custom-ex-add': {
      const a = c.after;
      if (customById(S, a.id)) throw new Error('an exercise with this id already exists');
      S.customEx = list(S.customEx);
      S.customEx.push({
        id: a.id, n: a.n, bp: a.bp, desc: a.desc, tg: a.tg, sm: [], muscleGroups: a.tg ? [a.tg] : [],
        primaries: a.tg ? [a.tg] : [], secondaries: [], eq: a.eq, custom: true
      });
      return;
    }
    case 'custom-ex-edit': {
      const cur = need(customById(S, c.target.exId), 'the exercise');
      Object.assign(cur, c.after);
      if (c.after.tg !== undefined) { cur.primaries = c.after.tg ? [c.after.tg] : []; cur.muscleGroups = [...cur.primaries, ...list(cur.secondaries)]; }
      return;
    }
    case 'custom-ex-delete': {
      const cur = need(customById(S, c.target.exId), 'the exercise');
      for (const w of list(S.workouts)) for (const e of list(w?.entries)) {
        if (e && e.id === cur.id) {
          e.n = cur.n;
          if (ctx.muscleSnapshot && (!e.muscleSnapshot || !Object.keys(e.muscleSnapshot).length)) e.muscleSnapshot = ctx.muscleSnapshot(cur);
        }
      }
      S.customEx = S.customEx.filter(x => x.id !== cur.id);
      for (const r of list(S.routines)) if (r) r.ex = list(r.ex).filter(e => e.id !== cur.id);
      if (isMap(S.exWeights)) delete S.exWeights[cur.id];
      S.favEx = list(S.favEx).filter(id => id !== cur.id);
      if (ctx.cleanupSg) for (const r of list(S.routines)) if (r) ctx.cleanupSg(r.ex);
      return;
    }
    case 'setting': {
      S[c.target.key] = c.after;
      return;
    }
    case 'profile-set': {
      S.coach = isMap(S.coach) ? S.coach : {};
      S.coach.profile = { ...(isMap(S.coach.profile) ? S.coach.profile : {}), ...c.after };
      return;
    }
    default:
      throw new Error(`unknown change type ${c.type}`);
  }
}

/** The current value a change's `before` should still match, for the data kinds. `undefined`
 *  means there is no single value to compare (the caller then trusts the target check alone). */
export function currentOfData(S, c) {
  switch (c.type) {
    case 'dayplan': return S.dayPlan?.[c.target.date] ?? null;
    case 'workout-add': return undefined;
    case 'workout-edit': case 'workout-delete': return workoutHash(findWorkout(S, c.target.workoutId));
    case 'bodyweight-set': case 'bodyweight-delete': { const b = bwOn(S, c.target.date); return b ? Number(b.w) : null; }
    case 'exnote-set': return S.exNotes?.[c.target.exId] ? String(S.exNotes[c.target.exId]) : null;
    case 'custom-ex-add': return undefined;
    case 'custom-ex-edit': {
      const cur = customById(S, c.target.exId);
      return cur ? Object.fromEntries(Object.keys(c.before || {}).map(k => [k, cur[k] ?? ''])) : null;
    }
    case 'custom-ex-delete': return customById(S, c.target.exId)?.n ?? null;
    case 'setting': return S[c.target.key] ?? null;
    case 'profile-set': {
      const cur = isMap(S.coach?.profile) ? S.coach.profile : {};
      return Object.fromEntries(Object.keys(c.before || {}).map(k => [k, cur[k] ?? null]));
    }
    default: return undefined;
  }
}
