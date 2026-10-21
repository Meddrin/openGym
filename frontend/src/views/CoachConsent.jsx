// The disclosure: what the assistant can reach, where it goes, who pays. The first thing anyone
// sees of the Coach, because "what leaves the server" is the first thing to know, not a setting
// to find later.
//
// Rendered from the same category list the server defines (api/coach/core/categories.js), so the
// promise on screen cannot drift from what the tools can actually return. Nothing is sent up
// front any more: the assistant asks for what a question needs, one lookup at a time, and the
// screen says so.
import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import { CATEGORY_TEXT } from '../lib/coach.js'
import { disclosure } from '../lib/coach-api.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import '../coach.css'

export default function CoachConsent({ onAgree, onDecline }) {
  const config = useStore(s => s.config)
  const [info, setInfo] = useState(null)
  useEffect(() => { disclosure().then(setInfo).catch(() => {}) }, [])
  const who = info?.payer === 'you'
    ? t('Sent straight to {0} with your own API key. You pay for every request.', info.host || info.providerLabel)
    : t('Sent to {0}, running on this server under the instance owner’s account.', info?.providerLabel || config?.coach?.providerLabel || t('the configured AI provider'))
  return <div className="narrow ob">
    <div className="ob-body">
      <div className="ob-eyebrow">{t('Before we start')}</div>
      <h1 className="ob-h">{t('Meet your Coach')}</h1>
      <p className="ob-p">{t('Ask it anything about training, technique or food. It looks things up in your own data and can suggest changes to your plan, your workouts, your body weight and your settings. Nothing changes until you tap Apply, and you can undo every change.')}</p>
      <div className="ob-sub" style={{ marginTop: 0 }}>{t('What it can look up')}</div>
      <div className="ob-consent">
        {(info?.categories || Object.keys(CATEGORY_TEXT)).map(k => {
          const [title, sub] = CATEGORY_TEXT[k]?.() || [k, '']
          return <div key={k} className="ob-consent-row"><Icon name="check" /><div><b>{title}</b><span>{sub}</span></div></div>
        })}
      </div>
      <div className="ob-fine">
        <div>{t('Nothing is sent up front. To answer, it asks for what the question needs, one lookup at a time, and only about you.')}</div>
        <div>{who}</div>
        <div>{t('Your name, your sign-in details and everything else about your account stay here. Other people’s data is never included.')}</div>
        <div style={{ color: 'var(--yellow)' }}>{t('The Coach is not a doctor or a physiotherapist. If something hurts, ask a professional.')}</div>
      </div>
    </div>
    <div className="ob-foot" style={{ flexDirection: 'column', bottom: 'calc(8px + var(--sab))' }}>
      <Button variant="primary" onClick={onAgree}>{t('I understand, let’s go')}</Button>
      <Button onClick={onDecline}>{t('Not now')}</Button>
    </div>
  </div>
}
