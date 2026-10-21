// Edit the coach profile: the answers the Coach keeps in mind when it answers you.
//
// One question per screen, big targets, as little copy as the question allows. Every answer is
// optional now: this used to be the gate in front of the Coach, and is context the assistant can
// read (and propose edits to) instead. Nothing is built from it, so the last button just saves.
// Reached from the Coach menu as `?edit=1`; without it there is nothing to ask and the route
// goes back to the chat.
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { DAYN } from '../lib/format.js'
import { EXDB } from '../lib/exercises.js'
import { emptyCoach, coachAvailable, hasConsent } from '../lib/coach.js'
import { DEMO } from '../lib/demo.js'
import { MOBILE } from '../lib/mobile.js'
import { activeProfile } from '../lib/equipment.js'
import Icon from '../components/Icon.jsx'
import { Button, TextArea } from '../components/ui.jsx'
import '../coach.css'

// Each choice's text returns [title, detail] in the current language, through literal t() calls
// so check-source-strings sees every key, as CATEGORY_TEXT in lib/coach.js does. When the screen
// passed these to t() as variables the checker could not see them, and the eight details had no
// translation in any pack.
const GOALS = [
  ['strength', () => [t('Get stronger'), t('Heavier lifts, lower reps.')], 'barbell'],
  ['muscle', () => [t('Build muscle'), t('Volume and progression.')], 'arm'],
  ['general', () => [t('General fitness'), t('Balanced, sustainable training.')], 'heart'],
  ['fatloss', () => [t('Lose fat'), t('Keep strength while leaning out.')], 'flame'],
  ['endurance', () => [t('Endurance'), t('Higher reps, less rest, cardio.')], 'figureRun']
]
const EXPERIENCE = [
  ['new', () => [t('New to lifting'), t('First months in the gym.')], 'sparkles'],
  ['returning', () => [t('Coming back after a break'), t('You know the movements; the numbers need rebuilding.')], 'reset'],
  ['regular', () => [t('Training regularly'), t('Consistent for a while now.')], 'trophy']
]

// Equipment options come from the library's own taxonomy, most common first, so every choice
// on screen has exercises behind it.
const EQUIPMENT = (() => {
  const count = {}
  EXDB.forEach(e => { if (e.eq) count[e.eq] = (count[e.eq] || 0) + 1 })
  return Object.keys(count).sort((a, b) => count[b] - count[a]).slice(0, 14)
})()

const QUICK_MIN = [30, 45, 60, 90]
const toHHMM = min => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0')
const fromHHMM = v => { const [h, m] = String(v || '').split(':').map(Number); return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null }

export default function CoachIntake() {
  const nav = useNavigate()
  const [params] = useSearchParams()
  const editing = params.get('edit') === '1'
  const S = useStore(s => s.S)
  const user = useStore(s => s.user)
  const config = useStore(s => s.config)
  const coachMode = useStore(s => s.coachLocal?.mode)
  const update = useStore(s => s.update)
  const toast = useUI(s => s.toast)
  const STEPS = ['goal', 'experience', 'days', 'length', 'equipment', 'limits', 'extras']
  const [step, setStep] = useState(0)
  const [p, setP] = useState(() => ({
    goal: null, experience: null, daysPerWeek: 3, preferredDays: [1, 3, 5],
    // A home gym already set up under Settings → Equipment is the best first guess here.
    sessionMin: 60, equipment: (activeProfile(S)?.equipment || []).filter(e => EQUIPMENT.includes(e)), limitations: '', likes: '', dislikes: '', notes: '',
    ...(S.coach?.profile || {})
  }))
  const set = patch => setP(v => ({ ...v, ...patch }))

  if (!coachAvailable(config, user, { demo: DEMO, mobile: MOBILE, coachMode })) { nav('/home', { replace: true }); return null }
  // Nothing to edit before the first consent, and nothing to ask without ?edit=1.
  if (!editing || !hasConsent(S)) { nav('/coach', { replace: true }); return null }

  const key = STEPS[step]
  const last = step === STEPS.length - 1
  const canNext = key === 'length' ? p.sessionMin >= 10 : true
  const optional = true

  const next = () => (last ? finish() : setStep(step + 1))
  const back = () => (step ? setStep(step - 1) : nav('/coach'))

  const finish = () => {
    // `??`, not `||`: only a missing answer takes the default. Nought is an answer, and the clamp
    // turns it into one day like every other count below the floor.
    const profile = { ...p, daysPerWeek: Math.min(7, Math.max(1, p.daysPerWeek ?? 3)) }
    update(s => { (s.coach = s.coach || emptyCoach()).profile = profile })
    toast(t('Saved'))
    nav('/coach')
  }

  const toggleDay = d => set({
    preferredDays: p.preferredDays.includes(d) ? p.preferredDays.filter(x => x !== d) : [...p.preferredDays, d].sort()
  })
  const toggleEq = e => set({
    equipment: p.equipment.includes(e) ? p.equipment.filter(x => x !== e) : [...p.equipment, e]
  })

  const dots = STEPS
  const dotIndex = dots.indexOf(key)

  return <div className="narrow ob">
    <div className="ob-top">
      <button className="iconbtn" onClick={back} aria-label={t('Back')}><Icon name="chevronLeft" /></button>
      <div className="ob-dots">
        {dots.map((s, i) => <span key={s} className={'ob-dot' + (i === dotIndex ? ' on' : i < dotIndex ? ' done' : '')} />)}
      </div>
      {optional && !last ? <button className="ob-skip" onClick={next}>{t('Skip')}</button> : <span style={{ width: 36 }} />}
    </div>

    <div className="ob-body">
      {key === 'goal' && <>
        <div className="ob-eyebrow">{t('Your goal')}</div>
        <h1 className="ob-h">{t('What are you training for?')}</h1>
        <p className="ob-p">{t('The Coach keeps this in mind when it answers.')}</p>
        <div className="ob-choices">
          {GOALS.map(([v, text, icon]) => { const [title, sub] = text(); return <Choice key={v} on={p.goal === v} icon={icon} title={title} sub={sub} onClick={() => set({ goal: v })} /> })}
        </div>
      </>}

      {key === 'experience' && <>
        <div className="ob-eyebrow">{t('Experience')}</div>
        <h1 className="ob-h">{t('Where are you starting from?')}</h1>
        <p className="ob-p">{t('Sets how much the Coach assumes you know.')}</p>
        <div className="ob-choices">
          {EXPERIENCE.map(([v, text, icon]) => { const [title, sub] = text(); return <Choice key={v} on={p.experience === v} icon={icon} title={title} sub={sub} onClick={() => set({ experience: v })} /> })}
        </div>
      </>}

      {key === 'days' && <>
        <div className="ob-eyebrow">{t('Schedule')}</div>
        <h1 className="ob-h">{t('How many days a week?')}</h1>
        <p className="ob-p">{t('Pick what you will actually keep, not the best week you can imagine.')}</p>
        <div className="ob-days">
          {[1, 2, 3, 4, 5, 6, 7].map(n => <button key={n} className={'ob-day' + (p.daysPerWeek === n ? ' on' : '')} onClick={() => set({ daysPerWeek: n })}>{n}</button>)}
        </div>
        <div className="ob-sub">{t('Which days suit you? (optional)')}</div>
        <div className="ob-week">
          {[1, 2, 3, 4, 5, 6, 0].map(d => <button key={d} className={'ob-wd' + (p.preferredDays.includes(d) ? ' on' : '')} onClick={() => toggleDay(d)}>{t(DAYN[d]).slice(0, 2)}</button>)}
        </div>
      </>}

      {key === 'length' && <>
        <div className="ob-eyebrow">{t('Session length')}</div>
        <h1 className="ob-h">{t('How long is a session?')}</h1>
        <p className="ob-p">{t('The Coach fits its advice to the time you actually have, including rest between sets.')}</p>
        {/* A duration, not a clock time — so two wheels (hours, minutes in fives), never the
            native time input, which insists on AM/PM. */}
        <div className="ob-time" role="group" aria-label={t('How long is a session?')}>
          <select className="ob-wheel" value={Math.floor((p.sessionMin || 60) / 60)}
            onChange={e => set({ sessionMin: (+e.target.value) * 60 + ((p.sessionMin || 60) % 60) || 5 })}>
            {[0, 1, 2, 3].map(h => <option key={h} value={h}>{String(h).padStart(2, '0')}</option>)}
          </select>
          <span className="ob-time-sep">:</span>
          <select className="ob-wheel" value={(p.sessionMin || 60) % 60}
            onChange={e => set({ sessionMin: Math.floor((p.sessionMin || 60) / 60) * 60 + (+e.target.value) || 5 })}>
            {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map(m => <option key={m} value={m}>{String(m).padStart(2, '0')}</option>)}
          </select>
          <span className="ob-time-l">{t('h:mm')}</span>
        </div>
        <div className="ob-quick">
          {QUICK_MIN.map(m => <button key={m} className={'chip' + (p.sessionMin === m ? ' on' : '')} onClick={() => set({ sessionMin: m })}>{m} {t('min')}</button>)}
        </div>
      </>}

      {key === 'equipment' && <>
        <div className="ob-eyebrow">{t('Equipment')}</div>
        <h1 className="ob-h">{t('What can you train with?')}</h1>
        <p className="ob-p">{t('Pick everything you have access to. Leave it empty and the Coach will not assume any.')}</p>
        <div className="ob-chips">
          {EQUIPMENT.map(e => <button key={e} className={'chip' + (p.equipment.includes(e) ? ' on' : '')} onClick={() => toggleEq(e)}>{t(e)}</button>)}
        </div>
      </>}

      {key === 'limits' && <>
        <div className="ob-eyebrow">{t('Limits')}</div>
        <h1 className="ob-h">{t('Anything to work around?')}</h1>
        <p className="ob-p">{t('Injuries, joints that complain, movements you cannot do, or practical limits like training at 6am in a flat.')}</p>
        <div className="ob-field">
          <TextArea rows={4} maxLength={600} value={p.limitations} onChange={e => set({ limitations: e.target.value })}
            placeholder={t('e.g. “dodgy left shoulder, no barbell overhead press”')} />
        </div>
        <div className="ob-note warn">{t('If something actually hurts, see a professional. The Coach will program conservatively, but it can’t diagnose anything.')}</div>
      </>}

      {key === 'extras' && <>
        <div className="ob-eyebrow">{t('Almost there')}</div>
        <h1 className="ob-h">{t('Anything else?')}</h1>
        <p className="ob-p">{t('All optional. The more the Coach knows, the less it guesses.')}</p>
        <div className="ob-sub" style={{ marginTop: 0 }}>{t('Exercises you love')}</div>
        <div className="ob-field"><TextArea rows={2} maxLength={300} value={p.likes} onChange={e => set({ likes: e.target.value })} placeholder={t('e.g. “deadlifts, anything with a kettlebell”')} /></div>
        <div className="ob-sub" style={{ marginTop: 4 }}>{t('Exercises you would rather not')}</div>
        <div className="ob-field"><TextArea rows={2} maxLength={300} value={p.dislikes} onChange={e => set({ dislikes: e.target.value })} placeholder={t('e.g. “I hate lunges”')} /></div>
        <div className="ob-sub" style={{ marginTop: 4 }}>{t('Anything you want the Coach to know')}</div>
        <div className="ob-field"><TextArea rows={3} maxLength={600} value={p.notes} onChange={e => set({ notes: e.target.value })} placeholder={t('e.g. “I want visible arms progress by spring”')} /></div>
      </>}
    </div>

    <div className="ob-foot">
      <Button variant="primary" style={{ flex: 1 }} disabled={!canNext} icon={last ? 'check' : undefined} onClick={next}>
        {last ? t('Save') : t('Continue')}
      </Button>
    </div>
  </div>
}

function Choice({ on, icon, title, sub, onClick }) {
  return <button className={'ob-choice' + (on ? ' on' : '')} onClick={onClick}>
    <Icon name={icon} />
    <span className="ob-choice-t">{title}{sub && <span className="ob-choice-s">{sub}</span>}</span>
    <Icon name="check" className="ob-k" />
  </button>
}
