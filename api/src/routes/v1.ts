// Open, read-only data for the site, bots and aggregators. Every number comes from indexed contract events;
// quotes are live contract views.
import type { Env } from '../env'
import { fail, isAccount, json, num } from '../http'
import { view } from '../near/rpc'
import { nearRaw, toNear, toTokens, tokensRaw } from '../lib/units'
import { nearUsd } from '../lib/price'
import { sessionAccount } from './auth'

const TOKEN_FIELDS = `id, account, name, ticker, creator, co_dev, split_bps, image, description, x, telegram, website, fee_bps, redirect_pct, redirect_to,
  dev_vault, phase, price, mcap, progress, volume, trades, holders, dev_fees, holder_fees, burned_tokens, created_ts, graduated_ts, last_trade_ts,
  merged_into, parents, crossing_id`

const SPARK_POINTS = 40
const SNIPE_MS = 60_000

export const FRAMES: Record<string, number> = { '1s': 1_000, '5s': 5_000, '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 }

type Token = Record<string, unknown> & { id: string; price: number; mcap: number }

async function withSparks(env: Env, rows: Token[]): Promise<Token[]> {
  if (!rows.length) return rows
  const ids = rows.map((r) => r.id)
  const since = Date.now() - 7 * 86_400_000
  const q = await env.DB.prepare(
    `SELECT token_id, price FROM (SELECT token_id, price, ts, ROW_NUMBER() OVER (PARTITION BY token_id ORDER BY ts DESC, id DESC) AS rn FROM trades
     WHERE token_id IN (${ids.map(() => '?').join(',')}) AND ts > ?) WHERE rn <= ? ORDER BY token_id, ts ASC`,
  )
    .bind(...ids, since, SPARK_POINTS)
    .all<{ token_id: string; price: number }>()
  const by = new Map<string, number[]>()
  for (const r of q.results) {
    if (!by.has(r.token_id)) by.set(r.token_id, [])
    by.get(r.token_id)!.push(r.price)
  }
  const day = Date.now() - 86_400_000
  const vol = await env.DB.prepare(`SELECT token_id, SUM(near) AS v FROM trades WHERE token_id IN (${ids.map(() => '?').join(',')}) AND ts > ? GROUP BY token_id`).bind(...ids, day).all<{ token_id: string; v: number }>()
  const v24 = new Map(vol.results.map((r) => [r.token_id, r.v]))
  return rows.map((r) => {
    const spark = by.get(r.id) ?? []
    // The change and the sparkline read the same window, so their colours always agree.
    const first = spark[0] ?? r.price
    return { ...r, parents: r.parents ? JSON.parse(String(r.parents)) : null, spark, change: first > 0 ? (r.price / first - 1) * 100 : 0, volume_24h: v24.get(r.id) ?? 0 }
  })
}

export async function handleV1(req: Request, env: Env, url: URL): Promise<Response> {
  const p = url.pathname.replace(/\/+$/, '')
  const parts = p.split('/').slice(2) // after /v1
  const db = env.DB

  if (!parts.length) {
    const last = await db.prepare("SELECT value FROM ix_state WHERE key = 'block'").first<{ value: string }>()
    return json({
      name: 'grow. API',
      network: env.NETWORK,
      launchpad: env.LAUNCHPAD,
      indexed_block: Number(last?.value ?? 0),
      units: 'NEAR amounts are in NEAR, token amounts in whole tokens, times in ms. Exact values are on-chain.',
      endpoints: [
        'GET /v1/stats', 'GET /v1/tokens?tab=trending|top|new|close|pool|watchlist&q=', 'GET /v1/tokens/{id}', 'GET /v1/tokens/{id}/trades',
        'GET /v1/tokens/{id}/holders', 'GET /v1/tokens/{id}/candles?tf=1s|5s|1m|5m|15m|30m|1h|4h|1d', 'GET /v1/tokens/{id}/quote?side=buy|sell&amount=',
        'GET /v1/tokens/{id}/comments', 'GET /v1/feed', 'GET /v1/leaderboard?tab=traders|devs|gardeners', 'GET /v1/gardeners?tab=all|house|community',
        'GET /v1/gardeners/{id}', 'GET /v1/users/{account}', 'GET /v1/stream (WebSocket)',
      ],
    })
  }

  if (parts[0] === 'stats') {
    const s = await db.prepare("SELECT COUNT(*) AS tokens, COALESCE(SUM(mcap), 0) AS cap, COALESCE(SUM(holders), 0) AS holders, COALESCE(SUM(volume), 0) AS volume FROM tokens WHERE phase IN ('Curve', 'Pool')").first<{ tokens: number; cap: number; holders: number; volume: number }>()
    return json({ ...s, near_usd: await nearUsd(env) })
  }

  if (parts[0] === 'tokens' && parts.length === 1) {
    const tab = url.searchParams.get('tab') || 'trending'
    const q = (url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 40)
    const limit = num(url.searchParams.get('limit'), 50, 1, 100)
    const offset = num(url.searchParams.get('offset'), 0, 0, 10_000)
    const where: string[] = ["phase IN ('Curve', 'Pool')"]
    const args: unknown[] = []
    if (q) {
      where.push('(LOWER(name) LIKE ? OR LOWER(ticker) LIKE ? OR id = ? OR account = ?)')
      args.push(`%${q}%`, `%${q.replace(/^\$/, '')}%`, q, q)
    }
    let order = 'last_trade_ts DESC'
    if (tab === 'top') order = 'mcap DESC'
    else if (tab === 'new') order = 'created_ts DESC'
    else if (tab === 'close') {
      where.push("phase = 'Curve'")
      order = 'progress DESC'
    } else if (tab === 'pool') {
      where.push("phase = 'Pool'")
      order = 'mcap DESC'
    } else if (tab === 'watchlist') {
      const me = await sessionAccount(req, env)
      if (!me) return json({ tokens: [] })
      where.push('id IN (SELECT token_id FROM favorites WHERE account = ?)')
      args.push(me)
    } else if (tab === 'trending') {
      order = `(SELECT COALESCE(SUM(near), 0) FROM trades WHERE trades.token_id = tokens.id AND trades.ts > ${Date.now() - 86_400_000}) DESC, last_trade_ts DESC`
    }
    const r = await db.prepare(`SELECT ${TOKEN_FIELDS} FROM tokens WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...args, limit, offset).all<Token>()
    return json({ tokens: await withSparks(env, r.results), near_usd: await nearUsd(env) })
  }

  if (parts[0] === 'tokens' && parts[1]) {
    const id = decodeURIComponent(parts[1])
    const t = await db.prepare(`SELECT ${TOKEN_FIELDS} FROM tokens WHERE id = ?`).bind(id).first<Token>()
    if (!t) fail(404, 'no such token')
    const sub = parts[2]
    if (!sub) {
      const [withSpark] = await withSparks(env, [t!])
      return json({ token: { ...withSpark, risk: await risk(env, t!) }, near_usd: await nearUsd(env) })
    }
    if (sub === 'trades') {
      const limit = num(url.searchParams.get('limit'), 50, 1, 200)
      const before = num(url.searchParams.get('before'), Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER)
      const r = await db.prepare('SELECT id, account, side, near, tokens, price, mcap, ts, vault_id FROM trades WHERE token_id = ? AND id < ? ORDER BY id DESC LIMIT ?').bind(id, before, limit).all()
      return json({ trades: r.results })
    }
    if (sub === 'holders') {
      const limit = num(url.searchParams.get('limit'), 20, 1, 100)
      const r = await db.prepare('SELECT account, balance, first_ts FROM balances WHERE token_id = ? AND account != ? AND balance > 0 ORDER BY balance DESC LIMIT ?').bind(id, env.LAUNCHPAD, limit).all<{ account: string; balance: number }>()
      return json({ holders: r.results.map((h) => ({ ...h, share: h.balance / 1e9, dev: h.account === t!.creator || h.account === t!.co_dev })) })
    }
    if (sub === 'candles') {
      const tf = FRAMES[url.searchParams.get('tf') || '15m'] ?? fail(400, 'tf must be one of ' + Object.keys(FRAMES).join(', '))
      const limit = num(url.searchParams.get('limit'), 64, 1, 500)
      return json({ tf, candles: await candles(env, id, tf, limit) })
    }
    if (sub === 'quote') {
      const side = url.searchParams.get('side') === 'sell' ? 'sell' : 'buy'
      const amount = Number(url.searchParams.get('amount'))
      if (!(amount > 0)) fail(400, 'amount must be positive (NEAR for buys, tokens for sells)')
      const q = await view<Record<string, unknown>>(env, env.LAUNCHPAD, side === 'buy' ? 'quote_buy' : 'quote_sell', { token_id: id, amount: side === 'buy' ? nearRaw(amount) : tokensRaw(amount) })
      return json({
        side,
        out: side === 'buy' ? toTokens(String(q.out)) : toNear(String(q.out)),
        out_raw: q.out,
        fee: toNear(String(q.fee)),
        rate_bps: q.rate_bps,
        used: side === 'buy' ? toNear(String(q.used)) : toTokens(String(q.used)),
        capped: q.capped,
        impact_bps: q.impact_bps,
        call: side === 'buy'
          ? { receiver: env.LAUNCHPAD, method: 'buy', args: { token_id: id, min_out: '<out_raw less slippage>', referrer: null }, deposit: `${amount} NEAR (+0.00125 NEAR on your first buy of this token)` }
          : { receiver: t!.account, method: 'ft_transfer_call', args: { receiver_id: env.LAUNCHPAD, amount: tokensRaw(amount), msg: '{"action":"sell","min_out":"<out_raw less slippage>"}' }, deposit: '1 yoctoNEAR' },
      })
    }
    if (sub === 'comments') {
      const r = await db
        .prepare('SELECT c.id, c.account, c.text, c.ts, p.avatar FROM comments c LEFT JOIN profiles p ON p.account = c.account WHERE c.token_id = ? AND c.hidden = 0 ORDER BY c.id DESC LIMIT 100')
        .bind(id)
        .all()
      return json({ comments: r.results })
    }
    fail(404, 'not found')
  }

  if (parts[0] === 'feed') {
    const r = await db.prepare('SELECT t.token_id, k.ticker, t.account, t.side, t.near, t.tokens, t.ts FROM trades t JOIN tokens k ON k.id = t.token_id ORDER BY t.id DESC LIMIT 30').all()
    const n = await db.prepare("SELECT id AS token_id, ticker, creator AS account, 'new' AS side, created_ts AS ts FROM tokens ORDER BY created_ts DESC LIMIT 10").all()
    const all = [...r.results, ...n.results].sort((a, b) => Number((b as { ts: number }).ts) - Number((a as { ts: number }).ts)).slice(0, 30)
    return json({ feed: all })
  }

  if (parts[0] === 'leaderboard') {
    const tab = url.searchParams.get('tab') || 'traders'
    if (tab === 'devs') {
      const r = await db.prepare("SELECT creator AS account, COUNT(*) AS tokens, SUM(mcap) AS cap FROM tokens WHERE phase IN ('Curve', 'Pool') GROUP BY creator ORDER BY cap DESC LIMIT 15").all()
      return json({ devs: r.results })
    }
    if (tab === 'gardeners') {
      const r = await db.prepare("SELECT id, name, strategy, kind, owner, art, equity, budget, CASE WHEN budget > 0 THEN (equity / budget - 1) * 100 ELSE 0 END AS pnl_pct FROM vaults WHERE kind IN ('House', 'User') AND status = 'Active' ORDER BY pnl_pct DESC LIMIT 15").all()
      return json({ gardeners: r.results })
    }
    const r = await db
      .prepare('SELECT b.account, SUM(b.balance * k.price) AS value FROM balances b JOIN tokens k ON k.id = b.token_id WHERE b.account != ? AND b.balance > 0 GROUP BY b.account ORDER BY value DESC LIMIT 15')
      .bind(env.LAUNCHPAD)
      .all()
    return json({ traders: r.results })
  }

  if (parts[0] === 'gardeners' && parts.length === 1) {
    const tab = url.searchParams.get('tab') || 'all'
    const kinds = tab === 'house' ? "('House')" : tab === 'community' ? "('User')" : "('House', 'User')"
    const r = await db
      .prepare(
        `SELECT v.id, v.kind, v.owner, v.name, v.strategy, v.status, v.stop_reason, v.art, v.budget, v.cash, v.equity, v.peak, v.fire_bps, v.trades, v.wins, v.created_ts, v.fired_ts,
         (SELECT COUNT(*) FROM vaults c WHERE c.leader = v.id AND c.status = 'Active') AS copiers
         FROM vaults v WHERE v.kind IN ${kinds} ORDER BY CASE v.kind WHEN 'House' THEN 0 ELSE 1 END, CASE v.status WHEN 'Fired' THEN 1 ELSE 0 END, v.equity / MAX(v.budget, 0.000001) DESC LIMIT 100`,
      )
      .all()
    return json({ gardeners: r.results.map(gardenerOut) })
  }

  if (parts[0] === 'gardeners' && parts[1]) {
    const id = Number(parts[1])
    const v = await db.prepare("SELECT *, (SELECT COUNT(*) FROM vaults c WHERE c.leader = vaults.id AND c.status = 'Active') AS copiers FROM vaults WHERE id = ?").bind(id).first()
    if (!v || (v as { kind: string }).kind === 'Copy') fail(404, 'no such gardener')
    const log = await db.prepare('SELECT l.ts, l.token_id, k.ticker, l.side, l.near, l.tokens, l.note FROM vault_log l LEFT JOIN tokens k ON k.id = l.token_id WHERE l.vault_id = ? ORDER BY l.id DESC LIMIT 50').bind(id).all()
    const history = await db.prepare('SELECT ts, equity FROM vault_equity WHERE vault_id = ? ORDER BY ts ASC LIMIT 2000').bind(id).all()
    return json({ gardener: gardenerOut(v!), log: log.results, history: history.results })
  }

  if (parts[0] === 'users' && parts[1]) {
    const account = decodeURIComponent(parts[1])
    if (!isAccount(account)) fail(400, 'bad account')
    const profile = await db.prepare('SELECT account, bio, avatar, x, tg, discord FROM profiles WHERE account = ?').bind(account).first()
    const held = await db.prepare(`SELECT ${TOKEN_FIELDS.split(',').map((f) => 'k.' + f.trim()).join(', ')}, b.balance FROM balances b JOIN tokens k ON k.id = b.token_id WHERE b.account = ? AND b.balance > 0 ORDER BY b.balance * k.price DESC LIMIT 50`).bind(account).all<Token>()
    const created = await db.prepare(`SELECT ${TOKEN_FIELDS} FROM tokens WHERE (creator = ? OR co_dev = ?) AND phase != 'Deploying' ORDER BY created_ts DESC LIMIT 50`).bind(account, account).all<Token>()
    return json({ profile: profile ?? { account, bio: '', avatar: null }, held: await withSparks(env, held.results), created: await withSparks(env, created.results) })
  }

  if (parts[0] === 'crossings') {
    const account = url.searchParams.get('account')
    const r = account
      ? await db.prepare("SELECT * FROM crossings WHERE (proposer = ? OR partner = ?) AND status IN ('Proposed', 'Window', 'Deploying') ORDER BY id DESC").bind(account, account).all()
      : await db.prepare("SELECT * FROM crossings WHERE status IN ('Proposed', 'Window', 'Deploying') ORDER BY id DESC LIMIT 50").all()
    return json({ crossings: r.results })
  }

  return fail(404, 'not found')
}

function gardenerOut(v: Record<string, unknown>) {
  const equity = Number(v.equity), peak = Number(v.peak), budget = Number(v.budget)
  return {
    ...v,
    pnl_pct: budget > 0 ? (equity / budget - 1) * 100 : 0,
    drawdown_pct: peak > 0 ? Math.max(0, (1 - equity / peak) * 100) : 0,
    house: v.kind === 'House',
    win_rate: Number(v.trades) ? Number(v.wins) / Number(v.trades) : 0,
    positions: typeof v.positions === 'string' ? JSON.parse(v.positions as string) : undefined,
    allowed: typeof v.allowed === 'string' ? JSON.parse(v.allowed as string) : undefined,
  }
}

/** OHLC candles. Periods without trades are skipped, like on most launchpads; each candle opens at the
 * previous close. */
export async function candles(env: Env, id: string, tf: number, limit: number) {
  const since = Date.now() - tf * limit * 50
  const r = await env.DB.prepare(
    `SELECT (ts / ?) * ? AS t, price, near, mcap FROM trades WHERE token_id = ? AND ts > ? ORDER BY ts ASC, id ASC`,
  )
    .bind(tf, tf, id, since)
    .all<{ t: number; price: number; near: number; mcap: number }>()
  const out: { t: number; o: number; h: number; l: number; c: number; v: number; mc: number }[] = []
  let prev: number | null = null
  for (const row of r.results) {
    const last = out[out.length - 1]
    if (last && last.t === row.t) {
      last.c = row.price
      last.h = Math.max(last.h, row.price)
      last.l = Math.min(last.l, row.price)
      last.v += row.near
      last.mc = row.mcap
    } else {
      const o = prev ?? row.price
      out.push({ t: row.t, o, h: Math.max(o, row.price), l: Math.min(o, row.price), c: row.price, v: row.near, mc: row.mcap })
    }
    prev = row.price
  }
  return out.slice(-limit)
}

/** Risk badges, as on Spark: holders, top-10 share, dev share and status, snipers (other wallets that bought in
 * the launch window) and bundles (bought in the launch block). */
async function risk(env: Env, t: Token) {
  const rows = await env.DB.prepare('SELECT account, balance FROM balances WHERE token_id = ? AND account != ? AND balance > 0 ORDER BY balance DESC').bind(t.id, env.LAUNCHPAD).all<{ account: string; balance: number }>()
  const bal = new Map(rows.results.map((r) => [r.account, r.balance]))
  const top10 = rows.results.slice(0, 10).reduce((n, r) => n + r.balance, 0)
  const creator = String(t.creator)
  const trades = await env.DB.prepare('SELECT account, side, tokens, ts, block FROM trades WHERE token_id = ? AND vault_id IS NULL ORDER BY id ASC LIMIT 5000').bind(t.id).all<{ account: string; side: string; tokens: number; ts: number; block: number }>()
  const created = Number(t.created_ts)
  const firstBlock = trades.results[0]?.block
  let devBought = 0, devSold = 0
  const snipers = new Set<string>(), bundlers = new Set<string>()
  for (const r of trades.results) {
    if (r.account === creator) {
      if (r.side === 'buy') devBought += r.tokens
      else devSold += r.tokens
      continue
    }
    if (r.side !== 'buy') continue
    if (r.block === firstBlock) bundlers.add(r.account)
    if (r.ts < created + SNIPE_MS) snipers.add(r.account)
  }
  const devBal = bal.get(creator) ?? 0
  const share = (s: Set<string>) => [...s].reduce((n, a) => n + (bal.get(a) ?? 0), 0) / 1e9
  return {
    holders: rows.results.length,
    top10_share: top10 / 1e9,
    dev_share: devBal / 1e9,
    dev_status: devBought || devSold ? (devBal === 0 ? 'sold_all' : devSold > 0 || devBal < devBought ? 'sold_part' : 'holds') : 'none',
    snipers: snipers.size,
    sniper_share: share(snipers),
    bundlers: bundlers.size,
    bundle_share: share(bundlers),
  }
}
