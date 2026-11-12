import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import Tree from '../components/Tree'
import { AgentArt, CopyArt, CreateArt } from '../components/WayArt'
import { ICONS, Icon, Num, TokenCard, fmtUsd } from '../components/ui'
import { capUsd, growth, holderCount, progress } from '../lib/engine'
import { FIRE_DRAWDOWN, STRATEGIES, WARN_DRAWDOWN, useS } from '../lib/store'

const STEPS = [
  { title: 'Plant', cap: 3_000, text: 'Give your token a name, a ticker and a picture. Every token starts as a sprout.' },
  { title: 'Grow', cap: 60_000, text: 'The tree grows with the market cap. Buys push it up, and sells shake leaves off.' },
  { title: 'Reach the pool', cap: 300_000, text: 'When the curve fills up, the token moves into its own pool. That liquidity is locked forever.' },
  { title: 'Cross', cap: 300_000, twin: true, text: 'Two devs can merge their tokens into one tree with two trunks. Holders swap at a fair rate or sell before it happens.' },
]
const TIERS = [{ days: 3, weight: '×1', width: 50 }, { days: 5, weight: '×1.5', width: 75 }, { days: 10, weight: '×2', width: 100 }]
const WAYS = [
  { title: 'Copy one', to: '/gardeners', text: 'Its trades run for you, at your size.', Art: CopyArt },
  { title: 'Create your own', to: '/gardeners?tab=create', text: `${STRATEGIES.length} strategies, your limits.`, Art: CreateArt },
  { title: 'Bring your agent', to: '/gardeners?tab=api', text: 'Plug in your bot with an API key.', Art: AgentArt },
]

/** The NEAR logo mark, for the "built on NEAR" labels. */
const NearMark = () => (
  <svg viewBox="0 0 90 90" width="14" height="14" aria-hidden="true">
    <path fill="currentColor" d="M72.2 4.6 53.4 32.5c-1.3 1.9 1.2 4.2 3 2.6l18.5-16.1c.5-.4 1.2-.1 1.2.6v50.3c0 .7-.9 1-1.3.5L20.5 6.2C18.8 4 16.1 2.8 13.3 2.8h-1.9C6.2 2.8 2 7 2 12.2v70.7c0 5.2 4.2 9.4 9.4 9.4 3.3 0 6.3-1.7 8-4.5l18.8-27.9c1.3-1.9-1.2-4.2-3-2.6L16.7 73.4c-.5.4-1.2.1-1.2-.6V22.6c0-.7.9-1 1.3-.5l54.2 64.9c1.8 2.2 4.4 3.4 7.2 3.4h1.9c5.2 0 9.4-4.2 9.4-9.4V10.2c0-5.2-4.2-9.4-9.4-9.4-3.3 0-6.4 1.7-8.2 4.6z" />
  </svg>
)

function HowItWorks() {
  return (
    <section className="how">
      <div className="section-head"><h2>How it works</h2><Link to="/rules" className="see-all">Fees and rules</Link></div>
      <div className="how-steps">
        {STEPS.map((s, i) => (
          <div className="card how-step" key={s.title}>
            <div className="how-tree"><Tree growth={growth(s.cap)} twin={s.twin} sway framed /></div>
            <small className="how-num">{String(i + 1).padStart(2, '0')}</small>
            <h3>{s.title}</h3>
            <p>{s.text}</p>
          </div>
        ))}
      </div>
      <div className="how-lower">
        <div className="card how-hold">
          <h3>Hold and earn</h3>
          <p>Every trade pays part of its fee to the token's holders, in NEAR, straight from the token's NEAR contract. The longer you hold, the bigger your share.</p>
          <div className="how-tiers">
            {TIERS.map((t) => <div key={t.days} className="how-tier"><span>{t.days} days</span><span className="how-tier-bar"><i style={{ width: `${t.width}%` }} /></span><b>{t.weight}</b></div>)}
          </div>
          <Link to="/invite" className="btn ghost how-invite"><Icon d={ICONS.gift} size={18} />Invite friends</Link>
        </div>
        <div className="card how-agents">
          <div className="how-agents-head">
            <div>
              <h3>Gardeners</h3>
              <p>AI agents that trade in the open. A NEAR AI model makes each decision inside a TEE, and the money never leaves the NEAR contract.</p>
            </div>
            <Link to="/gardeners" className="btn primary small">See gardeners</Link>
          </div>
          <div className="near-chips" aria-label="Built on NEAR">
            <span className="near-chip"><NearMark />NEAR AI Cloud</span>
            <span className="near-chip"><NearMark />Limits in the NEAR contract</span>
            <span className="near-chip"><NearMark />Every trade on chain</span>
          </div>
          <div className="how-ways">
            {WAYS.map((w) => <Link to={w.to} className="how-way" key={w.title}><w.Art /><b>{w.title}</b><span>{w.text}</span></Link>)}
          </div>
          <div className="how-fire">
            <div className="row between"><b>Lose too much and you're fired</b><small className="muted">From its peak</small></div>
            <div className="how-meter" aria-hidden="true"><i style={{ left: `${(WARN_DRAWDOWN / FIRE_DRAWDOWN) * 100}%` }} /></div>
            <div className="how-meter-labels" aria-hidden="true"><span>Peak</span><span style={{ left: `${(WARN_DRAWDOWN / FIRE_DRAWDOWN) * 100}%` }}>-{WARN_DRAWDOWN}% warning</span><span>-{FIRE_DRAWDOWN}% fired</span></div>
          </div>
        </div>
      </div>
    </section>
  )
}

export default function Home() {
  const tokens = useS((s) => s.tokens)
  const latest = useS((s) => s.feed[0])
  const mineId = useS((s) => (s.me ? s.homeTree : null))
  const mine = mineId ? tokens[mineId] : undefined
  const all = useMemo(() => Object.values(tokens), [tokens])
  const total = useMemo(() => all.reduce((n, t) => n + capUsd(t), 0), [all])
  const value = mine ? capUsd(mine) : total
  const holders = useMemo(() => all.reduce((n, t) => n + holderCount(t), 0), [all])
  const trending = useMemo(() => [...all].sort((a, b) => b.volume - a.volume).slice(0, 6), [all])
  const fresh = useMemo(() => [...all].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6), [all])
  const near = useMemo(() => all.filter((t) => t.phase === 'curve').sort((a, b) => progress(b) - progress(a)).slice(0, 3), [all])
  return (
    <>
      <div className="home">
        <div className="home-copy">
          <h1>Plant a token.<br />Watch it grow.</h1>
          <p>Every token here is a living tree. Each trade changes it.</p>
          <div className="home-actions">
            <Link to="/create" className="btn primary">Create token</Link>
            <Link to="/tokens" className="btn ghost">Browse tokens</Link>
          </div>
          {latest && <Link to={`/token/${latest.tokenId}`} className="home-activity"><span key={latest.id}>{latest.text}</span></Link>}
        </div>
        <div className="home-stage">
          <div className="home-tree"><Tree growth={mine ? growth(value) : growth(value, 2_000_000)} twin={!!mine?.parents} sway fill /></div>
          <div className="home-stats">
            <div className="stat"><small>{mine ? `$${mine.ticker} cap` : 'Total cap'}</small><b><Num value={value} format={fmtUsd} /></b></div>
            <div className="stat"><small>Tokens</small><b>{all.length}</b></div>
            <div className="stat"><small>Holders</small><b>{holders}</b></div>
          </div>
        </div>
      </div>
      <div className="page home-lists">
        <section>
          <div className="section-head"><h2>Trending</h2><Link to="/tokens" className="see-all">See all</Link></div>
          <div className="card-grid">{trending.map((t) => <TokenCard key={t.id} t={t} />)}</div>
        </section>
        <section>
          <div className="section-head"><h2>Almost in the pool</h2><Link to="/tokens?tab=close" className="see-all">See all</Link></div>
          <div className="card-grid">{near.map((t) => <TokenCard key={t.id} t={t} note={`${Math.round(progress(t) * 100)}% to pool`} />)}</div>
        </section>
        <section>
          <div className="section-head"><h2>Just planted</h2><Link to="/tokens?tab=new" className="see-all">See all</Link></div>
          <div className="card-grid">{fresh.map((t) => <TokenCard key={t.id} t={t} />)}</div>
        </section>
        <HowItWorks />
      </div>
    </>
  )
}
