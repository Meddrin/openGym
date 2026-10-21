/* Running assistant jobs, and owning the conversation.
 *
 * One chat message is one job. The conversation lives here, in a file this server alone writes
 * (coach/<uid>.json), for the same reason a proposal always did: a client PUTs its whole state
 * and the newest `_ts` wins, so a reply or a proposal written into that blob would be erased
 * without trace by the next device to sync an older copy. Here the reply is safe whether the
 * phone is open or not, every device reads the same thread, and forgetting the Coach deletes it
 * (clearUser) with nothing left behind.
 *
 * A proposal rides on the assistant message that made it, with a status the client reports when
 * the person decides: pending, applied, dismissed, undone. Applying it is the client's work
 * (frontend/src/lib/coach-changes.js): ordinary local edits, so the sync carries them; the
 * server only records the decision, so the next message can say what happened to the last one.
 *
 * Everything here is deliberately in-process and file-backed. A single-core box running one
 * household's gym app does not need a job queue with a broker; it needs jobs that cannot pile
 * up, cannot run forever, and cannot lie about what happened when the container restarts.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as cfgStore from './config.js';
import { adapterFor } from './adapters/index.js';
import { langTag } from './core/payload.js';
import { fetchFor } from './node-fetch.js';
import { canDropPrivileges, unprivilegedIds } from './adapters/spawn.js';
import { invalidate as invalidateCohort } from './cohort.js';
import { createToolset, todayFor } from './assistant/tools.js';
import { SYSTEM_PROMPT, buildPrompt } from './assistant/prompt.js';

const DATA = process.env.DATA_DIR || '/data';
const COACH_DIR = path.join(DATA, 'coach');

// Five minutes by default. A local model on a small CPU box can legitimately need more; a
// cloud API that needs more has a problem. COACH_JOB_TIMEOUT_MS overrides, never below one minute.
export const TIMEOUT_MS = Math.max(60000, +process.env.COACH_JOB_TIMEOUT_MS || 5 * 60000);
const MAX_CONCURRENT = 2;          // these are minutes-scale jobs on often-single-core boxes
const PENDING_DAYS = 14;           // an undecided proposal stops being offered after this
const HISTORY_MAX = 20;            // outcomes kept, for the status line and the admin card
// The conversation is bounded twice: by count, and by bytes, because a proposal of twenty-five
// changes is far bigger than a sentence. Only the newest few proposals keep their changes; older
// ones keep what the thread needs to read them back (what, how many, what happened).
export const CHAT_MAX = 60;
export const CHAT_BYTES_MAX = 400 * 1024;
export const FULL_PROPOSALS = 8;
export const TEXT_MAX = 8000;

/* ---------- per-user store ---------- */

const safe = uid => String(uid).replace(/[^a-zA-Z0-9_-]/g, '');
const userFile = uid => path.join(COACH_DIR, safe(uid) + '.json');
const EMPTY = { daily: null, current: null, chat: [], rev: 0, history: [] };

export function readUser(uid) {
  try {
    const rec = { ...EMPTY, ...JSON.parse(fs.readFileSync(userFile(uid), 'utf8')) };
    delete rec.pending;       // proposals live on the chat message that made them now
    return rec;
  } catch { return { ...EMPTY }; }
}
function writeUser(uid, rec) {
  fs.mkdirSync(COACH_DIR, { recursive: true, mode: 0o700 });
  const file = userFile(uid), tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function patchUser(uid, patch) {
  const rec = { ...readUser(uid), ...patch };
  writeUser(uid, rec);
  return rec;
}
/** Consent revoked, profile deleted, "reset everything" — no server-side residue (FR-51).
 *  Today's job count is the one thing that stays: it is the spending record the daily cap
 *  reads, not the profile's data, and forgetting must not hand out a fresh cap; the record
 *  outlives the day only until the next job or forget touches it, and counts for nothing once
 *  the date has passed. A job still waiting in the queue is dropped here; one already mid-call
 *  is cancelled where the adapter can be (the HTTP ones — a spawned runtime runs to its end),
 *  and either way finishes without writing anything back (see finish). */
export function clearUser(uid) {
  const { daily } = readUser(uid);
  try { fs.unlinkSync(userFile(uid)); } catch { /* nothing to clear */ }
  if (daily?.date === todayISO()) writeUser(uid, { ...EMPTY, daily });
  const queued = queue.findIndex(j => j.uid === uid);
  if (queued >= 0) { queue.splice(queued, 1); inflight.delete(uid); }
  aborts.get(uid)?.abort();
  forgetSeq.set(uid, (forgetSeq.get(uid) || 0) + 1);
  invalidateCohort();
}

/** Every profile with a state file — the population a cohort is drawn from. */
export function listUserIds() {
  try {
    return fs.readdirSync(DATA).filter(f => /^state-[a-zA-Z0-9_-]+\.json$/.test(f)).map(f => f.slice(6, -5));
  } catch { return []; }
}

/* ---------- "compare with others" opt-in ----------
   Held here, in the server's own per-profile record, rather than in the synced state: the
   flag decides whether this person's numbers reach other people, and a stale device syncing
   an older copy of S must not be able to flip it back on. */
export const isSharing = uid => !!readUser(uid).share;
export function setShare(uid, share) {
  patchUser(uid, { share: !!share });
  invalidateCohort();
  return !!share;
}

export function readState(uid) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'state-' + safe(uid) + '.json'), 'utf8')); }
  catch { return null; }
}

/* ---------- caps ---------- */

const todayISO = () => new Date().toISOString().slice(0, 10);
function bumpDaily(uid) {
  const rec = readUser(uid);
  const d = todayISO();
  const daily = rec.daily?.date === d ? { date: d, count: rec.daily.count + 1 } : { date: d, count: 1 };
  patchUser(uid, { daily });
  return daily.count;
}
export function capState(uid) {
  const caps = cfgStore.load().caps || {};
  const rec = readUser(uid);
  const used = rec.daily?.date === todayISO() ? rec.daily.count : 0;
  return { used, limit: caps.perProfileDaily || 0 };
}
// The instance-wide count is kept the same way in coach.json, not read off the job log: the
// log keeps its last hundred entries, and a count that stops at a hundred is not a cap.
function bumpInstanceDaily() {
  const cur = cfgStore.load().daily;
  const d = todayISO();
  cfgStore.save({ daily: cur?.date === d ? { date: d, count: cur.count + 1 } : { date: d, count: 1 } });
}
function instanceUsedToday() {
  const daily = cfgStore.load().daily;
  return daily?.date === todayISO() ? daily.count : 0;
}

/* ---------- the conversation ---------- */

const newId = () => crypto.randomBytes(6).toString('hex');

/** An old proposal, reduced to what the thread needs to show it again. */
function compactProposal(p) {
  if (!p || !Array.isArray(p.changes)) return p;
  const { changes, ...rest } = p;
  return { ...rest, count: changes.length, kinds: [...new Set(changes.map(c => c.type))].slice(0, 8), changes: undefined };
}

/** Keep the thread inside its bounds: newest proposals whole, the rest compact, oldest dropped. */
export function boundChat(chat) {
  let out = chat.slice(-CHAT_MAX);
  let seen = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    const p = out[i].proposal;
    if (p && Array.isArray(p.changes)) { if (++seen > FULL_PROPOSALS) out[i] = { ...out[i], proposal: compactProposal(p) }; }
  }
  while (out.length > 4 && JSON.stringify(out).length > CHAT_BYTES_MAX) out = out.slice(1);
  return out;
}

/** A proposal nobody answered for two weeks is no longer on offer. Applied lazily, on read. */
function expire(chat) {
  let changed = false;
  const cutoff = Date.now() - PENDING_DAYS * 86400000;
  const out = chat.map(m => {
    const p = m.proposal;
    if (p && p.status === 'pending' && (p.createdAt || 0) < cutoff) { changed = true; return { ...m, proposal: { ...p, status: 'expired', decidedAt: Date.now() } }; }
    return m;
  });
  return { chat: out, changed };
}

function appendChat(uid, msg) {
  const rec = readUser(uid);
  const chat = boundChat([...(rec.chat || []), msg]);
  writeUser(uid, { ...rec, chat, rev: (rec.rev || 0) + 1 });
}

/** The thread, oldest first. */
export function readChat(uid) {
  const rec = readUser(uid);
  const { chat, changed } = expire(rec.chat || []);
  if (changed) writeUser(uid, { ...rec, chat, rev: (rec.rev || 0) + 1 });
  return chat;
}

const STATUS_NEXT = { pending: ['applied', 'dismissed'], applied: ['undone'] };
/**
 * The person decided what to do with a proposal. The change itself already happened, or did
 * not, on their device; this records it so the next message can say so. Only moves the status
 * forward along pending -> applied | dismissed and applied -> undone.
 */
export function resolveProposal(uid, id, status) {
  const rec = readUser(uid);
  const { chat } = expire(rec.chat || []);
  const i = chat.findIndex(m => m.proposal && m.proposal.id === id);
  if (i < 0) return { ok: false, code: 'unknown' };
  const p = chat[i].proposal;
  if (!(STATUS_NEXT[p.status] || []).includes(status)) return { ok: false, code: 'state', status: p.status };
  chat[i] = { ...chat[i], proposal: { ...p, status, decidedAt: Date.now() } };
  writeUser(uid, { ...rec, chat, rev: (rec.rev || 0) + 1 });
  return { ok: true, status };
}

/* ---------- status ---------- */

/** What the client polls. `chatRev` changes whenever the thread does, so the client fetches the
 *  thread only when it has something new to read. */
export function status(uid) {
  const rec = readUser(uid);
  const cfg = cfgStore.load();
  return {
    job: rec.current ? { id: rec.current.id, state: rec.current.state, startedAt: rec.current.startedAt } : null,
    cap: capState(uid),
    // How the most recent job ended, so the chat can close a job that failed before the first poll.
    last: lastOutcome(rec),
    chatRev: rec.rev || 0,
    // Whether the configured provider can run the assistant at all, so the screen can say which
    // provider it needs before anybody types a message.
    assistant: { supported: adapterFor(cfg.provider)?.tools === true, provider: cfg.provider }
  };
}
function lastOutcome(rec) {
  const h = (rec.history || []).at(-1);
  return h ? { id: h.id, outcome: h.outcome, errorClass: h.errorClass || null, at: h.at } : null;
}

/* ---------- the queue ---------- */

const queue = [];
let running = 0;
const inflight = new Set();     // uids with a job queued or running (FR-07 single-flight)
const forgetSeq = new Map();    // uid → bumped by every clearUser; a job carries the value it saw at enqueue
const aborts = new Map();       // uid → AbortController of the provider call in flight, for clearUser to pull

class CoachError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export { CoachError };

/**
 * Clamp a chat message to the admin's configured `maxMessageLen` (issue #267). The one place
 * this is enforced — `routes.js` only applies a generous sanity ceiling before a string reaches
 * here. Exported so the clamp itself is directly testable without walking the whole pipeline.
 */
export function clampMessage(text) {
  if (!text) return null;
  const max = cfgStore.load().maxMessageLen || 1000;
  return String(text).slice(0, max);
}

/**
 * Enqueue the job for one chat message. Throws CoachError with a code the routes layer maps to
 * an HTTP status: `off`, `tools`, `empty`, `busy`, `cap`, `consent`, `shared`, `account`,
 * `unprivileged`. Returns { id, message } — the job and the user's message as stored.
 */
export function enqueue(uid, opts = {}) {
  if (!cfgStore.isEnabled() || !cfgStore.isConnected()) throw new CoachError('off', 'the Coach is not set up on this instance');
  // The assistant is a tool loop. A provider that cannot run one is refused here, plainly,
  // rather than answering from nothing and sounding as if it had looked.
  if (adapterFor(cfgStore.load().provider)?.tools !== true) throw new CoachError('tools', 'the assistant needs the Claude provider (or the Anthropic API) on this instance');
  const text = clampMessage(typeof opts.text === 'string' ? opts.text.trim() : '');
  if (!text) throw new CoachError('empty', 'write a message first');
  if (inflight.has(uid)) throw new CoachError('busy', 'the assistant is already answering you');

  const S = readState(uid);
  // Consent is enforced here, server-side, not by the screen that collects it: a UI-only gate
  // is not a gate (FR-08/13).
  if (!S?.coach?.consent?.agreedAt) throw new CoachError('consent', 'the Coach needs your go-ahead first');

  // Whose account pays. In instance mode the credential binds to the first profile that spends
  // it and every other profile is refused outright — not warned. A warning would move the
  // decision onto whoever clicks past it, and the decision is about spending somebody else's
  // personal subscription.
  const cred = cfgStore.credentialFor(uid);
  if (!cred.ok) {
    if (cred.reason === 'shared-account') throw new CoachError('shared', cred.message);
    // Per-profile mode: this profile has not connected its own account. Its own code so the
    // Coach screen can point at the "Your account" row instead of saying the Coach is off.
    if (cred.mode === 'profile') throw new CoachError('account', cred.message);
    throw new CoachError('off', 'this profile has no provider account connected');
  }

  // The privilege drop is what keeps a provider runtime out of ./data. If it cannot be
  // performed, there is no job — see canDropPrivileges for why this is not a warning either.
  // A provider that spawns nothing has no process to drop, and is not refused for it.
  if (adapterFor(cfgStore.load().provider)?.spawns !== false) {
    const priv = canDropPrivileges();
    if (!priv.ok) throw new CoachError('unprivileged', `Coach jobs are disabled: ${priv.why}`);
  }

  const caps = cfgStore.load().caps || {};
  const { used, limit } = capState(uid);
  if (limit > 0 && used >= limit) throw new CoachError('cap', 'daily limit reached');
  if (caps.instanceDaily > 0 && instanceUsedToday() >= caps.instanceDaily) throw new CoachError('cap', 'this instance has reached its daily limit');

  // Spending is what binds: a personal credential (setup token, OAuth) belongs to the first
  // profile that runs a job on it from here on; an API key binds to nobody and is shared.
  cfgStore.bindInstanceCredential(uid);

  // Counted at enqueue, not at completion: the cap exists to bound what one profile can spend
  // of the owner's provider account, and queueing twenty jobs spends it whether or not the
  // twentieth ever finishes.
  bumpDaily(uid);
  bumpInstanceDaily();

  const message = { id: newId(), role: 'user', kind: 'text', text, at: Date.now() };
  const job = {
    id: crypto.randomBytes(8).toString('hex'),
    uid,
    forgetSeq: forgetSeq.get(uid) || 0,
    messageId: message.id,
    text,
    lang: langTag(opts.lang),                         // the language the app was showing (#303)
    state: 'queued',
    startedAt: Date.now()
  };
  inflight.add(uid);
  appendChat(uid, message);
  patchUser(uid, { current: { id: job.id, state: 'queued', startedAt: job.startedAt } });
  queue.push(job);
  pump();
  return { id: job.id, message };
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    running++;
    execute(job)
      .catch(e => { console.error('coach job crashed', job.id, e); finish(job, { outcome: 'failed', errorClass: 'internal' }); })
      .finally(() => { running--; inflight.delete(job.uid); pump(); });
  }
}

function finish(job, result) {
  cfgStore.logJob({
    at: new Date().toISOString(), uid: job.uid, kind: 'chat', trigger: 'manual',
    outcome: result.outcome, errorClass: result.errorClass || null,
    ms: Date.now() - job.startedAt, detail: result.detail || null
  });
  // Forgotten while it ran: the record is gone and stays gone, and nobody is notified. The
  // job still ran and still spent, which is why the instance log above keeps its line.
  if ((forgetSeq.get(job.uid) || 0) !== job.forgetSeq) return;
  const rec = readUser(job.uid);
  const history = [...(rec.history || []), {
    id: job.id, outcome: result.outcome, errorClass: result.errorClass || null, at: Date.now()
  }].slice(-HISTORY_MAX);
  // The reply joins the thread in the same write that clears the job, so a poll can never see
  // a finished job without its answer.
  const chat = boundChat([...(rec.chat || []), result.message]);
  writeUser(job.uid, { ...rec, current: null, chat, rev: (rec.rev || 0) + 1, history });
  // A proposal is the one event worth a notification, and only when the person has probably
  // looked away (a reply that took a while). Failures stay silent (FR-38).
  if (result.outcome === 'ready' && result.message.proposal && Date.now() - job.startedAt > 20000 && onProposal) {
    try { onProposal(job.uid, result.message.proposal, job); } catch (e) { console.error('coach notify failed', e); }
  }
}

// Set by server.js so a finished job can raise a push notification without this module
// importing the web-push plumbing (and dragging it into every test that touches the queue).
let onProposal = null;
export function setProposalHook(fn) { onProposal = fn; }

const failed = (errorClass, detail) => ({ outcome: 'failed', errorClass, ...(detail ? { detail } : {}) });
const errorMessage = errorClass => ({ id: newId(), role: 'assistant', kind: 'error', text: '', errorClass, at: Date.now() });

/* ---------- execution ---------- */

async function execute(job) {
  patchUser(job.uid, { current: { id: job.id, state: 'running', startedAt: job.startedAt } });
  const stop = (errorClass, detail) => finish(job, { ...failed(errorClass, detail), message: errorMessage(errorClass) });

  const S = readState(job.uid);
  if (!S) return stop('nostate');
  // Checked again here, not only at enqueue: a job can wait behind two others, and consent
  // withdrawn or the Coach switched off in the meantime means nothing leaves for it.
  if (!S.coach?.consent?.agreedAt) return stop('consent');
  if (!cfgStore.isEnabled()) return stop('off');

  const cfg = cfgStore.load();
  const adapter = adapterFor(cfg.provider);
  if (!adapter) return stop('off');
  if (adapter.tools !== true) return stop('tools');

  // The earlier thread, without the message this job answers.
  const before = [];
  for (const m of readUser(job.uid).chat || []) { if (m.id === job.messageId) break; before.push(m); }
  const prompt = buildPrompt({
    history: before, message: job.text, today: todayFor(S),
    // The app says which language it is showing. A profile that never picked one gets the
    // instance's DEFAULT_LANG, like its screens do.
    lang: job.lang || (S.langAuto === true ? langTag(process.env.DEFAULT_LANG) : null) || langTag(S.lang),
    unit: S.unit === 'lb' ? 'lb' : 'kg'
  });
  // Bound to this profile here, once: nothing the model sends can name another.
  const toolset = createToolset({ uid: job.uid, readState });

  // An HTTPS provider has no child process, so no directory for one to live in either.
  const jobDir = adapter.spawns === false ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'coach-'));
  const env = cfgStore.jobEnv(jobDir || os.tmpdir(), cfgStore.credentialFor(job.uid));
  const ctl = new AbortController();
  aborts.set(job.uid, ctl);
  try {
    const ids = jobDir && unprivilegedIds();
    if (ids) shareJobDir(jobDir, ids);

    const r = await adapter.invoke({
      cfg, prompt, system: SYSTEM_PROMPT, tools: toolset,
      model: cfgStore.modelFor(cfg), timeoutMs: TIMEOUT_MS,
      // The HTTP adapters take the fetch and the abort signal they are given; the runtime
      // adapters ignore both.
      jobDir, env, fetch: fetchFor(TIMEOUT_MS), signal: ctl.signal, maxTokens: cfg.maxOutputTokens
    });
    // Cancelled by a forget, not failed by the provider: the log must not blame the job budget.
    if (ctl.signal.aborted) return stop('forgotten');
    if (r.timedOut) return stop('timeout');
    if (r.spawnError) return stop('missing', r.stderr?.slice(0, 300));
    if (r.code !== 0) {
      const err = (r.stderr || r.text || '').toLowerCase();
      const authish = /auth|unauthor|api key|credential|token|401|403|login/.test(err);
      return stop(authish ? 'auth' : 'provider', (r.stderr || r.text || '').slice(0, 300));
    }

    const proposal = toolset.proposal();
    let text = String(r.text || '').trim().slice(0, TEXT_MAX);
    if (!text && proposal) text = proposal.summary || '';
    if (!text) return stop('unusable', 'the assistant answered with nothing');
    const message = {
      id: newId(), role: 'assistant', kind: 'text', text, at: Date.now(),
      ...(proposal ? { proposal: { id: proposal.id, summary: proposal.summary || '', createdAt: proposal.createdAt, status: 'pending', changes: proposal.changes } } : {})
    };
    return finish(job, { outcome: 'ready', message, detail: `${toolset.calls().length} tool calls` });
  } finally {
    aborts.delete(job.uid);
    if (jobDir) removeJobDir(jobDir, unprivilegedIds());
  }
}

/* ---------- admin test + boot recovery ---------- */

/** A2's "Test the Coach": the real adapter, a trivial round-trip, no user data anywhere near it. */
/* Give the unprivileged `coach` user its job directory without locking this process out of it.
 *
 * The obvious move is chown(jobDir, coach) — and it breaks the spawn outright. libuv chdir()s
 * into cwd BEFORE it drops to the child's uid, so the parent still has to be able to enter the
 * directory it just gave away; mkdtemp creates 0700, and a container started with `drop: [ALL]`
 * has no CAP_DAC_OVERRIDE for root to ignore that with. The child never starts and node reports
 * EACCES, which the Agent SDK renders as "the native binary failed to launch … does not match
 * this system's libc" — a guess, and a misleading one.
 *
 * So the directory stays owned by this process and `coach` reaches it through the group: 0770
 * with the coach gid. The child can write, the parent can still chdir and still clean up
 * afterwards, and nobody else on the container can read it. chmod before chown, while this
 * process is still the owner — CAP_FOWNER is not in the capability set either.
 */
function shareJobDir(jobDir, ids) {
  fs.chmodSync(jobDir, 0o770);
  fs.chownSync(jobDir, process.getuid ? process.getuid() : 0, ids.gid);
}

/* Remove a job directory whose contents belong to somebody else.
 *
 * The child writes as `coach` and its own directories come out 0700/0755 coach-owned — this
 * process cannot unlink inside them without CAP_DAC_OVERRIDE, which is the same capability the
 * handover above is written to avoid needing. Left to `fs.rmSync` it throws EACCES from a
 * `finally`, turning a completed run into a failed one.
 *
 * So the child's user clears its own files, and this process removes the directory it still
 * owns. Best effort throughout: a leaked temp directory is a worse outcome than a failed job
 * only in the sense that it is not one.
 */
function removeJobDir(jobDir, ids) {
  if (ids) {
    try {
      const mine = fs.readdirSync(jobDir).map(n => path.join(jobDir, n));
      // argv array, no shell — the same rule the provider spawn follows, and these paths are
      // this module's own mkdtemp output rather than anything a user chose.
      if (mine.length) spawnSync('/bin/rm', ['-rf', ...mine], { uid: ids.uid, gid: ids.gid, stdio: 'ignore' });
    } catch { /* fall through: the removal below is still worth attempting */ }
  }
  try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch { /* leaked, not fatal */ }
}

const testing = new Set();      // uids with a per-profile connection test in flight

/**
 * The real adapter, a trivial round trip, no user data anywhere near it. With no `uid` it is the
 * admin's "Test the Coach": instance mode runs the bound profile's credential, and per-profile
 * mode refuses honestly, because there is no instance credential and an admin cannot test one
 * that belongs to a profile. With a `uid` it is that profile's "Test my connection", run on the
 * caller's own credential and nobody else's.
 */
export async function testRun(uid = null) {
  const cfg = cfgStore.load();
  const adapter = adapterFor(cfg.provider);
  if (!adapter) return { ok: false, error: 'no provider configured' };
  let cred;
  if (uid) {
    if (cfg.authMode !== 'profile') return { ok: false, error: 'this instance uses one shared account; the admin tests it' };
    cred = cfgStore.credentialFor(uid);
    if (!cred.ok) return { ok: false, error: cred.message || cfgStore.NO_PROFILE_ACCOUNT_REFUSAL };
    if (testing.has(uid)) return { ok: false, error: 'a test is already running' };
    testing.add(uid);
  } else if (cfg.authMode === 'profile' && cfg.provider !== 'fixture') {
    return { ok: false, error: 'each profile uses its own account on this instance, so there is no shared one to test; every user has a Test button of their own' };
  }
  try {
    return await roundTrip(cfg, adapter, cred);
  } finally {
    if (uid) testing.delete(uid);
  }
}

async function roundTrip(cfg, adapter, cred) {
  const jobDir = adapter.spawns === false ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'coach-test-'));
  try {
    // `cred` is the caller's own when a profile asked; otherwise there is no profile, and the
    // account tested is the bound profile's — the one the round trip is meant to prove.
    const env = cfgStore.jobEnv(jobDir || os.tmpdir(), cred || cfgStore.credentialFor(cfgStore.boundUidFor(cfg)));
    const ids = jobDir && unprivilegedIds();
    if (ids) shareJobDir(jobDir, ids);
    const check = await adapter.check(cfg, env);
    if (!check.ok) return { ok: false, error: check.error || 'the provider runtime could not be run' };
    const r = await adapter.invoke({
      cfg, jobDir, env, model: cfgStore.modelFor(cfg), timeoutMs: 90000, fetch: fetchFor(90000),
      prompt: 'Reply with the single word: ok'
    });
    if (r.timedOut) return { ok: false, version: check.version, error: 'the provider did not answer in time' };
    if (r.code !== 0) {
      const err = (r.stderr || r.text || '').trim();
      return { ok: false, version: check.version, error: err.slice(0, 300) || 'the provider runtime exited with an error' };
    }
    if (!String(r.text || '').trim()) return { ok: false, version: check.version, error: 'the provider answered with nothing' };
    // Whether this provider can run the assistant is a separate fact from whether it answers:
    // the card says so, and the Coach screen says so before anybody types.
    return { ok: true, version: check.version, assistant: adapter.tools === true };
  } finally {
    if (jobDir) removeJobDir(jobDir, unprivilegedIds());
  }
}

/**
 * A job that was running when the process died is not coming back. Say so plainly and let the
 * user retry, rather than leaving a spinner that never resolves or silently re-running work
 * that may already have cost them a provider call.
 */
export function recoverOnBoot() {
  let n = 0;
  try {
    for (const f of fs.readdirSync(COACH_DIR)) {
      if (!f.endsWith('.json')) continue;
      const uid = f.replace(/\.json$/, '');
      const rec = readUser(uid);
      if (!rec.current) continue;
      writeUser(uid, {
        ...rec, current: null,
        // The thread says so too: the person was waiting for an answer that is not coming.
        chat: boundChat([...(rec.chat || []), errorMessage('restart')]), rev: (rec.rev || 0) + 1,
        history: [...(rec.history || []), { id: rec.current.id, outcome: 'failed', errorClass: 'restart', at: Date.now() }].slice(-HISTORY_MAX)
      });
      n++;
    }
  } catch { /* no coach dir yet */ }
  if (n) console.log(`coach: cleared ${n} job(s) interrupted by restart`);
  return n;
}
