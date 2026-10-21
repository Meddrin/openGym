// A proposal, as a card in the thread: what each change would do, before and after, why the
// assistant suggests it, and the three things a person can do — Apply, Dismiss, Undo.
//
// The card never trusts the data it was written against. While a proposal waits, it is checked
// again on this device, against the state as it is now (lib/coach-changes.js checkProposal, the
// same code the server ran): if anything it describes has moved, Apply is switched off and the
// card says why, rather than applying a premise that is no longer true. A set applies whole or
// not at all.
import { useEffect, useState } from 'react'
import { t, tn } from '../lib/i18n.js'
import { describeChange, canUndo } from '../lib/coach.js'
import { Button } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'
import '../coach.css'

const STATUS = {
  pending: () => t('Suggested changes'),
  applied: () => t('Applied'),
  dismissed: () => t('Dismissed'),
  undone: () => t('Applied, then undone'),
  expired: () => t('Expired')
}

/** `checking` | `ok` | `stale` | `invalid`, for a proposal that is still waiting. */
export function useProposalCheck(S, proposal, active) {
  const [state, setState] = useState('checking')
  useEffect(() => {
    if (!active || !proposal || !Array.isArray(proposal.changes)) return
    let alive = true
    // Debounced: the state moves in bursts while a sync lands, and the check clones it.
    const tm = setTimeout(() => {
      import('../lib/coach-changes.js').then(m => { const r = m.checkProposal(S, proposal); if (alive) setState(r.ok ? 'ok' : r.reason) })
        .catch(() => { if (alive) setState('invalid') })
    }, 120)
    return () => { alive = false; clearTimeout(tm) }
  }, [S, proposal, active])
  return state
}

function ChangeRow({ c, S }) {
  const d = describeChange(c, S)
  return <div className="pchg">
    <div className="pchg-t">{d.title}</div>
    {d.rows.map((r, i) => <div key={i} className="pchg-v">
      {r.label && <span className="pchg-k">{r.label}</span>}
      <div className="pchg-ba">
        {r.before != null && r.before !== '' && <span className="pchg-b">{r.before}</span>}
        {r.before != null && r.before !== '' && <Icon name="chevronRight" className="pchg-arr" />}
        <span className="pchg-a">{r.after == null || r.after === '' ? '–' : r.after}</span>
      </div>
    </div>)}
    {c.why && <div className="pchg-w">{c.why}</div>}
  </div>
}

export default function ProposalCard({ proposal: p, S, busy, onApply, onDismiss, onUndo }) {
  const pending = p.status === 'pending'
  const check = useProposalCheck(S, p, pending)
  const [open, setOpen] = useState(pending || p.status === 'applied')
  const whole = Array.isArray(p.changes)
  const n = whole ? p.changes.length : (p.count || 0)
  const undoable = p.status === 'applied' && canUndo(S, p.id)
  const blocked = pending && whole && (check === 'stale' || check === 'invalid')
  return <div className={'pcard' + (pending ? '' : ' done')}>
    <div className="pcard-hd">
      <div className="pcard-eyebrow">{(STATUS[p.status] || STATUS.pending)()}</div>
      {!!p.summary && <h3 className="pcard-h">{p.summary}</h3>}
      <div className="pcard-sum">{tn('{0} change', '{0} changes', n)}</div>
    </div>
    {whole && open && p.changes.map(c => <ChangeRow key={c.id} c={c} S={S} />)}
    {!whole && !!p.kinds?.length && <div className="pcard-sum" style={{ padding: '0 18px 10px' }}>{p.kinds.join(', ')}</div>}
    {whole && !open && <button className="pcard-more" onClick={() => setOpen(true)}>{t('Show the changes')}</button>}
    {blocked && <div className="pcard-note">{check === 'stale'
      ? t('Your data has changed since this was suggested, so it can’t be applied as it is. Ask again and I’ll look at it as it is now.')
      : t('This suggestion no longer fits your data. Ask again and I’ll look at it as it is now.')}</div>}
    {(pending || undoable) && <div className="pcard-ft">
      {pending && <Button variant="primary" icon="check" disabled={busy || check !== 'ok'} onClick={onApply}>{t('Apply')}</Button>}
      {pending && <Button disabled={busy} onClick={onDismiss}>{t('Dismiss')}</Button>}
      {undoable && <Button icon="reset" disabled={busy} onClick={onUndo}>{t('Undo')}</Button>}
    </div>}
  </div>
}
