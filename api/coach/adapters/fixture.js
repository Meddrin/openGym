/* The in-repo fake provider.
 *
 * It ships with the image on purpose: it is what CI drives, and it lets an instance owner walk
 * the whole assistant loop (chat, tool calls, a proposal card, apply, undo) before connecting a
 * real account to it. It runs in-process — there is no model, so there is nothing to sandbox —
 * and it behaves like a model would: it calls the real tools through the real toolset, reads what
 * they return, and answers from that. Deliberately dumb: it never tries to be a coach.
 *
 * What it does is chosen by FIXTURE_MODE, or, when that is empty, by the message:
 *
 *   (default)         get_profile + list_workouts, then answers with what it found. A message
 *                     that mentions "weigh" also proposes logging a body weight; one that
 *                     mentions "plan" proposes one more set on the first exercise.
 *   propose-plan      always proposes one more set on the first exercise of the first routine
 *   bad-then-good     proposes a change naming an exercise nobody has, reads the refusal, and
 *                     sends a corrected one — the same-job repair the tool description promises
 *   bad-forever       keeps proposing the unknown exercise; ends with a plain answer, no card
 *   no-text           calls a tool and says nothing
 *   crash             exits the way a broken runtime does (code 3)
 *   timeout           never answers
 */
export const FIXTURE_ID = 'fixture';

const lastMessage = prompt => {
  const m = String(prompt || '').split('## New message from the user').pop();
  return (m || '').trim();
};

export default {
  id: FIXTURE_ID,
  spawns: false,
  tools: true,
  async check() { return { ok: true, version: 'fixture' }; },

  async invoke({ prompt, tools, timeoutMs }) {
    const mode = process.env.FIXTURE_MODE || '';
    if (mode === 'timeout') return { code: -1, text: '', stderr: 'timed out', timedOut: true };
    if (mode === 'crash') return { code: 3, text: '', stderr: 'fixture: simulated crash' };

    // The admin card's "Test the Coach": no tools, one small answer.
    if (!tools) return { code: 0, text: 'ok', stderr: '' };

    const msg = lastMessage(prompt);
    const profile = tools.call('get_profile');
    const workouts = tools.call('list_workouts', { limit: 5 });
    if (mode === 'no-text') return { code: 0, text: '', stderr: '' };

    const plan = tools.call('get_plan');
    const routine = (plan.routines || [])[0];
    const first = routine && routine.exercises && routine.exercises[0];
    const setsPlus = () => ({
      type: 'sets', target: { routineId: routine.id, exId: first.id }, after: (first.sets || 3) + 1,
      why: 'Every set hit its target, so one more set is the smallest useful step up.'
    });

    let proposed = '';
    if (mode === 'bad-then-good' || mode === 'bad-forever') {
      const bad = { type: 'add-exercise', target: { routineId: routine?.id }, after: { id: 'not-a-real-exercise', sets: 3, reps: 10 }, why: 'An id that resolves to nothing must never reach a plan.' };
      const r1 = tools.call('propose_changes', { summary: 'Try something new.', changes: [bad] });
      proposed = r1.ok ? 'proposed' : 'refused: ' + (r1.errors || []).join(' | ');
      if (mode === 'bad-then-good' && !r1.ok && first) {
        const r2 = tools.call('propose_changes', { summary: 'One more set.', changes: [setsPlus()] });
        proposed = r2.ok ? 'proposed after one correction' : 'refused twice';
      }
    } else if (mode === 'propose-plan' || (!mode && /plan|set/i.test(msg))) {
      if (first) proposed = tools.call('propose_changes', { summary: 'One more set on the first exercise.', changes: [setsPlus()] }).ok ? 'proposed' : 'refused';
    } else if (!mode && /weigh/i.test(msg)) {
      const t = profile.today || new Date().toISOString().slice(0, 10);
      proposed = tools.call('propose_changes', {
        summary: 'Log a weigh-in.',
        changes: [{ type: 'bodyweight-set', target: { date: t }, after: 80, why: 'You asked me to log your weight.' }]
      }).ok ? 'proposed' : 'refused';
    }

    const n = workouts.matching ?? 0;
    return {
      code: 0, stderr: '',
      text: `You have ${n} workout${n === 1 ? '' : 's'} logged (unit ${profile.unit}).${proposed ? ` Changes: ${proposed}.` : ''}`
    };
  }
};
