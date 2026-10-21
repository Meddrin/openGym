/* How one profile's data is read for the assistant.
 *
 * The assistant sees a profile only through its tools (assistant/tools.js), and what those
 * tools return is cut here, by name and by type: every field is copied in on purpose, nothing
 * is spread, and a field added to the state blob next year cannot ride along by accident.
 * The consent screen makes a promise about which categories reach the provider; this is where
 * that promise is kept or quietly broken.
 *
 * Excluded on purpose and permanently: the profile's display name and user id, passkey and
 * credential material, push subscriptions, invite data, theme and appearance settings, and
 * every other profile's everything.
 */
import { glyphStr } from './glyphs.js';
import { LIB_BY_ID } from './library.js';

// The most a session note can be: the app's own cap (frontend/src/lib/history.js NOTE_MAX, pinned
// by api/test/payload-parity.test.js), so a note the athlete wrote arrives whole and the bound only
// holds for a document edited outside the app.
export const NOTE_MAX = 500;

/* ---------- what a person typed, bounded ----------
   Every free-text field below rides into the prompt, and the prompt is paid for by whoever runs
   the instance: the Coach spends one instance-wide key. The intake screen caps what it lets you
   type, but this module never sees that screen. It reads the profile from a POST body or from
   the synced state, and a client can fill either with megabytes (the only server limit is the
   5 MB body cap). So the text is cut here, the one place both the server and the phone build a
   payload, to the limits the intake screen shows (CoachIntake.jsx). The system prompt already
   reads this text as data rather than instruction (common rule 3); the bound is about size.
   A field of the wrong type reads as absent rather than as "[object Object]". */
export const PROFILE_TEXT_MAX = { limitations: 600, likes: 300, dislikes: 300, notes: 600 };
// Goal and experience are enum words today (strength, returning, ...); 40 leaves room for new
// ones without letting either carry a paragraph.
export const PROFILE_WORD_MAX = 40;
// The equipment taxonomy has 28 values, the longest 20 characters.
export const PROFILE_EQUIPMENT_MAX = 40;
// Routine, workout and custom-exercise names have no length limit in the app. The Coach writes
// its own names at 40 (validate.js); twice that keeps any name a person would really type.
export const NAME_MAX = 80;
const text = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const word = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);

/** A language tag's shape ('de', 'pt-BR', 'zh_Hant'), or null — for a language that arrives with
 *  a request or from the environment rather than from the state (#303). */
export const langTag = v => (typeof v === 'string' && /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/.test(v.trim()) ? v.trim() : null);
// Zero reads as absent, as `|| null` always made it; anything else is clamped into range.
const count = (v, lo, hi) => {
  const n = typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n ? Math.min(hi, Math.max(lo, Math.round(n))) : null;
};
// A weekday is 0-6, as a number or a one-digit string; null must not turn into Sunday.
const weekday = d => (typeof d === 'number' ? d : typeof d === 'string' && /^\d$/.test(d) ? Number(d) : NaN);

/* ---------- what the plan and the log hold, bounded by type ----------
   The plan, the logged sets, the body-weight series and the exercise ids come from the same
   client-written state as the profile, and PUT /api/data checks no more than that workouts and
   routines are arrays. A field copied as it came is a field that can carry a megabyte of text
   into the prompt, so each one is read by what it is meant to be. Anything else reads as
   absent, as a wrong-typed profile field does. */
// The app's own ids are uid() (13 characters) or a four-digit catalogue number; 64 is room for
// any id an import or an older build ever wrote, and no room for a paragraph.
export const ID_MAX = 64;
// The progression engine's policies (frontend/src/lib/progression.js POLICIES, validate.js).
const POLICIES = ['off', 'linear', 'greyskull', 'double', 'time'];
const ident = v => (typeof v === 'string' ? v.slice(0, ID_MAX) : typeof v === 'number' && Number.isFinite(v) ? v : null);
const policy = v => (POLICIES.includes(v) ? v : null);
// A finite number, or a number written as a short string (the app writes numbers, but a
// hand-made import may not, and the model reads "20" as well as 20). Kept as given rather than
// converted, so a Coach change's `before` still equals what the plan holds.
const NUMERIC = /^-?\d{1,9}(\.\d{1,6})?$/;
const num = v => ((typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && NUMERIC.test(v)) ? v : undefined);
// A date is the ISO day every screen writes; anything else is not a date.
const day = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const list = v => (Array.isArray(v) ? v : []);
export function cleanProfile(profile) {
  const days = Array.isArray(profile.preferredDays) ? profile.preferredDays : [];
  const equipment = Array.isArray(profile.equipment) ? profile.equipment : [];
  return {
    goal: word(profile.goal, PROFILE_WORD_MAX),
    experience: word(profile.experience, PROFILE_WORD_MAX),
    daysPerWeek: count(profile.daysPerWeek, 1, 7),
    // Weekdays 0-6, each once: seven entries is the whole week, so anything past that is noise.
    preferredDays: [...new Set(days.map(weekday).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))],
    sessionMin: count(profile.sessionMin, 1, 24 * 60),
    equipment: equipment.filter(e => typeof e === 'string' && e).slice(0, PROFILE_EQUIPMENT_MAX).map(e => e.slice(0, PROFILE_WORD_MAX)),
    limitations: text(profile.limitations, PROFILE_TEXT_MAX.limitations),
    likes: text(profile.likes, PROFILE_TEXT_MAX.likes),
    dislikes: text(profile.dislikes, PROFILE_TEXT_MAX.dislikes),
    notes: text(profile.notes, PROFILE_TEXT_MAX.notes)
  };
}

/* ---------- the data categories the consent screen names (FR-09/10) ----------
   Kept here, next to the code that acts on it, and rendered by the consent UI from the same
   list — a screen that drifts from the payload is worse than no screen. */
export { DATA_CATEGORIES } from './categories.js';

/* ---------- reading a session the way the engine reads it ----------
   Duplicated from frontend/src/lib/history.js rather than shared: the two runtimes have no
   build step in common, and this is the same trade-off server.js already made for
   effectiveRoutineId. frontend/src/lib/coach-parity.test.js pins modeOf, isBw and isPerSide
   against the frontend's own copies over a shared table of configs, so the duplicate cannot
   drift silently — which it otherwise would have, quietly, when v1.2.4 taught the app about
   bodyweight work. isWarmupSet and readSession are duplicated the same way but were pinned by
   nothing; api/test/payload-parity.test.js pins them now. It has to be a separate file: that
   test imports the frontend's own readSession, and a vitest test cannot import into a
   node:test file or back. */
export const modeOf = (cfg, ex) => {
  const m = cfg && cfg.mode;
  if (m === 'reps' || m === 'time' || m === 'cardio') return m;
  return ex && ex.bp === 'cardio' ? 'cardio' : 'reps';
};

/* Two flags that ride on top of a mode rather than making new ones (upstream #31/#32), and
   both matter to the Coach for the same reason: on a bodyweight exercise `w` is *added* load,
   so it is 0 on a perfectly good session, and every load-shaped signal — volume, e1RM, "is it
   going up" — reads as a flat zero. A Coach that could not see this would look at a push-up
   progression that is working and propose adding weight to a push-up.

   Absent reads as false on every plan written before these existed, exactly as upstream. */
export const isBw = (cfg, ex) =>
  (cfg && cfg.bodyweight != null ? !!cfg.bodyweight : (ex && ex.eq) === 'body weight');
export const isPerSide = cfg => !!(cfg && cfg.side);
// Mirror of frontend/src/lib/workout-model.js isWarmupRow: an explicit phase wins, else the
// legacy boolean. A warm-up row is prep, not the session: it is filtered out of the stall
// count exactly as progression.js filters it, it never counts as a done set or a top set,
// and where it does travel (the last few sessions in full) it is flagged so the model reads
// "0x12 warm-up" as what it is rather than as a failed set.
export const isWarmupSet = s => {
  const ph = typeof s?.phase === 'string' ? s.phase.trim().toLowerCase() : '';
  if (ph) return ph === 'warmup' || ph === 'warm-up' || ph === 'warm_up';
  return s?.warmup === true;
};
/* ---------- plan cleaning (mirrors plan-share.js cleanEx) ---------- */
function cleanEx(e) {
  const o = { id: ident(e.id), name: LIB_BY_ID.get(e.id)?.n || null, sets: num(e.sets) };
  const mode = modeOf(e, LIB_BY_ID.get(e.id));
  o.mode = mode;
  const put = (k, v) => { if (num(v) !== undefined) o[k] = v; };
  if (mode === 'cardio') { put('min', e.min); put('speed', e.speed); }
  else if (mode === 'time') { put('sec', e.sec); if (e.weight) put('weight', e.weight); }
  else { put('reps', e.reps); if (e.weight) put('weight', e.weight); }
  if (policy(e.prog)) o.prog = e.prog;
  if (e.inc > 0) put('inc', e.inc);
  put('repsMin', e.repsMin);
  // repsMax is the ceiling that turns "+1 rep forever" into "add a set and start over"; without
  // it the Coach cannot see, or propose, how a bodyweight exercise is meant to progress.
  put('repsMax', e.repsMax);
  // Triple progression's set ceiling: `sets` is where its cycle starts, `setsMax` where it ends.
  put('setsMax', e.setsMax);
  // Written out only when they disagree with the catalogue, matching plan-share.js — an
  // absent flag has always meant "whatever the exercise says", and still does.
  if (e.bodyweight != null) o.bodyweight = !!e.bodyweight;
  if (e.side) o.side = true;
  // A superset tag is an id the app mints (sg-0-1, hs + uid()), so it is bounded like one.
  if (e.sg) o.sg = ident(e.sg);
  return o;
}
/**
 * The plan reduced to exactly the fields that decide whether it has *changed* — mode-aware,
 * with every absent value written out as a zero so "no weight" and "0 kg" cannot hash apart.
 *
 * frontend/src/lib/coach.js mirrors this function field for field. That duplication is the
 * price of the two runtimes sharing no build step, and it is load-bearing: if the two ever
 * disagree, every proposal reads as stale and the feature quietly stops working. coach.test.js
 * pins them together against shared fixtures.
 */
export function canonicalPlan(S) {
  const custom = new Map((S.customEx || []).map(c => [c.id, c]));
  const exOf = id => LIB_BY_ID.get(id) || custom.get(id);
  return {
    routines: (S.routines || []).map(r => ({
      id: r.id, name: r.name || '', prog: r.prog || '',
      ex: (r.ex || []).map(e => {
        const mode = modeOf(e, exOf(e.id));
        return {
          id: e.id, mode, sets: e.sets || 0,
          reps: mode === 'reps' ? (e.reps || 0) : 0,
          sec: mode === 'time' ? (e.sec || 0) : 0,
          min: mode === 'cardio' ? (e.min || 0) : 0,
          speed: mode === 'cardio' ? (e.speed || 0) : 0,
          weight: mode === 'cardio' ? 0 : (e.weight || 0),
          prog: e.prog || '', inc: e.inc || 0, repsMin: e.repsMin || 0, repsMax: e.repsMax || 0,
          // Resolved rather than copied: the fingerprint has to change when a plan starts
          // disagreeing with the catalogue, and `bodyweight: undefined` and an exercise the
          // dataset already calls bodyweight are the same plan and must hash the same.
          bodyweight: isBw(e, exOf(e.id)), side: isPerSide(e),
          sg: e.sg || ''
        };
      })
    })),
    // A weekday holds a routine-id list. `[].concat` folds a legacy bare string and a
    // one-element list to the same shape (so their fingerprint is identical); `?.length` keeps
    // a stray `[]` out; insertion order is preserved and never sorted (it is the merge order).
    week: Object.fromEntries([1, 2, 3, 4, 5, 6, 0].filter(d => S.week?.[d]?.length).map(d => [d, [].concat(S.week[d])]))
  };
}

export function cleanPlan(S) {
  // Names are typed by the person, so they are cut like the profile's text. The icon is held to
  // what the validator lets a plan carry (an icon key or a legacy emoji, core/glyphs.js): it is
  // the client's state, and free text in it would ride into every prompt.
  const routines = list(S.routines).filter(r => r && typeof r === 'object').map(r => ({
    id: ident(r.id), name: r.name == null ? r.name : text(String(r.name), NAME_MAX),
    emoji: r.emoji == null ? r.emoji : glyphStr(String(r.emoji)),
    ...(policy(r.prog) ? { prog: r.prog } : {}),
    ex: list(r.ex).filter(e => e && typeof e === 'object').map(cleanEx)
  }));
  // A weekday holds routine ids, so each entry is bounded like one.
  const week = {};
  [1, 2, 3, 4, 5, 6, 0].forEach(d => { if (S.week?.[d]?.length) week[d] = [].concat(S.week[d]).map(ident); });
  return { routines, week };
}

