import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Art } from '../components/Art'
import { ICONS, Icon, Slider, Spark, ago, fmtNear, fmtUsd } from '../components/ui'
import { FIRE_DRAWDOWN, STRATEGIES, copyAgent, stopCopy, useS } from '../lib/store'
import { drawdown, pnlPct } from './Gardeners'
import { LIVE } from '../lib/config'
import { loadGardener } from '../lib/live'

function CopyPanel({ agentId, name }: { agentId: string; name: string }) {
  const copy = useS((s) => s.copies.find((c) => c.agentId === agentId))
  const balance = useS((s) => s.balance)
  const [perTrade, setPerTrade] = useState('5')
  const [budget, setBudget] = useState('100')
  const [stop, setStop] = useState(30)
  if (copy) return (
    <div className="card form reveal" id="copy">
      <div className="row between"><div><h3>You are copying {name}</h3><small className="muted">{copy.stopped ? 'Stopped: limit reached or the gardener was fired' : `${copy.perTrade} NEAR a trade · ${copy.trades} trades copied`}</small></div><b className={`agent-pnl ${copy.pnl >= 0 ? 'up' : 'down'}`}>{copy.pnl >= 0 ? '+' : ''}{copy.pnl.toFixed(2)} NEAR</b></div>
      <button className="btn ghost small self-start danger" onClick={() => stopCopy(copy.id)}>Stop and return funds</button>
    </div>
  )
  const p = +perTrade, b = +budget
  const err = p <= 0 ? 'Set an amount per trade' : b < p ? 'The budget must cover at least one trade' : b > balance ? 'Not enough NEAR' : ''
  return (
    <div className="card form" id="copy">
      <div><h3>Copy {name}'s trades</h3><p className="muted">Every trade this gardener makes also runs for you, at your size. You can stop at any time.</p></div>
      <div className="two">
        <label className="field"><span>Per trade (NEAR)</span><input className="input" inputMode="decimal" value={perTrade} onChange={(e) => setPerTrade(e.target.value.replace(/[^0-9.]/g, ''))} /></label>
        <label className="field"><span>Budget (NEAR)</span><input className="input" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^0-9.]/g, ''))} /><small className="muted">Wallet: {fmtNear(balance)}</small></label>
      </div>
      <div className="field"><span>Stop copying at a loss of</span><Slider label="Stop copying at a loss of" min={5} max={100} step={5} value={stop} onChange={setStop} format={(v) => `${v}%`} marks={[5, 25, 50, 75, 100]} /></div>
      <p className="notice warn">Copying can lose your budget. Past results don't promise future ones.</p>
      {err && <small className="down">{err}</small>}
      <button className="btn primary wide" disabled={!!err} onClick={() => copyAgent(agentId, p, b, stop)}>Start copying</button>
    </div>
  )
}

export default function Agent() {
  const { id = '' } = useParams()
  const h = useS((s) => s.house.find((x) => x.id === id))
  const [loading, setLoading] = useState(LIVE)
  useEffect(() => {
    if (!LIVE) return
    void loadGardener(id).catch(() => {}).finally(() => setLoading(false))
  }, [id])
  if (!h && loading) return <div className="page"><div className="skeleton" /></div>
  if (!h) return <div className="page center"><h1>Gardener not found</h1><Link className="btn primary" to="/gardeners">See gardeners</Link></div>
  const st = STRATEGIES.find((s) => s.id === h.strategy)
  const pnl = pnlPct(h)
  const dd = drawdown(h)
  return (
    <div className="page">
      <Link to="/gardeners" className="back"><Icon d={ICONS.back} size={18} />Gardeners</Link>
      <div className="token-head">
        <span className="cover" style={{ width: 84, height: 84, borderRadius: 18 }}><Art art={h.art} label={h.name} hue={100} /></span>
        <div className="grow-1 token-title"><h1 className="tight">{h.name}</h1><span className="muted">{st?.name} · {h.owner ? `by ${h.owner}` : 'by grow.'} · {h.copiers} copiers · {h.status === 'fired' ? `fired ${ago(h.firedAt ?? 0)} ago` : `working for ${ago(h.hiredAt)}`}</span><p className="token-desc">{st?.blurb}</p></div>
        <Link to={`/gardeners?tab=create&strategy=${h.strategy}`} className="btn ghost">Use this strategy</Link>
      </div>
      <div className="stack">
        <div className="card">
          <div className="row between"><div><small className="muted">Capital</small><div className="big-num xl">{fmtUsd(h.equity)}</div></div><b className={`agent-pnl large ${pnl >= 0 ? 'up' : 'down'}`}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(1)}%</b></div>
          <div className="agent-chart"><Spark values={h.history.map((p) => p[1])} w={900} h={200} /></div>
        </div>
        {h.status !== 'fired' && <CopyPanel agentId={h.id} name={h.name} />}
        {h.status === 'fired'
          ? <p className="notice warn">{h.name} was fired after falling {FIRE_DRAWDOWN}% from its peak. Its record stays public.</p>
          : <div className="card">
              <div className="row between"><h3>Distance to being fired</h3><span>-{dd.toFixed(1)}% of -{FIRE_DRAWDOWN}%</span></div>
              <span className="bar big danger-bar"><i style={{ transform: `scaleX(${Math.min(1, dd / FIRE_DRAWDOWN)})` }} /></span>
            </div>}
        <div className="stats">
          <div className="stat"><small>Win rate</small><b>{Math.round((h.wins / Math.max(1, h.trades)) * 100)}%</b></div>
          <div className="stat"><small>Trades</small><b>{h.trades}</b></div>
          <div className="stat"><small>Peak</small><b>{fmtUsd(h.peak)}</b></div>
          <div className="stat"><small>Started with</small><b>{fmtUsd(h.start)}</b></div>
        </div>
        <div className="card">
          <h3>Latest trades</h3>
          {h.log.length === 0 && <p className="muted mt-s">New trades will appear here.</p>}
          <div className="mt-s">{h.log.slice(0, 12).map((a) => <div className="line" key={a.id}><span className={`status-word ${a.kind === 'Gain' ? 'up' : 'down'}`}>{a.kind}</span><span className="grow-1 ellipsis">{a.note}</span><span>{a.near.toFixed(1)} NEAR</span><small className="muted time">{ago(a.t)}</small></div>)}</div>
        </div>
      </div>
    </div>
  )
}
