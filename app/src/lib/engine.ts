// Pure trading maths from the spec. Replaced by contract views when contracts exist.
export const SUPPLY = 1e9
export const V_TOK = 1.073e9
export const V_BASE = 1200
export const CURVE_END_TOK = 280e6
export const POOL_TOK = 207e6
export const RAISE = (V_BASE * V_TOK) / CURVE_END_TOK - V_BASE
export const POOL_FEE = 0.5
export const SNIPER_MS = 60_000
/** NEAR in USD: the API's rate on the live site, a fixed one on the built-in market. */
export let NEAR_USD = 2.5
export const setNearUsd = (v: number) => {
  if (v > 0) NEAR_USD = v
}

export interface Trade { id: number; who: string; side: 'buy' | 'sell'; near: number; tokens: number; t: number }
export interface GardenerAction { id: number; t: number; kind: string; note: string; near: number; tx: string; rejected?: boolean; aiId?: number }
export interface Token {
  /** Live: the token's AI treasurer (its own gardener). */
  treasury?: { cash: number; ai: import('./store').AiDecision[] }
  id: string; name: string; ticker: string; desc: string; image?: string; hue: number
  dev: string; coDev?: string; createdAt: number; feePct: number
  phase: 'curve' | 'pool'; base: number; tok: number; supply: number
  holders: Record<string, number>; holderCount?: number; rewardPool: number; devEarned: number; devClaimed: number
  burned: number; redirect: { pct: number; to: 'holders' | 'buyback' }
  gardener: boolean; devVault?: number; log: GardenerAction[]; trades: Trade[]; prices: [number, number][]
  parents?: [string, string]; split?: number; vestUntil?: number
  art?: string; socials: { x?: string; tg?: string; web?: string }; comments: Comment[]; volume: number; txns: number
  /** The token contract (live site). */
  account?: string
}
export interface Comment { id: number; who: string; text: string; t: number }

export const contractOf = (t: Pick<Token, 'id'> & { account?: string }) => t.account ?? `${t.id}.grow.near`
export const holderCount = (t: Token) => t.holderCount ?? Object.keys(t.holders).length
export const price = (t: Pick<Token, 'base' | 'tok'>) => t.base / t.tok
export const capNear = (t: Token) => price(t) * (t.supply - t.burned)
export const capUsd = (t: Token) => capNear(t) * NEAR_USD
export const raised = (t: Token) => (t.phase === 'pool' ? RAISE : t.base - V_BASE)
export const progress = (t: Token) => (t.phase === 'pool' ? 1 : Math.min(1, raised(t) / RAISE))

export function feeRate(t: Token, now: number) {
  if (t.phase === 'pool') return POOL_FEE / 100
  const age = now - t.createdAt
  const normal = t.feePct / 100
  if (age >= SNIPER_MS) return normal
  return normal + (0.5 - normal) * (1 - age / SNIPER_MS)
}

export interface Quote { out: number; fee: number; rate: number; impact: number; used: number; capped: boolean }

export function quote(t: Token, side: 'buy' | 'sell', amount: number, now: number): Quote {
  const rate = feeRate(t, now)
  const empty = { out: 0, fee: 0, rate, impact: 0, used: 0, capped: false }
  if (!(amount > 0)) return empty
  const k = t.base * t.tok
  const p = price(t)
  if (side === 'buy') {
    let used = amount
    let capped = false
    if (t.phase === 'curve') {
      const room = (k / CURVE_END_TOK - t.base) / (1 - rate)
      if (used > room) { used = room; capped = true }
    }
    const net = used * (1 - rate)
    const out = t.tok - k / (t.base + net)
    return { out, fee: used - net, rate, used, capped, impact: out > 0 ? net / out / p - 1 : 0 }
  }
  const gross = t.base - k / (t.tok + amount)
  const fee = gross * rate
  return { out: gross - fee, fee, rate, used: amount, capped: false, impact: 1 - gross / amount / p }
}

/** Fee split: base 1 → dev 30%, holders 10%, referrer 10% of the rest, platform the remainder. */
export function splitFee(t: Token, fee: number, normalRate: number, rate: number, referred: boolean) {
  const normalPart = rate > 0 ? fee * Math.min(1, normalRate / rate) : 0
  const sniperExtra = fee - normalPart
  const devGross = normalPart * 0.3
  const moved = devGross * (t.redirect.pct / 100)
  const holders = normalPart * 0.1 + (t.redirect.to === 'holders' ? moved : 0)
  const buyback = t.redirect.to === 'buyback' ? moved : 0
  const rest = normalPart * 0.6
  const referrer = referred ? rest * 0.1 : 0
  return { dev: devGross - moved, holders, buyback, referrer, platform: rest - referrer + sniperExtra }
}

export const holdWeight = (days: number) => (days >= 10 ? 2 : days >= 5 ? 1.5 : days >= 3 ? 1 : 0)

/** Cap to tree growth. A new token (about $2.8K) is a sprout, $1M is a full oak. */
export const growth = (usd: number, max = 1_000_000) => {
  const v = Math.max(0, usd * (1_000_000 / max) - 2800)
  return Math.min(1, Math.log1p(v / 8000) / Math.log1p(1_000_000 / 8000))
}
