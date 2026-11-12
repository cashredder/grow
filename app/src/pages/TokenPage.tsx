import { useEffect, useState } from 'react'
import { AiChip, AiDecisions } from '../components/AiProof'
import { ShareButton } from '../components/ShareCard'
import { Link, useParams } from 'react-router-dom'
import Tree from '../components/Tree'
import { Chart, CopyCa, Cover, ICONS, Icon, Num, PageTabs, Star, Tabs, TokenSocials, UserAvatar, ago, fmtAmt, fmtNear, fmtPrice, fmtUsd } from '../components/ui'
import { NEAR_USD, POOL_FEE, RAISE, capUsd, feeRate, growth, holderCount, price, progress, quote, raised, type Token } from '../lib/engine'
import { DAY, addComment, claimReward, lotTotal, setSlippage, setWalletOpen, trade, useS } from '../lib/store'
import { LIVE } from '../lib/config'
import { loadToken } from '../lib/live'

function TradePanel({ t }: { t: Token }) {
  const me = useS((s) => s.me)
  const balance = useS((s) => s.balance)
  const held = useS((s) => lotTotal(s.lots[t.id]))
  const slippage = useS((s) => s.slippage)
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [raw, setRaw] = useState('')
  const [settings, setSettings] = useState(false)
  const amount = Number(raw.replace(',', '.')) || 0
  const q = quote(t, side, amount, Date.now())
  const max = side === 'buy' ? balance : held
  const over = !!me && amount > max * 1.000001
  const minOut = q.out * (1 - slippage / 100)
  const unit = side === 'buy' ? 'NEAR' : t.ticker
  const outUnit = side === 'buy' ? t.ticker : 'NEAR'
  return (
    <div className="card trade">
      <Tabs value={side} onChange={(v) => { setSide(v); setRaw('') }} options={[{ id: 'buy', label: 'Buy' }, { id: 'sell', label: 'Sell' }]} />
      <label className="field">
        <span className="row between"><span>You pay</span>{me && <small className="muted">{side === 'buy' ? fmtNear(balance) : `${fmtAmt(held)} ${t.ticker}`}</small>}</span>
        <div className="amount"><input inputMode="decimal" placeholder="0" value={raw} onChange={(e) => setRaw(e.target.value.replace(/[^0-9.,]/g, ''))} aria-label={`Amount in ${unit}`} /><b>{unit}</b></div>
      </label>
      <div className="chips">
        {side === 'buy'
          ? [10, 50, 100, 500].map((v) => <button key={v} className="pick" onClick={() => setRaw(String(v))}>{v}</button>)
          : [0.25, 0.5, 1].map((p) => <button key={p} className="pick" disabled={max <= 0} onClick={() => setRaw(String(+(max * p).toFixed(0)))}>{p === 1 ? 'All' : p * 100 + '%'}</button>)}
      </div>
      <div className="quote">
        <div className="row between"><span>You get</span><b>{q.out > 0 ? `${side === 'buy' ? fmtAmt(q.out) : q.out.toFixed(3)} ${outUnit}` : '—'}</b></div>
        <div className="row between"><span className="muted">Fee</span><span>{(q.rate * 100).toFixed(q.rate > 0.05 ? 0 : 1)}%{q.fee > 0 ? ` · ${q.fee.toFixed(3)} NEAR` : ''}</span></div>
        <div className={`row between ${q.impact > 0.05 ? 'warn-text' : ''}`}><span className="muted">Price impact</span><span>{(q.impact * 100).toFixed(2)}%</span></div>
        <button className="row between link-row" onClick={() => setSettings(!settings)} aria-expanded={settings}><span className="muted">Max slippage</span><span>{slippage}%</span></button>
        {settings && <div className="chips reveal">{[1, 3, 5, 10].map((v) => <button key={v} className={`pick ${slippage === v ? 'on' : ''}`} onClick={() => setSlippage(v)}>{v}%</button>)}</div>}
      </div>
      {q.rate > t.feePct / 100 + 0.001 && t.phase === 'curve' && <p className="notice warn">Launch protection is on. The fee falls to {t.feePct}% within the first minute.</p>}
      {q.capped && <p className="notice">Only {q.used.toFixed(2)} NEAR fits before this token moves to its pool. The rest stays in your wallet.</p>}
      {!me
        ? <button className="btn primary wide" onClick={() => setWalletOpen(true)}>Connect wallet</button>
        : <button className="btn primary wide" disabled={amount <= 0 || over} onClick={() => { if (trade(t.id, side, amount, minOut)) setRaw('') }}>{over ? `Not enough ${unit}` : amount <= 0 ? 'Enter an amount' : `${side === 'buy' ? 'Buy' : 'Sell'} ${t.ticker}`}</button>}
    </div>
  )
}

function HoldCard({ t }: { t: Token }) {
  const lots = useS((s) => s.lots[t.id])
  const reward = useS((s) => s.rewards[t.id] || 0)
  if (!lots || lotTotal(lots) <= 0) return null
  const days = (Date.now() - Math.min(...lots.map((l) => l.t))) / DAY
  return (
    <div className="card side-card">
      <div className="row between"><h3>Your position</h3><span>{fmtUsd(lotTotal(lots) * price(t) * NEAR_USD)}</span></div>
      <div className="tiers">{[3, 5, 10].map((d) => <span key={d} className={days >= d ? 'on' : ''}>{d} days</span>)}</div>
      <p className="muted small-note">Held for {Math.floor(days)} days. Longer holds earn a larger share of this token's rewards.</p>
      <button className="btn ghost small wide" disabled={reward <= 0} onClick={() => claimReward(t.id)}>{reward > 0 ? `Claim ${reward.toFixed(3)} NEAR` : 'No rewards to claim yet'}</button>
    </div>
  )
}

function Comments({ t }: { t: Token }) {
  const [text, setText] = useState('')
  const me = useS((s) => s.me)
  return (
    <>
      <form className="comment-form" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { addComment(t.id, text); setText('') } }}>
        <input className="input" maxLength={280} placeholder={me ? 'Write a comment' : 'Connect a wallet to comment'} value={text} onChange={(e) => setText(e.target.value)} aria-label="Write a comment" />
        <button className="btn primary small" disabled={!text.trim()}>Post</button>
      </form>
      {t.comments.length === 0 && <p className="muted">No comments yet. Say something first.</p>}
      {t.comments.slice(0, 20).map((c) => (
        <div className="comment" key={c.id}>
          <Link to={`/user/${c.who}`} className="comment-avatar" aria-label={`Open ${c.who}'s profile`}><UserAvatar name={c.who} /></Link>
          <div className="comment-body">
            <div className="row between"><Link to={`/user/${c.who}`}><b>{c.who}</b></Link><small className="muted">{ago(c.t)} ago</small></div>
            <p>{c.text}</p>
          </div>
        </div>
      ))}
    </>
  )
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="stat"><small>{label}</small><b>{children}</b></div>
}

type Tab = 'comments' | 'trades' | 'holders' | 'gardener'
export default function TokenPage() {
  const { id = '' } = useParams()
  const t = useS((s) => s.tokens[id])
  const cross = useS((s) => s.crossings.find((c) => c.status === 'window' && (c.a === id || c.b === id)))
  const [tab, setTab] = useState<Tab>('comments')
  const [, setNow] = useState(0)
  const [loading, setLoading] = useState(LIVE)
  useEffect(() => {
    if (!LIVE) return
    let alive = true
    const load = () => loadToken(id).catch(() => {}).finally(() => alive && setLoading(false))
    void load()
    const i = setInterval(() => { if (!document.hidden) void load() }, 10_000)
    return () => { alive = false; clearInterval(i) }
  }, [id])
  useEffect(() => { if (!cross) return; const i = setInterval(() => setNow((n) => n + 1), 1000); return () => clearInterval(i) }, [cross])
  if (!t && loading) return <div className="page"><div className="skeleton" /></div>
  if (!t) return <div className="page center"><h1>Token not found</h1><p className="muted">It may have been crossed into a new token.</p><Link className="btn primary" to="/tokens">Browse tokens</Link></div>
  const cap = capUsd(t)
  const holders = Object.entries(t.holders).sort((a, b) => b[1] - a[1]).slice(0, 12)
  return (
    <div className="page">
      <Link to="/tokens" className="back"><Icon d={ICONS.back} size={18} />Tokens</Link>
      {cross && <div className="notice warn mb">This token is merging soon. You can still sell for {Math.max(0, Math.ceil((cross.endsAt - Date.now()) / 1000))}s. After that your coins convert to ${cross.ticker}.</div>}
      <div className="token-head">
        <Cover t={t} size={84} />
        <div className="grow-1 token-title">
          <div className="token-name"><h1 className="tight">${t.ticker}</h1><Star id={t.id} /></div>
          <div className="token-meta">
            <span>{t.name}</span>
            <Link className="token-dev" to={`/user/${t.dev}`}><UserAvatar name={t.dev} size={20} />{t.dev}</Link>
            {t.coDev && <Link className="token-dev" to={`/user/${t.coDev}`}><UserAvatar name={t.coDev} size={20} />{t.coDev}</Link>}
            <span className="token-age"><Icon d={ICONS.clock} size={14} />{ago(t.createdAt)}</span>
          </div>
          {t.desc && <p className="token-desc">{t.desc}</p>}
        </div>
        <div className="token-actions">
          <TokenSocials t={t} />
          <ShareButton t={t} />
          <CopyCa t={t} full />
        </div>
      </div>
      <div className="token-layout">
        <div className="stack">
          <div className="card tree-card">
            <div className="tree-big"><Tree growth={growth(cap)} twin={!!t.parents} sway /></div>
            <div className="tree-overlay">
              <small className="muted">Market cap</small>
              <div className="big-num xl"><Num value={cap} format={fmtUsd} /></div>
              {t.parents && <small className="muted">Crossed from {t.parents[0]} and {t.parents[1]}</small>}
            </div>
            <div className="chip chip-a">
              <small>{t.phase === 'pool' ? 'Stage' : 'To pool'}</small>
              <b>{t.phase === 'pool' ? 'In pool' : Math.round(progress(t) * 100) + '%'}</b>
              <span className="meter" aria-hidden="true"><i style={{ transform: `scaleX(${progress(t)})` }} /></span>
            </div>
            <div className="chip chip-b"><small>Holders</small><b>{holderCount(t)}</b></div>
          </div>
          <div className="card"><Chart prices={t.prices} supply={t.supply - t.burned} /></div>
          <div className="stats">
            <Stat label="Price">{fmtPrice(price(t))}</Stat>
            <Stat label="Volume">{fmtUsd(t.volume * NEAR_USD)}</Stat>
            <Stat label="Trades">{t.txns}</Stat>
            <Stat label="Fee">{t.phase === 'pool' ? POOL_FEE : (feeRate(t, Date.now()) * 100).toFixed(1)}%</Stat>
            <Stat label="Rewards pool">{fmtNear(t.rewardPool)}</Stat>
            <Stat label="Burned">{fmtAmt(t.burned)}</Stat>
          </div>
          <div className="card">
            <PageTabs<Tab> value={tab} onChange={setTab} options={[{ id: 'comments', label: 'Comments' }, { id: 'trades', label: 'Trades' }, { id: 'holders', label: 'Holders' }, { id: 'gardener', label: 'Treasurer' }]} />
            <div className="tab-body" key={tab}>
              {tab === 'comments' && <Comments t={t} />}
              {tab === 'trades' && (t.trades.length ? t.trades.slice(0, 18).map((x) => (
                <div className="line" key={x.id}><span className={x.side === 'buy' ? 'up' : 'down'}>{x.side === 'buy' ? 'Buy' : 'Sell'}</span><Link to={`/user/${x.who}`} className="ellipsis grow-1">{x.who}</Link><span>{x.near.toFixed(2)} NEAR</span><small className="muted time">{ago(x.t)}</small></div>
              )) : <p className="muted">No trades yet.</p>)}
              {tab === 'holders' && holders.map(([who, amt], i) => {
                const pct = (amt / t.supply) * 100
                return (
                  <div className="line holder" key={who}><small className="muted rank">{i + 1}</small><Link to={`/user/${who}`} className="ellipsis grow-1">{who}{who === t.dev ? ' · dev' : ''}</Link><span className="holder-bar"><i style={{ width: `${Math.min(100, pct * 6)}%` }} /></span><span>{pct.toFixed(2)}%</span></div>
                )
              })}
              {tab === 'gardener' && (!t.gardener ? <p className="muted">This token launched without an AI treasurer.</p> : <>
                <p className="muted">The dev's share of the fees goes to this token's treasury. A NEAR AI model decides how to use it: buybacks that burn coins, rewards for holders, and the dev's pay (at most 20% a day). The contract enforces the limits, and every decision is signed inside a TEE.</p>
                {t.treasury && <div className="row between treasury-cash"><small className="muted">Treasury</small><b>{t.treasury.cash.toFixed(4)} NEAR</b></div>}
                <h4 className="mt-s">Decisions</h4>
                <AiDecisions list={t.treasury?.ai} empty="The treasurer decides about every 30 minutes once the treasury has NEAR." />
                <h4 className="mt-s">Actions</h4>
                {t.log.map((a) => (
                  <div className="log" key={a.id}>
                    <div className="row between"><b className={a.rejected ? 'down' : ''}>{a.kind} <AiChip id={a.aiId} /></b><small className="muted">{ago(a.t)} ago</small></div>
                    <p className="muted">{a.note}</p>
                    {a.near > 0 && <small className="muted">{a.near < 1 ? a.near.toFixed(4) : a.near.toFixed(2)} NEAR{a.tx ? ` · tx ${a.tx}` : ''}</small>}
                  </div>
                ))}
              </>)}
            </div>
          </div>
        </div>
        <aside className="sticky-side stack">
          <TradePanel t={t} />
          <HoldCard t={t} />
          <div className="card side-card">
            {t.phase === 'pool'
              ? <><div className="row between"><h3>In its pool</h3><span>{fmtUsd(t.base * NEAR_USD)}</span></div><p className="muted small-note">Liquidity is locked forever. Trades pay a {POOL_FEE}% fee.</p></>
              : <><div className="row between"><h3>Road to the pool</h3><span>{Math.round(progress(t) * 100)}%</span></div><span className="bar big"><i style={{ transform: `scaleX(${progress(t)})` }} /></span><p className="muted small-note">{fmtNear(Math.max(0, RAISE - raised(t)))} more, then liquidity moves to a pool and locks forever.</p></>}
          </div>
        </aside>
      </div>
    </div>
  )
}
