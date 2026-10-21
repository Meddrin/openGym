/* The conversation as the user turn of a job.
 *
 * Pure text in, text out, with nothing from the filesystem, so the phone (which runs the
 * assistant itself when it brings its own Anthropic key) builds the very same prompt the server
 * does. The system prompt itself is api/coach/prompts/assistant.md: the server reads the file
 * (prompt.js), the phone imports it as text.
 *
 * Everything about the person arrives through the tools, never in the prompt: the context block
 * carries only the date, the app language and the unit, which the model needs to address them
 * before it has called anything.
 */
/** How many earlier chat messages travel with a new one, and how much of each. */
export const HISTORY_TURNS = 20;
export const TURN_CHARS = 1500;

const STATUS_WORDS = {
  pending: 'the person has not decided yet',
  applied: 'the person applied it',
  dismissed: 'the person dismissed it',
  undone: 'the person applied it and later undid it',
  expired: 'it expired unanswered'
};

/** One earlier message as a line (or two) of the transcript. */
export function turnText(m) {
  const who = m.role === 'user' ? 'User' : 'Assistant';
  let out = `${who}: ${String(m.text || '').slice(0, TURN_CHARS)}`;
  const p = m.proposal;
  if (p && Array.isArray(p.changes) && p.changes.length) {
    const kinds = [...new Set(p.changes.map(c => c.type))].slice(0, 8).join(', ');
    out += `\n[Proposal "${String(p.summary || '').slice(0, 200)}": ${p.changes.length} change${p.changes.length === 1 ? '' : 's'} (${kinds}) — ${STATUS_WORDS[p.status] || STATUS_WORDS.pending}]`;
  }
  return out;
}

/**
 * The user turn of a job.
 * @param {{ history: object[], message: string, today: string, lang: string|null, unit: string|null }} a
 *   `history` is the chat before the new message, oldest first, as stored by jobs.js.
 */
export function buildPrompt({ history = [], message, today, lang, unit }) {
  const turns = history.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.kind !== 'error').slice(-HISTORY_TURNS);
  const parts = [];
  parts.push(`## Context\n\nToday is ${today}. App language: ${lang || 'en'}. Weight unit: ${unit || 'kg'}.`);
  if (turns.length) parts.push('## Conversation so far\n\n' + turns.map(turnText).join('\n\n'));
  parts.push('## New message from the user\n\n' + String(message || ''));
  return parts.join('\n\n');
}
