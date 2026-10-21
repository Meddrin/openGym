// The conversation with the Coach.
//
// A chat with an assistant that can look things up in your own data and suggest changes to it.
// You write, it answers in prose; when it suggests edits they arrive as a card under its answer
// with a before/after for each change and its reason, and you decide with one tap. Apply runs
// the edits on this device as ordinary local changes (so the sync carries them), Undo puts back
// what they touched. Nothing is written until you tap, and a set applies whole or not at all.
//
// The thread is not in S: it is kept by whoever runs the assistant (the server's coach record
// for a signed-in profile, the phone's device file for a phone with its own key), so a reply
// that arrives while the app is closed is there when it opens, and a stale device cannot erase
// it. This screen only reads it (lib/coach-api.js useCoachChat) and reports decisions back.
//
// The consent screen is this screen's first state, not a separate route: no consent, no chat.
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { closeThenNav } from '../lib/nav.js'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t, tn } from '../lib/i18n.js'
import { fmtDate } from '../lib/format.js'
import { DEMO } from '../lib/demo.js'
import { MOBILE } from '../lib/mobile.js'
import { coachAvailable, hasConsent, emptyCoach, CONSENT_VERSION } from '../lib/coach.js'
import { useCoachChat, sendMessage, resolveProposal, jobErrorText, JOB_ERRORS, ASSISTANT_ERRORS } from '../lib/coach-api.js'
import { useCoachAccount, needsOwnAccount } from '../lib/coach-account.js'
import { openAccountSheet, accountSubtitle } from './CoachAccount.jsx'
import Icon from '../components/Icon.jsx'
import Markdown from '../components/Markdown.jsx'
import { Row } from '../components/ui.jsx'
import CoachConsent from './CoachConsent.jsx'
import CohortSheet from './CoachCohort.jsx'
import ProposalCard from './CoachProposal.jsx'
import '../coach.css'

// What to offer under an empty thread: things the assistant can really do, in the user's words.
const STARTERS = () => [
  t('How is my training going?'),
  t('What should I change in my plan?'),
  t('Log my weight for today'),
  t('Explain RIR and RPE to me')
]

export default function CoachChat() {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const user = useStore(s => s.user)
  const config = useStore(s => s.config)
  const coachLocal = useStore(s => s.coachLocal)
  const update = useStore(s => s.update)
  const storeReady = useStore(s => s.ready)
  const toast = useUI(s => s.toast)
  const openSheet = useUI(s => s.openSheet)
  const coachMode = coachLocal?.mode

  const ok = coachAvailable(config, user, { demo: DEMO, mobile: MOBILE, coachMode })
  const consented = hasConsent(S)
  const { job, cap, assistant, chat, refresh, maxMessageLen } = useCoachChat(ok && consented)
  const { account, refresh: refreshAccount } = useCoachAccount()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const endRef = useRef(null)

  // Not before the store has loaded: a cold start straight on #/coach would otherwise read an
  // empty state, decide there is no consent, and show the consent screen to somebody who gave it.
  useEffect(() => { if (storeReady && !ok) nav('/home', { replace: true }) }, [storeReady, ok])
  useEffect(() => { if (typeof endRef.current?.scrollIntoView === 'function') endRef.current.scrollIntoView({ block: 'end' }) }, [chat.length, !!job])

  if (!ok || !storeReady) return null
  if (!consented) {
    const agree = () => update(s => { s.coach = { ...(s.coach || emptyCoach()), consent: { agreedAt: new Date().toISOString(), version: CONSENT_VERSION } } })
    return <CoachConsent onAgree={agree} onDecline={() => nav('/plan')} />
  }

  const community = !!config?.coach?.community && !DEMO && !(MOBILE && coachMode === 'byok')
  const ownAccount = needsOwnAccount(account)
  const openAccount = () => openAccountSheet(openSheet, refreshAccount)
  // `assistant` is null until the first status answer; an answer that says no is what blocks.
  const cannot = assistant && assistant.supported === false
  const providerName = config?.coach?.providerLabel || coachLocal?.provider || assistant?.provider || ''

  const refused = e => {
    toast(JOB_ERRORS[e.data?.code] || ASSISTANT_ERRORS[e.data?.code] || ASSISTANT_ERRORS[e.code] || e.message || t('Could not ask the Coach'))
    if (e.data?.code === 'account') { refreshAccount(); openAccount() }
  }

  const send = async (override) => {
    const msg = String(override ?? text).trim()
    if (!msg || busy || job) return
    setBusy(true)
    try {
      await sendMessage(msg)
      setText('')
      await refresh()
    } catch (e) {
      // A server that refuses the job says so in English, with its class beside it: the class
      // picks the translated line. One with no line here ('shared') keeps the server's words.
      refused(e)
    }
    setBusy(false)
  }

  const decide = async (p, status, work) => {
    setBusy(true)
    try {
      await work()
      await resolveProposal(p.id, status).catch(() => {})
      await refresh()
    } catch (e) {
      // The change set did not apply (or came back stale): nothing was written, and the card says why.
      toast(e.reason === 'stale' ? t('Your data has changed since this was suggested. Nothing was applied.') : e.reason ? t('That suggestion no longer fits your data. Nothing was applied.') : (e.message || t('Could not apply')))
      await refresh()
    }
    setBusy(false)
  }
  const apply = p => decide(p, 'applied', async () => {
    const m = await import('../lib/coach-changes.js')
    let res
    update(s => { res = m.applyProposal(s, p) })
    toast(tn('{0} change applied', '{0} changes applied', res?.applied || p.changes.length))
  })
  const undo = p => decide(p, 'undone', async () => {
    const m = await import('../lib/coach-changes.js')
    let done = false
    update(s => { done = m.undoProposal(s, p.id) })
    toast(done ? t('Changes undone') : t('Nothing to undo'))
  })
  const dismiss = p => decide(p, 'dismissed', async () => {})

  const showCohort = () => openSheet(() => <CohortSheet S={S} toast={toast} />)
  const showHistory = () => openSheet(close => <HistorySheet S={S} close={close} />)
  const menu = () => openSheet(close => <div className="chat-menu">
    <h3>{t('Coach')}</h3>
    <div className="sect-b">
      {ownAccount && <Row icon="key" iconTint="var(--orange)" title={t('Your account')} subtitle={accountSubtitle(account)} accessory="chevron" onClick={() => { close(); openAccount() }} />}
      {community && <Row icon="person" iconTint="var(--teal)" title={t('Compare with others here')} subtitle={t('Anonymous medians from this instance')} accessory="chevron" onClick={() => { close(); showCohort() }} />}
      <Row icon="history" iconTint="var(--blue)" title={t('Everything the Coach changed')} subtitle={t('Changes you applied, kept')} accessory="chevron" onClick={() => { close(); showHistory() }} />
      <Row icon="pencil" iconTint="var(--indigo)" title={t('Edit my coach profile')} subtitle={t('Goal, days, equipment, limits')} accessory="chevron" onClick={() => closeThenNav(close, '/coach/intake?edit=1')} />
    </div>
    <div style={{ height: 10 }} />
  </div>)

  const status = job ? t('thinking…') : t('here when you need it')
  const empty = !chat.length && !job
  const placeholder = job ? t('Coach is thinking…') : t('Message the Coach…')

  return <div className="narrow chat">
    <div className="chat-hdr">
      <button className="iconbtn" onClick={() => nav('/plan')} aria-label={t('Back')}><Icon name="chevronLeft" /></button>
      <div className="chat-av"><Icon name="sparkles" /></div>
      <div className="grow">
        <h1>{t('Coach')}</h1>
        <div className={'chat-st' + (job ? ' live' : '')}>{status}</div>
      </div>
      <button className="iconbtn" onClick={menu} aria-label={t('More')}><Icon name="more" /></button>
    </div>

    <div className="msgs">
      <Bubble role="coach">{t('Hi, I’m your Coach. Ask me about your training, technique or food, or tell me what to change. I look things up in your own data. Nothing changes until you tap Apply.')}</Bubble>

      {cannot && <div className="pcard-note" role="status" style={{ padding: '12px 14px', background: 'var(--surface)', borderRadius: 'var(--r-lg)' }}>
        {t('The assistant needs the Claude provider or the Anthropic API, and this one uses {0}. Ask the instance owner to switch it, or on a phone choose Anthropic under Settings → AI Coach.', providerName || t('another provider'))}
      </div>}

      {chat.map(m => <Message key={m.id} m={m} S={S} busy={busy} onApply={apply} onDismiss={dismiss} onUndo={undo} />)}

      {job && <Typing startedAt={job.startedAt} coachLocal={coachLocal} config={config} />}
      <div ref={endRef} />
    </div>

    <div className="composer">
      {ownAccount && !account.connected && <div className="chips-row">
        <button className="qchip" onClick={openAccount}><Icon name="key" />{t('Connect your account to use the Coach')}</button>
      </div>}
      {empty && !busy && !cannot && <div className="chips-row">
        {STARTERS().map(s => <button key={s} className="qchip" onClick={() => send(s)}>{s}</button>)}
      </div>}
      <div className="composer-in">
        <textarea rows={1} value={text} maxLength={maxMessageLen || 1000} placeholder={placeholder} disabled={!!job || cannot} aria-label={t('Message the Coach…')}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
        <button className="send" onClick={() => send()} disabled={!text.trim() || busy || !!job || cannot} aria-label={t('Send')}><Icon name="arrowUp" /></button>
      </div>
      {cap?.limit > 0 && <div className="composer-cap">{t('{0} of {1} Coach runs used today', cap.used, cap.limit)}</div>}
    </div>
  </div>
}

/* ---------------------------------- bubbles ---------------------------------- */

function Bubble({ role, kind, at, children }) {
  const cls = kind === 'error' ? ' err' : ''
  return <div className={'msg ' + role}>
    <div className={'bub' + cls}>{children}</div>
    {at && <div className="msg-t">{stamp(at)}</div>}
  </div>
}

function Message({ m, S, busy, onApply, onDismiss, onUndo }) {
  if (m.role === 'user') return <Bubble role="user" at={m.at}>{m.text}</Bubble>
  if (m.kind === 'error') return <Bubble role="coach" kind="error" at={m.at}>{jobErrorText(m.errorClass, m.detail)}</Bubble>
  return <div className="msg coach" style={m.proposal ? { maxWidth: '100%', width: '100%' } : undefined}>
    {!!m.text && <div className="bub"><Markdown text={m.text} /></div>}
    {m.proposal && <ProposalCard proposal={m.proposal} S={S} busy={busy}
      onApply={() => onApply(m.proposal)} onDismiss={() => onDismiss(m.proposal)} onUndo={() => onUndo(m.proposal)} />}
    {m.at && <div className="msg-t">{stamp(m.at)}</div>}
  </div>
}

const stamp = at => {
  const d = new Date(at)
  const today = new Date()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === today.toDateString() ? time : fmtDate(d.toISOString().slice(0, 10)) + ' · ' + time
}

/** The dots, and how long it has been going: a model on a small box can take a while, and a spinner
 *  that says nothing is how people decide the app froze. */
function Typing({ startedAt, coachLocal, config }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i) }, [])
  const sec = Math.max(0, Math.round((now - (startedAt || now)) / 1000))
  const local = (coachLocal?.mode === 'byok' && coachLocal?.provider === 'compatible') || config?.coach?.provider === 'compatible'
  return <div className="msg coach">
    <div className="bub typing"><i /><i /><i /></div>
    <div className="typing-eta" aria-live="polite">
      {t('Looking it up…')} {sec >= 5 ? t('{0} s', sec) + ' · ' : ''}{t('Feel free to leave, it keeps going.')}
      {local ? ' ' + t('A local model can take longer.') : ''}
    </div>
  </div>
}

/* ---------------------------------- what the Coach changed ---------------------------------- */

function HistorySheet({ S }) {
  const rows = (S.coach?.log || []).filter(e => e && (e.kind === 'assistant' || e.kind === 'revert')).slice().reverse()
  return <div className="chat-menu">
    <h3>{t('Everything the Coach changed')}</h3>
    <div className="sect-b">
      {!rows.length && <div className="chat-empty">{t('Nothing yet. Changes you apply from the chat are listed here.')}</div>}
      {rows.map(e => <Row key={e.id} icon={e.kind === 'revert' ? 'reset' : 'checkCircle'} iconTint={e.kind === 'revert' ? 'var(--blue)' : 'var(--green)'}
        title={e.summary || (e.kind === 'revert' ? t('Undid the assistant’s changes.') : t('Suggested changes'))}
        subtitle={fmtDate(new Date(e.at).toISOString().slice(0, 10)) + (e.changes?.length ? ' · ' + tn('{0} change', '{0} changes', e.changes.length) : '')} />)}
    </div>
    <div style={{ height: 10 }} />
  </div>
}

