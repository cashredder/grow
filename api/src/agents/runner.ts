// Runs strategy gardeners, copies leaders' trades and keeps the contracts tidy. Called by the clock.
import type { Env } from '../env'
import { enqueue } from '../lib/jobs'
import { nearRaw } from '../lib/units'
import { view } from '../near/rpc'
import { aiTrades, aiTreasury } from './ai'
import { type AgentState, decide, type Decision, type MarketToken, remember, setMinTrade, STRATEGIES, type VaultSnapshot } from './strategies'

const SLIPPAGE = 0.03
const HOUSE_NAMES = ['Linden', 'Rowan', 'Hazel', 'Cedar', 'Alder', 'Juniper', 'Maple', 'Elm', 'Spruce', 'Larch', 'Holly', 'Yew', 'Poplar', 'Aspen']

/** A note with the NEAR AI decision it came from, as "... #ai123" (the site links it to the proof). */
const tagged = (note: string, aiId: number | null) => (aiId ? `${note.slice(0, 130)} #ai${aiId}` : note.slice(0, 140))

export async function marketSnapshot(env: Env, now = Date.now(), only?: string): Promise<MarketToken[]> {
  const hour = now - 3_600_000
  const day = now - 86_400_000
  const r = await env.DB.prepare(
    `SELECT k.id, k.ticker, k.phase, k.price, k.mcap, k.progress, k.holders,
      COALESCE((SELECT SUM(near) FROM trades WHERE token_id = k.id AND ts > ?1), 0) AS volume_1h,
      (SELECT COUNT(DISTINCT account) FROM trades WHERE token_id = k.id AND ts > ?1 AND side = 'buy') AS buyers_1h,
      (SELECT price FROM trades WHERE token_id = k.id AND ts <= ?1 ORDER BY ts DESC LIMIT 1) AS p1h,
      (SELECT price FROM trades WHERE token_id = k.id AND ts <= ?2 ORDER BY ts DESC LIMIT 1) AS p24h,
      COALESCE((SELECT MAX(price) FROM trades WHERE token_id = k.id AND ts > ?2), k.price) AS high_24h
     FROM tokens k WHERE k.phase IN ('Curve', 'Pool') AND (k.last_trade_ts > ?3 OR k.id = ?4) ${only ? 'AND k.id = ?4' : ''} ORDER BY volume_1h DESC LIMIT 200`,
  )
    .bind(hour, day, now - 3 * 86_400_000, only ?? '')
    .all<MarketToken & { p1h: number | null; p24h: number | null }>()
  return r.results.map((t) => ({
    ...t,
    change_1h: t.p1h ? (t.price / t.p1h - 1) * 100 : 0,
    change_24h: t.p24h ? (t.price / t.p24h - 1) * 100 : 0,
  }))
}

/** Strategy gardeners traded by the relayer whose turn has come. */
export async function runAgents(env: Env): Promise<number> {
  if (env.AGENTS_ENABLED !== 'true') return 0
  setMinTrade(Number(env.MIN_TRADE_NEAR || 0.5))
  const now = Date.now()
  const vaults = await env.DB.prepare(
    `SELECT v.id, v.kind, v.strategy, v.cash, v.equity, v.budget, v.daily_limit, v.allowed, v.positions, s.last_run, s.state,
      COALESCE((SELECT SUM(near) FROM vault_log l WHERE l.vault_id = v.id AND l.side = 'buy' AND l.ts > ?), 0) AS spent_today
     FROM vaults v LEFT JOIN agent_state s ON s.vault_id = v.id
     WHERE v.status = 'Active' AND v.agent = ? AND v.kind IN ('House', 'User', 'Dev') AND v.strategy != 'custom'
       AND v.id NOT IN (SELECT vault_id FROM api_key_vaults) AND (v.expires_ts = 0 OR v.expires_ts > ?)`,
  )
    .bind(Math.floor(now / 86_400_000) * 86_400_000, env.RELAYER, now)
    .all<{ id: number; kind: string; strategy: string; cash: number; equity: number; budget: number; daily_limit: number; allowed: string; positions: string; last_run: number | null; state: string | null; spent_today: number }>()
  const due = vaults.results.filter((v) => {
    // A token's own gardener is its treasurer.
    const s = STRATEGIES[v.kind === 'Dev' ? 'treasurer' : v.strategy]
    return s && now - (v.last_run ?? 0) >= s.every_ms
  })
  if (!due.length) return 0
  const market = await marketSnapshot(env, now)
  let queued = 0
  for (const row of due) {
    const strategy = row.kind === 'Dev' ? 'treasurer' : row.strategy
    const v: VaultSnapshot = { ...row, strategy, allowed: JSON.parse(row.allowed), positions: JSON.parse(row.positions || '[]') }
    const st: AgentState = row.state ? JSON.parse(row.state) : { entries: {} }
    let decisions: Decision[] = []
    if (strategy === 'treasurer') {
      const tokenId = (v.allowed as { Only?: string })?.Only
      const token = market.find((t) => t.id === tokenId) ?? (tokenId ? (await marketSnapshot(env, now, tokenId))[0] : undefined)
      const { actions, aiId, fp } = await aiTreasury(env, v, token, st.ai_fp)
      if (fp) st.ai_fp = fp
      if (aiId) queued += await chargeAi(env, v, aiId)
      for (const a of actions) {
        const id = await enqueue(env, 'relayer', 'treasury_action', { vault_id: v.id, action: a.action, amount: nearRaw(a.near), note: tagged(a.note, aiId) }, { dedupe: `treasury:${v.id}:${Math.floor(now / 60_000)}:${a.action}` })
        if (id) queued++
      }
    } else {
      const ai: { decisions: Decision[]; aiId: number | null; fp?: string } = strategy === 'ai' ? await aiTrades(env, v, market, st, now) : { decisions: decide(strategy, v, market, st, now), aiId: null }
      if (ai.fp) st.ai_fp = ai.fp
      if (ai.aiId) queued += await chargeAi(env, v, ai.aiId)
      decisions = ai.decisions.slice(0, 3)
      for (const d of decisions) {
        const args = await tradeArgs(env, v, d.token_id, d.buy, d.near, d.fraction)
        if (!args) continue
        const id = await enqueue(env, 'relayer', 'vault_trade', { vault_id: v.id, ...args, note: tagged(d.note, ai.aiId) }, { dedupe: `agent:${v.id}:${Math.floor(now / 60_000)}:${d.token_id}:${d.buy ? 'b' : 's'}` })
        if (id) queued++
      }
    }
    const next = { ...remember(st, decisions, market, now), ai_fp: st.ai_fp }
    await env.DB.prepare('INSERT INTO agent_state (vault_id, last_run, state) VALUES (?, ?, ?) ON CONFLICT (vault_id) DO UPDATE SET last_run = excluded.last_run, state = excluded.state').bind(v.id, now, JSON.stringify(next)).run()
  }
  return queued
}

let feeCache: { near: number; at: number } | null = null
/** The launchpad's fee per AI decision, in NEAR (read every 10 minutes). */
async function aiFee(env: Env): Promise<number> {
  if (!feeCache || Date.now() - feeCache.at > 600_000) {
    const raw = await view<string>(env, env.LAUNCHPAD, 'ai_fee').catch(() => null)
    feeCache = { near: raw ? Number(BigInt(raw) / 10n ** 18n) / 1e6 : 0.001, at: Date.now() }
  }
  return feeCache.near
}

/** One answered AI decision is paid by the gardener that asked (grow.'s own gardeners are not charged). */
async function chargeAi(env: Env, v: VaultSnapshot, aiId: number): Promise<number> {
  if (v.kind === 'House') return 0
  if (v.cash < (await aiFee(env))) return 0
  return (await enqueue(env, 'relayer', 'pay_ai', { vault_id: v.id, decision: aiId }, { dedupe: `ai-fee:${aiId}`, tgas: 30 })) ? 1 : 0
}

/** Contract arguments for a vault trade, with min_out from a live quote less the slippage. */
export async function tradeArgs(env: Env, v: { positions: { token_id: string; amount: string }[] }, tokenId: string, buy: boolean, near?: number, fraction?: number, slippage = SLIPPAGE) {
  if (buy) {
    if (!near || near <= 0) return null
    const amount = nearRaw(near)
    const q = await view<{ out: string }>(env, env.LAUNCHPAD, 'quote_buy', { token_id: tokenId, amount }).catch(() => null)
    if (!q || q.out === '0') return null
    return { token_id: tokenId, buy: true, amount, min_out: minus(q.out, slippage) }
  }
  const p = v.positions.find((x) => x.token_id === tokenId)
  if (!p) return null
  const f = Math.max(0, Math.min(1, fraction ?? 1))
  const amount = f >= 1 ? BigInt(p.amount) : (BigInt(p.amount) * BigInt(Math.floor(f * 10_000))) / 10_000n
  if (amount === 0n) return null
  const q = await view<{ out: string }>(env, env.LAUNCHPAD, 'quote_sell', { token_id: tokenId, amount: amount.toString() }).catch(() => null)
  if (!q) return null
  return { token_id: tokenId, buy: false, amount: amount.toString(), min_out: minus(q.out, slippage) }
}

const minus = (raw: string, slip: number) => ((BigInt(raw) * BigInt(Math.floor((1 - slip) * 10_000))) / 10_000n).toString()

/** Queues copies of a leader's new trade for every active copy vault. */
export async function fanOutCopies(env: Env, trades: { vault_id: number; seq: number; copied: boolean; side: string; token_id: string }[]): Promise<number> {
  let queued = 0
  for (const t of trades) {
    if (t.copied || !t.seq) continue
    const copies = await env.DB.prepare("SELECT id, cash, per_trade, positions FROM vaults WHERE leader = ? AND kind = 'Copy' AND status = 'Active'").bind(t.vault_id).all<{ id: number; cash: number; per_trade: number; positions: string }>()
    for (const c of copies.results) {
      let minOut = '0'
      if (t.side === 'buy') {
        const near = Math.min(c.per_trade, c.cash)
        if (near <= 0) continue
        const q = await view<{ out: string }>(env, env.LAUNCHPAD, 'quote_buy', { token_id: t.token_id, amount: nearRaw(near) }).catch(() => null)
        if (q) minOut = minus(q.out, 0.05)
      }
      const id = await enqueue(env, 'relayer', 'copy_trade', { copy_id: c.id, seq: t.seq, min_out: minOut }, { dedupe: `copy:${c.id}:${t.seq}` })
      if (id) queued++
    }
  }
  return queued
}

/** Maintenance anyone could do; the relayer does it so nobody has to. */
export async function runKeeper(env: Env): Promise<number> {
  const now = Date.now()
  let n = 0
  const minute = Math.floor(now / 60_000)
  const push = await env.DB.prepare("SELECT id FROM tokens WHERE holder_pending >= 0.1 AND phase IN ('Curve', 'Pool', 'Merged') LIMIT 20").all<{ id: string }>()
  for (const t of push.results) if (await enqueue(env, 'relayer', 'push_rewards', { token_id: t.id }, { dedupe: `push:${t.id}:${Math.floor(minute / 10)}`, tgas: 60 })) n++
  const bb = await env.DB.prepare("SELECT id FROM tokens WHERE buyback_pending >= 0.05 AND phase IN ('Curve', 'Pool') LIMIT 20").all<{ id: string }>()
  for (const t of bb.results) if (await enqueue(env, 'relayer', 'buyback', { token_id: t.id }, { dedupe: `buyback:${t.id}:${minute}`, tgas: 60 })) n++
  const cross = await env.DB.prepare("SELECT id FROM crossings WHERE status = 'Window' AND ends_ts > 0 AND ends_ts <= ?").bind(now).all<{ id: number }>()
  for (const c of cross.results) if (await enqueue(env, 'relayer', 'finalize_cross', { cross_id: c.id }, { dedupe: `finalize:${c.id}:${Math.floor(minute / 5)}`, tgas: 200 })) n++

  // Equity moves with prices between trades: mark vaults to market, and ask the contract to fire those past
  // their limit (the contract checks it again itself).
  const market = new Map((await env.DB.prepare("SELECT id, price FROM tokens WHERE phase IN ('Curve', 'Pool')").all<{ id: string; price: number }>()).results.map((t) => [t.id, t.price]))
  const vaults = await env.DB.prepare("SELECT id, kind, owner, name, cash, peak, fire_bps, positions, expires_ts FROM vaults WHERE status IN ('Active', 'Paused')").all<{ id: number; kind: string; owner: string; name: string; cash: number; peak: number; fire_bps: number; positions: string; expires_ts: number }>()
  const updates: D1PreparedStatement[] = []
  for (const v of vaults.results) {
    const pos: { token_id: string; amount: string }[] = JSON.parse(v.positions || '[]')
    const equity = v.cash + pos.reduce((s, p) => s + (Number(BigInt(p.amount) / 10n ** 12n) / 1e6) * (market.get(p.token_id) ?? 0), 0)
    updates.push(env.DB.prepare('UPDATE vaults SET equity = ? WHERE id = ?').bind(equity, v.id))
    const dd = v.peak > 0 ? (1 - equity / v.peak) * 10_000 : 0
    if (dd >= v.fire_bps || (v.expires_ts && v.expires_ts <= now)) {
      if (await enqueue(env, 'relayer', 'check_vault', { vault_id: v.id }, { dedupe: `check:${v.id}:${Math.floor(minute / 5)}` })) n++
    } else if (v.kind === 'House' && dd >= 1_800) {
      // Close to being fired: tell the people copying it.
      const day = Math.floor(now / 86_400_000)
      const copiers = await env.DB.prepare("SELECT owner FROM vaults WHERE leader = ? AND status = 'Active'").bind(v.id).all<{ owner: string }>()
      for (const c of copiers.results)
        updates.push(env.DB.prepare('INSERT OR IGNORE INTO notifications (account, text, link, ts, dedupe) VALUES (?, ?, ?, ?, ?)').bind(c.owner, `${v.name} is close to being fired: down ${Math.floor(dd / 100)}% from its peak`, `/gardeners/${v.id}`, now, `warn:${v.id}:${c.owner}:${day}`))
    }
  }
  for (let i = 0; i < updates.length; i += 80) await env.DB.batch(updates.slice(i, i + 80))

  // A fired house gardener is replaced by a new one with the same strategy, funded by the house account.
  if (env.HOUSE_FUNDER && env.HOUSE_FUNDER_KEY) {
    const fired = await env.DB.prepare("SELECT v.id, v.strategy, v.daily_limit FROM vaults v WHERE v.kind = 'House' AND v.status = 'Fired' AND NOT EXISTS (SELECT 1 FROM ix_state s WHERE s.key = 'replaced:' || v.id)").all<{ id: number; strategy: string; daily_limit: number }>()
    const used = new Set((await env.DB.prepare("SELECT name FROM vaults WHERE kind = 'House'").all<{ name: string }>()).results.map((r) => r.name))
    for (const f of fired.results) {
      const name = HOUSE_NAMES.find((h) => !used.has(h)) ?? `Gardener ${f.id + 1}`
      used.add(name)
      const budget = Number(env.HOUSE_BUDGET_NEAR || 100)
      const id = await enqueue(env, 'house', 'create_house_vault', { name, strategy: f.strategy, daily_limit: nearRaw(Math.max(f.daily_limit, budget / 2)) }, { dedupe: `replace:${f.id}`, deposit: nearRaw(budget) })
      if (id) {
        await env.DB.prepare("INSERT OR IGNORE INTO ix_state (key, value) VALUES (?, ?)").bind(`replaced:${f.id}`, String(id)).run()
        n++
      }
    }
  }

  // Hold tiers reached: 3, 5 and 10 days.
  const tiers = await env.DB.prepare(
    `SELECT b.token_id, b.account, b.first_ts, k.ticker FROM balances b JOIN tokens k ON k.id = b.token_id
     WHERE b.balance > 0 AND b.account != ? AND b.first_ts < ? AND b.updated_ts > ? LIMIT 400`,
  )
    .bind(env.LAUNCHPAD, now - 3 * 86_400_000, now - 30 * 86_400_000)
    .all<{ token_id: string; account: string; first_ts: number; ticker: string }>()
  const notes: D1PreparedStatement[] = []
  for (const t of tiers.results) {
    const days = Math.floor((now - t.first_ts) / 86_400_000)
    const tier = days >= 10 ? 10 : days >= 5 ? 5 : 3
    const weight = tier === 10 ? '×2' : tier === 5 ? '×1.5' : '×1'
    notes.push(env.DB.prepare('INSERT OR IGNORE INTO notifications (account, text, link, ts, dedupe) VALUES (?, ?, ?, ?, ?)').bind(t.account, `Your $${t.ticker} hold reached ${tier} days. Reward weight is now ${weight}.`, `/token/${t.token_id}`, now, `tier:${t.token_id}:${t.account}:${tier}`))
  }
  for (let i = 0; i < notes.length; i += 80) await env.DB.batch(notes.slice(i, i + 80))
  return n
}
