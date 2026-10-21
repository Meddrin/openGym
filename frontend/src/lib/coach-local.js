// The assistant, on a phone that brings its own Anthropic key.
//
// No server. The loop the server runs for the Anthropic API — the same nine tools, the same
// system prompt, the same tool loop over the Messages API — is imported from api/coach and run
// here, in-process, so the phone gets exactly the code the server has and not a second opinion of
// it. The tools read the profile straight out of the store (there is no other profile on a phone),
// and a proposal is applied by the same engine every build uses (lib/coach-changes.js).
//
// This module is the one static importer of that code, which makes `import('./coach-local.js')`
// the whole lazy chunk: the exercise catalogue, the tools and the loop arrive together and only
// after the user chose this mode. coach-api.js dispatches here the way it dispatches to the demo,
// so the screens never learn that there is no server.
//
// Only the Anthropic API can run the assistant from here: it needs a tool loop, and the other
// providers' adapters do not have one. The status says so (`assistant.supported`), and the screen
// tells the person which provider it needs instead of offering a chat that cannot answer.
//
// What is different from the server, and on purpose:
//   - the user pays. There is no cfg.caps to lean on, so a local daily cap is not optional.
//   - the conversation lives in the device file, not in S: it is a device fact, it must not ride
//     into a backup or a sync, and a proposal waiting there survives an app kill.
import { createToolset, todayFor } from '../../../api/coach/assistant/tools.js'
import { buildPrompt } from '../../../api/coach/assistant/transcript.js'
import SYSTEM_PROMPT from '../../../api/coach/prompts/assistant.md?raw'
import { DATA_CATEGORIES } from '../../../api/coach/core/categories.js'
import { HTTP_PROVIDERS, baseUrlFor } from '../../../api/coach/core/providers.js'
import anthropic from '../../../api/coach/core/adapters/anthropic.js'
import openai from '../../../api/coach/core/adapters/openai.js'
import gemini from '../../../api/coach/core/adapters/gemini.js'
import compatible from '../../../api/coach/core/adapters/compatible.js'
import { nativeFetch } from './capacitor-fetch.js'
import { getApiKey } from './coach-secrets.js'
import { loadCoachDevice, saveCoachDevice } from './coach-device.js'
import { todayISO } from './format.js'
import { t, getLang } from './i18n.js'

export const ADAPTERS = { anthropic, openai, gemini, compatible }
export const LOCAL_DAILY_CAP = 10
export const TIMEOUT_MS = 5 * 60000
export const CHAT_MAX = 40
export const FULL_PROPOSALS = 6
const MESSAGE_MAX = 1000
const TEXT_MAX = 8000

let job = null
let last = null   // how the most recent job ended — the same shape the server's status() reports

/* ---------- what this phone is configured with ---------- */

const cfgOf = d => ({ provider: d.provider, providerOptions: d.baseUrl ? { [d.provider]: { baseUrl: d.baseUrl } } : {} })
const envOf = (d, key) => (key ? { [HTTP_PROVIDERS[d.provider].apiKeyEnv]: key } : {})
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
const supported = d => d.provider === 'anthropic' && !!ADAPTERS[d.provider]?.tools

/* ---------- the cap ---------- */

async function capState() {
  const d = await loadCoachDevice()
  const today = todayISO()
  const used = d.daily && d.daily.d === today ? d.daily.n : 0
  return { used, limit: LOCAL_DAILY_CAP }
}
async function bumpDaily() {
  const { used } = await capState()
  await saveCoachDevice({ daily: { d: todayISO(), n: used + 1 } })
}

/* ---------- the thread ---------- */

/** Bounded like the server's: the newest messages, and only the newest proposals keep their changes. */
export function boundChat(chat) {
  const out = chat.slice(-CHAT_MAX)
  let whole = 0
  for (let i = out.length - 1; i >= 0; i--) {
    const p = out[i].proposal
    if (p && Array.isArray(p.changes) && ++whole > FULL_PROPOSALS) {
      const { changes, ...rest } = p
      out[i] = { ...out[i], proposal: { ...rest, count: changes.length, kinds: [...new Set(changes.map(c => c.type))].slice(0, 8) } }
    }
  }
  return out
}
async function append(msg) {
  const d = await loadCoachDevice()
  await saveCoachDevice({ chat: boundChat([...(d.chat || []), msg]), rev: (d.rev || 0) + 1 })
}

/* ---------- the API surface coach-api.js dispatches to ---------- */

export async function localStatus() {
  const d = await loadCoachDevice()
  return {
    job, cap: await capState(), last, chatRev: d.rev || 0,
    assistant: { supported: supported(d), provider: d.provider }
  }
}
export async function localChat() {
  const d = await loadCoachDevice()
  return { chat: d.chat || [], chatRev: d.rev || 0 }
}

const STATUS_NEXT = { pending: ['applied', 'dismissed'], applied: ['undone'] }
/** What the person did with a proposal, recorded forward only, as the server records it. */
export async function localResolve(id, status) {
  const d = await loadCoachDevice()
  const chat = [...(d.chat || [])]
  const i = chat.findIndex(m => m.proposal && m.proposal.id === id)
  if (i < 0) return { ok: false, code: 'unknown' }
  const p = chat[i].proposal
  if (!(STATUS_NEXT[p.status] || []).includes(status)) return { ok: false, code: 'state', status: p.status }
  chat[i] = { ...chat[i], proposal: { ...p, status, decidedAt: Date.now() } }
  await saveCoachDevice({ chat, rev: (d.rev || 0) + 1 })
  return { ok: true, status }
}
export async function localForget() { job = null; last = null; await saveCoachDevice({ chat: [], rev: 0, daily: null }); return { ok: true } }

export async function localDisclosure() {
  const d = await loadCoachDevice()
  const meta = HTTP_PROVIDERS[d.provider] || {}
  const base = d.provider ? baseUrlFor(d.provider, cfgOf(d)) : ''
  return {
    provider: d.provider, providerLabel: meta.label || t('the configured AI provider'),
    categories: DATA_CATEGORIES, flow: 'tools', version: 2,
    // The honest difference from the self-hosted flow: it is the user's own account.
    payer: 'you', host: hostOf(base)
  }
}

/** The models the configured endpoint serves — the setup screen's list, and its reachability test. */
export async function localModels(settings, key) {
  const adapter = ADAPTERS[settings.provider]
  if (!adapter) return { ok: false, error: 'unknown provider', models: [] }
  return adapter.models(cfgOf(settings), envOf(settings, key), { fetch: nativeFetch, timeoutMs: 20000 })
}

const hostOf = url => { try { return new URL(url).host } catch { return url || '' } }

/* ---------- running a job ---------- */

const refuse = (code, message, status) => Object.assign(new Error(message), { status, code })

/**
 * One message, one job. `getS` reads the live state: the tools are bound to it, so they see
 * what the person sees, including an edit made while the assistant was thinking.
 */
export async function localSend(getS, text) {
  const S = getS()
  if (job) throw refuse('busy', t('The Coach is already thinking about your training.'), 409)
  if (!S?.coach?.consent?.agreedAt) throw refuse('consent', t('The Coach needs your go-ahead first.'), 403)
  const d = await loadCoachDevice()
  const adapter = ADAPTERS[d.provider]
  if (d.mode !== 'byok' || !adapter) throw refuse('off', t('The Coach isn’t set up on this phone.'), 503)
  if (!supported(d)) throw refuse('tools', t('The assistant needs the Anthropic API (or Claude on a server). Check Settings → AI Coach.'), 409)
  const clean = String(text || '').trim().slice(0, MESSAGE_MAX)
  if (!clean) throw refuse('empty', t('Write a message first.'), 400)
  const cap = await capState()
  if (cap.used >= cap.limit) throw refuse('cap', t('The Coach is taking a breather. You’ve used today’s {0} runs on this phone.', cap.limit), 429)

  await bumpDaily()
  const before = d.chat || []
  const message = { id: newId(), role: 'user', kind: 'text', text: clean, at: Date.now() }
  await append(message)
  job = { id: 'local-' + Date.now().toString(36), state: 'running', startedAt: Date.now() }
  // Not awaited: the screens poll, exactly as they do against a server.
  const mine = job
  run(getS, clean, before, d, adapter, mine).catch(e => finish(mine, 'failed', 'internal', String(e && e.message || e))).finally(() => { job = null })
  return { job: { id: mine.id }, message }
}

const finish = async (j, outcome, errorClass, detail, message) => {
  last = { id: j.id, outcome, errorClass: errorClass || null, at: Date.now() }
  await append(message || { id: newId(), role: 'assistant', kind: 'error', text: '', errorClass, ...(detail ? { detail: String(detail).slice(0, 300) } : {}), at: Date.now() })
}

async function run(getS, text, before, d, adapter, j) {
  const key = await getApiKey()
  const S = getS()
  const toolset = createToolset({ uid: 'device', readState: () => getS() })
  const r = await adapter.invoke({
    cfg: cfgOf(d), env: envOf(d, key), fetch: nativeFetch, tools: toolset, system: SYSTEM_PROMPT,
    model: d.model || HTTP_PROVIDERS[d.provider].defaultModel, timeoutMs: TIMEOUT_MS,
    prompt: buildPrompt({ history: before, message: text, today: todayFor(S), lang: getLang(), unit: S.unit === 'lb' ? 'lb' : 'kg' })
  })
  if (r.timedOut) return finish(j, 'failed', 'timeout')
  if (r.spawnError) return finish(j, 'failed', 'missing', r.stderr)
  if (r.code !== 0) {
    const err = (r.stderr || r.text || '').toLowerCase()
    return finish(j, 'failed', /auth|unauthor|api key|credential|token|401|403/.test(err) ? 'auth' : 'provider', r.stderr || r.text)
  }
  const proposal = toolset.proposal()
  let reply = String(r.text || '').trim().slice(0, TEXT_MAX)
  if (!reply && proposal) reply = proposal.summary || ''
  if (!reply) return finish(j, 'failed', 'unusable', 'the assistant answered with nothing')
  return finish(j, 'ready', null, null, {
    id: newId(), role: 'assistant', kind: 'text', text: reply, at: Date.now(),
    ...(proposal ? { proposal: { id: proposal.id, summary: proposal.summary || '', createdAt: proposal.createdAt, status: 'pending', changes: proposal.changes } } : {})
  })
}

// Test seam.
export function _resetLocal() { job = null; last = null }
