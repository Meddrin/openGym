/* What the model is told: one system prompt, and the conversation as the user turn.
 *
 * The system prompt is the file api/coach/prompts/assistant.md, read once at load. It is the
 * same for every job (nothing user- or day-specific in it), so a provider that caches a prefix
 * can. Everything about the person arrives through the tools, never in the prompt: the context
 * block below carries only the date, the app language and the unit, which the model needs to
 * address them before it has called anything.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SYSTEM_PROMPT = fs.readFileSync(fileURLToPath(new URL('../prompts/assistant.md', import.meta.url)), 'utf8').trim();

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
