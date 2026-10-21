// "Compare with others here": how this profile sits against everyone else on the instance who
// opted in. Medians only, at least three people, nothing for a profile that does not share.
import { useEffect, useState } from 'react'
import { t } from '../lib/i18n.js'
import { fmtNum } from '../lib/format.js'
import { cohortStats, setCohortShare } from '../lib/coach-api.js'
import { Switch, Section, Row } from '../components/ui.jsx'
import '../coach.css'

const Tile = ({ v, l }) => <div className="ins-tile"><div className="ins-tile-v">{v}</div><div className="ins-tile-l">{l}</div></div>

export default function CohortSheet({ S, toast }) {
  const [d, setD] = useState(null)
  const [busy, setBusy] = useState(false)
  const load = () => cohortStats().then(setD).catch(e => { toast(e.message || t('Could not load')); setD({ ok: false }) })
  useEffect(() => { load() }, [])
  const share = async v => {
    setBusy(true)
    try { await setCohortShare(v); await load() }
    catch (e) { toast(e.message || t('Could not save')) }
    setBusy(false)
  }
  const sharing = !!d?.sharing
  return <div className="chat-menu">
    <h3>{t('Compare with others here')}</h3>
    <Section footer={t('Only medians across everyone who shares, never a name, a body weight or a single session. Turning this off removes you from the numbers immediately.')}>
      <Row icon="person" iconTint="var(--teal)" title={t('Include me')} subtitle={sharing ? t('Your lifts count towards the medians') : t('Off. You see nothing and share nothing')}>
        <Switch checked={sharing} disabled={busy || !d} onChange={share} />
      </Row>
    </Section>
    {!d && <div className="chat-empty">{t('Loading…')}</div>}
    {d && sharing && !d.ok && <div className="chat-empty">{d.people != null
      ? t('Not enough people are sharing yet ({0} of {1} needed). Rope in your gym mates!', d.people, d.minPeople)
      : t('Not available right now.')}</div>}
    {d && sharing && d.ok && <div className="ins" style={{ padding: 0 }}>
      <div className="ins-tiles">
        <Tile v={d.people} l={t('People')} />
        <Tile v={fmtNum(d.sessionsPerWeek.you)} l={t('Your sessions / wk')} />
        <Tile v={fmtNum(d.sessionsPerWeek.median)} l={t('Median / wk')} />
        <Tile v={d.rankPct != null ? d.rankPct + '%' : '–'} l={t('Your strength rank')} />
      </div>
      {!!d.exercises.length && <div className="ins-block">
        <div className="ins-h"><span>{t('Estimated 1RM, you vs. median')}</span><span className="dim">{S.unit}</span></div>
        {d.exercises.map(x => {
          const max = Math.max(x.median, x.you || 0) || 1
          return <div key={x.id} className="cmp">
            <div className="cmp-h"><span>{x.name}</span><span className="dim">{x.people} {t('people')}</span></div>
            <div className="cmp-bar you"><i style={{ width: Math.round((x.you || 0) / max * 100) + '%' }} /><span>{t('You')} · {x.you != null ? fmtNum(x.you) : '–'}</span></div>
            <div className="cmp-bar"><i style={{ width: Math.round(x.median / max * 100) + '%' }} /><span>{t('Median')} · {fmtNum(x.median)}</span></div>
          </div>
        })}
      </div>}
      {!d.exercises.length && <div className="chat-empty">{t('No exercise is trained by three or more people yet.')}</div>}
    </div>}
    <div style={{ height: 10 }} />
  </div>
}
