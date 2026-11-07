// Everything that needs a signed-in wallet: profile, comments, watchlist, notifications, portfolio, invites and
// API keys for agents people run themselves.
import type { Env } from '../env'
import { body, clean, fail, json, num, sha256Hex } from '../http'
import { view } from '../near/rpc'
import { toNear } from '../lib/units'
import { nearUsd } from '../lib/price'
import { requireAccount } from './auth'

const AVATARS = ['sapling', 'oak', 'acorn', 'moss', 'clover', 'bonsai', 'truffle', 'willow', 'pollen', 'fern', 'thorn', 'ivy']

// Only handles are stored; links are built from them, so a pasted address cannot point anywhere else.
export const LINK_RULES = {
  x: /^[A-Za-z0-9_]{1,15}$/,
  tg: /^[A-Za-z0-9_]{5,32}$/,
  discord: /^[A-Za-z0-9-]{2,32}$/,
}
export const cleanHandle = (v: unknown) =>
  clean(v, 80)
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/^(x\.com|twitter\.com|t\.me|discord\.gg|discord\.com\/invite)\//i, '')
    .replace(/^@/, '')
    .replace(/\/$/, '')

export async function saveProfile(req: Request, env: Env): Promise<Response> {
  const me = await requireAccount(req, env)
  const b = await body(req)
  const avatar = clean(b.avatar, 16)
  if (avatar && !AVATARS.includes(avatar)) fail(400, 'unknown avatar')
  const bio = clean(b.bio, 160)
  const links: Record<string, string | null> = {}
  for (const k of Object.keys(LINK_RULES) as (keyof typeof LINK_RULES)[]) {
    const h = cleanHandle((b.links as Record<string, unknown> | undefined)?.[k])
    if (h && !LINK_RULES[k].test(h)) fail(400, `that does not look like a valid ${k === 'tg' ? 'Telegram' : k === 'x' ? 'X' : 'Discord'} handle`)
    links[k] = h || null
  }
  await env.DB.prepare(
    'INSERT INTO profiles (account, bio, avatar, x, tg, discord, updated) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (account) DO UPDATE SET bio = excluded.bio, avatar = excluded.avatar, x = excluded.x, tg = excluded.tg, discord = excluded.discord, updated = excluded.updated',
  )
    .bind(me, bio, avatar || 'sapling', links.x, links.tg, links.discord, Date.now())
    .run()
  return json({ ok: true })
}

export async function postComment(req: Request, env: Env, tokenId: string): Promise<Response> {
  const me = await requireAccount(req, env)
  const b = await body(req)
  const text = clean(b.text, 280).replace(/\r/g, '')
  if (!text) fail(400, 'comment must be 1-280 characters')
  const t = await env.DB.prepare('SELECT id FROM tokens WHERE id = ?').bind(tokenId).first()
  if (!t) fail(404, 'no such token')
  const now = Date.now()
  // A new wallet costs nothing, so limits go per author and per client IP (stored only as a salted hash).
  const ip = await sha256Hex(`${env.SESSION_SALT || 'salt'}|${req.headers.get('CF-Connecting-IP') || 'local'}`)
  const lim = await env.DB.prepare('SELECT SUM(CASE WHEN ts > ? THEN 1 ELSE 0 END) AS burst, COUNT(*) AS hour FROM comments WHERE (account = ? OR ip = ?) AND ts > ?')
    .bind(now - 15_000, me, ip, now - 3_600_000)
    .first<{ burst: number; hour: number }>()
  if (lim && lim.burst > 0) fail(429, 'slow down: one comment per 15 seconds')
  if (lim && lim.hour >= 30) fail(429, 'too many comments this hour')
  const row = await env.DB.prepare('INSERT INTO comments (token_id, account, text, ts, ip) VALUES (?, ?, ?, ?, ?) RETURNING id, account, text, ts').bind(tokenId, me, text, now, ip).first()
  return json({ comment: row }, 201)
}

export async function hideComment(req: Request, env: Env, id: number): Promise<Response> {
  if (!env.ADMIN_TOKEN || req.headers.get('Authorization') !== `Bearer ${env.ADMIN_TOKEN}`) fail(403, 'forbidden')
  await env.DB.prepare('UPDATE comments SET hidden = 1 WHERE id = ?').bind(id).run()
  return json({ ok: true })
}

export async function favorite(req: Request, env: Env, tokenId: string, on: boolean): Promise<Response> {
  const me = await requireAccount(req, env)
  if (on) await env.DB.prepare('INSERT OR IGNORE INTO favorites (account, token_id, ts) VALUES (?, ?, ?)').bind(me, tokenId, Date.now()).run()
  else await env.DB.prepare('DELETE FROM favorites WHERE account = ? AND token_id = ?').bind(me, tokenId).run()
  return json({ ok: true })
}

export async function notifications(req: Request, env: Env, url: URL): Promise<Response> {
  const me = await requireAccount(req, env)
  const r = await env.DB.prepare('SELECT id, text, link, ts, seen FROM notifications WHERE account = ? ORDER BY id DESC LIMIT ?').bind(me, num(url.searchParams.get('limit'), 30, 1, 100)).all()
  return json({ notifications: r.results, unseen: r.results.filter((n) => !(n as { seen: number }).seen).length })
}

export async function seenNotifications(req: Request, env: Env): Promise<Response> {
  const me = await requireAccount(req, env)
  await env.DB.prepare('UPDATE notifications SET seen = 1 WHERE account = ? AND seen = 0').bind(me).run()
  return json({ ok: true })
}

interface HoldInfo {
  balance: string
  since_day: number
  held_days: number
  multiplier: number
  claimable: string
}

/** Positions with live hold tiers and claimable rewards, wallet and summary. */
export async function portfolio(req: Request, env: Env): Promise<Response> {
  const me = await requireAccount(req, env)
  const rows = await env.DB.prepare('SELECT b.token_id, b.balance, b.first_ts, k.account, k.name, k.ticker, k.image, k.price, k.phase FROM balances b JOIN tokens k ON k.id = b.token_id WHERE b.account = ? AND b.balance > 0 ORDER BY b.balance * k.price DESC LIMIT 50')
    .bind(me)
    .all<{ token_id: string; balance: number; first_ts: number; account: string; name: string; ticker: string; image: string | null; price: number; phase: string }>()
  const infos = await Promise.all(rows.results.map((r) => view<HoldInfo>(env, r.account, 'hold_info', { account_id: me }).catch(() => null)))
  const positions = rows.results.map((r, i) => {
    const h = infos[i]
    return {
      ...r,
      value: r.balance * r.price,
      held_days: h?.held_days ?? Math.floor((Date.now() - r.first_ts) / 86_400_000),
      multiplier: h ? h.multiplier / 100 : null,
      claimable: h ? toNear(h.claimable) : 0,
      bought_ts: h ? h.since_day * 86_400_000 : r.first_ts,
    }
  })
  const credits = await view<string>(env, env.LAUNCHPAD, 'credits_of', { account_id: me }).catch(() => '0')
  const balance = await accountBalance(env, me)
  const trades = await env.DB.prepare('SELECT t.token_id, k.ticker, t.side, t.near, t.tokens, t.ts FROM trades t JOIN tokens k ON k.id = t.token_id WHERE t.account = ? AND t.vault_id IS NULL ORDER BY t.id DESC LIMIT 80').bind(me).all()
  return json({
    account: me,
    wallet_near: balance,
    positions,
    positions_value: positions.reduce((n, p) => n + p.value, 0),
    rewards_claimable: positions.reduce((n, p) => n + p.claimable, 0),
    credits: toNear(credits),
    activity: trades.results,
    near_usd: await nearUsd(env),
  })
}

async function accountBalance(env: Env, account: string): Promise<number | null> {
  try {
    const res = await fetch(env.RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'b', method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: account } }),
    })
    const j = (await res.json()) as { result?: { amount: string; locked: string } }
    return j.result ? toNear(j.result.amount) : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- invites

const CODE_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789'

export async function inviteCode(req: Request, env: Env): Promise<Response> {
  const me = await requireAccount(req, env)
  let row = await env.DB.prepare('SELECT code FROM ref_codes WHERE account = ?').bind(me).first<{ code: string }>()
  if (!row) {
    const rnd = crypto.getRandomValues(new Uint8Array(6))
    const code = 'grow' + [...rnd].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('')
    await env.DB.prepare('INSERT OR IGNORE INTO ref_codes (code, account, created) VALUES (?, ?, ?)').bind(code, me, Date.now()).run()
    row = await env.DB.prepare('SELECT code FROM ref_codes WHERE account = ?').bind(me).first<{ code: string }>()
  }
  const invited = await env.DB.prepare('SELECT COUNT(*) AS n FROM referrals WHERE referrer = ?').bind(me).first<{ n: number }>()
  const earned = await env.DB.prepare('SELECT earned, claimed FROM ref_earnings WHERE referrer = ?').bind(me).first<{ earned: number; claimed: number }>()
  const credits = await view<string>(env, env.LAUNCHPAD, 'credits_of', { account_id: me }).catch(() => '0')
  return json({ code: row!.code, invited: invited?.n ?? 0, earned: earned?.earned ?? 0, available: toNear(credits) })
}

/** Turns an invite code into the account to pass as `referrer` when trading. */
export async function resolveCode(env: Env, code: string): Promise<Response> {
  const r = await env.DB.prepare('SELECT account FROM ref_codes WHERE code = ?').bind(code.toLowerCase().slice(0, 24)).first<{ account: string }>()
  if (!r) fail(404, 'unknown code')
  return json({ referrer: r!.account })
}

// ---------------------------------------------------------------- API keys

export async function listKeys(req: Request, env: Env): Promise<Response> {
  const me = await requireAccount(req, env)
  const r = await env.DB.prepare('SELECT k.id, k.name, k.hint, k.daily_limit, k.created, k.last_used, (SELECT GROUP_CONCAT(vault_id) FROM api_key_vaults v WHERE v.key_id = k.id) AS vaults FROM api_keys k WHERE k.account = ? AND k.revoked = 0 ORDER BY k.created DESC')
    .bind(me)
    .all()
  return json({ keys: r.results })
}

export async function createKey(req: Request, env: Env): Promise<Response> {
  const me = await requireAccount(req, env)
  const b = await body(req)
  const name = clean(b.name, 24)
  const limit = Number(b.daily_limit)
  if (name.length < 2) fail(400, 'name the key')
  if (!(limit > 0 && limit <= 100_000)) fail(400, 'set a daily limit in NEAR')
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE account = ? AND revoked = 0').bind(me).first<{ n: number }>()
  if ((count?.n ?? 0) >= 10) fail(400, 'at most 10 keys')
  const secret = 'gk_' + [...crypto.getRandomValues(new Uint8Array(24))].map((x) => x.toString(16).padStart(2, '0')).join('')
  const id = 'k' + crypto.randomUUID().slice(0, 8)
  await env.DB.prepare('INSERT INTO api_keys (id, account, name, hash, hint, daily_limit, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, me, name, await sha256Hex(`${env.SESSION_SALT || ''}|${secret}`), secret.slice(-4), limit, Date.now())
    .run()
  return json({ id, key: secret, note: 'Shown once. Keep it private.' }, 201)
}

export async function revokeKey(req: Request, env: Env, id: string): Promise<Response> {
  const me = await requireAccount(req, env)
  await env.DB.batch([
    env.DB.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ? AND account = ?').bind(id, me),
    env.DB.prepare('DELETE FROM api_key_vaults WHERE key_id = ? AND key_id IN (SELECT id FROM api_keys WHERE account = ?)').bind(id, me),
  ])
  return json({ ok: true })
}

/** Lets a key trade one of your vaults. The vault's agent must be the relayer (the default). */
export async function linkKey(req: Request, env: Env, id: string): Promise<Response> {
  const me = await requireAccount(req, env)
  const b = await body(req)
  const vaultId = Number(b.vault_id)
  const key = await env.DB.prepare('SELECT id FROM api_keys WHERE id = ? AND account = ? AND revoked = 0').bind(id, me).first()
  if (!key) fail(404, 'no such key')
  const v = await env.DB.prepare('SELECT owner, agent, kind FROM vaults WHERE id = ?').bind(vaultId).first<{ owner: string; agent: string; kind: string }>()
  if (!v || v.owner !== me) fail(404, 'no such gardener of yours')
  if (v!.kind !== 'User' || v!.agent !== env.RELAYER) fail(400, 'only your own gardeners traded by the grow. relayer can use a key')
  await env.DB.prepare('INSERT INTO api_key_vaults (vault_id, key_id) VALUES (?, ?) ON CONFLICT (vault_id) DO UPDATE SET key_id = excluded.key_id').bind(vaultId, id).run()
  // A strategy no longer runs on this vault: the key drives it.
  await env.DB.prepare("UPDATE vaults SET strategy = 'custom' WHERE id = ?").bind(vaultId).run()
  return json({ ok: true })
}

export async function myVaults(req: Request, env: Env): Promise<Response> {
  const me = await requireAccount(req, env)
  const r = await env.DB.prepare('SELECT v.*, k.key_id FROM vaults v LEFT JOIN api_key_vaults k ON k.vault_id = v.id WHERE v.owner = ? ORDER BY v.created_ts DESC').bind(me).all()
  return json({ vaults: r.results.map((v) => ({ ...v, positions: JSON.parse(String((v as { positions: string }).positions || '[]')) })) })
}
