import { StrictMode, Suspense, lazy, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Link, NavLink, Navigate, Route, Routes, useLocation, useSearchParams } from 'react-router-dom'
import '@fontsource-variable/instrument-sans/wght.css'
import './styles.css'
import { Art } from './components/Art'
import { ICONS, Icon, Logo, ago, fmtNear, fmtUsd, useExit } from './components/ui'
import { NEAR_USD } from './lib/engine'
import { LIVE, WALLETS } from './lib/config'
import { applyRef, connectWallet, disconnect, markNoticesSeen, quickTurnOff, quickTurnOn, quickWithdraw, setTheme, setWalletOpen, startMarket, useS } from './lib/store'
import Home from './pages/Home'

const routes = {
  Tokens: () => import('./pages/Tokens'), TokenPage: () => import('./pages/TokenPage'), Create: () => import('./pages/Create'), Gardeners: () => import('./pages/Gardeners'), Agent: () => import('./pages/Agent'),
  Profile: () => import('./pages/Profile'), Invite: () => import('./pages/Invite'), Rules: () => import('./pages/Rules'), Swap: () => import('./pages/Swap'), Leaders: () => import('./pages/Leaders'),
}
const Stages = lazy(() => import('./pages/Stages'))
const Banner = lazy(() => import('./pages/Banner'))
const Tokens = lazy(routes.Tokens)
const TokenPage = lazy(routes.TokenPage)
const Create = lazy(routes.Create)
const Gardeners = lazy(routes.Gardeners)
const Agent = lazy(routes.Agent)
const Profile = lazy(routes.Profile)
const Invite = lazy(routes.Invite)
const Rules = lazy(routes.Rules)
const Swap = lazy(routes.Swap)
const Leaders = lazy(routes.Leaders)
// Fetch the other pages once the browser is idle, so navigation never flashes a loader.
setTimeout(() => Object.values(routes).forEach((load) => void load()), 1200)

// Replace with the project's own account once it exists.
const GROW_X = 'https://x.com'

const TOP = [
  { to: '/tokens', label: 'Tokens' }, { to: '/create', label: 'Create' }, { to: '/gardeners', label: 'Gardeners' }, { to: '/profile', label: 'Profile' },
]
const MORE = [
  { to: '/', label: 'Home', d: ICONS.home }, { to: '/tokens', label: 'Tokens', d: ICONS.list }, { to: '/create', label: 'Create token', d: ICONS.plus }, { to: '/swap', label: 'Swap', d: ICONS.swap },
  { to: '/gardeners', label: 'Gardeners', d: ICONS.leaf }, { to: '/leaderboard', label: 'Leaderboard', d: ICONS.trophy }, { to: '/profile', label: 'Profile', d: ICONS.user },
  { to: '/invite', label: 'Invite', d: ICONS.gift }, { to: '/rules', label: 'How it works', d: ICONS.book },
]
const MOBILE = [MORE[0], MORE[1], { to: '/create', label: 'Create', d: ICONS.plus }, MORE[4], MORE[6]]

function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close() }
    document.addEventListener('pointerdown', h)
    return () => document.removeEventListener('pointerdown', h)
  }, [open, close])
  return ref
}

function WalletModal() {
  const open = useS((s) => s.walletOpen)
  const { visible, leaving } = useExit(open)
  if (!visible) return null
  return (
    <div className={`modal-back ${leaving ? 'leaving' : ''}`} onPointerDown={(e) => { if (e.target === e.currentTarget) setWalletOpen(false) }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Connect a wallet">
        <div className="row between"><h2>Connect a wallet</h2><button className="btn icon" aria-label="Close" onClick={() => setWalletOpen(false)}><Icon d={ICONS.x} /></button></div>
        <p className="muted">Choose a NEAR wallet. grow. never holds your keys.</p>
        <div className="wallet-list">
          {WALLETS.map((w) => (
            <button key={w.id} className="wallet-row" onClick={() => connectWallet(w.id)}><span className="wallet-mark"><img src={w.icon} alt="" width={38} height={38} /></span><b>{w.name}</b></button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Quick trading in the wallet menu: a trading balance that buys and sells without a wallet approval each time. */
function QuickTrading() {
  const quick = useS((s) => s.quick)
  const [amount, setAmount] = useState('1')
  const [adding, setAdding] = useState(false)
  if (!LIVE) return null
  const n = Number(amount.replace(',', '.'))
  const ok = n >= 0.01
  const on = !!quick?.on
  const form = (label: string) => (
    <div className="quick-add">
      <label className="quick-amt"><input inputMode="decimal" aria-label="NEAR to put on the trading balance" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, '').slice(0, 8))} /><span>NEAR</span></label>
      <button className="btn primary small" disabled={!ok} onClick={() => { quickTurnOn(n); setAdding(false) }}>{label}</button>
    </div>
  )
  return (
    <div className="quick-box">
      <div className="row between"><b>Quick trading</b>{on && <span className="quick-on">On</span>}</div>
      {on ? (
        <>
          <span className="quick-bal">{fmtNear(quick!.balance)} <small>on your trading balance</small></span>
          {adding ? form('Add') : (
            <div className="quick-actions">
              <button onClick={() => setAdding(true)}>Top up</button>
              <button disabled={quick!.balance <= 0} onClick={quickWithdraw}>Withdraw</button>
              <button onClick={quickTurnOff}>Turn off</button>
            </div>
          )}
        </>
      ) : (
        <>
          <small className="quick-note">Buy and sell without approving each trade. One approval puts NEAR on a trading balance; taking it out always goes through your wallet.</small>
          {form('Turn on')}
        </>
      )}
    </div>
  )
}

function Wallet() {
  const me = useS((s) => s.me)
  const balance = useS((s) => s.balance)
  const avatar = useS((s) => s.avatar)
  const [open, setOpen] = useState(false)
  const { pathname } = useLocation()
  useEffect(() => setOpen(false), [pathname])
  const ref = useOutside(open, () => setOpen(false))
  const pop = useExit(open)
  if (!me) return <button className="btn primary small" onClick={() => setWalletOpen(true)}>Connect</button>
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="wallet-btn" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`Account menu, balance ${fmtNear(balance)}`}>
        <span className="cover"><Art art={avatar} label="G" hue={100} /></span>
        <span className="wallet-bal"><b>{fmtNear(balance)}</b><small>{fmtUsd(balance * NEAR_USD)}</small></span>
      </button>
      {pop.visible && (
        <div className={`menu ${pop.leaving ? 'leaving' : ''}`}>
          <small>{me}</small>
          <QuickTrading />
          <Link to="/profile">Profile</Link>
          <Link to="/invite">Invite friends</Link>
          <button onClick={() => { disconnect(); setOpen(false) }}>Disconnect</button>
        </div>
      )}
    </div>
  )
}

function Notifications() {
  const notices = useS((s) => s.notices)
  const seen = useS((s) => s.seenNotices)
  const [open, setOpen] = useState(false)
  const ref = useOutside(open, () => setOpen(false))
  const fresh = notices.length - seen
  const pop = useExit(open)
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="btn icon" aria-label={`Notifications${fresh > 0 ? `, ${fresh} new` : ''}`} onClick={() => { setOpen(!open); markNoticesSeen() }}>
        <Icon d={ICONS.bell} />{fresh > 0 && <i className="dot" />}
      </button>
      {pop.visible && (
        <div className={`menu wide-menu ${pop.leaving ? 'leaving' : ''}`}>
          {notices.length === 0 ? <small>Nothing yet. Activity on your tokens will appear here.</small> : notices.slice(0, 8).map((n) => (
            <Link key={n.id} to={n.to} onClick={() => setOpen(false)}>{n.text}<small className="block">{ago(n.t)} ago</small></Link>
          ))}
        </div>
      )}
    </div>
  )
}

function ThemeToggle() {
  const theme = useS((s) => s.theme)
  return <button className="btn icon theme-toggle" key={theme} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}><Icon d={theme === 'dark' ? ICONS.sun : ICONS.moon} /></button>
}

function BurgerMenu() {
  const [open, setOpen] = useState(false)
  const { pathname } = useLocation()
  useEffect(() => setOpen(false), [pathname])
  const ref = useOutside(open, () => setOpen(false))
  const pop = useExit(open)
  return (
    <div className="menu-wrap" ref={ref}>
      <button className={`btn icon burger ${open ? 'open' : ''}`} aria-label="Menu" aria-expanded={open} onClick={() => setOpen(!open)}><i /><i /><i /></button>
      {pop.visible && (
        <nav className={`menu nav-menu ${pop.leaving ? 'leaving' : ''}`}>
          {MORE.map((n, i) => <NavLink key={n.to} to={n.to} end={n.to === '/'} style={{ '--i': i } as React.CSSProperties}><Icon d={n.d} />{n.label}</NavLink>)}
        </nav>
      )}
    </div>
  )
}

function Shell() {
  const theme = useS((s) => s.theme)
  const toasts = useS((s) => s.toasts)
  const { pathname } = useLocation()
  const [params] = useSearchParams()
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  useEffect(() => { const r = params.get('ref'); if (r) applyRef(r) }, [params])
  useEffect(() => { window.scrollTo(0, 0) }, [pathname])
  return (
    <div className="shell">
      <header className="top">
        <Link to="/" className="top-logo" aria-label="grow. home"><Logo /></Link>
        <nav className="top-nav">{TOP.map((n) => <NavLink key={n.to} to={n.to}>{n.label}</NavLink>)}</nav>
        <div className="row gap-s top-right">
          <Notifications />
          <ThemeToggle />
          <Wallet />
          <BurgerMenu />
        </div>
      </header>
      <main key={pathname} className="route">
          <Suspense fallback={<div className="page"><div className="skeleton" /></div>}>
            <Routes>
              <Route path="/" element={<Home />} />
              {import.meta.env.DEV && <Route path="/dev-stages" element={<Stages />} />}
              {import.meta.env.DEV && <Route path="/dev-banner" element={<Banner />} />}
              <Route path="/tokens" element={<Tokens />} />
              <Route path="/token/:id" element={<TokenPage />} />
              <Route path="/create" element={<Create />} />
              <Route path="/swap" element={<Swap />} />
              <Route path="/gardeners" element={<Gardeners />} />
              <Route path="/gardeners/:id" element={<Agent />} />
              <Route path="/leaderboard" element={<Leaders />} />
              <Route path="/portfolio" element={<Navigate to="/profile" replace />} />
              <Route path="/profile" element={<Profile />} />
              <Route path="/user/:name" element={<Profile />} />
              <Route path="/invite" element={<Invite />} />
              <Route path="/rules" element={<Rules />} />
              <Route path="*" element={<div className="page center"><h1>This page didn't grow.</h1><Link className="btn primary" to="/">Go home</Link></div>} />
            </Routes>
          </Suspense>
        </main>
        <footer className="foot"><Link to="/rules">Fees, rules and risks</Link><nav className="foot-links" aria-label="Footer"><Link to="/rules">How it works</Link><Link to="/invite">Invite</Link><a href={GROW_X} target="_blank" rel="noopener noreferrer">Twitter</a></nav></footer>
      <nav className="tabbar">{MOBILE.map((n) => <NavLink key={n.to} to={n.to} end={n.to === '/'}><Icon d={n.d} size={22} /><span>{n.label}</span></NavLink>)}</nav>
      <WalletModal />
      <div className="toasts" role="status" aria-live="polite">{toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}</div>
    </div>
  )
}

startMarket()
createRoot(document.getElementById('root')!).render(
  <StrictMode><BrowserRouter><Shell /></BrowserRouter></StrictMode>,
)
