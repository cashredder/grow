import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { Art } from '../components/Art'
import Tree from '../components/Tree'
import { Check, CopyCa, Cover, ICONS, Icon, Num, PageTabs, AVATARS, Slider, TokenCard, UserAvatar, X_LOGO, ago, useExit, fmtAmt, fmtNear, fmtUsd } from '../components/ui'
import { NEAR_USD, capUsd, growth, price, quote, type Token } from '../lib/engine'
import { LIVE } from '../lib/config'
import { loadUser } from '../lib/live'
import { DAY, acceptCross, cancelCross, claimAllRewards, claimDev, claimReward, lotTotal, proposeCross, saveProfile, setHomeTree, setWalletOpen, trade, useS, type Crossing, type ProfileLinks } from '../lib/store'
import { Mine } from './Gardeners'

function CrossForm({ mine, all }: { mine: Token[]; all: Token[] }) {
  const crossings = useS((s) => s.crossings)
  const busy = new Set(crossings.flatMap((c) => [c.a, c.b]))
  const own = mine.filter((t) => !t.parents && !busy.has(t.id))
  const others = all.filter((t) => !t.parents && !busy.has(t.id) && !own.some((m) => m.id === t.id))
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [split, setSplit] = useState(50)
  const [name, setName] = useState('')
  const [ticker, setTicker] = useState('')
  const A = all.find((t) => t.id === a), B = all.find((t) => t.id === b)
  if (!own.length) return <p className="muted">You need a token of your own that hasn't been crossed yet.</p>
  const valid = A && B && name.trim().length > 1 && /^[A-Za-z0-9]{2,8}$/.test(ticker)
  return (
    <div className="form">
      <div className="two">
        <label className="field"><span>Your token</span><select className="input" value={a} onChange={(e) => setA(e.target.value)}><option value="">Choose</option>{own.map((t) => <option key={t.id} value={t.id}>${t.ticker} · {t.name}</option>)}</select></label>
        <label className="field"><span>Partner token</span><select className="input" value={b} onChange={(e) => setB(e.target.value)}><option value="">Choose</option>{others.map((t) => <option key={t.id} value={t.id}>${t.ticker} · {t.name}</option>)}</select></label>
      </div>
      <div className="two">
        <label className="field"><span>New name</span><input className="input" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>New ticker</span><input className="input" value={ticker} maxLength={8} onChange={(e) => setTicker(e.target.value.toUpperCase())} /></label>
      </div>
      <div className="field"><span>Your share of dev rewards</span><Slider label="Your share of dev rewards" min={10} max={90} step={5} value={split} onChange={setSplit} format={(v) => `${v}%`} marks={[10, 30, 50, 70, 90]} /></div>
      {A && B && <div className="cross-preview reveal"><div className="mini-tree"><Tree growth={growth(capUsd(A) + capUsd(B))} twin /></div><p className="muted">Holders swap at a fair rate based on each token's average price. {fmtUsd(capUsd(A) + capUsd(B))} combined cap. Rewards vest for 30 days. A crossing is permanent.</p></div>}
      <button className="btn primary wide" disabled={!valid} onClick={() => { proposeCross(a, b, split, name, ticker); setA(''); setB(''); setName(''); setTicker('') }}>Send proposal</button>
    </div>
  )
}

function CrossRow({ c, tokens }: { c: Crossing; tokens: Record<string, Token> }) {
  const [, tick] = useState(0)
  useEffect(() => { if (c.status !== 'window') return; const i = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(i) }, [c.status])
  const me = useS((s) => s.me)
  const A = tokens[c.a], B = tokens[c.b]
  if (!A || !B) return null
  return (
    <div className="line wrap">
      <span className="grow-1"><b>${A.ticker} × ${B.ticker}</b> → ${c.ticker}<small className="muted block">{c.status === 'waiting' ? `Waiting for ${B.dev} to accept` : `Holders can exit for ${Math.max(0, Math.ceil((c.endsAt - Date.now()) / 1000))}s`}</small></span>
      {c.status === 'waiting' && me && c.partner === me && <button className="btn primary small" onClick={() => acceptCross(c.id)}>Accept</button>}
      {c.status === 'waiting' && <button className="btn ghost small" onClick={() => cancelCross(c.id)}>{c.partner === me ? 'Decline' : 'Cancel'}</button>}
    </div>
  )
}

function SellPanel({ t, held, onClose }: { t: Token; held: number; onClose: () => void }) {
  const slippage = useS((s) => s.slippage)
  const [pct, setPct] = useState(100)
  // Own share: typed as a percent (0.01-100); empty means a preset chip is in use.
  const [own, setOwn] = useState('')
  const typed = Number(own.replace(',', '.'))
  const ownOk = own !== '' && typed > 0 && typed <= 100
  const share = own !== '' ? (ownOk ? typed : 0) : pct
  const amount = share >= 100 ? held : (held * share) / 100
  const q = quote(t, 'sell', amount, Date.now())
  return (
    <div className="sell-panel">
      <div className="chips tight">
        {[25, 50, 100].map((p) => <button key={p} className={`pick ${own === '' && pct === p ? 'on' : ''}`} aria-pressed={own === '' && pct === p} onClick={() => { setPct(p); setOwn('') }}>{p}%</button>)}
        <label className={`pick pct-own ${own !== '' ? 'on' : ''} ${own !== '' && !ownOk ? 'bad' : ''}`}>
          <input inputMode="decimal" placeholder="Other" aria-label="Share to sell, percent" value={own} onChange={(e) => setOwn(e.target.value.replace(/[^\d.,]/g, '').slice(0, 5))} />
          <span aria-hidden="true">%</span>
        </label>
      </div>
      <span className="sell-quote">Sell {fmtAmt(amount)} {t.ticker}<small className="muted">You get about {fmtNear(q.out)} ({fmtUsd(q.out * NEAR_USD)})</small></span>
      <div className="sell-actions">
        <button className="btn ghost small" onClick={onClose}>Cancel</button>
        <button className="btn primary small" disabled={q.out <= 0 || amount <= 0} onClick={() => { if (trade(t.id, 'sell', amount, q.out * (1 - slippage / 100))) onClose() }}>Confirm sale</button>
      </div>
    </div>
  )
}

function Positions({ tokens }: { tokens: Record<string, Token> }) {
  const lots = useS((s) => s.lots)
  const rewards = useS((s) => s.rewards)
  const [selling, setSelling] = useState<string | null>(null)
  const held = Object.entries(lots).filter(([id, l]) => tokens[id] && lotTotal(l) > 0)
  if (!held.length) return <div className="card empty-card"><h2>No positions yet</h2><p className="muted">Buy a token and hold it for 3 days to start earning rewards.</p><Link to="/tokens" className="btn primary">Browse tokens</Link></div>
  return (
    <div className="profile-rows">
      {held.map(([id, l], i) => {
        const t = tokens[id]
        const amt = lotTotal(l)
        const first = Math.min(...l.map((x) => x.t))
        const days = (Date.now() - first) / DAY
        const reward = rewards[id] || 0
        return (
          <div className="card owned" key={id} style={{ '--i': i } as React.CSSProperties}>
            <Link to={`/token/${id}`} className="owned-main">
              <Cover t={t} size={64} />
              <span className="t-title"><b>${t.ticker}</b><small>{t.name}</small></span>
              <CopyCa t={t} />
            </Link>
            <div className="owned-cell owned-value"><b>{fmtUsd(amt * price(t) * NEAR_USD)}</b><small>{fmtAmt(amt)} {t.ticker}</small></div>
            <div className="owned-cell owned-bought"><b>{ago(first)} ago</b><small>Bought</small></div>
            <div className="tiers owned-tiers" aria-label={`Held for ${Math.floor(days)} days`}>{[3, 5, 10].map((d) => <span key={d} className={days >= d ? 'on' : ''}>{d}d</span>)}</div>
            <div className="owned-actions">
              <button className="btn ghost small" aria-expanded={selling === id} onClick={() => setSelling(selling === id ? null : id)}>Sell</button>
              <button className="btn primary small" disabled={reward <= 0} onClick={() => claimReward(id)}>{reward > 0 ? `Claim ${reward.toFixed(2)} NEAR` : 'No rewards yet'}</button>
            </div>
            {selling === id && <SellPanel t={t} held={amt} onClose={() => setSelling(null)} />}
          </div>
        )
      })}
      <p className="small-note">Rewards are paid in NEAR from trading fees, so the amount depends on volume. Selling or sending coins resets their hold time.</p>
    </div>
  )
}

function Activity() {
  const history = useS((s) => s.history)
  if (!history.length) return <div className="card empty-card"><h2>No trades yet</h2><p className="muted">Your buys and sells will show here.</p></div>
  return <div className="card">{history.map((h) => <div className="line" key={h.id}><span className={h.side === 'buy' ? 'up' : 'down'}>{h.side === 'buy' ? 'Buy' : 'Sell'}</span><Link to={`/token/${h.tokenId}`} className="grow-1 ellipsis">{fmtAmt(h.tokens)} {h.ticker}</Link><span>{h.near.toFixed(2)} NEAR</span><small className="muted time">{ago(h.t)}</small></div>)}</div>
}

function Created({ mine, all, tokens }: { mine: Token[]; all: Token[]; tokens: Record<string, Token> }) {
  const home = useS((s) => s.homeTree)
  const crossings = useS((s) => s.crossings)
  if (!mine.length) return <div className="card empty-card"><h2>You haven't launched yet</h2><p className="muted">Tokens you create will show here.</p><Link to="/create" className="btn primary">Create token</Link></div>
  return (
    <div className="stack">
      <div className="created-grid">
        {mine.map((t) => {
          const earned = t.devEarned - t.devClaimed
          return (
            <div key={t.id} className="card created-card">
              <Link to={`/token/${t.id}`} className="created-head">
                <Cover t={t} size={64} />
                <span className="t-title"><b>${t.ticker}</b><small>{t.name}</small></span>
                <span className="owned-cell created-cap"><b>{fmtUsd(capUsd(t))}</b><small>Market cap</small></span>
              </Link>
              <Link to={`/token/${t.id}`} className="created-tree" aria-label={`Open $${t.ticker}`}><Tree growth={growth(capUsd(t))} twin={!!t.parents} sway framed /></Link>
              <CopyCa t={t} full />
              <div className="line"><span className="muted grow-1">Dev rewards</span><span>{fmtNear(earned)}</span></div>
              <Check checked={home === t.id} onChange={(v) => setHomeTree(v ? t.id : null)}>Show on my home page</Check>
              <button className="btn primary wide" disabled={earned <= 0} onClick={() => claimDev(t.id)}>Claim rewards</button>
            </div>
          )
        })}
      </div>
      <details className="card cross-box"><summary>Cross two tokens</summary><CrossForm mine={mine} all={all} /></details>
      {crossings.length > 0 && <div className="card"><h3>Crossings in progress</h3>{crossings.map((c) => <CrossRow key={c.id} c={c} tokens={tokens} />)}</div>}
    </div>
  )
}

function PublicProfile({ name }: { name: string }) {
  const tokens = useS((s) => s.tokens)
  const user = useS((s) => s.users?.[name])
  useEffect(() => { if (LIVE) void loadUser(name).catch(() => {}) }, [name])
  const created = LIVE ? (user?.created ?? []).map((id) => tokens[id]).filter(Boolean) : Object.values(tokens).filter((t) => t.dev === name || t.coDev === name)
  const held = LIVE ? (user?.held ?? []).map((id) => tokens[id]).filter(Boolean) : Object.values(tokens).filter((t) => t.holders[name])
  const [tab, setTab] = useState<'bought' | 'created'>('bought')
  return (
    <div className="page">
      <div className="profile-head">
        <UserAvatar name={name} size={104} />
        <div className="profile-info"><h1>{name}</h1><p className="muted">{held.length} tokens held · {created.length} created</p></div>
      </div>
      <PageTabs value={tab} onChange={setTab} options={[{ id: 'bought', label: 'Bought tokens' }, { id: 'created', label: 'Created tokens' }]} />
      <div key={tab} className="tab-swap">
        {tab === 'bought' && (held.length ? <div className="card-grid">{held.slice(0, 12).map((t) => <TokenCard key={t.id} t={t} />)}</div> : <p className="muted">Nothing held right now.</p>)}
        {tab === 'created' && (created.length ? <div className="card-grid">{created.map((t) => <TokenCard key={t.id} t={t} />)}</div> : <p className="muted">No tokens yet.</p>)}
      </div>
    </div>
  )
}

const DISCORD_LOGO = 'M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z'

// Only the handle is stored, and links are built from it, so a pasted address can't point anywhere else.
const LINK_RULES: { key: keyof ProfileLinks; label: string; hint: string; test: RegExp; url: (v: string) => string }[] = [
  { key: 'x', label: 'X', hint: 'Username', test: /^[A-Za-z0-9_]{1,15}$/, url: (v) => `https://x.com/${v}` },
  { key: 'tg', label: 'Telegram', hint: 'Username', test: /^[A-Za-z0-9_]{5,32}$/, url: (v) => `https://t.me/${v}` },
  { key: 'discord', label: 'Discord', hint: 'Invite code or discord.gg link', test: /^[A-Za-z0-9-]{2,32}$/, url: (v) => `https://discord.gg/${v}` },
]
const cleanHandle = (v: string) => v.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/^(x\.com|twitter\.com|t\.me|discord\.gg|discord\.com\/invite)\//i, '').replace(/^@/, '').replace(/\/$/, '')

function ProfileSocials({ links }: { links: ProfileLinks }) {
  return (
    <>
      {links.x && <a className="link-icon" href={`https://x.com/${links.x}`} target="_blank" rel="noopener noreferrer" aria-label="Open X" title="X"><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={X_LOGO} /></svg></a>}
      {links.tg && <a className="link-icon" href={`https://t.me/${links.tg}`} target="_blank" rel="noopener noreferrer" aria-label="Open Telegram" title="Telegram"><Icon d={ICONS.send} size={17} /></a>}
      {links.discord && <a className="link-icon" href={`https://discord.gg/${links.discord}`} target="_blank" rel="noopener noreferrer" aria-label="Open Discord" title="Discord"><svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={DISCORD_LOGO} /></svg></a>}
    </>
  )
}

function EditProfile({ leaving, onClose }: { leaving: boolean; onClose: () => void }) {
  const current = useS((s) => s.avatar)
  const savedBio = useS((s) => s.bio)
  const savedLinks = useS((s) => s.links)
  const [avatar, setAvatar] = useState(current)
  const [bio, setBio] = useState(savedBio)
  const [links, setLinks] = useState<Record<string, string>>({ x: savedLinks.x ?? '', tg: savedLinks.tg ?? '', discord: savedLinks.discord ?? '' })
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])
  const bad = (r: (typeof LINK_RULES)[number]) => { const v = cleanHandle(links[r.key]); return !!v && !r.test.test(v) }
  const save = () => {
    const out: ProfileLinks = {}
    for (const r of LINK_RULES) { const v = cleanHandle(links[r.key]); if (v) out[r.key] = v }
    saveProfile({ avatar, bio: bio.trim(), links: out })
    onClose()
  }
  return createPortal(
    <div className={`modal-back ${leaving ? 'leaving' : ''}`} onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal edit-modal" role="dialog" aria-modal="true" aria-label="Edit profile">
        <div className="row between"><h2>Edit profile</h2><button className="btn icon" aria-label="Close" onClick={onClose}><Icon d={ICONS.x} /></button></div>
        <div className="field"><span>Avatar</span>
          <div className="avatar-grid">{AVATARS.map((a) => <button key={a} className={a === avatar ? 'on' : ''} aria-label={`Use the ${a} avatar`} aria-pressed={a === avatar} onClick={() => setAvatar(a)}><span className="cover"><Art art={a} label="G" hue={100} /></span></button>)}</div>
        </div>
        <label className="field"><span>Bio</span><textarea className="input" rows={2} maxLength={160} value={bio} onChange={(e) => setBio(e.target.value)} /></label>
        <div className="edit-links">
          {LINK_RULES.map((r) => (
            <label className={`field ${r.key === 'discord' ? 'span-all' : ''}`} key={r.key}><span>{r.label}</span>
              <input className="input" maxLength={80} placeholder={r.hint} value={links[r.key]} onChange={(e) => setLinks({ ...links, [r.key]: e.target.value })} />
              {bad(r) && <small className="down">That doesn't look like a valid {r.label} {r.key === 'discord' ? 'invite' : 'username'}.</small>}
            </label>
          ))}
        </div>
        <div className="edit-actions">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={LINK_RULES.some(bad)} onClick={save}>Save</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

type Tab = 'positions' | 'created' | 'gardeners' | 'activity'
export default function Profile() {
  const { name } = useParams()
  const nav = useNavigate()
  const tokens = useS((s) => s.tokens)
  const me = useS((s) => s.me)
  const bio = useS((s) => s.bio)
  const links = useS((s) => s.links)
  const avatar = useS((s) => s.avatar)
  const rewards = useS((s) => s.rewards)
  const lots = useS((s) => s.lots)
  const balance = useS((s) => s.balance)
  const [tab, setTab] = useState<Tab>('positions')
  const [editing, setEditing] = useState(false)
  const editor = useExit(editing)
  if (name && name !== me) return <PublicProfile name={name} />
  const all = Object.values(tokens)
  const mine = all.filter((t) => t.dev === me || t.coDev === me)
  const toClaim = Object.values(rewards).reduce((n, v) => n + v, 0)
  const value = Object.entries(lots).reduce((n, [id, l]) => n + (tokens[id] ? lotTotal(l) * price(tokens[id]) * NEAR_USD : 0), 0)
  return (
    <div className="page">
      <div className="profile-head">
        <span className="cover profile-avatar"><Art art={avatar} label="G" hue={100} /></span>
        <div className="profile-info">
          <h1>{me ?? 'Your profile'}</h1>
          {me
            ? <div className="profile-actions">
                <button className="edit-btn" onClick={() => setEditing(true)}><Icon d={ICONS.pencil} size={16} />Edit profile</button>
                <ProfileSocials links={links} />
              </div>
            : <p className="muted">Track what you hold and claim what you earned.</p>}
          {me && bio && <p className="profile-bio">{bio}</p>}
        </div>
        {me
          ? <button className="btn primary" disabled={toClaim <= 0} onClick={claimAllRewards}>{toClaim > 0 ? `Claim ${toClaim.toFixed(2)} NEAR` : 'Nothing to claim'}</button>
          : <button className="btn primary" onClick={() => setWalletOpen(true)}>Connect wallet</button>}
      </div>
      {editor.visible && <EditProfile leaving={editor.leaving} onClose={() => setEditing(false)} />}
      {me
        ? <>
            <div className="summary-grid profile-summary">
              <div className="card"><small className="muted">Positions value</small><div className="big-num xl"><Num value={value} format={fmtUsd} /></div></div>
              <div className="card"><small className="muted">Wallet</small><div className="big-num xl">{fmtUsd(balance * NEAR_USD)}</div><small className="muted">{fmtNear(balance)}</small></div>
              <div className="card"><small className="muted">Rewards to claim</small><div className="big-num xl">{fmtUsd(toClaim * NEAR_USD)}</div><small className="muted">{fmtNear(toClaim)}</small></div>
            </div>
            <PageTabs value={tab} onChange={setTab} options={[{ id: 'positions', label: 'Positions' }, { id: 'created', label: 'Created tokens' }, { id: 'gardeners', label: 'Gardeners' }, { id: 'activity', label: 'Activity' }]} />
            <div key={tab} className="tab-swap">
              {tab === 'positions' && <Positions tokens={tokens} />}
              {tab === 'created' && <Created mine={mine} all={all} tokens={tokens} />}
              {tab === 'gardeners' && <Mine onCreate={() => nav('/gardeners?tab=create')} />}
              {tab === 'activity' && <Activity />}
            </div>
          </>
        : <p className="muted empty-note">Connect a wallet to see your profile.</p>}
    </div>
  )
}
