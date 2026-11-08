// The two AI gardeners. The model only proposes; this code keeps what is allowed (tokens, sizes, limits) and
// the contract enforces the rest. Without a NEAR AI key, or when the model fails, they fall back to rules.
//
// - AI Trader (strategy "ai"): trades like the rule gardeners.
// - AI Treasurer (strategy "treasurer", a token's own Dev gardener): spends the token's treasury on buybacks,
//   holder rewards and the dev's pay (launchpad `treasury_action`).
import type { Env } from '../env'
import { askNearAi, jsonIn, saveDecision } from './nearai'
import { type AgentState, type Decision, decide, type MarketToken, minTrade, type VaultSnapshot } from './strategies'

export interface TreasuryDecision {
  action: 'buyback' | 'rewards' | 'pay_dev'
  near: number
  note: string
}

const r = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d
const clip = (s: unknown, n = 120) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '')

function positionsOf(v: VaultSnapshot, market: MarketToken[], st: AgentState) {
  const byId = new Map(market.map((t) => [t.id, t]))
  return v.positions.map((p) => {
    const t = byId.get(p.token_id)
    const tokens = Number(BigInt(p.amount) / 10n ** 12n) / 1e6
    const entry = st.entries[p.token_id]?.price
    return { token_id: p.token_id, ticker: t?.ticker ?? p.token_id, tokens: r(tokens, 0), value_near: t ? r(tokens * t.price) : null, gain_pct: t && entry ? r((t.price / entry - 1) * 100, 1) : null }
  })
}

const TRADER_SYSTEM = `You are an AI trading gardener on grow., a token launchpad on NEAR. Every token is a tree: it starts on a bonding curve and moves into a locked liquidity pool when the curve sells out.
You manage one vault of NEAR. Each run you see the market and your vault and decide whether to trade.
Rules: protect the vault first; it is fired if it falls 30% from its peak. Prefer tokens with many holders, rising volume and many unique buyers. Avoid chasing tokens that already rose a lot this hour. Take profit and cut losses on positions. Doing nothing is often right.
Answer with JSON only, no other text:
{"decisions":[{"token_id":"<id>","side":"buy"|"sell","near":<NEAR to spend, buys only>,"fraction":<0-1 of the position, sells only>,"reason":"<one short sentence a holder can read>"}]}
At most 2 decisions. An empty list is a valid answer.`

/** AI Trader: the model's trades, checked against the vault. Falls back to the trend rules. */
export async function aiTrades(env: Env, v: VaultSnapshot, market: MarketToken[], st: AgentState, now: number): Promise<{ decisions: Decision[]; aiId: number | null }> {
  const maxBuy = Math.min(v.cash, Math.max(0, v.daily_limit - v.spent_today), v.equity * 0.2)
  if (!env.NEARAI_KEY) return { decisions: decide('trend', v, market, st, now), aiId: null }
  const tokens = market.slice(0, 25).map((t) => ({ id: t.id, ticker: t.ticker, phase: t.phase, progress_to_pool_pct: r(t.progress * 100, 1), mcap_near: r(t.mcap, 1), holders: t.holders, volume_1h_near: r(t.volume_1h, 2), buyers_1h: t.buyers_1h, change_1h_pct: r(t.change_1h, 1), change_24h_pct: r(t.change_24h, 1) }))
  const user = JSON.stringify({
    vault: { cash_near: r(v.cash), equity_near: r(v.equity), max_buy_near: r(maxBuy), min_trade_near: minTrade(), positions: positionsOf(v, market, st) },
    market: tokens,
  })
  const a = await askNearAi(env, TRADER_SYSTEM, user)
  const out = jsonIn<{ decisions?: { token_id?: string; side?: string; near?: number; fraction?: number; reason?: string }[] }>(a.content)
  const byId = new Map(market.map((t) => [t.id, t]))
  const held = new Set(v.positions.map((p) => p.token_id))
  const decisions: Decision[] = []
  let budget = maxBuy
  for (const d of out?.decisions?.slice(0, 2) ?? []) {
    const t = d.token_id ? byId.get(d.token_id) : undefined
    if (!t) continue
    const reason = clip(d.reason) || 'AI decision'
    if (d.side === 'buy') {
      const near = Math.min(Number(d.near) || 0, budget)
      if (near < minTrade()) continue
      budget -= near
      decisions.push({ token_id: t.id, buy: true, near: r(near), note: reason })
    } else if (d.side === 'sell' && held.has(t.id)) {
      const fraction = Math.min(1, Math.max(0, Number(d.fraction) || 1))
      if (fraction > 0) decisions.push({ token_id: t.id, buy: false, fraction, note: reason })
    }
  }
  const aiId = await saveDecision(env, v.id, 'trade', a, { decisions, raw: out })
  // A failed call (no answer at all) falls back to rules, so the vault keeps working.
  if (a.error) return { decisions: decide('trend', v, market, st, now), aiId }
  return { decisions, aiId }
}

const TREASURER_SYSTEM = `You are the AI treasurer of one token on grow., a token launchpad on NEAR. The treasury is NEAR the token earned from trading fees (the dev's share).
Each run you see the token and the treasury and choose how to use it, for the long-term health of the token and its holders:
- "buyback": NEAR goes to a buyback pool that buys coins and burns them, a little each block. Good after a sharp fall or when selling pressure is high.
- "rewards": NEAR goes to holders as rewards (paid to holders by hold time). Good to reward loyal holders when the token is calm or growing.
- "pay_dev": NEAR goes to the dev who launched the token (at most 20% of the treasury a day). Pay the dev modestly and only when the token is healthy.
Keep a reserve: never spend more than a quarter of the treasury in one run. Doing nothing is often right.
Answer with JSON only, no other text:
{"actions":[{"action":"buyback"|"rewards"|"pay_dev","near":<NEAR>,"reason":"<one short sentence holders can read>"}]}
At most 2 actions. An empty list is a valid answer.`

const TREASURY_MIN = 0.01

/** Rules used without a NEAR AI key: buy back after a fall, otherwise reward holders. */
function treasuryRules(v: VaultSnapshot, t: MarketToken): TreasuryDecision[] {
  const room = Math.min(v.cash * 0.25, Math.max(0, v.daily_limit - v.spent_today))
  if (room < TREASURY_MIN) return []
  if (t.high_24h > 0 && t.price <= t.high_24h * 0.85) return [{ action: 'buyback', near: r(room * 0.6), note: `Bought back $${t.ticker} after a ${Math.round((1 - t.price / t.high_24h) * 100)}% fall from today's high` }]
  if (t.holders >= 3) return [{ action: 'rewards', near: r(room * 0.4), note: `Shared the treasury with ${t.holders} $${t.ticker} holders` }]
  return []
}

/** AI Treasurer: the model's treasury actions, checked against the treasury and its daily limits. */
export async function aiTreasury(env: Env, v: VaultSnapshot, t: MarketToken | undefined): Promise<{ actions: TreasuryDecision[]; aiId: number | null }> {
  if (!t) return { actions: [], aiId: null }
  const room = Math.min(v.cash * 0.25, Math.max(0, v.daily_limit - v.spent_today))
  if (room < TREASURY_MIN) return { actions: [], aiId: null }
  if (!env.NEARAI_KEY) return { actions: treasuryRules(v, t), aiId: null }
  const user = JSON.stringify({
    token: { id: t.id, ticker: t.ticker, phase: t.phase, progress_to_pool_pct: r(t.progress * 100, 1), price_near: t.price, high_24h_near: t.high_24h, change_1h_pct: r(t.change_1h, 1), change_24h_pct: r(t.change_24h, 1), holders: t.holders, volume_1h_near: r(t.volume_1h, 2), buyers_1h: t.buyers_1h },
    treasury: { cash_near: r(v.cash), max_spend_this_run_near: r(room), min_action_near: TREASURY_MIN },
  })
  const a = await askNearAi(env, TREASURER_SYSTEM, user)
  const out = jsonIn<{ actions?: { action?: string; near?: number; reason?: string }[] }>(a.content)
  const actions: TreasuryDecision[] = []
  let left = room
  for (const d of out?.actions?.slice(0, 2) ?? []) {
    if (d.action !== 'buyback' && d.action !== 'rewards' && d.action !== 'pay_dev') continue
    const near = r(Math.min(Number(d.near) || 0, left, d.action === 'pay_dev' ? v.cash * 0.2 : Infinity))
    if (near < TREASURY_MIN) continue
    left -= near
    actions.push({ action: d.action, near, note: clip(d.reason) || 'AI treasury decision' })
  }
  const aiId = await saveDecision(env, v.id, 'treasury', a, { actions, raw: out })
  if (a.error) return { actions: treasuryRules(v, t), aiId }
  return { actions, aiId }
}
