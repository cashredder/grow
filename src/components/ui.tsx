import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Art } from './Art'
import { NEAR_USD, capUsd, contractOf, holderCount, price, progress, type Token } from '../lib/engine'
import { setWalletOpen, toast, toggleFavorite, useS } from '../lib/store'

export const fmtUsd = (v: number) => {
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M'
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(v >= 1e5 ? 0 : 1) + 'K'
  return '$' + v.toFixed(v < 10 ? 2 : 0)
}
export const fmtNear = (v: number) => Math.abs(v) < 0.00005 ? '0 NEAR' : (v >= 1000 ? (v / 1000).toFixed(1) + 'K' : v >= 10 ? v.toFixed(1) : v.toFixed(v < 0.1 ? 4 : 2)) + ' NEAR'
export const fmtAmt = (v: number) => (v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : v.toFixed(v < 10 ? 2 : 0))
export const fmtPrice = (near: number) => '$' + (near * NEAR_USD).toPrecision(3)
export const ago = (t: number) => {
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return Math.floor(s) + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm'
  if (s < 86400) return Math.floor(s / 3600) + 'h'
  return Math.floor(s / 86400) + 'd'
}
// The percentage and the sparkline read the same window, so their colours always agree.
const TREND_POINTS = 40
export const trendPrices = (t: Token) => t.prices.slice(-TREND_POINTS).map((p) => p[1])
export const recentChange = (t: Token) => (price(t) / trendPrices(t)[0] - 1) * 100

/** Keeps a closing popup on screen long enough to play its exit animation. */
export function useExit(open: boolean, ms = 190) {
  const [shown, setShown] = useState(open)
  useEffect(() => {
    if (open) { setShown(true); return }
    const id = setTimeout(() => setShown(false), ms)
    return () => clearTimeout(id)
  }, [open, ms])
  return { visible: open || shown, leaving: !open && shown }
}

export const Icon = ({ d, size = 20 }: { d: string; size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
export const ICONS = {
  home: 'M3 11l9-8 9 8M5 10v10h14V10', list: 'M4 6h16M4 12h16M4 18h16', plus: 'M12 5v14M5 12h14', swap: 'M7 4v15m0 0l-3-3m3 3l3-3M17 20V5m0 0l-3 3m3-3l3 3',
  leaf: 'M12 21v-9m0 0c0-4 3-7 8-7 0 5-3 7-8 7zm0 3c0-3-2-5-7-5 0 4 3 5 7 5z', trophy: 'M8 4h8v6a4 4 0 01-8 0V4zM8 6H4c0 4 2 5 4 5M16 6h4c0 4-2 5-4 5M12 14v4M8 21h8M10 18h4v3h-4z', wallet: 'M3 7h18v13H3zM8 7V4h8v3M16 13h2',
  gift: 'M3 9h18v4H3zM5 13v8h14v-8M12 9v12M12 9c-3 0-5-1-5-3s3-3 5 3c2-6 5-5 5-3s-2 3-5 3z', user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21c1-5 4-7 8-7s7 2 8 7', book: 'M5 4h10a4 4 0 014 4v12H9a4 4 0 01-4-4V4zM5 16a4 4 0 014-4h10',
  bell: 'M6 16V11a6 6 0 1112 0v5l2 2H4l2-2zM10 21h4', search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4', sun: 'M12 3v2m0 14v2M3 12h2m14 0h2M6 6l1.500 1.500M16.500 16.500L18 18M6 18l1.500-1.500M16.500 7.500L18 6M12 8a4 4 0 100 8 4 4 0 000-8z', moon: 'M20 14A8 8 0 0110 4a8 8 0 1010 10z',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2',
  pencil: 'M4 20l1-4L16 5l3 3L8 19zM14 7l3 3',
  star: 'M12 4l2.500 5.200 5.700.8-4.100 4 1 5.700-5.100-2.700L6.900 19.700l1-5.700-4.100-4 5.700-.8z', share: 'M12 15V4m0 0L8 8m4-4l4 4M5 13v7h14v-7', copy: 'M9 9h11v11H9zM5 15H4V4h11v1', back: 'M15 5l-7 7 7 7', x: 'M5 5l14 14M19 5L5 19', send: 'M4 12l16-8-6 16-3-7z', globe: 'M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
}

export function Logo() {
  return <span className="logo" role="img" aria-label="grow." />
}

/** Tweens text directly on the DOM node, so a price tick never re-renders a row. */
export const Num = memo(function Num({ value, format }: { value: number; format: (v: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const shown = useRef(value)
  useEffect(() => {
    const from = shown.current
    if (from === value || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      shown.current = value
      if (ref.current) ref.current.textContent = format(value)
      return
    }
    // A quick colour flash shows which way the number moved.
    ref.current?.animate([{ color: value > from ? 'var(--pos)' : 'var(--neg)' }, { color: 'inherit' }], { duration: 900, easing: 'ease-out' })
    const start = performance.now()
    let raf = requestAnimationFrame(function step(t) {
      const k = Math.min(1, (t - start) / 420)
      const v = from + (value - from) * (1 - (1 - k) ** 3)
      shown.current = v
      if (ref.current) ref.current.textContent = format(v)
      if (k < 1) raf = requestAnimationFrame(step)
    })
    return () => cancelAnimationFrame(raf)
  }, [value, format])
  return <span ref={ref} className="num">{format(shown.current)}</span>
})

export function Cover({ t, size = 56 }: { t: { image?: string; art?: string; ticker: string; hue: number }; size?: number }) {
  return (
    <span className="cover" style={{ width: size, height: size, borderRadius: Math.max(8, size * 0.2) }}>
      {t.image ? <img src={t.image} alt="" loading="lazy" /> : <Art art={t.art} label={t.ticker} hue={t.hue} />}
    </span>
  )
}

export const Spark = memo(function Spark({ values, w = 120, h = 36 }: { values: number[]; w?: number; h?: number }) {
  const pts = values
  const lo = Math.min(...pts), hi = Math.max(...pts), span = hi - lo || 1
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${((i / Math.max(1, pts.length - 1)) * w).toFixed(1)} ${(h - 3 - ((v - lo) / span) * (h - 6)).toFixed(1)}`).join('')
  const rising = pts[pts.length - 1] >= pts[0]
  return <svg className="spark" style={{ width: w, height: h }} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true"><path d={d} fill="none" stroke={rising ? 'var(--chart-up)' : 'var(--neg)'} strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinejoin="round" /></svg>
})

export function Star({ id }: { id: string }) {
  const on = useS((s) => s.favorites.includes(id))
  return (
    <button className={`star ${on ? 'on' : ''}`} key={String(on)} aria-label={on ? 'Remove from watchlist' : 'Add to watchlist'} aria-pressed={on} onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFavorite(id) }}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d={ICONS.star} /></svg>
    </button>
  )
}

export const X_LOGO = 'M18.2 2.25h3.31l-7.23 8.26 8.5 11.24h-6.66l-5.21-6.82-5.97 6.82H1.68l7.73-8.84L1.25 2.25h6.83l4.71 6.23zm-1.16 17.52h1.83L7.08 4.13H5.12z'
const quiet = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation() }
const open = (url?: string) => { if (url && /^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer') }

const CopyMark = ({ on, size }: { on: boolean; size: number }) => (
  <span className={`copy-mark ${on ? 'on' : ''}`} style={{ width: size, height: size }}>
    <Icon d={ICONS.copy} size={size} />
    <svg className="copy-tick" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12.500l4.500 4.500L19 7" pathLength={1} /></svg>
  </span>
)

/** Copies the contract address. Works inside a row link without opening the token. */
export function CopyCa({ t, full = false }: { t: Pick<Token, 'id' | 'account'>; full?: boolean }) {
  const ca = contractOf(t)
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = (e: React.MouseEvent) => {
    quiet(e)
    const fail = () => toast('Could not copy. Select the address by hand.', 'err')
    if (!navigator.clipboard) return fail()
    navigator.clipboard.writeText(ca).then(() => {
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1600)
    }, fail)
  }
  const label = copied ? 'Contract address copied' : `Copy contract address ${ca}`
  return full
    ? <button className={`ca-pill ${copied ? 'copied' : ''}`} onClick={copy} aria-label={label}><span className="ca-tag">CA</span><span className="ellipsis">{ca}</span><CopyMark on={copied} size={16} /></button>
    : <button className="link-icon" onClick={copy} aria-label={label} title={copied ? 'Copied' : 'Copy contract address'}><CopyMark on={copied} size={17} /></button>
}

export function TokenLinks({ t }: { t: Token }) {
  return (
    <span className="t-links">
      {t.socials.x && <button className="link-icon" aria-label="Open X" title="X" onClick={(e) => { quiet(e); open(t.socials.x) }}><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={X_LOGO} /></svg></button>}
      {t.socials.web && <button className="link-icon" aria-label="Open website" title="Website" onClick={(e) => { quiet(e); open(t.socials.web) }}><Icon d={ICONS.globe} size={17} /></button>}
      {t.socials.tg && <button className="link-icon" aria-label="Open Telegram" title="Telegram" onClick={(e) => { quiet(e); open(t.socials.tg) }}><Icon d={ICONS.send} size={17} /></button>}
      <CopyCa t={t} />
    </span>
  )
}

/** Named link buttons for the token page. */
export function TokenSocials({ t }: { t: Token }) {
  return (
    <>
      {t.socials.x && <button className="social-btn" onClick={() => open(t.socials.x)}><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={X_LOGO} /></svg>Twitter</button>}
      {t.socials.web && <button className="social-btn" onClick={() => open(t.socials.web)}><Icon d={ICONS.globe} size={16} />Website</button>}
      {t.socials.tg && <button className="social-btn" onClick={() => open(t.socials.tg)}><Icon d={ICONS.send} size={16} />Telegram</button>}
    </>
  )
}

export const AVATARS = ['sapling', 'oak', 'acorn', 'moss', 'clover', 'bonsai', 'truffle', 'willow', 'pollen', 'fern', 'thorn', 'ivy']

/** Your chosen avatar, or a sticker picked from the name, so everyone else always looks the same too. */
export function UserAvatar({ name, size = 40 }: { name: string; size?: number }) {
  const me = useS((s) => s.me)
  const mine = useS((s) => s.avatar)
  const hash = [...name].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7)
  return <span className="cover" style={{ width: size, height: size, borderRadius: Math.max(8, size * 0.24) }}><Art art={name === me ? mine : AVATARS[hash % AVATARS.length]} label={name.slice(0, 2).toUpperCase()} hue={100} /></span>
}

const stage = (t: Token) => (t.parents ? 'Crossed' : t.phase === 'pool' ? 'In pool' : `${Math.round(progress(t) * 100)}%`)

export const TokenRow = memo(function TokenRow({ t, i }: { t: Token; i: number }) {
  const cap = capUsd(t)
  const change = recentChange(t)
  return (
    <Link to={`/token/${t.id}`} className="t-row" style={{ '--i': Math.min(i, 14) } as React.CSSProperties}>
      <Star id={t.id} />
      <span className="t-name">
        <Cover t={t} size={64} />
        <span className="t-title"><b>${t.ticker}</b><small>{t.name} · {ago(t.createdAt)}</small></span>
        <span className="hide-s"><TokenLinks t={t} /></span>
      </span>
      <span className="cell-r"><Num value={cap} format={fmtUsd} /></span>
      <span className={`cell-r ${change >= 0 ? 'up' : 'down'}`}>{change >= 0 ? '+' : ''}{change.toFixed(1)}%</span>
      <span className="cell-r hide-m">{fmtUsd(t.volume * NEAR_USD)}</span>
      <span className="cell-r hide-m">{holderCount(t)}</span>
      <span className="hide-m"><Spark values={[...trendPrices(t).slice(0, -1), price(t)]} /></span>
      <span className="stage-cell hide-m"><span>{stage(t)}</span><span className="bar"><i style={{ transform: `scaleX(${progress(t)})` }} /></span></span>
    </Link>
  )
})

export const TokenCard = memo(function TokenCard({ t, note }: { t: Token; note?: string }) {
  const change = recentChange(t)
  return (
    <Link to={`/token/${t.id}`} className="t-card">
      <Cover t={t} size={104} />
      <span className="t-card-body">
        <span className="row between"><span className="t-card-id"><b>${t.ticker}</b><small className="muted ellipsis">{t.name}</small></span><span className={change >= 0 ? 'up' : 'down'}>{change >= 0 ? '+' : ''}{change.toFixed(1)}%</span></span>
        <span className="row between t-card-mid"><small className="muted ellipsis">{t.desc}</small><TokenLinks t={t} /></span>
        <span className="row between t-card-foot"><span className="big-num"><Num value={capUsd(t)} format={fmtUsd} /></span><small className="muted">{note ?? stage(t)}</small></span>
        <span className="bar"><i style={{ transform: `scaleX(${progress(t)})` }} /></span>
      </span>
    </Link>
  )
})

// Candle sizes, like the popular launchpads. Quiet periods are skipped rather than drawn as empty candles.
const FRAMES = [
  { id: '1s', label: '1s', ms: 1_000 }, { id: '5s', label: '5s', ms: 5_000 },
  { id: '1m', label: '1m', ms: 60_000 }, { id: '5m', label: '5m', ms: 300_000 }, { id: '15m', label: '15m', ms: 900_000 }, { id: '30m', label: '30m', ms: 1_800_000 },
  { id: '1h', label: '1h', ms: 3_600_000 }, { id: '4h', label: '4h', ms: 14_400_000 }, { id: '1d', label: '1D', ms: 86_400_000 },
]
const MAX_CANDLES = 64
const MIN_SLOTS = 28
const SCALE_LEVELS = [0.12, 0.38, 0.62, 0.88]
const TICK = 'M5 12.500l4.500 4.500L19 7'

function ChartMenu({ label, title, children }: { label: ReactNode; title: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false)
  const pop = useExit(open)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="chart-tool" aria-label={title} aria-expanded={open} onClick={() => setOpen(!open)}>
        {label}
        <svg className={`chart-caret ${open ? 'open' : ''}`} width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 3.500l3 3 3-3" /></svg>
      </button>
      {pop.visible && <div className={`menu chart-menu ${pop.leaving ? 'leaving' : ''}`}>{children(() => setOpen(false))}</div>}
    </div>
  )
}

export const Chart = memo(function Chart({ prices, supply, height = 300 }: { prices: [number, number][]; supply: number; height?: number }) {
  const [frame, setFrame] = useState('15m')
  const [mode, setMode] = useState<'candles' | 'line'>('candles')
  const [unit, setUnit] = useState<'price' | 'cap'>('price')
  const [hover, setHover] = useState<number | null>(null)
  const W = 800
  const ms = FRAMES.find((f) => f.id === frame)!.ms
  const { candles, lo, hi } = useMemo(() => {
    const buckets: { k: number; o: number; h: number; l: number; c: number; t: number }[] = []
    const sorted = [...prices].sort((a, b) => a[0] - b[0])
    let prev = sorted[0]?.[1] ?? 0
    for (const [t, v] of sorted) {
      const k = Math.floor(t / ms)
      const last = buckets[buckets.length - 1]
      if (last && last.k === k) { last.c = v; last.h = Math.max(last.h, v); last.l = Math.min(last.l, v) }
      else buckets.push({ k, o: prev, c: v, h: Math.max(prev, v), l: Math.min(prev, v), t: k * ms })
      prev = v
    }
    const use = buckets.slice(-MAX_CANDLES)
    return { candles: use, lo: Math.min(...use.map((b) => b.l)), hi: Math.max(...use.map((b) => b.h)) }
  }, [prices, ms])
  if (prices.length < 2 || !candles.length) return <div className="empty" style={{ height }}>The chart starts after the first trade.</div>
  const range = hi - lo || hi || 1
  const y = (v: number) => height - 18 - ((v - lo) / range) * (height - 36)
  const step = W / Math.max(candles.length, MIN_SLOTS)
  // New candles sit on the right, so a young token doesn't stretch a few candles across the chart.
  const xAt = (i: number) => W - (candles.length - i) * step + step / 2
  const show = (near: number) => (unit === 'cap' ? fmtUsd(near * supply * NEAR_USD) : fmtPrice(near))
  const index = hover === null ? candles.length - 1 : Math.min(hover, candles.length - 1)
  const cur = candles[index]
  const last = candles[candles.length - 1]
  const line = candles.map((b, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)} ${y(b.c).toFixed(1)}`).join('')
  const day = (t: number) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric' })
  // Candles from an earlier day carry their date, so skipped quiet periods can't make the axis misleading.
  const stamp = (t: number) => {
    if (ms >= 14_400_000) return day(t)
    const time = new Date(t).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: ms < 60_000 ? '2-digit' : undefined, hour12: false })
    return day(t) === day(last.t) ? time : `${day(t)} ${time}`
  }
  const labelEvery = Math.max(1, Math.ceil(candles.length / 5))
  return (
    <div>
      <div className="chart-toolbar">
        <ChartMenu title="Candle size" label={FRAMES.find((f) => f.id === frame)!.label}>
          {(close) => FRAMES.map((f) => <button key={f.id} className={frame === f.id ? 'on' : ''} aria-pressed={frame === f.id} onClick={() => { setFrame(f.id); setHover(null); close() }}>{f.label}{frame === f.id && <Icon d={TICK} size={15} />}</button>)}
        </ChartMenu>
        <i className="chart-sep" />
        <button className="chart-tool" aria-label={mode === 'candles' ? 'Show a line chart' : 'Show a candle chart'} title={mode === 'candles' ? 'Candles' : 'Line'} onClick={() => setMode(mode === 'candles' ? 'line' : 'candles')}>
          <span key={mode} className="chart-mode"><Icon d={mode === 'candles' ? 'M8 3v4M8 15v5M6 7h4v8H6zM16 5v3M16 17v4M14 8h4v9h-4z' : 'M3 17l6-6 4 4 8-9'} size={18} /></span>
        </button>
        <i className="chart-sep" />
        <span className="chart-unit">
          <button className={unit === 'price' ? 'on' : ''} aria-pressed={unit === 'price'} onClick={() => setUnit('price')}>Price</button>
          <span aria-hidden="true">/</span>
          <button className={unit === 'cap' ? 'on' : ''} aria-pressed={unit === 'cap'} onClick={() => setUnit('cap')}>MCap</button>
        </span>
      </div>
      <div className="chart-now">
        <b className="chart-price">{show(cur.c)}</b>
        <small className="muted chart-ohlc">{hover === null ? (unit === 'cap' ? 'market cap' : 'price') : `O ${show(cur.o)}  H ${show(cur.h)}  L ${show(cur.l)}  ${stamp(cur.t)}`}</small>
      </div>
      <div className="chart" style={{ height }} onPointerLeave={() => setHover(null)} onPointerMove={(e) => {
        const r = e.currentTarget.querySelector('svg')!.getBoundingClientRect()
        const i = candles.length - 1 - Math.floor(((r.right - e.clientX) / r.width) * (W / step))
        setHover(i >= 0 && e.clientX <= r.right ? i : null)
      }}>
        <svg key={frame + mode} className="chart-svg" viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" style={{ height }} role="img" aria-label={unit === 'cap' ? 'Market cap chart' : 'Price chart'}>
          {SCALE_LEVELS.map((f) => <line key={f} x1="0" x2={W} y1={height * f} y2={height * f} stroke="var(--line)" vectorEffect="non-scaling-stroke" />)}
          <line x1="0" x2={W} y1={y(last.c)} y2={y(last.c)} stroke={last.c >= last.o ? 'var(--chart-up)' : 'var(--neg)'} strokeDasharray="3 4" vectorEffect="non-scaling-stroke" opacity=".7" />
          {mode === 'line' && <path d={line} fill="none" stroke="var(--chart-up)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />}
          {mode === 'candles' && candles.map((b, i) => {
            const up = b.c >= b.o
            const x = xAt(i)
            const top = y(Math.max(b.o, b.c)), bottom = y(Math.min(b.o, b.c))
            return <g key={b.k} fill={up ? 'var(--chart-up)' : 'var(--neg)'} stroke={up ? 'var(--chart-up)' : 'var(--neg)'}>
              <line x1={x} x2={x} y1={y(b.h)} y2={y(b.l)} vectorEffect="non-scaling-stroke" />
              <rect x={x - step * 0.34} width={step * 0.68} y={top} height={Math.max(1.5, bottom - top)} stroke="none" rx="1" />
            </g>
          })}
          {hover !== null && <line x1={xAt(index)} x2={xAt(index)} y1="0" y2={height} stroke="var(--faint)" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />}
        </svg>
        <div className="chart-scale" aria-hidden="true">
          {SCALE_LEVELS.map((f) => <span key={f} style={{ top: height * f }}>{show(hi - ((height * f - 18) / (height - 36)) * range)}</span>)}
          <span className={`chart-last ${last.c >= last.o ? 'rising' : 'falling'}`} style={{ top: y(last.c) }}>{show(last.c)}</span>
        </div>
      </div>
      <div className="chart-times" aria-hidden="true">
        {candles.map((b, i) => ((candles.length - 1 - i) % labelEvery === 0 ? <span key={b.k} style={{ left: `${(xAt(i) / W) * 100}%` }}>{stamp(b.t)}</span> : null))}
      </div>
    </div>
  )
})

export function ConnectGate({ children, text }: { children: ReactNode; text: string }) {
  const me = useS((s) => s.me)
  if (me) return <>{children}</>
  return (
    <div className="card empty-card">
      <h2>{text}</h2>
      <p className="muted">Connect a wallet to continue.</p>
      <button className="btn primary" onClick={() => setWalletOpen(true)}>Connect wallet</button>
    </div>
  )
}

export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  const idx = Math.max(0, options.findIndex((o) => o.id === value))
  return (
    <div className="tabs" role="tablist" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0,1fr))` }}>
      <span className="tabs-thumb" style={{ width: `calc((100% - 6px) / ${options.length})`, transform: `translateX(${idx * 100}%)` }} />
      {options.map((o) => <button key={o.id} type="button" role="tab" aria-selected={o.id === value} onClick={() => onChange(o.id)} className={o.id === value ? 'active' : ''}>{o.label}</button>)}
    </div>
  )
}

/** Page-level navigation: plain labels with a sliding underline. */
export function PageTabs<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  const wrap = useRef<HTMLDivElement>(null)
  const [bar, setBar] = useState({ x: 0, w: 0 })
  useLayoutEffect(() => {
    const measure = () => {
      const el = wrap.current?.querySelector<HTMLElement>('[aria-selected="true"]')
      if (el) setBar({ x: el.offsetLeft, w: el.offsetWidth })
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (wrap.current) ro.observe(wrap.current)
    return () => ro.disconnect()
  }, [value, options.length])
  return (
    <div className="ptabs" role="tablist" ref={wrap}>
      {options.map((o) => <button key={o.id} type="button" role="tab" aria-selected={o.id === value} className={o.id === value ? 'active' : ''} onClick={() => onChange(o.id)}>{o.label}</button>)}
      <span className="ptabs-bar" style={{ width: bar.w, transform: `translateX(${bar.x}px)` }} />
    </div>
  )
}

export function Slider({ value, min, max, step, onChange, format, marks, label }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; format: (v: number) => string; marks?: number[]; label: string }) {
  const p = ((value - min) / (max - min)) * 100
  return (
    <div className="slider" style={{ '--p': p } as React.CSSProperties}>
      <span className="slider-bubble" key={value}>{format(value)}</span>
      <input type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} />
      {marks && <div className="slider-marks">{marks.map((m) => <button key={m} type="button" className={m <= value ? 'on' : ''} style={{ left: `${((m - min) / (max - min)) * 100}%` }} onClick={() => onChange(m)}>{format(m)}</button>)}</div>}
    </div>
  )
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="box" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M4.500 10.500l3.700 3.700 7.300-8" /></svg></span>
      <span>{children}</span>
    </label>
  )
}

export const Page = ({ title, sub, action, children }: { title: string; sub?: string; action?: ReactNode; children: ReactNode }) => (
  <div className="page">
    <div className="page-head">
      <div><h1>{title}</h1>{sub && <p className="muted lead">{sub}</p>}</div>
      {action}
    </div>
    {children}
  </div>
)
