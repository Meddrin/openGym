// The assistant on a phone with its own Anthropic key: the same tools and the same tool loop the
// server runs, driven end to end here with a fake provider on the wire — prompt, Messages API,
// tool calls over the live state, a proposal the apply engine accepts. Also the things this mode
// has to get right on its own: the daily cap, the key never touching S or the device file, the
// conversation surviving in the device file, and every other provider being told it cannot chat.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The device file and the secret store are in-memory here; nativeFetch is the script.
const device = { data: null }
vi.mock('./mobile.js', () => ({
  MOBILE: true,
  readJsonFile: async () => device.data,
  writeJsonFile: async (_n, d) => { device.data = JSON.parse(JSON.stringify(d)) }
}))
const secret = { key: 'sk-ant-test-1' }
vi.mock('./coach-secrets.js', () => ({ getApiKey: async () => secret.key, setApiKey: async v => { secret.key = v }, clearApiKey: async () => { secret.key = null } }))
const wire = { calls: [], answers: [] }
vi.mock('./capacitor-fetch.js', () => ({
  nativeFetch: async (url, init) => {
    wire.calls.push({ url, init, body: JSON.parse(init.body) })
    const a = wire.answers[Math.min(wire.calls.length, wire.answers.length) - 1]
    return { ok: a.status < 300, status: a.status, text: async () => JSON.stringify(a.body), json: async () => a.body }
  }
}))

const local = await import('./coach-local.js')
const { _resetCoachDevice, loadCoachDevice } = await import('./coach-device.js')
const { applyProposal, checkProposal } = await import('./coach-changes.js')
const { CONSENT_VERSION } = await import('./coach.js')
const { todayISO } = await import('./format.js')

const ok = content => ({ status: 200, body: { content, stop_reason: 'end_turn' } })
const toolUse = (id, name, input) => ({ status: 200, body: { content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' } })
const say = text => ok([{ type: 'text', text }])

const state = () => ({
  unit: 'kg', lang: 'en', targetW: 80,
  routines: [{ id: 'r1', name: 'A', ex: [{ id: '0001', sets: 3, reps: 8, mode: 'reps' }, { id: '0007', sets: 3, sec: 45, mode: 'time' }] }],
  week: { 1: ['r1'] }, dayPlan: {}, customEx: [], bodyweight: [{ d: '2026-08-01', w: 80, t: 1 }],
  workouts: [{ id: 'w1', d: '2026-08-20', start: 1, end: 3600001, entries: [{ id: '0001', target: { sets: 3, reps: 8 }, sets: [{ done: true, w: 40, r: 8 }, { done: true, w: 40, r: 8 }] }] }],
  coach: { consent: { agreedAt: '2026-08-01T00:00:00Z', version: CONSENT_VERSION }, profile: null, log: [], snapshots: [] }
})

async function settle() {
  for (let i = 0; i < 400; i++) {
    const s = await local.localStatus()
    if (!s.job) return s
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error('never settled')
}

describe('the assistant on a phone with its own key', () => {
  beforeEach(() => {
    _resetCoachDevice(); local._resetLocal()
    device.data = { mode: 'byok', provider: 'anthropic', model: 'claude-t', baseUrl: null, chat: [], rev: 0 }
    wire.calls = []; wire.answers = [say('Looking good.')]; secret.key = 'sk-ant-test-1'
  })

  it('answers a message through the real tool loop, reading the live state, and keeps the thread on the device', async () => {
    const S = state()
    wire.answers = [toolUse('t1', 'get_profile', {}), say('You train in kilograms and have one workout logged.')]
    const r = await local.localSend(() => S, 'How am I doing?')
    expect(r.message).toMatchObject({ role: 'user', text: 'How am I doing?' })
    const s = await settle()
    expect(s.last).toMatchObject({ outcome: 'ready' })

    const { chat, chatRev } = await local.localChat()
    expect(chat.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(chat[1].text).toMatch(/kilograms/)
    expect(chatRev).toBe(s.chatRev)
    expect(chatRev).toBeGreaterThanOrEqual(2)

    // What went on the wire: Anthropic's shape, the key as a header, the nine tools, the system prompt.
    expect(wire.calls).toHaveLength(2)
    expect(wire.calls[0].url).toBe('https://api.anthropic.com/v1/messages')
    expect(wire.calls[0].init.headers['x-api-key']).toBe('sk-ant-test-1')
    expect(wire.calls[0].body.model).toBe('claude-t')
    expect(wire.calls[0].body.tools.map(t => t.name)).toContain('propose_changes')
    expect(wire.calls[0].body.system[0].text).toMatch(/strength and conditioning/)
    expect(wire.calls[0].body.messages[0].content).toMatch(/## New message from the user\n\nHow am I doing\?$/)
    // The second turn carries the tool's answer: the profile, read from the live state.
    const toolResult = wire.calls[1].body.messages.at(-1).content[0]
    expect(JSON.parse(toolResult.content)).toMatchObject({ unit: 'kg', totals: { workouts: 1 } })
  })

  it('the tools read what the person sees now, including an edit made while it was thinking', async () => {
    const S = state()
    let n = 0
    wire.answers = [toolUse('t1', 'get_bodyweight', {}), say('ok')]
    const real = wire.answers
    wire.answers = new Proxy(real, { get: (t, k) => { if (k === 'length') return t.length; if (k === '0') { S.bodyweight.push({ d: '2026-08-21', w: 79.1, t: 2 }); n++ } return t[k] } })
    await local.localSend(() => S, 'weight?')
    await settle()
    const result = JSON.parse(wire.calls[1].body.messages.at(-1).content[0].content)
    expect(result.entries.map(e => e.weight)).toEqual([80, 79.1])
    expect(n).toBeGreaterThan(0)
  })

  it('a proposal arrives on the reply, validated, and the ordinary engine applies it', async () => {
    const S = state()
    wire.answers = [
      toolUse('t1', 'propose_changes', { summary: 'One more set.', changes: [{ type: 'sets', target: { routineId: 'r1', exId: '0001' }, after: 4, why: 'every set was clean' }] }),
      say('I would add a set to the first exercise.')
    ]
    await local.localSend(() => S, 'add a set')
    await settle()
    const { chat } = await local.localChat()
    const p = chat[1].proposal
    expect(p).toMatchObject({ status: 'pending', summary: 'One more set.' })
    expect(p.changes[0]).toMatchObject({ type: 'sets', before: 3, after: 4 })
    expect(checkProposal(S, p).ok).toBe(true)
    applyProposal(S, p)
    expect(S.routines[0].ex[0].sets).toBe(4)
    // And the decision is recorded on the thread, forward only.
    expect(await local.localResolve(p.id, 'undone')).toMatchObject({ ok: false, code: 'state' })
    expect(await local.localResolve(p.id, 'applied')).toEqual({ ok: true, status: 'applied' })
    expect((await local.localChat()).chat[1].proposal.status).toBe('applied')
    expect(await local.localResolve('nope', 'applied')).toEqual({ ok: false, code: 'unknown' })
  })

  it('the next message carries the earlier turns', async () => {
    const S = state()
    await local.localSend(() => S, 'first question')
    await settle()
    wire.answers = [say('second answer')]
    wire.calls = []
    await local.localSend(() => S, 'second question')
    await settle()
    const prompt = wire.calls[0].body.messages[0].content
    expect(prompt).toMatch(/User: first question/)
    expect(prompt).toMatch(/Assistant: Looking good\./)
    expect(prompt).toMatch(/## New message from the user\n\nsecond question$/)
  })

  it('refuses without consent, an empty message, and a second message while one is running', async () => {
    const S = state()
    delete S.coach.consent
    await expect(local.localSend(() => S, 'hi')).rejects.toMatchObject({ code: 'consent', status: 403 })
    const S2 = state()
    await expect(local.localSend(() => S2, '   ')).rejects.toMatchObject({ code: 'empty', status: 400 })
    await local.localSend(() => S2, 'one')
    await expect(local.localSend(() => S2, 'two')).rejects.toMatchObject({ code: 'busy', status: 409 })
    await settle()
  })

  it('has a daily cap of its own, because the person pays', async () => {
    const S = state()
    for (let i = 0; i < local.LOCAL_DAILY_CAP; i++) { await local.localSend(() => S, 'q' + i); await settle() }
    expect((await local.localStatus()).cap).toEqual({ used: local.LOCAL_DAILY_CAP, limit: local.LOCAL_DAILY_CAP })
    await expect(local.localSend(() => S, 'one too many')).rejects.toMatchObject({ code: 'cap', status: 429 })
    expect(wire.calls).toHaveLength(local.LOCAL_DAILY_CAP)
    // Yesterday's count is worth nothing today.
    device.data = { ...(await loadCoachDevice()), daily: { d: '2000-01-01', n: 99 } }
    _resetCoachDevice()
    expect((await local.localStatus()).cap.used).toBe(0)
  })

  it('any provider but Anthropic is told it cannot run the assistant, before a request is made', async () => {
    for (const provider of ['openai', 'gemini', 'compatible']) {
      _resetCoachDevice()
      device.data = { mode: 'byok', provider, model: 'm', baseUrl: provider === 'compatible' ? 'https://x.example' : null, chat: [], rev: 0 }
      expect((await local.localStatus()).assistant).toEqual({ supported: false, provider })
      await expect(local.localSend(() => state(), 'hi')).rejects.toMatchObject({ code: 'tools', status: 409 })
    }
    expect(wire.calls).toHaveLength(0)
    expect((await local.localDisclosure()).provider).toBe('compatible')
  })

  it('a rejected key is an auth failure in the thread, with the provider\'s words for the person who has to fix it', async () => {
    wire.answers = [{ status: 401, body: { error: { message: 'invalid x-api-key' } } }]
    await local.localSend(() => state(), 'hi')
    const s = await settle()
    expect(s.last).toMatchObject({ outcome: 'failed', errorClass: 'auth' })
    const m = (await local.localChat()).chat.at(-1)
    expect(m).toMatchObject({ role: 'assistant', kind: 'error', errorClass: 'auth' })
    expect(m.detail).toMatch(/invalid x-api-key/)
  })

  it('an answer with nothing in it fails, and the next message still goes', async () => {
    wire.answers = [ok([])]
    await local.localSend(() => state(), 'hi')
    const s = await settle()
    expect(s.last).toMatchObject({ outcome: 'failed' })
    wire.answers = [say('fine')]
    await local.localSend(() => state(), 'again')
    expect((await settle()).last.outcome).toBe('ready')
  })

  it('the key never reaches the state or the device file, and forgetting clears the thread and the count', async () => {
    const S = state()
    await local.localSend(() => S, 'hi')
    await settle()
    expect(JSON.stringify(S)).not.toContain('sk-ant')
    expect(JSON.stringify(device.data)).not.toContain('sk-ant')
    await local.localForget()
    expect((await local.localChat()).chat).toEqual([])
    expect((await local.localStatus()).cap.used).toBe(0)
    expect((await local.localStatus()).chatRev).toBe(0)
  })

  it('bounds the thread, and old proposals shrink to a summary', () => {
    const big = i => ({ id: 'm' + i, role: 'assistant', kind: 'text', text: 'r' + i, proposal: { id: 'p' + i, status: 'applied', changes: [{ type: 'sets' }, { type: 'reps' }] } })
    const out = local.boundChat(Array.from({ length: 100 }, (_, i) => big(i)))
    expect(out).toHaveLength(local.CHAT_MAX)
    expect(out.filter(m => Array.isArray(m.proposal.changes))).toHaveLength(local.FULL_PROPOSALS)
    expect(out[0].proposal).toMatchObject({ count: 2, kinds: ['sets', 'reps'], status: 'applied' })
    expect(out.at(-1).id).toBe('m99')
  })

  it('says it is the person\'s own account that pays, and to whom the requests go', async () => {
    const d = await local.localDisclosure()
    expect(d).toMatchObject({ payer: 'you', host: 'api.anthropic.com', flow: 'tools', provider: 'anthropic' })
    expect(d.categories).toContain('chat')
  })

  it('stamps today on the cap record', async () => {
    await local.localSend(() => state(), 'hi')
    await settle()
    expect((await loadCoachDevice()).daily).toEqual({ d: todayISO(), n: 1 })
  })
})
