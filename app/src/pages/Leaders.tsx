import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Art } from '../components/Art'
import { Page, PageTabs, fmtUsd } from '../components/ui'
import { NEAR_USD, capUsd, price } from '../lib/engine'
import { useS } from '../lib/store'
import { pnlPct, strategyName } from './Gardeners'
import { LIVE } from '../lib/config'
import { loadBoard } from '../lib/live'

const short = (name: string) => name.replace('.near', '').slice(0, 2).toUpperCase()

export default function Leaders() {
  const tokens = useS((s) => s.tokens)
  const house = useS((s) => s.house)
  const [tab, setTab] = useState<'traders' | 'devs' | 'gardeners'>('traders')
  const board = useS((s) => s.board)
  useEffect(() => { if (LIVE) void loadBoard().catch(() => {}) }, [])
  const traders = useMemo(() => {
    if (LIVE) return (board?.traders ?? []).map((r) => [r.account, r.value * NEAR_USD] as [string, number])
    const m: Record<string, number> = {}
    for (const t of Object.values(tokens)) for (const [who, amt] of Object.entries(t.holders)) m[who] = (m[who] || 0) + amt * price(t) * NEAR_USD
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 15)
  }, [tokens, board])
  const devs = useMemo(() => {
    if (LIVE) return (board?.devs ?? []).map((r) => [r.account, { cap: r.cap * NEAR_USD, n: r.tokens }] as [string, { cap: number; n: number }])
    const m: Record<string, { cap: number; n: number }> = {}
    for (const t of Object.values(tokens)) { m[t.dev] = m[t.dev] || { cap: 0, n: 0 }; m[t.dev].cap += capUsd(t); m[t.dev].n++ }
    return Object.entries(m).sort((a, b) => b[1].cap - a[1].cap).slice(0, 15)
  }, [tokens, board])
  const agents = useMemo(() => house.filter((h) => h.status !== 'fired').sort((a, b) => pnlPct(b) - pnlPct(a)), [house])
  return (
    <Page title="Leaderboard" sub="Who is growing the most right now.">
      <PageTabs value={tab} onChange={setTab} options={[{ id: 'traders', label: 'Traders' }, { id: 'devs', label: 'Devs' }, { id: 'gardeners', label: 'Gardeners' }]} />
      <div className="card list" key={tab}>
        {tab === 'traders' && traders.map(([who, v], i) => <Link to={`/user/${who}`} key={who} className="lb-row" style={{ '--i': i } as React.CSSProperties}><span className="rank-n">{i + 1}</span><span className="user-mark">{short(who)}</span><b className="grow-1 ellipsis">{who}</b><span>{fmtUsd(v)}</span></Link>)}
        {tab === 'devs' && devs.map(([who, d], i) => <Link to={`/user/${who}`} key={who} className="lb-row" style={{ '--i': i } as React.CSSProperties}><span className="rank-n">{i + 1}</span><span className="user-mark">{short(who)}</span><span className="grow-1 ellipsis"><b>{who}</b><small className="muted block">{d.n} {d.n === 1 ? 'token' : 'tokens'}</small></span><span>{fmtUsd(d.cap)}</span></Link>)}
        {tab === 'gardeners' && agents.map((h, i) => { const p = pnlPct(h); return <Link to={`/gardeners/${h.id}`} key={h.id} className="lb-row" style={{ '--i': i } as React.CSSProperties}><span className="rank-n">{i + 1}</span><span className="cover" style={{ width: 48, height: 48, borderRadius: 11 }}><Art art={h.art} label={h.name} hue={100} /></span><span className="grow-1 ellipsis"><b>{h.name}</b><small className="muted block">{strategyName(h.strategy)}</small></span><span className={p >= 0 ? 'up' : 'down'}>{p >= 0 ? '+' : ''}{p.toFixed(1)}%</span></Link> })}
      </div>
    </Page>
  )
}
