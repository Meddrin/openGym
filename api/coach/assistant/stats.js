/* The numbers the assistant's get_stats tool reports, computed from one profile's state.
 *
 * Pure functions over a plain state object: no file, no clock they were not handed. They are
 * the server's own small copies of what the Stats screen computes (estimated one-rep max,
 * weekly hard sets per muscle, plan adherence), because the image carries nothing from the
 * frontend. api/test/assistant-stats.test.js pins the one formula that must agree with the app
 * (Epley) against the frontend's own implementation.
 */
import { LIB_BY_ID } from '../core/library.js';
import { isWarmupSet } from '../core/payload.js';

const list = v => (Array.isArray(v) ? v : []);
const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v);
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/** At or above this many reps an estimate says more about endurance than about a max. */
export const REP_CAP = 12;
/** A set this close to failure is the kind that drives adaptation (frontend lib/effort.js). */
export const HARD_RIR = 3;

/** Epley, the app's default formula (frontend lib/onerm.js). Null outside 1..REP_CAP reps. */
export const epley = (w, r) => (w > 0 && Number.isInteger(r) && r >= 1 && r <= REP_CAP ? w * (1 + r / 30) : null);

const rirOf = s => (s.rir != null ? Number(s.rir) : s.rpe != null ? 10 - Number(s.rpe) : s.failure === true ? 0 : null);
export const isWorkingSet = s => !!s && typeof s === 'object' && s.done === true && !isWarmupSet(s);

const muscleOf = (S, id) => {
  const row = LIB_BY_ID.get(id) || list(S.customEx).find(c => c && c.id === id);
  return (row && (row.tg || row.bp)) || null;
};
const nameOf = (S, id) => (LIB_BY_ID.get(id) || list(S.customEx).find(c => c && c.id === id) || {}).n || null;

function* eachSet(S, fromDate) {
  for (const w of list(S.workouts)) {
    if (!w || !w.d || (fromDate && w.d < fromDate)) continue;
    for (const e of list(w.entries)) {
      if (!e) continue;
      for (const s of list(e.sets)) if (isWorkingSet(s)) yield { w, e, s };
    }
  }
}

const dayOfWeek = iso => new Date(iso + 'T12:00:00Z').getUTCDay();
const addDays = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
/** The first day of the week containing `iso`, for a week that starts on `weekStart` (0 = Sunday). */
export const weekStartOf = (iso, weekStart = 1) => addDays(iso, -((dayOfWeek(iso) - weekStart + 7) % 7));
const weekStartSetting = S => (S.weekStart === 0 || S.weekStart === 1 || S.weekStart === 6 ? S.weekStart : 1);

/** Best estimated one-rep max per exercise: the all-time best, and the most recent session's. */
export function strength(S, { exerciseId = null, limit = 15 } = {}) {
  const by = new Map();
  for (const { w, e, s } of eachSet(S, null)) {
    if (exerciseId && e.id !== exerciseId) continue;
    const est = epley(Number(s.w), Number(s.r));
    if (est == null) continue;
    let x = by.get(e.id);
    if (!x) { x = { id: e.id, name: nameOf(S, e.id), days: new Set(), best: null, last: null }; by.set(e.id, x); }
    x.days.add(w.d);
    if (!x.best || est > x.best.e1rm) x.best = { e1rm: round(est), d: w.d, w: Number(s.w), r: Number(s.r) };
    if (!x.last || w.d > x.last.d || (w.d === x.last.d && est > x.last.e1rm)) x.last = { e1rm: round(est), d: w.d, w: Number(s.w), r: Number(s.r) };
  }
  return [...by.values()]
    .sort((a, b) => b.days.size - a.days.size)
    .slice(0, limit)
    .map(x => ({ id: x.id, name: x.name, sessions: x.days.size, bestE1rm: x.best, lastSession: x.last }));
}

/** Working sets per muscle per week, for the last `weeks` weeks (the current one included). */
export function weeklyVolume(S, { weeks = 8, today }) {
  const ws = weekStartSetting(S);
  const thisWeek = weekStartOf(today, ws);
  const first = addDays(thisWeek, -7 * (weeks - 1));
  const buckets = new Map();
  for (let i = 0; i < weeks; i++) buckets.set(addDays(first, i * 7), {});
  const unrated = { sets: 0, rated: 0 };
  for (const { w, e, s } of eachSet(S, first)) {
    const b = buckets.get(weekStartOf(w.d, ws));
    if (!b) continue;
    const m = muscleOf(S, e.id) || 'other';
    const cell = (b[m] = b[m] || { sets: 0, hardSets: 0 });
    cell.sets++;
    unrated.sets++;
    const rir = rirOf(s);
    if (rir != null) { unrated.rated++; if (rir <= HARD_RIR) cell.hardSets++; }
  }
  return {
    weekStartsOn: ws,
    weeks: [...buckets.entries()].map(([start, m]) => ({ start, muscles: m })),
    ratedShare: unrated.sets ? round(unrated.rated / unrated.sets, 2) : null
  };
}

/** Planned training days a week against the days actually trained, week by week. */
export function adherence(S, { weeks = 8, today }) {
  const ws = weekStartSetting(S);
  const planned = Object.keys(isMap(S.week) ? S.week : {}).filter(k => [].concat(S.week[k] || []).length).length;
  const thisWeek = weekStartOf(today, ws);
  const days = new Set(list(S.workouts).filter(w => w && w.d).map(w => w.d));
  const out = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = addDays(thisWeek, -7 * i);
    let trained = 0;
    for (let d = 0; d < 7; d++) if (days.has(addDays(start, d))) trained++;
    out.push({ start, trainedDays: trained, current: i === 0 });
  }
  const done = out.filter(w => !w.current);
  const ratio = planned && done.length ? round(done.reduce((n, w) => n + Math.min(w.trainedDays, planned), 0) / (planned * done.length), 2) : null;
  return { plannedDaysPerWeek: planned, weeks: out, adherenceOfCompletedWeeks: ratio };
}

/** Everything in one object, for the default get_stats call. */
export function summary(S, { weeks = 8, today } = {}) {
  return {
    strength: strength(S),
    weeklyVolume: weeklyVolume(S, { weeks, today }),
    adherence: adherence(S, { weeks, today })
  };
}
