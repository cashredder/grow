// Applies chain events to D1. One call handles one or more blocks atomically (a single D1 batch), and events
// already stored are skipped, so re-reading a block is harmless.
import type { Env } from '../env'
import { marketFigures, toNear, toTokens } from '../lib/units'
import type { ChainEvent } from './events'

const AVATARS = ['sapling', 'oak', 'acorn', 'moss', 'clover', 'bonsai', 'truffle', 'willow', 'pollen', 'fern', 'thorn', 'ivy']

type Row = Record<string, unknown>
interface TokenRow extends Row {
  id: string
  phase: string
  near_reserve_raw: string
  tok_reserve_raw: string
  burned_raw: string
  creator: string
  co_dev: string | null
  ticker: string
  holders: number
}
interface VaultRow extends Row {
  id: number
  kind: string
  owner: string
  status: string
  cash: number
  budget: number
  positions: string
  trades: number
  seq: number
  name: string
  leader: number | null
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))
const raw = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v) ? v : '0')

export interface Applied {
  count: number
  /** Public events for the live feed. */
  feed: { type: string; data: Row }[]
}

export async function applyEvents(env: Env, events: ChainEvent[]): Promise<Applied> {
  if (!events.length) return { count: 0, feed: [] }
  const db = env.DB
  const lp = env.LAUNCHPAD
  const suffix = `.${lp}`
  const tokenOf = (account: string) => (account.endsWith(suffix) ? account.slice(0, -suffix.length) : account)

  // Skip what was already applied.
  const lo = Math.min(...events.map((e) => e.block))
  const hi = Math.max(...events.map((e) => e.block))
  const seen = await db.prepare('SELECT receipt, idx FROM events WHERE block BETWEEN ? AND ?').bind(lo, hi).all<{ receipt: string; idx: number }>()
  const have = new Set(seen.results.map((r) => `${r.receipt}:${r.idx}`))
  const fresh = events.filter((e) => !have.has(`${e.receipt}:${e.idx}`))
  if (!fresh.length) return { count: 0, feed: [] }

  // Load the rows these events touch.
  const tokenIds = new Set<string>()
  const vaultIds = new Set<number>()
  const balanceKeys = new Set<string>()
  for (const e of fresh) {
    const d = e.data
    if (e.standard === 'grow') {
      for (const k of ['token_id', 'a', 'b']) if (typeof d[k] === 'string') tokenIds.add(d[k] as string)
      if (d.vault_id !== undefined && d.vault_id !== null) vaultIds.add(Number(d.vault_id))
      if (d.to_vault !== undefined && d.to_vault !== null) vaultIds.add(Number(d.to_vault))
    } else if (e.standard === 'nep141') {
      const t = tokenOf(e.contract)
      tokenIds.add(t)
      for (const k of ['owner_id', 'old_owner_id', 'new_owner_id']) if (typeof d[k] === 'string') balanceKeys.add(`${t}\u0000${d[k]}`)
    }
  }
  const tokens = new Map<string, TokenRow>()
  if (tokenIds.size) {
    const ids = [...tokenIds]
    for (let i = 0; i < ids.length; i += 50) {
      const part = ids.slice(i, i + 50)
      const r = await db.prepare(`SELECT * FROM tokens WHERE id IN (${part.map(() => '?').join(',')})`).bind(...part).all<TokenRow>()
      for (const t of r.results) tokens.set(t.id, t)
    }
  }
  const vaults = new Map<number, VaultRow>()
  if (vaultIds.size) {
    const ids = [...vaultIds]
    const r = await db.prepare(`SELECT * FROM vaults WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<VaultRow>()
    for (const v of r.results) vaults.set(v.id, v)
  }
  const balances = new Map<string, { raw: bigint; first: number; existed: boolean }>()
  if (balanceKeys.size) {
    const keys = [...balanceKeys].map((k) => k.split('\u0000'))
    for (let i = 0; i < keys.length; i += 40) {
      const part = keys.slice(i, i + 40)
      const r = await db
        .prepare(`SELECT token_id, account, balance_raw, first_ts FROM balances WHERE ${part.map(() => '(token_id = ? AND account = ?)').join(' OR ')}`)
        .bind(...part.flat())
        .all<{ token_id: string; account: string; balance_raw: string; first_ts: number }>()
      for (const b of r.results) balances.set(`${b.token_id}\u0000${b.account}`, { raw: BigInt(b.balance_raw), first: b.first_ts, existed: true })
    }
  }

  const stmts: D1PreparedStatement[] = []
  const feed: Applied['feed'] = []
  const touchedTokens = new Set<string>()
  const touchedVaults = new Set<number>()
  const notify = (account: string | null | undefined, text: string, link: string, ts: number, dedupe: string) => {
    if (!account) return
    stmts.push(db.prepare('INSERT OR IGNORE INTO notifications (account, text, link, ts, dedupe) VALUES (?, ?, ?, ?, ?)').bind(account, text, link, ts, dedupe))
  }
  const setMarket = (t: TokenRow, d: Row) => {
    if (d.near_reserve !== undefined) t.near_reserve_raw = raw(d.near_reserve)
    if (d.tok_reserve !== undefined) t.tok_reserve_raw = raw(d.tok_reserve)
    if (d.burned !== undefined) t.burned_raw = raw(d.burned)
    if (typeof d.phase === 'string') t.phase = d.phase
    const m = marketFigures(t)
    Object.assign(t, m)
  }
  const balanceDelta = (token: string, account: string, delta: bigint, ts: number) => {
    const key = `${token}\u0000${account}`
    const b = balances.get(key) ?? { raw: 0n, first: ts, existed: false }
    const before = b.raw
    b.raw = b.raw + delta
    if (b.raw < 0n) b.raw = 0n
    if (before === 0n && b.raw > 0n) b.first = ts
    balances.set(key, b)
    const t = tokens.get(token)
    if (t && account !== lp) {
      if (before === 0n && b.raw > 0n) t.holders = (t.holders || 0) + 1
      if (before > 0n && b.raw === 0n) t.holders = Math.max(0, (t.holders || 0) - 1)
      touchedTokens.add(token)
    }
    stmts.push(
      db
        .prepare('INSERT INTO balances (token_id, account, balance_raw, balance, first_ts, updated_ts) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (token_id, account) DO UPDATE SET balance_raw = excluded.balance_raw, balance = excluded.balance, first_ts = excluded.first_ts, updated_ts = excluded.updated_ts')
        .bind(token, account, b.raw.toString(), toTokens(b.raw), b.first, ts),
    )
  }

  for (const e of fresh) {
    const d = e.data
    stmts.push(
      db.prepare('INSERT OR IGNORE INTO events (receipt, idx, block, ts, contract, standard, event, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(e.receipt, e.idx, e.block, e.ts, e.contract, e.standard, e.event, JSON.stringify(d)),
    )

    if (e.standard === 'nep141') {
      const token = tokenOf(e.contract)
      const amount = BigInt(raw(d.amount))
      if (e.event === 'ft_mint') balanceDelta(token, str(d.owner_id), amount, e.ts)
      else if (e.event === 'ft_burn') balanceDelta(token, str(d.owner_id), -amount, e.ts)
      else if (e.event === 'ft_transfer') {
        balanceDelta(token, str(d.old_owner_id), -amount, e.ts)
        balanceDelta(token, str(d.new_owner_id), amount, e.ts)
      }
      continue
    }
    if (e.standard !== 'grow') continue

    const tid = str(d.token_id)
    const t = tokens.get(tid)
    switch (e.event) {
      case 'token_created': {
        const row: TokenRow = {
          id: tid,
          account: str(d.account),
          name: str(d.name),
          ticker: str(d.ticker),
          creator: str(d.creator),
          co_dev: null,
          split_bps: 10_000,
          reference: d.reference ? str(d.reference) : null,
          fee_bps: Number(d.fee_bps ?? 100),
          redirect_pct: Number(d.redirect_pct ?? 0),
          redirect_to: str(d.redirect_to) || 'holders',
          dev_vault: d.dev_vault === null || d.dev_vault === undefined ? null : Number(d.dev_vault),
          phase: 'Curve',
          near_reserve_raw: raw(d.near_reserve),
          tok_reserve_raw: raw(d.tok_reserve),
          burned_raw: '0',
          holders: 0,
          created_ts: e.ts,
        }
        Object.assign(row, marketFigures(row))
        tokens.set(tid, row)
        touchedTokens.add(tid)
        feed.push({ type: 'token_created', data: { token_id: tid, name: row.name, ticker: row.ticker, creator: row.creator, ts: e.ts } })
        break
      }
      case 'token_failed':
        stmts.push(db.prepare('DELETE FROM tokens WHERE id = ?').bind(tid))
        tokens.delete(tid)
        touchedTokens.delete(tid)
        break
      case 'trade': {
        if (!t) break
        setMarket(t, d)
        const near = toNear(raw(d.near))
        t.volume = Number(t.volume || 0) + near
        t.trades = Number(t.trades || 0) + 1
        t.last_trade_ts = e.ts
        touchedTokens.add(tid)
        const vault = d.vault_id === null || d.vault_id === undefined ? null : Number(d.vault_id)
        stmts.push(
          db
            .prepare('INSERT INTO trades (receipt, token_id, account, side, near, tokens, fee, price, mcap, ts, block, vault_id, referrer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(e.receipt, tid, str(d.account_id), str(d.side), near, toTokens(raw(d.tokens)), toNear(raw(d.fee)), Number(t.price), Number(t.mcap), e.ts, e.block, vault, d.referrer ? str(d.referrer) : null),
        )
        feed.push({ type: 'trade', data: { token_id: tid, ticker: t.ticker, account: str(d.account_id), side: str(d.side), near, tokens: toTokens(raw(d.tokens)), price: t.price, mcap: t.mcap, ts: e.ts } })
        // A buy of 1% of the supply or more is worth telling the dev about.
        if (str(d.side) === 'buy' && toTokens(raw(d.tokens)) >= 10_000_000) notify(t.creator, `${str(d.account_id)} bought ${Math.round(toTokens(raw(d.tokens)) / 1e6)}M $${t.ticker}`, `/token/${tid}`, e.ts, `bigbuy:${e.receipt}`)
        break
      }
      case 'graduated':
        if (!t) break
        t.phase = 'Pool'
        t.graduated_ts = e.ts
        setMarket(t, { near_reserve: d.pool_near, tok_reserve: d.pool_tokens, phase: 'Pool' })
        touchedTokens.add(tid)
        notify(t.creator, `$${t.ticker} moved into its pool`, `/token/${tid}`, e.ts, `grad:${tid}`)
        feed.push({ type: 'graduated', data: { token_id: tid, ticker: t.ticker, ts: e.ts } })
        break
      case 'fees': {
        if (!t) break
        if (d.to_vault === null || d.to_vault === undefined) t.dev_fees = Number(t.dev_fees || 0) + toNear(raw(d.dev))
        else {
          const v = vaults.get(Number(d.to_vault))
          if (v) {
            v.cash += toNear(raw(d.dev))
            v.budget += toNear(raw(d.dev))
            touchedVaults.add(v.id)
          }
        }
        t.holder_fees = Number(t.holder_fees || 0) + toNear(raw(d.holders))
        t.holder_pending = Number(t.holder_pending || 0) + toNear(raw(d.holders))
        t.buyback_pending = Number(t.buyback_pending || 0) + toNear(raw(d.buyback))
        touchedTokens.add(tid)
        if (d.referrer_id) {
          stmts.push(db.prepare('INSERT INTO ref_earnings (referrer, earned) VALUES (?, ?) ON CONFLICT (referrer) DO UPDATE SET earned = earned + excluded.earned').bind(str(d.referrer_id), toNear(raw(d.referrer))))
        }
        break
      }
      case 'rewards_pushed':
        if (!t) break
        t.holder_pending = Math.max(0, Number(t.holder_pending || 0) - toNear(raw(d.amount)))
        touchedTokens.add(tid)
        break
      case 'buyback':
        if (!t) break
        t.buyback_pending = Math.max(0, Number(t.buyback_pending || 0) - toNear(raw(d.near)))
        t.burned_tokens = Number(t.burned_tokens || 0) + toTokens(raw(d.tokens))
        setMarket(t, d)
        touchedTokens.add(tid)
        break
      case 'credits_claimed':
        stmts.push(db.prepare('UPDATE ref_earnings SET claimed = MIN(earned, claimed + ?) WHERE referrer = ?').bind(toNear(raw(d.amount)), str(d.account_id)))
        break
      case 'referral':
        stmts.push(db.prepare('INSERT OR IGNORE INTO referrals (account, referrer, since_ts) VALUES (?, ?, ?)').bind(str(d.account_id), str(d.referrer), e.ts))
        notify(str(d.referrer), `${str(d.account_id)} joined with your invite link`, '/invite', e.ts, `ref:${str(d.account_id)}`)
        break
      case 'tokens_pending':
        notify(str(d.account_id), 'Some coins could not be delivered. Claim them on the token page.', `/token/${tid}`, e.ts, `pending:${e.receipt}`)
        break
      case 'cross_proposed': {
        const id = Number(d.cross_id)
        stmts.push(
          db
            .prepare('INSERT OR IGNORE INTO crossings (id, a, b, proposer, partner, split_bps, name, ticker, status, created_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(id, str(d.a), str(d.b), str(d.proposer), str(d.partner), Number(d.split_bps), str(d.name), str(d.ticker), 'Proposed', e.ts),
        )
        for (const k of ['a', 'b']) {
          const x = tokens.get(str(d[k]))
          if (x) {
            x.crossing_id = id
            touchedTokens.add(x.id)
          }
        }
        notify(str(d.partner), `${str(d.proposer)} wants to cross $${tokens.get(str(d.a))?.ticker ?? ''} with your $${tokens.get(str(d.b))?.ticker ?? ''}`, '/profile?tab=created', e.ts, `cross:${id}:p`)
        break
      }
      case 'cross_cancelled': {
        const id = Number(d.cross_id)
        stmts.push(db.prepare("UPDATE crossings SET status = 'Cancelled' WHERE id = ?").bind(id))
        stmts.push(db.prepare('UPDATE tokens SET crossing_id = NULL WHERE crossing_id = ?').bind(id))
        for (const x of tokens.values()) if (x.crossing_id === id) x.crossing_id = null
        break
      }
      case 'cross_accepted': {
        const id = Number(d.cross_id)
        stmts.push(db.prepare("UPDATE crossings SET status = 'Window', ends_ts = ? WHERE id = ?").bind(Number(d.ends_ms), id))
        const c = await db.prepare('SELECT proposer FROM crossings WHERE id = ?').bind(id).first<{ proposer: string }>()
        notify(c?.proposer, 'Your crossing was accepted. Holders can exit before it completes.', '/profile?tab=created', e.ts, `cross:${id}:a`)
        break
      }
      case 'cross_failed':
        stmts.push(db.prepare("UPDATE crossings SET status = 'Window' WHERE id = ?").bind(Number(d.cross_id)))
        break
      case 'cross_done': {
        const id = Number(d.cross_id)
        const a = tokens.get(str(d.a))
        const b = tokens.get(str(d.b))
        const nid = tid
        stmts.push(db.prepare("UPDATE crossings SET status = 'Done', new_token = ?, rate_a = ?, rate_b = ? WHERE id = ?").bind(nid, raw(d.rate_a), raw(d.rate_b), id))
        for (const x of [a, b]) {
          if (!x) continue
          x.phase = 'Merged'
          x.merged_into = nid
          x.crossing_id = null
          x.near_reserve_raw = '0'
          x.tok_reserve_raw = '0'
          x.price = 0
          x.mcap = 0
          touchedTokens.add(x.id)
        }
        const row: TokenRow = {
          id: nid,
          account: str(d.account),
          name: '',
          ticker: '',
          creator: str(d.creator),
          co_dev: d.co_dev ? str(d.co_dev) : null,
          split_bps: Number(d.split_bps ?? 5000),
          fee_bps: Number(a?.fee_bps ?? 100),
          redirect_pct: Number(a?.redirect_pct ?? 0),
          redirect_to: str(a?.redirect_to) || 'holders',
          dev_vault: (a?.dev_vault as number | null) ?? null,
          phase: 'Pool',
          near_reserve_raw: raw(d.pool_near),
          tok_reserve_raw: raw(d.pool_tokens),
          burned_raw: '0',
          holders: 0,
          created_ts: e.ts,
          graduated_ts: e.ts,
          parents: JSON.stringify([a?.name ?? '', b?.name ?? '']),
          image: (a?.image as string) ?? null,
        }
        const c = await db.prepare('SELECT name, ticker FROM crossings WHERE id = ?').bind(id).first<{ name: string; ticker: string }>()
        row.name = c?.name ?? nid
        row.ticker = c?.ticker ?? nid.split('-')[0].toUpperCase()
        row.description = `Crossed from ${a?.name ?? d.a} and ${b?.name ?? d.b}.`
        Object.assign(row, marketFigures(row))
        tokens.set(nid, row)
        touchedTokens.add(nid)
        for (const dev of [row.creator, row.co_dev]) notify(dev, `$${a?.ticker} and $${b?.ticker} became $${row.ticker}`, `/token/${nid}`, e.ts, `cross:${id}:d:${dev}`)
        feed.push({ type: 'crossed', data: { token_id: nid, a: d.a, b: d.b, ticker: row.ticker, ts: e.ts } })
        break
      }
      case 'vault_created': {
        const id = Number(d.vault_id)
        const budget = toNear(raw(d.budget))
        const v: VaultRow = {
          id,
          kind: str(d.kind),
          owner: str(d.owner),
          agent: str(d.agent),
          name: str(d.name),
          strategy: str(d.strategy),
          status: 'Active',
          budget,
          cash: budget,
          equity: budget,
          peak: budget,
          fire_bps: Number(d.fire_bps),
          daily_limit: toNear(raw(d.daily_limit)),
          allowed: JSON.stringify(d.allowed ?? 'All'),
          expires_ts: Number(d.expires_ms ?? 0),
          leader: d.leader === null || d.leader === undefined ? null : Number(d.leader),
          per_trade: toNear(raw(d.per_trade)),
          trades: 0,
          wins: 0,
          positions: '[]',
          seq: 0,
          created_ts: e.ts,
          art: AVATARS[id % AVATARS.length],
        }
        vaults.set(id, v)
        touchedVaults.add(id)
        if (v.leader !== null) {
          const l = await db.prepare('SELECT owner, name FROM vaults WHERE id = ?').bind(v.leader).first<{ owner: string; name: string }>()
          if (l) notify(l.owner, `Someone started copying ${l.name}`, `/gardeners/${v.leader}`, e.ts, `copy:${id}`)
        }
        break
      }
      case 'vault_deposit': {
        const v = vaults.get(Number(d.vault_id))
        if (!v) break
        v.cash += toNear(raw(d.amount))
        v.budget += toNear(raw(d.amount))
        touchedVaults.add(v.id)
        break
      }
      case 'vault_status':
      case 'vault_agent': {
        const v = vaults.get(Number(d.vault_id))
        if (!v) break
        if (d.status) v.status = str(d.status)
        if (d.agent) v.agent = str(d.agent)
        if (d.reason === 'expired') v.stop_reason = 'the end date passed'
        touchedVaults.add(v.id)
        break
      }
      case 'vault_trade': {
        const v = vaults.get(Number(d.vault_id))
        if (!v) break
        const near = toNear(raw(d.near))
        const amount = BigInt(raw(d.tokens))
        const buy = str(d.side) === 'buy'
        v.cash += buy ? -near : near
        v.trades += 1
        if (d.copied_from === null || d.copied_from === undefined) v.seq = Number(d.seq ?? v.seq + 1)
        const pos: { token_id: string; amount: string }[] = JSON.parse(v.positions || '[]')
        const p = pos.find((x) => x.token_id === tid)
        if (buy) {
          if (p) p.amount = (BigInt(p.amount) + amount).toString()
          else pos.push({ token_id: tid, amount: amount.toString() })
        } else if (p) {
          const left = BigInt(p.amount) - amount
          if (left > 0n) p.amount = left.toString()
          else pos.splice(pos.indexOf(p), 1)
        }
        v.positions = JSON.stringify(pos)
        touchedVaults.add(v.id)
        stmts.push(
          db
            .prepare('INSERT INTO vault_log (vault_id, ts, receipt, token_id, side, near, tokens, note, seq, copied_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(v.id, e.ts, e.receipt, tid, str(d.side), near, toTokens(amount), d.note ? str(d.note) : null, d.copied_from === null || d.copied_from === undefined ? Number(d.seq ?? 0) : Number(d.leader_seq ?? 0), d.copied_from === null || d.copied_from === undefined ? null : Number(d.copied_from)),
        )
        feed.push({ type: 'vault_trade', data: { vault_id: v.id, name: v.name, token_id: tid, side: str(d.side), near, note: d.note ?? null, ts: e.ts, seq: Number(d.seq ?? 0), copied: !(d.copied_from === null || d.copied_from === undefined) } })
        break
      }
      case 'vault_equity': {
        const v = vaults.get(Number(d.vault_id))
        if (!v) break
        v.equity = toNear(raw(d.equity))
        v.peak = toNear(raw(d.peak))
        v.cash = toNear(raw(d.cash))
        touchedVaults.add(v.id)
        stmts.push(db.prepare('INSERT OR REPLACE INTO vault_equity (vault_id, ts, equity) VALUES (?, ?, ?)').bind(v.id, Math.floor(e.ts / 60_000) * 60_000, v.equity))
        break
      }
      case 'vault_fired': {
        const v = vaults.get(Number(d.vault_id))
        if (!v) break
        v.status = 'Fired'
        v.fired_ts = e.ts
        v.stop_reason = d.reason === 'leader_fired' ? 'the gardener was fired' : `down ${Math.floor(Number(d.drawdown_bps ?? 0) / 100)}% from its peak`
        touchedVaults.add(v.id)
        notify(v.owner, v.kind === 'Copy' ? `${v.name} stopped: ${v.stop_reason}` : `${v.name} was fired: ${v.stop_reason}`, `/gardeners/${v.id}`, e.ts, `fired:${v.id}`)
        break
      }
      case 'vault_closed': {
        const v = vaults.get(Number(d.vault_id))
        if (!v) break
        v.status = 'Closed'
        v.cash = 0
        v.equity = 0
        v.positions = '[]'
        touchedVaults.add(v.id)
        break
      }
      case 'vault_converted': {
        const v = vaults.get(Number(d.vault_id))
        if (!v) break
        const pos: { token_id: string; amount: string }[] = JSON.parse(v.positions || '[]').filter((x: { token_id: string }) => x.token_id !== str(d.from))
        const to = pos.find((x) => x.token_id === str(d.to))
        if (to) to.amount = (BigInt(to.amount) + BigInt(raw(d.amount_out))).toString()
        else pos.push({ token_id: str(d.to), amount: raw(d.amount_out) })
        v.positions = JSON.stringify(pos)
        touchedVaults.add(v.id)
        break
      }
      default:
        break
    }
  }

  for (const id of touchedTokens) {
    const t = tokens.get(id)
    if (t) stmts.push(upsert(db, 'tokens', 'id', t))
  }
  for (const id of touchedVaults) {
    const v = vaults.get(id)
    if (v) stmts.push(upsert(db, 'vaults', 'id', v))
  }
  await db.batch(stmts)
  return { count: fresh.length, feed }
}

const TOKEN_COLS = [
  'id', 'account', 'name', 'ticker', 'creator', 'co_dev', 'split_bps', 'reference', 'image', 'description', 'x', 'telegram', 'website', 'meta_done',
  'fee_bps', 'redirect_pct', 'redirect_to', 'dev_vault', 'phase', 'near_reserve_raw', 'tok_reserve_raw', 'burned_raw', 'price', 'mcap', 'progress',
  'volume', 'trades', 'holders', 'dev_fees', 'holder_fees', 'holder_pending', 'buyback_pending', 'burned_tokens', 'created_ts', 'graduated_ts',
  'last_trade_ts', 'merged_into', 'parents', 'crossing_id',
]
const VAULT_COLS = [
  'id', 'kind', 'owner', 'agent', 'name', 'strategy', 'status', 'stop_reason', 'budget', 'cash', 'equity', 'peak', 'fire_bps', 'daily_limit', 'allowed',
  'expires_ts', 'leader', 'per_trade', 'trades', 'wins', 'positions', 'seq', 'created_ts', 'fired_ts', 'art',
]
const DEFAULTS: Record<string, unknown> = { meta_done: 0, split_bps: 10_000, price: 0, mcap: 0, progress: 0, volume: 0, trades: 0, holders: 0, dev_fees: 0, holder_fees: 0, holder_pending: 0, buyback_pending: 0, burned_tokens: 0, last_trade_ts: 0, wins: 0, seq: 0, expires_ts: 0, per_trade: 0, positions: '[]' }

function upsert(db: D1Database, table: 'tokens' | 'vaults', key: string, row: Row): D1PreparedStatement {
  const cols = table === 'tokens' ? TOKEN_COLS : VAULT_COLS
  const vals = cols.map((c) => {
    const v = row[c] ?? DEFAULTS[c] ?? null
    return typeof v === 'boolean' ? (v ? 1 : 0) : v
  })
  const set = cols.filter((c) => c !== key).map((c) => `${c} = excluded.${c}`).join(', ')
  return db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT (${key}) DO UPDATE SET ${set}`).bind(...vals)
}
