/* The data categories the consent screen names (FR-09/10).
 *
 * Its own tiny module so a screen that only needs to *say* what would leave can import six
 * strings without pulling the exercise catalogue behind them. The consent screen renders from
 * this list, and the assistant's tools (assistant/tools.js) are the only way any of it reaches
 * the provider, so the screen cannot promise less than can leave.
 *
 * Unlike the old fixed payload, nothing here is sent up front: the assistant asks for what a
 * question needs, one tool call at a time, and every category is something one of those tools
 * can return. The chat itself is the sixth: what you type and what it answered, last twenty turns. */
export const DATA_CATEGORIES = Object.freeze([
  'plan',        // routines, exercises, sets/reps, schedule, per-date overrides, progression settings
  'training',    // logged workouts it looks up: sets, weights, reps, effort, durations, notes
  'bodyweight',  // weigh-ins and your goal weight
  'profile',     // intake answers (limitations, injuries), standing exercise notes, your own exercises
  'prefs',       // unit, language, effort scale, the settings it may change
  'chat'         // your messages to it and its recent replies
]);
