import { useMemo, useState } from 'react'
import { ICONS, Icon, Cover, Page, fmtAmt, fmtNear } from '../components/ui'
import { lotTotal, quoteSwap, setWalletOpen, swap, useS } from '../lib/store'

export default function Swap() {
  const tokens = useS((s) => s.tokens)
  const lots = useS((s) => s.lots)
  const balance = useS((s) => s.balance)
  const me = useS((s) => s.me)
  const slippage = useS((s) => s.slippage)
  const list = useMemo(() => Object.values(tokens).sort((a, b) => a.name.localeCompare(b.name)), [tokens])
  const [from, setFrom] = useState('near')
  const [to, setTo] = useState(list[0]?.id ?? '')
  const [raw, setRaw] = useState('')
  const amount = Number(raw) || 0
  const have = from === 'near' ? balance : lotTotal(lots[from])
  const q = to && from !== to ? quoteSwap(from, to, amount) : { out: 0, fee: 0, impact: 0 }
  const over = !!me && amount > have * 1.000001
  const nameOf = (id: string) => (id === 'near' ? 'NEAR' : tokens[id]?.ticker ?? '')
  const flip = () => { setFrom(to); setTo(from); setRaw('') }
  const select = (value: string, onChange: (v: string) => void, label: string) => (
    <select className="swap-select" value={value} aria-label={label} onChange={(e) => onChange(e.target.value)}>
      <option value="near">NEAR</option>
      {list.map((t) => <option key={t.id} value={t.id}>${t.ticker}</option>)}
    </select>
  )
  const route = from === 'near' || to === 'near' ? `${nameOf(from)} → ${nameOf(to)}` : `${nameOf(from)} → NEAR → ${nameOf(to)}`
  return (
    <Page title="Swap" sub="Trade any token on grow. in one step.">
      <div className="swap card form">
        <div className="swap-box">
          <div className="row between"><small className="muted">You pay</small><small className="muted">{me ? `Balance ${from === 'near' ? fmtNear(have) : fmtAmt(have)}` : ''}</small></div>
          <div className="row gap"><input className="swap-input" inputMode="decimal" placeholder="0" value={raw} onChange={(e) => setRaw(e.target.value.replace(/[^0-9.]/g, ''))} aria-label="Amount to pay" />{select(from, (v) => { setFrom(v); if (v === to) setTo(from) }, 'Token to pay')}</div>
        </div>
        <button className="swap-flip" onClick={flip} aria-label="Swap direction"><Icon d={ICONS.swap} /></button>
        <div className="swap-box">
          <small className="muted">You get</small>
          <div className="row gap"><span className="swap-input out">{q.out > 0 ? fmtAmt(q.out) : '0'}</span>{select(to, (v) => { setTo(v); if (v === from) setFrom(to) }, 'Token to receive')}</div>
        </div>
        <div className="quote">
          <div className="row between"><span className="muted">Route</span><span>{route}</span></div>
          <div className="row between"><span className="muted">Fee</span><span>{q.fee > 0 ? `${q.fee.toFixed(3)} NEAR` : '—'}</span></div>
          <div className={`row between ${q.impact > 0.05 ? 'warn-text' : ''}`}><span className="muted">Price impact</span><span>{(q.impact * 100).toFixed(2)}%</span></div>
          <div className="row between"><span className="muted">Max slippage</span><span>{slippage}%</span></div>
        </div>
        {!me
          ? <button className="btn primary wide" onClick={() => setWalletOpen(true)}>Connect wallet</button>
          : <button className="btn primary wide" disabled={amount <= 0 || over || !q.out} onClick={() => { swap(from, to, amount, q.out * (1 - slippage / 100)); setRaw('') }}>{over ? `Not enough ${nameOf(from)}` : amount <= 0 ? 'Enter an amount' : 'Swap'}</button>}
      </div>
      {list.length > 0 && <div className="swap-recent"><small className="muted">Popular</small><div className="row gap-s wrap-row">{list.slice(0, 6).map((t) => <button key={t.id} className="pick with-cover" onClick={() => { setFrom('near'); setTo(t.id) }}><Cover t={t} size={22} />${t.ticker}</button>)}</div></div>}
    </Page>
  )
}
