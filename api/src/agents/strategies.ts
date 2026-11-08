// The five strategies gardeners trade with, plus the dev gardener's. Pure functions: market snapshot and
// vault in, decisions out. Every limit that matters (budget, daily limit, loss limit, allowed tokens) is also
// enforced by the contract, so a strategy bug can lose a trade's worth at most, never more than the rules allow.
export interface MarketToken {
  id: string
  ticker: string
  phase: 'Curve' | 'Pool'
  price: number // NEAR per token
  mcap: number // NEAR
  progress: number
  holders: number
  volume_1h: number // NEAR
  buyers_1h: number
  change_1h: number // %
  change_24h: number // %
  high_24h: number
}

export interface VaultSnapshot {
  id: number
  kind: string
  strategy: string
  cash: number // NEAR
  equity: number
  budget: number
  daily_limit: number
  spent_today: number
  allowed: unknown
  positions: { token_id: string; amount: string }[]
}

export interface Entry {
  price: number
  ts: number
  steps?: number // take-profit steps done
}

export interface AgentState {
  entries: Record<string, Entry>
  last_buy?: number
  /** Hash of what the AI model was last shown: an unchanged market is not asked again. */
  ai_fp?: string
}

export interface Decision {
  token_id: string
  buy: boolean
  /** Buys: NEAR. */
  near?: number
  /** Sells: share of the position, 0-1. */
  fraction?: number
  note: string
}

export const STRATEGIES: Record<string, { name: string; risk: string; every_ms: number; blurb: string }> = {
  steady: { name: 'Steady', risk: 'Low', every_ms: 6 * 3_600_000, blurb: 'Buys a fixed amount of top tokens on a schedule.' },
  trend: { name: 'Trend Rider', risk: 'High', every_ms: 10 * 60_000, blurb: 'Buys tokens gaining volume and unique traders.' },
  dip: { name: 'Dip Buyer', risk: 'Medium', every_ms: 15 * 60_000, blurb: 'Buys sharp drops on tokens with strong holders.' },
  grad: { name: 'Graduation', risk: 'High', every_ms: 10 * 60_000, blurb: 'Enters tokens close to moving into their pool.' },
  exit: { name: 'Take Profit', risk: 'Low', every_ms: 4 * 3_600_000, blurb: 'Takes profit in steps at set price targets.' },
  dev: { name: 'Dev gardener', risk: 'Low', every_ms: 30 * 60_000, blurb: "Supports its own token on dips and trims on strength." },
  ai: { name: 'AI Trader', risk: 'Medium', every_ms: 15 * 60_000, blurb: 'A NEAR AI model reads the market and trades within your limits. Every decision is signed in a TEE.' },
  treasurer: { name: 'AI Treasurer', risk: 'Low', every_ms: 30 * 60_000, blurb: "A NEAR AI model runs the token's treasury: buybacks, holder rewards and the dev's pay, within on-chain limits." },
}

let MIN_TRADE = 0.5
/** The smallest trade (MIN_TRADE_NEAR); testnet gardeners hold a few NEAR, so it is set lower there. */
export const setMinTrade = (near: number) => {
  if (near > 0) MIN_TRADE = near
}
export const minTrade = () => MIN_TRADE
const MAX_POSITION_SHARE = 0.25

const fmt = (n: number) => (Math.abs(n) >= 10 ? n.toFixed(0) : n.toFixed(1))

function allowedToken(v: VaultSnapshot, t: MarketToken): boolean {
  const a = v.allowed as string | { Only?: string }
  if (a === 'PoolOnly') return t.phase === 'Pool'
  if (a && typeof a === 'object' && a.Only) return a.Only === t.id
  return true
}

function budgetFor(v: VaultSnapshot, share: number): number {
  const room = Math.max(0, v.daily_limit - v.spent_today)
  return Math.min(v.cash, room, v.equity * share)
}

function positionValue(v: VaultSnapshot, t: MarketToken): number {
  const p = v.positions.find((x) => x.token_id === t.id)
  return p ? (Number(BigInt(p.amount) / 10n ** 12n) / 1e6) * t.price : 0
}

/** Exits shared by the trading strategies: take profit, stop loss and time stop. */
function exits(v: VaultSnapshot, byId: Map<string, MarketToken>, st: AgentState, now: number, tp: number, sl: number, maxMs: number, out: Decision[]) {
  for (const p of v.positions) {
    const t = byId.get(p.token_id)
    const e = st.entries[p.token_id]
    if (!t || !e || BigInt(p.amount) === 0n) continue
    const gain = (t.price / e.price - 1) * 100
    if (gain >= tp) out.push({ token_id: t.id, buy: false, fraction: 1, note: `Took profit on $${t.ticker}: +${fmt(gain)}%` })
    else if (gain <= -sl) out.push({ token_id: t.id, buy: false, fraction: 1, note: `Cut $${t.ticker} at ${fmt(gain)}%` })
    else if (now - e.ts > maxMs) out.push({ token_id: t.id, buy: false, fraction: 1, note: `Closed $${t.ticker} after holding too long (${fmt(gain)}%)` })
  }
}

export function decide(strategy: string, v: VaultSnapshot, market: MarketToken[], st: AgentState, now: number): Decision[] {
  const tokens = market.filter((t) => allowedToken(v, t) && t.price > 0)
  const byId = new Map(market.map((t) => [t.id, t]))
  const held = new Set(v.positions.map((p) => p.token_id))
  const out: Decision[] = []
  const canBuy = (t: MarketToken) => positionValue(v, t) < v.equity * MAX_POSITION_SHARE

  switch (strategy) {
    case 'steady': {
      // Rebalance anything grown past 30% of the vault; then buy the largest pool tokens in turn.
      for (const t of tokens) if (positionValue(v, t) > v.equity * 0.3) out.push({ token_id: t.id, buy: false, fraction: 0.25, note: `Trimmed $${t.ticker}, it grew past 30% of the vault` })
      const top = tokens.filter((t) => t.phase === 'Pool').sort((a, b) => b.mcap - a.mcap).slice(0, 3)
      const pick = top[Math.floor(now / STRATEGIES.steady.every_ms) % Math.max(1, top.length)]
      const amount = Math.min(budgetFor(v, 0.05), v.budget * 0.05)
      if (pick && amount >= MIN_TRADE && canBuy(pick)) out.push({ token_id: pick.id, buy: true, near: amount, note: `Scheduled buy of $${pick.ticker}, a top token by market cap` })
      break
    }
    case 'trend': {
      exits(v, byId, st, now, 35, 12, 2 * 86_400_000, out)
      for (const p of v.positions) {
        const t = byId.get(p.token_id)
        const e = st.entries[p.token_id]
        if (t && e && now - e.ts > 30 * 60_000 && t.change_1h < -8 && !out.some((d) => d.token_id === t.id)) out.push({ token_id: t.id, buy: false, fraction: 1, note: `Momentum turned on $${t.ticker} (${fmt(t.change_1h)}% in an hour)` })
      }
      const c = tokens
        .filter((t) => !held.has(t.id) && t.volume_1h >= 20 && t.buyers_1h >= 5 && t.change_1h >= 5 && t.change_1h <= 60)
        .sort((a, b) => b.volume_1h * b.buyers_1h - a.volume_1h * a.buyers_1h)[0]
      const amount = budgetFor(v, 0.1)
      if (c && amount >= MIN_TRADE) out.push({ token_id: c.id, buy: true, near: amount, note: `Volume and buyers are rising on $${c.ticker}: ${c.buyers_1h} buyers, ${fmt(c.volume_1h)} NEAR in an hour` })
      break
    }
    case 'dip': {
      exits(v, byId, st, now, 12, 10, 86_400_000, out)
      const c = tokens
        .filter((t) => !held.has(t.id) && t.holders >= 25 && t.change_1h <= -15 && t.change_24h >= -60 && (t.phase === 'Pool' || t.progress >= 0.3))
        .sort((a, b) => a.change_1h - b.change_1h)[0]
      const amount = budgetFor(v, 0.08)
      if (c && amount >= MIN_TRADE) out.push({ token_id: c.id, buy: true, near: amount, note: `Bought the dip on $${c.ticker}: ${fmt(c.change_1h)}% in an hour, ${c.holders} holders` })
      break
    }
    case 'grad': {
      for (const p of v.positions) {
        const t = byId.get(p.token_id)
        const e = st.entries[p.token_id]
        if (!t || !e) continue
        const gain = (t.price / e.price - 1) * 100
        if ((t.phase === 'Pool' && gain >= 20) || gain <= -15 || now - e.ts > 2 * 86_400_000) out.push({ token_id: t.id, buy: false, fraction: 1, note: t.phase === 'Pool' && gain >= 20 ? `$${t.ticker} reached its pool: +${fmt(gain)}%` : `Closed $${t.ticker} (${fmt(gain)}%)` })
      }
      const c = tokens.filter((t) => !held.has(t.id) && t.phase === 'Curve' && t.progress >= 0.7 && t.progress <= 0.97 && t.volume_1h >= 10).sort((a, b) => b.progress - a.progress)[0]
      const amount = budgetFor(v, 0.1)
      if (c && amount >= MIN_TRADE) out.push({ token_id: c.id, buy: true, near: amount, note: `$${c.ticker} is ${Math.round(c.progress * 100)}% of the way to its pool` })
      break
    }
    case 'exit': {
      for (const p of v.positions) {
        const t = byId.get(p.token_id)
        const e = st.entries[p.token_id]
        if (!t || !e) continue
        const gain = (t.price / e.price - 1) * 100
        const steps = e.steps ?? 0
        const targets = [20, 40, 80]
        if (steps < targets.length && gain >= targets[steps]) out.push({ token_id: t.id, buy: false, fraction: steps === targets.length - 1 ? 1 : 0.25, note: `Took profit step ${steps + 1} on $${t.ticker}: +${fmt(gain)}%` })
        else if (gain <= -20) out.push({ token_id: t.id, buy: false, fraction: 1, note: `Stopped out of $${t.ticker} at ${fmt(gain)}%` })
      }
      const c = tokens.filter((t) => !held.has(t.id) && t.phase === 'Pool' && t.change_24h > 0).sort((a, b) => b.volume_1h - a.volume_1h)[0]
      const amount = Math.min(budgetFor(v, 0.05), v.budget * 0.05)
      if (c && amount >= MIN_TRADE) out.push({ token_id: c.id, buy: true, near: amount, note: `Opened $${c.ticker}; profit is taken at +20%, +40% and +80%` })
      break
    }
    case 'dev': {
      const t = tokens[0]
      if (!t) break
      const e = st.entries[t.id]
      if (t.high_24h > 0 && t.price <= t.high_24h * 0.85 && v.cash >= 1) {
        const amount = Math.min(budgetFor(v, 1) * 0.1, v.cash)
        if (amount >= MIN_TRADE) out.push({ token_id: t.id, buy: true, near: amount, note: `Supported $${t.ticker} after a ${fmt((1 - t.price / t.high_24h) * 100)}% drop from today's high` })
      } else if (e && t.price >= e.price * 1.5 && held.has(t.id)) {
        out.push({ token_id: t.id, buy: false, fraction: 0.1, note: `Trimmed $${t.ticker} on strength: +${fmt((t.price / e.price - 1) * 100)}%` })
      }
      break
    }
    default:
      break
  }
  return out
}

/** Records the effect of decisions on the strategy's memory (entry prices, take-profit steps). */
export function remember(st: AgentState, decisions: Decision[], market: MarketToken[], now: number): AgentState {
  const byId = new Map(market.map((t) => [t.id, t]))
  const entries = { ...st.entries }
  for (const d of decisions) {
    const t = byId.get(d.token_id)
    if (!t) continue
    if (d.buy) {
      const prev = entries[d.token_id]
      entries[d.token_id] = prev ? { ...prev, price: (prev.price + t.price) / 2 } : { price: t.price, ts: now }
    } else if ((d.fraction ?? 1) >= 1) delete entries[d.token_id]
    else if (entries[d.token_id]) entries[d.token_id] = { ...entries[d.token_id], steps: (entries[d.token_id].steps ?? 0) + 1 }
  }
  return { ...st, entries, last_buy: decisions.some((d) => d.buy) ? now : st.last_buy }
}
