// The API for agents people build themselves. Authorization: Bearer gk_... (an API key made on the site).
// A key trades only the vaults linked to it; the contract still enforces each vault's budget, daily limit,
// loss limit and allowed tokens, and the key's own daily limit applies on top.
import type { Env } from '../env'
import { body, clean, fail, json, sha256Hex } from '../http'
import { enqueue } from '../lib/jobs'
import { marketSnapshot, tradeArgs } from '../agents/runner'
import { bearer } from './auth'

async function keyOf(req: Request, env: Env) {
  const t = bearer(req)
  if (!t.startsWith('gk_')) fail(401, 'send your API key as "Authorization: Bearer gk_..."')
  const k = await env.DB.prepare('SELECT id, account, daily_limit FROM api_keys WHERE hash = ? AND revoked = 0').bind(await sha256Hex(`${env.SESSION_SALT || ''}|${t}`)).first<{ id: string; account: string; daily_limit: number }>()
  if (!k) fail(401, 'unknown or revoked key')
  await env.DB.prepare('UPDATE api_keys SET last_used = ? WHERE id = ?').bind(Date.now(), k!.id).run()
  return k!
}

export async function handleAgent(req: Request, env: Env, url: URL): Promise<Response> {
  const k = await keyOf(req, env)
  const path = url.pathname.replace(/\/+$/, '')

  if (req.method === 'GET' && path === '/v1/agent/vaults') {
    const r = await env.DB.prepare('SELECT v.id, v.name, v.status, v.cash, v.equity, v.peak, v.fire_bps, v.daily_limit, v.allowed, v.positions, v.expires_ts FROM vaults v JOIN api_key_vaults a ON a.vault_id = v.id WHERE a.key_id = ?').bind(k.id).all()
    return json({ vaults: r.results.map((v) => ({ ...v, positions: JSON.parse(String((v as { positions: string }).positions)), allowed: JSON.parse(String((v as { allowed: string }).allowed)) })) })
  }

  if (req.method === 'GET' && path === '/v1/agent/market') return json({ tokens: await marketSnapshot(env) })

  if (req.method === 'POST' && path === '/v1/agent/trade') {
    const b = await body(req)
    const vaultId = Number(b.vault_id)
    const tokenId = clean(b.token_id, 64)
    const side = b.side === 'sell' ? 'sell' : b.side === 'buy' ? 'buy' : fail(400, 'side must be buy or sell')
    const v = await env.DB.prepare("SELECT v.id, v.status, v.positions FROM vaults v JOIN api_key_vaults a ON a.vault_id = v.id WHERE a.key_id = ? AND v.id = ?").bind(k.id, vaultId).first<{ id: number; status: string; positions: string }>()
    if (!v) fail(404, 'this key cannot trade that vault')
    if (v!.status !== 'Active') fail(409, 'the vault is not trading')
    const near = side === 'buy' ? Number(b.near) : undefined
    const fraction = side === 'sell' ? Number(b.fraction ?? 1) : undefined
    if (side === 'buy' && !(near! > 0)) fail(400, 'near must be positive')
    if (side === 'sell' && !(fraction! > 0 && fraction! <= 1)) fail(400, 'fraction must be between 0 and 1')
    const slippage = b.slippage === undefined ? 0.03 : Number(b.slippage)
    if (!(slippage >= 0 && slippage <= 0.5)) fail(400, 'slippage must be 0-0.5')
    if (side === 'buy') {
      const day = Math.floor(Date.now() / 86_400_000)
      const spent = await env.DB.prepare('SELECT near FROM api_spend WHERE key_id = ? AND day = ?').bind(k.id, day).first<{ near: number }>()
      if ((spent?.near ?? 0) + near! > k.daily_limit) fail(429, "the key's daily limit is reached")
      await env.DB.prepare('INSERT INTO api_spend (key_id, day, near) VALUES (?, ?, ?) ON CONFLICT (key_id, day) DO UPDATE SET near = near + excluded.near').bind(k.id, day, near).run()
    }
    const args = await tradeArgs(env, { positions: JSON.parse(v!.positions || '[]') }, tokenId, side === 'buy', near, fraction, slippage)
    if (!args) fail(400, side === 'buy' ? 'no quote for that token' : 'no position in that token')
    const note = clean(b.note, 140) || null
    const idem = clean(b.idempotency_key, 64)
    const id = await enqueue(env, 'relayer', 'vault_trade', { vault_id: vaultId, ...args, note }, { dedupe: idem ? `api:${k.id}:${idem}` : undefined })
    if (!id) return json({ duplicate: true }, 200)
    return json({ job_id: id, status: 'queued', min_out: args!.min_out }, 202)
  }

  if (req.method === 'GET' && path.startsWith('/v1/agent/jobs/')) {
    const id = Number(path.split('/').pop())
    const j = await env.DB.prepare("SELECT id, status, tx_hash, error, created, updated FROM jobs WHERE id = ? AND json_extract(args, '$.vault_id') IN (SELECT vault_id FROM api_key_vaults WHERE key_id = ?)").bind(id, k.id).first()
    if (!j) fail(404, 'no such job')
    return json({ job: j })
  }

  return fail(404, 'not found')
}
