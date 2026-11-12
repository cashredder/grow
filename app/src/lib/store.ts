// App state and every action the UI calls. On the live site (VITE_API_URL set) actions go to lib/live.ts:
// wallet transactions and API calls. Without it a built-in market runs here, for working on the design.
import { useSyncExternalStore } from 'react'
import { LIVE } from './config'
import * as live from './live'
import { CURVE_END_TOK, POOL_TOK, SUPPLY, V_BASE, V_TOK, holdWeight, price, quote, splitFee, type GardenerAction, type Token } from './engine'

export const DAY = 86_400_000
export const STRATEGIES = [
  { id: 'ai', name: 'AI Trader', risk: 'Medium', blurb: 'A NEAR AI model reads the market and trades within your limits. Every decision is signed inside a TEE and costs 0.001 NEAR from the gardener; an unchanged market is not asked again.' },
  { id: 'steady', name: 'Steady', risk: 'Low', blurb: 'Buys a fixed amount of top tokens on a schedule.' },
  { id: 'trend', name: 'Trend Rider', risk: 'High', blurb: 'Buys tokens gaining volume and unique traders.' },
  { id: 'dip', name: 'Dip Buyer', risk: 'Medium', blurb: 'Buys sharp drops on tokens with strong holders.' },
  { id: 'grad', name: 'Graduation', risk: 'High', blurb: 'Enters tokens close to moving into their pool.' },
  { id: 'exit', name: 'Take Profit', risk: 'Low', blurb: 'Takes profit in steps at set price targets.' },
] as const

/** A token's own gardener: not offered for hire, chosen at launch. */
export const TREASURER = { id: 'treasurer', name: 'AI Treasurer', risk: 'Low', blurb: "A NEAR AI model runs the token's treasury: buybacks, holder rewards and the dev's pay, within limits the contract enforces. Each decision costs 0.001 NEAR from the treasury, never from holder rewards." } as const
export const strategyOf = (id: string) => (id === 'treasurer' || id === 'dev' ? TREASURER : STRATEGIES.find((s) => s.id === id))

export const FIRE_DRAWDOWN = 30
export const WARN_DRAWDOWN = 18

export interface Lot { amt: number; t: number }
export interface AiDecision { id: number; ts: number; kind: string; model: string; signing_address: string | null; signature_ok: boolean; attested: boolean; error: string | null; summary: string }
export interface House { ai?: AiDecision[]; id: string; name: string; art: string; strategy: string; status: 'active' | 'warning' | 'fired'; start: number; equity: number; peak: number; trades: number; wins: number; hiredAt: number; firedAt?: number; history: [number, number][]; log: GardenerAction[]; owner?: string; copiers: number }
export interface Copy { id: string; agentId: string; perTrade: number; budget: number; stopLoss: number; pnl: number; trades: number; stopped: boolean; startedAt: number; log: GardenerAction[] }
export interface Hired { id: string; name: string; strategy: string; custom?: string; budget: number; dailyLimit: number; stopLoss: number; until: number; allowed: 'all' | 'graduated'; paused: boolean; fired: boolean; pnl: number; trades: number; wins: number; createdAt: number; history: [number, number][]; log: GardenerAction[]; apiKeyId?: string }
export interface ApiKey { id: string; name: string; hint: string; createdAt: number; dailyLimit: number }
export interface Crossing { id: string; a: string; b: string; split: number; name: string; ticker: string; status: 'waiting' | 'window'; endsAt: number; createdAt: number; proposer?: string; partner?: string }
export interface Feed { id: number; text: string; tokenId: string; side: 'buy' | 'sell' | 'new' | 'cross'; t: number }
export interface Toast { id: number; text: string; kind: 'ok' | 'err' }
export interface Notice { id: number; text: string; to: string; t: number }
export interface HistoryItem { id: number; tokenId: string; ticker: string; side: 'buy' | 'sell'; near: number; tokens: number; t: number }
export interface State {
  tokens: Record<string, Token>; me: string | null; balance: number; lots: Record<string, Lot[]>; rewards: Record<string, number>
  refCode: string; referredBy: string | null; refEarned: number; refClaimed: number; invited: number
  homeTree: string | null; house: House[]; hired: Hired[]; copies: Copy[]; avatar: string; apiKeys: ApiKey[]; crossings: Crossing[]; feed: Feed[]; toasts: Toast[]
  theme: 'dark' | 'light'; slippage: number; favorites: string[]; bio: string; links: ProfileLinks
  notices: Notice[]; seenNotices: number; history: HistoryItem[]; startedUser: boolean; walletOpen: boolean
  board?: live.Board; users?: Record<string, live.PublicUser>
  /** Live only: quick trading (a trading balance on the launchpad and a key in this browser). */
  quick?: { on: boolean; balance: number }
}

export interface ProfileLinks { x?: string; tg?: string; discord?: string }
const KEY = 'grow.state.v11'
let uid = 1
const next = () => uid++
const BOTS = ['oak.near', 'fern.near', 'lime.near', 'rain.near', 'bark.near', 'moss.near', 'dew.near', 'seed.near', 'root.near', 'twig.near', 'petal.near', 'loam.near', 'sap.near', 'reed.near', 'pine.near', 'vine.near']
const TALK = ['Chart looks healthy.', 'Dev keeps shipping.', 'Holding past 10 days for the full reward.', 'This tree is getting thick.', 'Who else is in since the sprout?', 'Almost at the pool.', 'Gardener just bought back again.', 'Would love to see this crossed with something.', 'Rewards are actually paying out.', 'Bought the dip.', 'Nice community here.', 'Top holders look fine to me.']
const rnd = (a: number, b: number) => a + Math.random() * (b - a)
const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)]
const tx = () => Array.from({ length: 8 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')

function blank(name: string, ticker: string, desc: string, dev: string, createdAt: number, hue: number, feePct = 1): Token {
  return { id: ticker.toLowerCase() + '-' + next().toString(36), name, ticker, desc, hue, dev, createdAt, feePct, phase: 'curve', base: V_BASE, tok: V_TOK, supply: SUPPLY, holders: {}, rewardPool: 0, devEarned: 0, devClaimed: 0, burned: 0, redirect: { pct: 0, to: 'holders' }, gardener: false, log: [], trades: [], prices: [[createdAt, V_BASE / V_TOK]], socials: {}, comments: [], volume: 0, txns: 0 }
}

function graduate(t: Token) {
  if (t.phase === 'curve' && t.tok <= CURVE_END_TOK * 1.000001) {
    t.base = t.base - V_BASE
    t.tok = POOL_TOK
    t.phase = 'pool'
  }
}

/** Mutates a fresh token copy. */
function exec(t: Token, who: string, side: 'buy' | 'sell', amount: number, now: number, s?: State) {
  const q = quote(t, side, amount, now)
  if (q.out <= 0) return null
  const k = t.base * t.tok
  const split = splitFee(t, q.fee, t.phase === 'pool' ? q.rate : t.feePct / 100, q.rate, !!s?.referredBy && who === s.me)
  const hold = { ...t.holders }
  if (side === 'buy') {
    t.base += q.used - q.fee; t.tok = k / t.base
    hold[who] = (hold[who] || 0) + q.out
  } else {
    t.tok += amount; t.base = k / t.tok
    hold[who] = Math.max(0, (hold[who] || 0) - amount)
    if (hold[who] < 1e-6) delete hold[who]
  }
  t.holders = hold
  t.devEarned += split.dev
  t.rewardPool += split.holders
  if (split.buyback > 0) t.burned = Math.min(t.supply * 0.5, t.burned + split.buyback / price(t))
  graduate(t)
  const near = side === 'buy' ? q.used : q.out
  t.volume += near
  t.txns += 1
  t.trades = [{ id: next(), who, side, near, tokens: side === 'buy' ? q.out : amount, t: now }, ...t.trades].slice(0, 60)
  t.prices = [...t.prices, [now, price(t)] as [number, number]].slice(-240)
  return { q, split, near }
}

function sampleLog(now: number): GardenerAction[] {
  return [
    { id: next(), t: now - 3_600_000, kind: 'Buyback', note: 'Volume is up and the daily limit allows it.', near: 12.4, tx: tx() },
    { id: next(), t: now - 9_000_000, kind: 'Blocked', note: 'Requested 80 NEAR. The contract rejected it: above the daily limit.', near: 80, tx: tx(), rejected: true },
    { id: next(), t: now - 26_000_000, kind: 'Add liquidity', note: 'Moved rewards into the pool to reduce price impact.', near: 20, tx: tx() },
  ]
}

function hireAgent(name: string, art: string, strategy: string, now: number, age: number, drift: number, owner?: string): House {
  const start = 10000
  const history: [number, number][] = []
  let equity = start, peak = start, wins = 0
  const trades = 40 + Math.floor(age / DAY) * 7
  for (let i = 0; i < trades; i++) {
    const change = equity * (rnd(-0.03, 0.03) + drift)
    equity += change
    peak = Math.max(peak, equity)
    if (change > 0) wins++
    history.push([now - age + (age * i) / trades, equity])
  }
  const dd = (1 - equity / peak) * 100
  return { id: 'g-' + name.toLowerCase(), name, art, strategy, status: dd >= WARN_DRAWDOWN ? 'warning' : 'active', start, equity, peak, trades, wins, hiredAt: now - age, history: history.slice(-120), log: [], owner, copiers: Math.floor(rnd(owner ? 3 : 40, owner ? 60 : 900)) }
}

function seed(): State {
  const now = Date.now()
  const defs: [string, string, string, number, number, string][] = [
    ['Old Oak', 'OAK', 'The first big tree in the forest. Slow, stubborn and still growing.', 38000, 96, 'oak'], ['Moss', 'MOSS', 'Slow, soft, and everywhere.', 15000, 120, 'moss'], ['Acorn', 'ACORN', 'Small coin. Big plans.', 8000, 80, 'acorn'],
    ['Bonsai', 'BONSAI', 'Tiny on purpose. Trimmed daily.', 3400, 140, 'bonsai'], ['Clover', 'CLVR', 'Four leaves, one chart.', 1700, 110, 'clover'], ['Truffle', 'TRUF', 'Found by pigs. Held by legends.', 1000, 40, 'truffle'],
    ['Willow', 'WILO', 'Bends and never breaks.', 650, 150, 'willow'], ['Pollen', 'POLN', 'Spreads faster than you think.', 420, 60, 'pollen'], ['Fern', 'FERN', 'Older than dinosaurs.', 260, 130, 'fern'],
    ['Thorn', 'THRN', 'Do not touch the top.', 150, 10, 'thorn'], ['Ivy', 'IVY', 'Climbs anything.', 90, 125, 'ivy'], ['Sapling', 'SAPL', 'Just planted this morning.', 40, 100, 'sapling'],
  ]
  const tokens: Record<string, Token> = {}
  defs.forEach(([name, ticker, desc, spend, hue, art], i) => {
    const age = (i < 6 ? rnd(3, 12) : rnd(0.1, 2)) * DAY
    const t = blank(name, ticker, desc, BOTS[i % BOTS.length], now - age, hue)
    t.art = art
    t.socials = { x: '#', web: '#', tg: i % 2 ? '#' : undefined }
    const steps = 90
    for (let n = 0; n < steps; n++) {
      const when = now - age + (age * n) / steps
      exec(t, pick(BOTS), 'buy', (spend / steps) * rnd(1, 1.6), when)
      const who = pick(Object.keys(t.holders))
      if (Math.random() < 0.34) exec(t, who, 'sell', t.holders[who] * rnd(0.05, 0.3), when + 1000)
    }
    // The latest stretch of trading goes both ways: about half the tokens are falling.
    const falling = i % 2 === 1
    for (let n = 0; n < 45; n++) {
      const when = now - (45 - n) * 240_000
      const up = Math.random() < (falling ? 0.28 : 0.72)
      const holders = Object.keys(t.holders)
      if (up || !holders.length) exec(t, pick(BOTS), 'buy', t.base * rnd(0.003, 0.012), when)
      else { const w = pick(holders); exec(t, w, 'sell', t.holders[w] * rnd(0.03, 0.1), when) }
    }
    if (i % 3 === 0) { t.gardener = true; t.log = sampleLog(now) }
    t.comments = Array.from({ length: 3 + (i % 5) }, (_, c) => ({ id: next(), who: pick(BOTS), text: pick(TALK), t: now - (c + 1) * rnd(600_000, 3_000_000) }))
    tokens[t.id] = t
  })
  const house: House[] = [
    hireAgent('Rowan', 'oak', 'steady', now, 40 * DAY, 0.0022),
    hireAgent('Hazel', 'acorn', 'dip', now, 26 * DAY, 0.0016),
    hireAgent('Sage', 'fern', 'exit', now, 33 * DAY, 0.0012),
    hireAgent('Bram', 'thorn', 'trend', now, 14 * DAY, 0.0034),
    hireAgent('Linden', 'willow', 'grad', now, 8 * DAY, -0.0028),
  ]
  const community: House[] = [
    hireAgent('Night Shift', 'pollen', 'trend', now, 21 * DAY, 0.0026, 'reed.near'),
    hireAgent('Slow Sap', 'moss', 'steady', now, 52 * DAY, 0.0014, 'pine.near'),
    hireAgent('Dip Goblin', 'bonsai', 'dip', now, 17 * DAY, 0.0031, 'dew.near'),
    hireAgent('Pool Hopper', 'clover', 'grad', now, 11 * DAY, 0.0009, 'sap.near'),
    hireAgent('Exit Liquidity', 'sapling', 'exit', now, 29 * DAY, -0.0009, 'twig.near'),
  ]
  const fired: House[] = [['Ash', 'truffle', 'trend'], ['Birch', 'ivy', 'grad']].map(([name, art, strategy], i) => {
    const h = hireAgent(name, art, strategy, now - (i + 1) * 12 * DAY, 18 * DAY, -0.0012)
    return { ...h, status: 'fired' as const, firedAt: now - (i + 1) * 12 * DAY, equity: h.peak * (0.66 + i * 0.03) }
  })
  return {
    tokens, me: null, balance: 5000, lots: {}, rewards: {}, refCode: 'grow' + tx().slice(0, 5), referredBy: null, refEarned: 0.62, refClaimed: 0, invited: 12,
    homeTree: null, house: [...house, ...community, ...fired], hired: [], copies: [], avatar: 'sapling', apiKeys: [], crossings: [], feed: [], toasts: [], theme: 'light', slippage: 3, favorites: [], bio: '', links: {},
    notices: [], seenNotices: 0, history: [], startedUser: false, walletOpen: false,
  }
}

/** The live site starts empty and fills from the API; only preferences are kept between visits. */
function loadLive(): State {
  const empty: State = {
    tokens: {}, me: null, balance: 0, lots: {}, rewards: {}, refCode: '', referredBy: null, refEarned: 0, refClaimed: 0, invited: 0,
    homeTree: null, house: [], hired: [], copies: [], avatar: 'sapling', apiKeys: [], crossings: [], feed: [], toasts: [], theme: 'light', slippage: 3, favorites: [], bio: '', links: {},
    notices: [], seenNotices: 0, history: [], startedUser: true, walletOpen: false,
  }
  try {
    const p = JSON.parse(localStorage.getItem(LIVE_KEY) || '{}') as Partial<State>
    return { ...empty, theme: p.theme ?? 'light', slippage: p.slippage ?? 3, homeTree: p.homeTree ?? null, favorites: p.favorites ?? [] }
  } catch {
    return empty
  }
}
const LIVE_KEY = 'grow.live.v1'

function load(): State {
  if (LIVE) return loadLive()
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const p = JSON.parse(raw) as State
      uid = Date.now() % 1_000_000_000
      return { ...p, toasts: [], walletOpen: false }
    }
  } catch { /* storage blocked: start fresh */ }
  return seed()
}

let state = load()
const subs = new Set<() => void>()
let saveTimer: ReturnType<typeof setTimeout> | undefined
function set(patch: Partial<State>) {
  state = { ...state, ...patch }
  subs.forEach((f) => f())
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      if (LIVE) localStorage.setItem(LIVE_KEY, JSON.stringify({ theme: state.theme, slippage: state.slippage, homeTree: state.homeTree, favorites: state.favorites }))
      else localStorage.setItem(KEY, JSON.stringify({ ...state, toasts: [] }))
    } catch { /* ignore */ }
  }, 800)
}
export const getState = () => state
export const patch = (p: Partial<State>) => set(p)
export function useS<T>(sel: (s: State) => T): T {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f) }, () => sel(state))
}

export function toast(text: string, kind: Toast['kind'] = 'ok') {
  const id = next()
  set({ toasts: [...state.toasts, { id, text, kind }].slice(-3) })
  setTimeout(() => set({ toasts: state.toasts.filter((t) => t.id !== id) }), kind === 'err' ? 5000 : 3000)
}
const feed = (text: string, tokenId: string, side: Feed['side']) => [{ id: next(), text, tokenId, side, t: Date.now() }, ...state.feed].slice(0, 30)
const put = (t: Token) => ({ ...state.tokens, [t.id]: t })
const notice = (text: string, to: string) => [{ id: next(), text, to, t: Date.now() }, ...state.notices].slice(0, 30)

export const setTheme = (theme: 'dark' | 'light') => set({ theme })
export const setSlippage = (slippage: number) => set({ slippage })
export const setHomeTree = (homeTree: string | null) => set({ homeTree })
export const setWalletOpen = (walletOpen: boolean) => set({ walletOpen })
export const saveProfile = (p: { avatar: string; bio: string; links: ProfileLinks }) => {
  if (LIVE) return void live.saveProfileLive(p)
  set(p); toast('Profile saved')
}
export const markNoticesSeen = () => {
  set({ seenNotices: state.notices.length })
  if (LIVE) void live.seenLive()
}
export const toggleFavorite = (id: string) => {
  const on = !state.favorites.includes(id)
  set({ favorites: on ? [...state.favorites, id] : state.favorites.filter((f) => f !== id) })
  if (LIVE && state.me) void live.favoriteLive(id, on)
}
export function applyRef(code: string) {
  if (!code || code === state.refCode || state.referredBy) return
  set({ referredBy: code })
  if (LIVE) void live.applyRefLive(code)
}
export const disconnect = () => (LIVE ? void live.disconnectLive() : set({ me: null }))
/** Wallet picker button: a real wallet on the live site. */
export const quickTurnOn = (near: number) => { if (LIVE) live.quickTurnOn(near) }
export const quickWithdraw = () => { if (LIVE) live.quickWithdraw() }
export const quickTurnOff = () => { if (LIVE) live.quickTurnOff() }
export const connectWallet = (walletId: string) => (LIVE ? void live.connectWith(walletId) : connect())

/** Fills a first-time account with holdings, so every section has content to show. */
export function connect() {
  const me = 'you.near'
  if (state.startedUser) return set({ me, walletOpen: false })
  const now = Date.now()
  const tokens = { ...state.tokens }
  const lots = { ...state.lots }
  const rewards = { ...state.rewards }
  const list = Object.values(tokens)
  const owned = list.find((t) => t.art === 'sapling')
  if (owned) tokens[owned.id] = { ...owned, dev: me, devEarned: Math.max(owned.devEarned, 1.84) }
  ;([['oak', 11.5, 60], ['moss', 6.2, 40], ['clover', 4, 12], ['pollen', 1.3, 4]] as [string, number, number][]).forEach(([art, days, spend]) => {
    const t = list.find((x) => x.art === art)
    if (!t) return
    const copy = { ...tokens[t.id] }
    const r = exec(copy, me, 'buy', spend, now)
    if (!r) return
    tokens[t.id] = copy
    lots[t.id] = [{ amt: r.q.out, t: now - days * DAY }]
    if (days >= 3) rewards[t.id] = days * 0.31
  })
  const n = list.slice(0, 3)
  set({
    me, walletOpen: false, tokens, lots, rewards, startedUser: true,
    notices: [
      { id: next(), text: 'Your $OAK hold reached 10 days. Reward weight is now ×2.', to: n[0] ? `/token/${n[0].id}` : '/profile', t: now - 1_800_000 },
      { id: next(), text: 'Sapling got 16 new holders today.', to: owned ? `/token/${owned.id}` : '/profile', t: now - 7_200_000 },
      { id: next(), text: 'Linden is close to being fired: down 19% from its peak.', to: '/gardeners/g-linden', t: now - 18_000_000 },
    ],
  })
  toast('Wallet connected')
}

export function userWeight(lots: Lot[] = [], now = Date.now()) {
  return lots.reduce((w, l) => w + l.amt * holdWeight((now - l.t) / DAY), 0)
}
export const lotTotal = (lots: Lot[] = []) => lots.reduce((n, l) => n + l.amt, 0)

/** Sold coins come off the newest purchases, so older coins keep their hold time. */
function removeLots(lots: Lot[], amount: number) {
  const out = [...lots].sort((a, b) => a.t - b.t)
  let left = amount
  for (let i = out.length - 1; i >= 0 && left > 0; i--) {
    const take = Math.min(out[i].amt, left)
    out[i] = { ...out[i], amt: out[i].amt - take }
    left -= take
  }
  return out.filter((l) => l.amt > 1e-6)
}

function creditRewards(tokenId: string, reward: number, t: Token) {
  const w = userWeight(state.lots[tokenId])
  if (w <= 0 || reward <= 0) return state.rewards
  const others = Object.entries(t.holders).reduce((n, [k, v]) => (k === state.me ? n : n + v), 0)
  return { ...state.rewards, [tokenId]: (state.rewards[tokenId] || 0) + (reward * w) / (w + others) }
}

export function trade(id: string, side: 'buy' | 'sell', amount: number, minOut: number, silent = false) {
  const s = state
  const t0 = s.tokens[id]
  if (!s.me) { setWalletOpen(true); return false }
  if (side === 'buy' && amount > s.balance) { toast('Not enough NEAR', 'err'); return false }
  if (side === 'sell' && amount > lotTotal(s.lots[id]) * 1.000001) { toast('Not enough tokens', 'err'); return false }
  if (LIVE) {
    if (side === 'buy') live.buy(id, amount, minOut)
    else live.sell(id, amount, minOut)
    return true
  }
  const t = { ...t0 }
  const now = Date.now()
  const pre = quote(t, side, amount, now)
  if (pre.out < minOut) { toast('Price moved past your slippage limit. Nothing was spent.', 'err'); return false }
  const r = exec(t, s.me, side, amount, now, s)
  if (!r) { toast('Amount is too small', 'err'); return false }
  const lots = side === 'buy'
    ? [...(s.lots[id] || []), { amt: r.q.out, t: now }]
    : removeLots(s.lots[id] || [], amount)
  const justGrad = t0.phase === 'curve' && t.phase === 'pool'
  set({
    tokens: put(t), balance: s.balance + (side === 'buy' ? -r.q.used : r.q.out), lots: { ...s.lots, [id]: lots },
    rewards: creditRewards(id, r.split.holders, t),
    feed: feed(`${s.me} ${side === 'buy' ? 'bought' : 'sold'} $${t.ticker} for ${r.near.toFixed(1)} NEAR`, id, side),
    history: [{ id: next(), tokenId: id, ticker: t.ticker, side, near: r.near, tokens: side === 'buy' ? r.q.out : amount, t: now }, ...s.history].slice(0, 80),
  })
  if (!silent) toast(justGrad ? `$${t.ticker} moved into its pool` : `${side === 'buy' ? 'Bought' : 'Sold'} $${t.ticker}`)
  return true
}

/** Swap between NEAR and any listed token. Token to token goes through NEAR. */
export function quoteSwap(from: string, to: string, amount: number) {
  const now = Date.now()
  if (!(amount > 0) || from === to) return { out: 0, fee: 0, impact: 0 }
  if (from === 'near') { const q = quote(state.tokens[to], 'buy', amount, now); return { out: q.out, fee: q.fee, impact: q.impact } }
  const sell = quote(state.tokens[from], 'sell', amount, now)
  if (to === 'near') return { out: sell.out, fee: sell.fee, impact: sell.impact }
  const buy = quote(state.tokens[to], 'buy', sell.out, now)
  return { out: buy.out, fee: sell.fee + buy.fee, impact: sell.impact + buy.impact }
}
export function swap(from: string, to: string, amount: number, minOut: number) {
  const q = quoteSwap(from, to, amount)
  if (q.out < minOut) return toast('Price moved past your slippage limit. Nothing was spent.', 'err')
  if (LIVE) {
    if (!state.me) return setWalletOpen(true)
    const slip = q.out > 0 ? minOut / q.out : 0.97
    const mid = from !== 'near' && to !== 'near' ? quote(state.tokens[from], 'sell', amount, Date.now()).out * slip : 0
    return live.swapLive(from, to, amount, minOut, mid)
  }
  if (from === 'near') { if (trade(to, 'buy', amount, 0, true)) toast('Swap complete'); return }
  const before = state.balance
  if (!trade(from, 'sell', amount, 0, true)) return
  if (to !== 'near') trade(to, 'buy', state.balance - before, 0, true)
  toast('Swap complete')
}

export function addComment(id: string, text: string) {
  const s = state
  if (!s.me) return setWalletOpen(true)
  if (LIVE) return void live.commentLive(id, text.trim())
  const t = s.tokens[id]
  set({ tokens: put({ ...t, comments: [{ id: next(), who: s.me, text: text.trim(), t: Date.now() }, ...t.comments].slice(0, 60) }) })
}

export function claimReward(id: string) {
  const amt = state.rewards[id] || 0
  if (amt <= 0) return
  if (LIVE) return live.claimRewardLive(id)
  set({ balance: state.balance + amt, rewards: { ...state.rewards, [id]: 0 } })
  toast('Reward claimed')
}
export function claimRef() {
  const amt = state.refEarned - state.refClaimed
  if (amt <= 0) return
  if (LIVE) return live.claimRefLive()
  set({ balance: state.balance + amt, refClaimed: state.refEarned })
  toast('Referral earnings claimed')
}
export function claimDev(id: string) {
  const t = state.tokens[id]
  const amt = t.devEarned - t.devClaimed
  if (amt <= 0) return
  if (t.vestUntil && Date.now() < t.vestUntil) return toast('Rewards of this crossed token are still vesting', 'err')
  if (LIVE) return live.claimDevLive(id)
  set({ balance: state.balance + amt * (t.coDev ? (t.split ?? 50) / 100 : 1), tokens: put({ ...t, devClaimed: t.devEarned }) })
  toast('Dev rewards claimed')
}

export interface NewToken { name: string; ticker: string; desc: string; image?: string; feePct: number; devBuy: number; redirect: Token['redirect']; gardener: boolean; socials: Token['socials'] }
export function createToken(n: NewToken, onDone?: (id: string) => void, onFail?: () => void): string | null {
  const s = state
  if (!s.me) { setWalletOpen(true); return null }
  if (LIVE) { live.createTokenLive(n, onDone ?? (() => {}), onFail); return null }
  const CREATE_FEE = 1
  if (s.balance < CREATE_FEE + n.devBuy) { toast('Not enough NEAR', 'err'); return null }
  const now = Date.now()
  const t = blank(n.name.trim(), n.ticker.trim().toUpperCase(), n.desc.trim(), s.me, now, Math.floor(rnd(60, 150)), n.feePct)
  t.image = n.image
  t.redirect = n.redirect
  t.gardener = n.gardener
  t.socials = n.socials
  let balance = s.balance - CREATE_FEE
  const lots = { ...s.lots }
  if (n.devBuy > 0) {
    // The launch buy skips the anti-sniper fee and is capped at 10% of supply.
    t.createdAt = now - 120_000
    const q = quote(t, 'buy', n.devBuy, now)
    const r = exec(t, s.me, 'buy', q.out > SUPPLY * 0.1 ? n.devBuy * ((SUPPLY * 0.1) / q.out) : n.devBuy, now)
    t.createdAt = now
    if (r) {
      balance -= r.q.used
      lots[t.id] = [{ amt: r.q.out, t: now }]
    }
  }
  set({ tokens: put(t), balance, lots, feed: feed(`$${t.ticker} was just planted`, t.id, 'new') })
  toast(`$${t.ticker} is live`)
  return t.id
}


export function proposeCross(a: string, b: string, split: number, name: string, ticker: string) {
  if (LIVE) return live.proposeCrossLive(a, b, split, name, ticker)
  set({ crossings: [...state.crossings, { id: 'x' + next(), a, b, split, name: name.trim(), ticker: ticker.trim().toUpperCase(), status: 'waiting', endsAt: 0, createdAt: Date.now() }] })
  toast('Crossing proposal sent')
}
export const CROSS_WINDOW = 30_000
export function cancelCross(id: string) {
  if (LIVE) return live.cancelCrossLive(id)
  set({ crossings: state.crossings.filter((c) => c.id !== id) })
}
export const acceptCross = (id: string) => (LIVE ? live.acceptCrossLive(id) : undefined)

const twap = (t: Token) => {
  const p = t.prices.slice(-30)
  return p.reduce((n, [, v]) => n + v, 0) / p.length
}

function finishCross(c: Crossing) {
  const s = state
  const A = s.tokens[c.a]; const B = s.tokens[c.b]
  if (!A || !B) return set({ crossings: s.crossings.filter((x) => x.id !== c.id) })
  const now = Date.now()
  const pa = twap(A); const pb = twap(B)
  const value = pa * (A.supply - A.burned) + pb * (B.supply - B.burned)
  const p = value / SUPPLY
  const base = (A.phase === 'pool' ? A.base : A.base - V_BASE) + (B.phase === 'pool' ? B.base : B.base - V_BASE)
  const holders: Record<string, number> = {}
  for (const [k, v] of Object.entries(A.holders)) holders[k] = (holders[k] || 0) + (v * pa) / p
  for (const [k, v] of Object.entries(B.holders)) holders[k] = (holders[k] || 0) + (v * pb) / p
  const t = blank(c.name, c.ticker, `Crossed from ${A.name} and ${B.name}.`, A.dev, now, A.hue, 1)
  Object.assign(t, { phase: 'pool', base: Math.max(base, 1), tok: Math.max(base, 1) / p, holders, parents: [A.name, B.name], coDev: B.dev, split: c.split, vestUntil: now + 30 * DAY, gardener: A.gardener || B.gardener, devEarned: A.devEarned + B.devEarned - A.devClaimed - B.devClaimed, rewardPool: A.rewardPool + B.rewardPool, prices: [[now, p]], art: A.art })
  // Hold time is kept: each old lot converts at its own rate.
  const lots = { ...s.lots }
  const merged: Lot[] = [...(lots[c.a] || []).map((l) => ({ amt: (l.amt * pa) / p, t: l.t })), ...(lots[c.b] || []).map((l) => ({ amt: (l.amt * pb) / p, t: l.t }))]
  if (merged.length) lots[t.id] = merged
  delete lots[c.a]; delete lots[c.b]
  const tokens = { ...s.tokens, [t.id]: t }
  delete tokens[c.a]; delete tokens[c.b]
  set({ tokens, lots, crossings: s.crossings.filter((x) => x.id !== c.id), homeTree: s.homeTree === c.a || s.homeTree === c.b ? t.id : s.homeTree, feed: feed(`$${A.ticker} and $${B.ticker} became $${t.ticker}`, t.id, 'cross'), notices: notice(`${A.ticker} and ${B.ticker} became ${t.ticker}.`, `/token/${t.id}`) })
  toast(`${A.ticker} and ${B.ticker} became ${t.ticker}`)
}

export function hire(name: string, strategy: string, budget: number, dailyLimit: number, stopLoss: number, days: number, allowed: Hired['allowed'], custom?: string, apiKeyId?: string) {
  if (!state.me) return setWalletOpen(true)
  if (budget > state.balance) return toast('Not enough NEAR', 'err')
  if (LIVE) return live.hireLive(name, strategy, budget, dailyLimit, stopLoss, days, allowed, apiKeyId)
  set({ balance: state.balance - budget, hired: [...state.hired, { id: 'h' + next(), name: name.trim(), strategy, custom, apiKeyId, budget, dailyLimit, stopLoss, until: Date.now() + days * DAY, allowed, paused: false, fired: false, pnl: 0, trades: 0, wins: 0, createdAt: Date.now(), history: [[Date.now(), budget]], log: [] }] })
  toast(`${name.trim()} started`)
}
export function copyAgent(agentId: string, perTrade: number, budget: number, stopLoss: number) {
  if (!state.me) return setWalletOpen(true)
  if (budget > state.balance) return toast('Not enough NEAR', 'err')
  const agent = state.house.find((h) => h.id === agentId)
  if (!agent || agent.status === 'fired') return toast('This gardener is no longer trading', 'err')
  if (LIVE) return live.copyLive(agentId, perTrade, budget, stopLoss)
  set({ balance: state.balance - budget, copies: [...state.copies, { id: 'c' + next(), agentId, perTrade, budget, stopLoss, pnl: 0, trades: 0, stopped: false, startedAt: Date.now(), log: [] }], house: state.house.map((h) => (h.id === agentId ? { ...h, copiers: h.copiers + 1 } : h)) })
  toast(`Copying ${agent.name}`)
}
export function stopCopy(id: string) {
  if (LIVE) return live.closeVaultLive(id)
  const c = state.copies.find((x) => x.id === id)
  if (!c) return
  set({ balance: state.balance + Math.max(0, c.budget + c.pnl), copies: state.copies.filter((x) => x.id !== id), house: state.house.map((h) => (h.id === c.agentId ? { ...h, copiers: Math.max(0, h.copiers - 1) } : h)) })
  toast('Stopped copying. The remaining budget is back in your wallet.')
}
/** The signed-in user's gardener, shaped like a public agent for the All gardeners list. */
export const asPublicAgent = (h: Hired, owner: string): House => ({
  id: h.id, name: h.name, art: 'sapling', strategy: h.strategy, status: h.fired ? 'fired' : 'active', start: h.budget, equity: h.budget + h.pnl,
  peak: Math.max(h.budget, ...h.history.map((p) => p[1])), trades: h.trades, wins: h.wins, hiredAt: h.createdAt, history: h.history, log: h.log, owner, copiers: 0,
})
export const claimAllRewards = () => {
  if (LIVE) return live.claimAllLive()
  const total = Object.values(state.rewards).reduce((n, v) => n + v, 0)
  if (total <= 0) return
  set({ balance: state.balance + total, rewards: {} })
  toast('Rewards claimed')
}
export const setAvatar = (avatar: string) => set({ avatar })
export const togglePause = (id: string) => LIVE ? live.pauseVaultLive(id, !state.hired.find((h) => h.id === id)?.paused) : set({ hired: state.hired.map((h) => (h.id === id ? { ...h, paused: !h.paused } : h)) })
export function stopHired(id: string) {
  if (LIVE) return live.closeVaultLive(id)
  const h = state.hired.find((x) => x.id === id)
  if (!h) return
  set({ balance: state.balance + Math.max(0, h.budget + h.pnl), hired: state.hired.filter((x) => x.id !== id) })
  toast('Gardener removed. The remaining budget is back in your wallet.')
}

/** Returns the full key once. Only a hint is stored. */
export async function createApiKey(name: string, dailyLimit: number): Promise<string> {
  if (LIVE) return live.createKeyLive(name, dailyLimit)
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  const secret = 'grw_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  set({ apiKeys: [...state.apiKeys, { id: 'k' + next(), name: name.trim(), hint: secret.slice(-4), createdAt: Date.now(), dailyLimit }] })
  return secret
}
export const revokeApiKey = (id: string) => {
  if (LIVE) return void live.revokeKeyLive(id)
  set({ apiKeys: state.apiKeys.filter((k) => k.id !== id), hired: state.hired.map((h) => (h.apiKeyId === id ? { ...h, paused: true } : h)) }); toast('Key revoked. Agents using it are paused.') }

const REPLACEMENTS: [string, string][] = [['Alder', 'clover'], ['Maple', 'pollen'], ['Yarrow', 'moss'], ['Tansy', 'bonsai'], ['Elm', 'sapling']]

function tickHouse(now: number) {
  const s = state
  const active = s.house.filter((h) => h.status !== 'fired')
  const agent = pick(active)
  if (!agent) return
  const change = agent.equity * rnd(-0.022, 0.024)
  const equity = agent.equity + change
  const peak = Math.max(agent.peak, equity)
  const dd = (1 - equity / peak) * 100
  const tokenList = Object.values(s.tokens)
  const token = pick(tokenList)
  const updated: House = {
    ...agent, equity, peak, trades: agent.trades + 1, wins: agent.wins + (change > 0 ? 1 : 0),
    status: dd >= FIRE_DRAWDOWN ? 'fired' : dd >= WARN_DRAWDOWN ? 'warning' : 'active',
    history: [...agent.history, [now, equity] as [number, number]].slice(-120),
    log: [{ id: next(), t: now, kind: change >= 0 ? 'Gain' : 'Loss', note: `${change >= 0 ? 'Closed' : 'Cut'} a $${token?.ticker ?? ''} position`, near: Math.abs(change) / 2.5, tx: tx() }, ...agent.log].slice(0, 30),
    firedAt: dd >= FIRE_DRAWDOWN ? now : undefined,
  }
  let house = s.house.map((h) => (h.id === agent.id ? updated : h))
  const patch: Partial<State> = {}
  if (updated.status === 'fired') {
    patch.notices = notice(`${agent.name} was fired after falling ${FIRE_DRAWDOWN}% from its peak.`, `/gardeners/${agent.id}`)
    const free = REPLACEMENTS.find(([n]) => !house.some((h) => h.name === n))
    if (free && !agent.owner) house = [...house, hireAgent(free[0], free[1], agent.strategy, now, DAY, 0.002)]
  }
  patch.house = house
  // Everyone copying this gardener takes the same trade, scaled to their size.
  if (s.copies.some((c) => c.agentId === agent.id && !c.stopped)) {
    const pct = change / agent.equity
    patch.copies = s.copies.map((c) => {
      if (c.agentId !== agent.id || c.stopped) return c
      const delta = c.perTrade * pct
      const pnl = c.pnl + delta
      const stopped = updated.status === 'fired' || pnl <= -c.budget * (c.stopLoss / 100)
      return { ...c, pnl, stopped, trades: c.trades + 1, log: [{ id: next(), t: now, kind: delta >= 0 ? 'Gain' : 'Loss', note: `Copied ${agent.name}: $${token?.ticker ?? ''}`, near: Math.abs(delta), tx: tx() }, ...c.log].slice(0, 20) }
    })
  }
  set(patch)
}

// ---- simulated market ----
function tick() {
  const s = state
  const ids = Object.keys(s.tokens)
  if (!ids.length) return
  const id = pick(ids)
  const t = { ...s.tokens[id] }
  const now = Date.now()
  const who = pick(BOTS)
  const sellers = Object.keys(t.holders).filter((k) => k !== s.me)
  let r
  let side: 'buy' | 'sell' = 'buy'
  let actor = who
  if (Math.random() < 0.5 || !sellers.length) {
    r = exec(t, who, 'buy', t.base * rnd(0.003, 0.014), now)
  } else {
    side = 'sell'
    actor = pick(sellers)
    r = exec(t, actor, 'sell', t.holders[actor] * rnd(0.03, 0.12), now)
  }
  if (!r) return
  if (Math.random() < 0.05) t.comments = [{ id: next(), who, text: pick(TALK), t: now }, ...t.comments].slice(0, 60)
  if (t.gardener && Math.random() < 0.04) {
    const blocked = Math.random() < 0.2
    t.log = [blocked
      ? { id: next(), t: now, kind: 'Blocked', note: 'The request was above the daily limit, so the contract rejected it.', near: rnd(40, 90), tx: tx(), rejected: true }
      : { id: next(), t: now, kind: Math.random() < 0.6 ? 'Buyback' : 'Add liquidity', note: 'Action taken within the token limits.', near: rnd(1, 12), tx: tx() }, ...t.log].slice(0, 40)
  }
  const patch: Partial<State> = { tokens: put(t), rewards: creditRewards(id, r.split.holders, t), feed: feed(`${actor} ${side === 'buy' ? 'bought' : 'sold'} $${t.ticker} for ${r.near.toFixed(1)} NEAR`, id, side) }
  if (s.me && s.invited > 0 && Math.random() < 0.02) patch.refEarned = s.refEarned + r.q.fee * 0.06
  const hired = s.hired.map((h) => {
    if (h.paused || h.fired || now > h.until || Math.random() > 0.25) return h
    const near = Math.min(rnd(1, 5), h.dailyLimit)
    const change = near * rnd(-0.14, 0.14)
    const pnl = h.pnl + change
    const fired = pnl <= -h.budget * (h.stopLoss / 100)
    return { ...h, pnl, fired, trades: h.trades + 1, wins: h.wins + (change > 0 ? 1 : 0), history: [...h.history, [now, h.budget + pnl] as [number, number]].slice(-120), log: [{ id: next(), t: now, kind: change >= 0 ? 'Gain' : 'Loss', note: `$${t.ticker}`, near, tx: tx() }, ...h.log].slice(0, 20) }
  })
  if (hired.some((h, i) => h !== s.hired[i])) patch.hired = hired
  set(patch)
  if (Math.random() < 0.3) tickHouse(now)
}

export function startMarket() {
  if (LIVE) return live.startLive()
  let timer: ReturnType<typeof setInterval> | undefined
  const run = () => {
    clearInterval(timer)
    if (document.hidden) return
    timer = setInterval(() => {
      tick()
      const now = Date.now()
      for (const c of state.crossings) {
        if (c.status === 'waiting' && now - c.createdAt > 6000) set({ crossings: state.crossings.map((x) => (x.id === c.id ? { ...x, status: 'window', endsAt: now + CROSS_WINDOW } : x)), notices: notice(`Partner accepted the ${c.ticker} crossing. Holders can exit now.`, '/profile') })
        else if (c.status === 'window' && now >= c.endsAt) finishCross(c)
      }
    }, 1600)
  }
  document.addEventListener('visibilitychange', run)
  run()
}
