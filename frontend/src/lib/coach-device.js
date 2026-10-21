// Mobile build only: how the Coach runs on this phone, and the little it keeps between runs.
//
// Deliberately NOT part of S. S is the training log — it syncs to a paired server, travels in
// the JSON export, and is what "back up your data" means. Which provider this phone talks to,
// today's run count and the conversation with the assistant are device
// facts, so they live in their own file next to the remote-pairing one. The API key itself is
// not even here: see coach-secrets.js.
//
// This module is intentionally light. The setup screen imports it before the user has chosen
// anything, and the promise there is that nothing AI-shaped loads until they do.
import { readJsonFile, writeJsonFile } from './mobile.js'

const FILE = 'opengym-coach.json'

export const COACH_MODES = ['off', 'server', 'byok']

const DEFAULTS = { mode: 'off', provider: null, model: null, baseUrl: null, daily: null, chat: [], rev: 0 }

let cache = null
export async function loadCoachDevice() {
  if (cache) return cache
  const saved = await readJsonFile(FILE)
  cache = { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) }
  if (!COACH_MODES.includes(cache.mode)) cache.mode = 'off'
  return cache
}
export async function saveCoachDevice(patch) {
  const next = { ...(await loadCoachDevice()), ...patch }
  cache = next
  await writeJsonFile(FILE, next)
  return next
}
/** The part of it a UI may show: never the conversation. */
export const coachDeviceSettings = d => d ? { mode: d.mode, provider: d.provider, model: d.model, baseUrl: d.baseUrl } : null

// Test seam.
export function _resetCoachDevice() { cache = null }
