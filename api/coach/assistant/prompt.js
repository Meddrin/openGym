/* What the model is told on the server: one system prompt, and the conversation as the user turn.
 *
 * The system prompt is the file api/coach/prompts/assistant.md, read once at load. It is the
 * same for every job (nothing user- or day-specific in it), so a provider that caches a prefix
 * can. The conversation is built by transcript.js, which has no filesystem in it so the phone can
 * use it too.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SYSTEM_PROMPT = fs.readFileSync(fileURLToPath(new URL('../prompts/assistant.md', import.meta.url)), 'utf8').trim();

export { HISTORY_TURNS, TURN_CHARS, turnText, buildPrompt } from './transcript.js';
