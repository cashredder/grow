// grow. API (Cloudflare Worker).
//
//   /v1/...                 open read-only data (routes/v1.ts), any origin, edge-cached for 3 s
//   /v1/stream              live feed (WebSocket)
//   /v1/agent/...           API for agents people run themselves (routes/agent.ts), Bearer gk_...
//   /auth/nonce, /auth/login, /auth/logout      NEP-413 wallet sign-in (routes/auth.ts)
//   /me/...                 signed-in: profile, portfolio, notifications, invites, API keys, gardeners
//   /tokens/{id}/comments   POST a comment;  /tokens/{id}/favorite  PUT/DELETE watchlist
//   /upload, /meta, /f/...  pictures and token metadata (routes/files.ts)
//   /ref/{code}             invite code -> referrer account
//   /admin/...              moderation and status, Bearer ADMIN_TOKEN
//
// The scheduled trigger (every minute) only keeps the clock wound; the clock does the work (clock.ts).
import type { Env } from './env'
import { fetchNearUsd } from './lib/price'
import { cors, fail, HttpError, json } from './http'
import { handleV1 } from './routes/v1'
import { handleAgent } from './routes/agent'
import { login, logout, nonce, requireAccount } from './routes/auth'
import { file, meta, upload } from './routes/files'
import {
  createKey, favorite, hideComment, inviteCode, linkKey, listKeys, myVaults, notifications, portfolio, postComment, resolveCode, revokeKey,
  saveProfile, seenNotifications,
} from './routes/me'

export { Clock, Hub } from './clock'

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(env.CLOCK.get(env.CLOCK.idFromName('clock')).fetch('https://clock/wind').then(() => undefined))
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname
    const h = cors(req, env)
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h })
    try {
      let res: Response
      if (path === '/v1/stream') return env.HUB.get(env.HUB.idFromName('hub')).fetch(req)
      if (path.startsWith('/v1/agent/')) res = await handleAgent(req, env, url)
      else if (path === '/v1' || path.startsWith('/v1/')) {
        if (req.method !== 'GET') fail(405, 'read-only')
        // Bots polling the same URL hit the edge cache; signed-in lists (watchlist) skip it.
        const cacheable = !req.headers.get('Authorization')
        const cache = caches.default
        if (cacheable) {
          const hit = await cache.match(req)
          if (hit) return hit
        }
        res = await handleV1(req, env, url)
        res.headers.set('Cache-Control', cacheable ? 'public, max-age=3' : 'private, no-store')
        res.headers.set('Access-Control-Allow-Origin', '*')
        if (cacheable && res.status === 200) ctx.waitUntil(cache.put(req, res.clone()))
        return res
      } else res = await route(req, env, url)
      for (const [k, v] of Object.entries(h)) res.headers.set(k, v)
      return res
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500
      const message = e instanceof HttpError ? e.message : 'server error'
      if (!(e instanceof HttpError)) console.error(e)
      return json({ error: message }, status, h)
    }
  },
}

async function route(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname
  const m = req.method
  const seg = path.split('/').filter(Boolean)

  if (m === 'GET' && path === '/health') return json({ ok: true })
  if (m === 'GET' && path === '/auth/nonce') return nonce(env)
  if (m === 'POST' && path === '/auth/login') return login(req, env)
  if (m === 'POST' && path === '/auth/logout') return logout(req, env)

  if (m === 'POST' && path === '/upload') {
    await requireAccount(req, env)
    return upload(req, env)
  }
  if (m === 'POST' && path === '/meta') {
    await requireAccount(req, env)
    return meta(req, env)
  }
  if (m === 'GET' && seg[0] === 'f') return file(seg.slice(1).join('/'), env)
  if (m === 'GET' && seg[0] === 'ref' && seg[1]) return resolveCode(env, seg[1])

  if (seg[0] === 'tokens' && seg[1]) {
    const id = decodeURIComponent(seg[1])
    if (m === 'POST' && seg[2] === 'comments') return postComment(req, env, id)
    if (seg[2] === 'favorite' && (m === 'PUT' || m === 'DELETE')) return favorite(req, env, id, m === 'PUT')
  }

  if (seg[0] === 'me') {
    if (m === 'PUT' && seg[1] === 'profile') return saveProfile(req, env)
    if (m === 'GET' && seg[1] === 'portfolio') return portfolio(req, env)
    if (m === 'GET' && seg[1] === 'notifications') return notifications(req, env, url)
    if (m === 'POST' && seg[1] === 'notifications' && seg[2] === 'seen') return seenNotifications(req, env)
    if (m === 'GET' && seg[1] === 'invite') return inviteCode(req, env)
    if (m === 'GET' && seg[1] === 'gardeners') return myVaults(req, env)
    if (seg[1] === 'api-keys') {
      if (m === 'GET' && !seg[2]) return listKeys(req, env)
      if (m === 'POST' && !seg[2]) return createKey(req, env)
      if (m === 'DELETE' && seg[2]) return revokeKey(req, env, seg[2])
      if (m === 'POST' && seg[2] && seg[3] === 'vaults') return linkKey(req, env, seg[2])
    }
  }

  if (seg[0] === 'admin') {
    if (!env.ADMIN_TOKEN || req.headers.get('Authorization') !== `Bearer ${env.ADMIN_TOKEN.trim()}`) fail(403, 'forbidden')
    if (m === 'DELETE' && seg[1] === 'comments' && seg[2]) return hideComment(req, env, Number(seg[2]))
    if (m === 'GET' && seg[1] === 'status') {
      const state = await env.DB.prepare("SELECT key, value FROM ix_state WHERE key IN ('block', 'indexed_at') OR key LIKE 'error:%'").all()
      const jobs = await env.DB.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all()
      const failed = await env.DB.prepare("SELECT id, method, error, updated FROM jobs WHERE status = 'failed' ORDER BY id DESC LIMIT 20").all()
      return json({ source: env.TX_API_URL ? 'accounts' : 'blocks', state: state.results, jobs: jobs.results, failed: failed.results })
    }
    if (m === 'GET' && seg[1] === 'price') return json({ price: await fetchNearUsd() })
    if (m === 'GET' && seg[1] === 'probe') {
      // Which public endpoints answer from this worker (they limit shared Cloudflare addresses differently).
      const urls = (new URL(req.url).searchParams.get('urls') || '').split(',').filter((u) => u.startsWith('https://')).slice(0, 8)
      const out: Record<string, string> = {}
      for (const u of urls) {
        try {
          const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'block', params: { finality: 'final' } }) })
          out[u] = `${r.status} ${(await r.text()).slice(0, 60)}`
        } catch (e) {
          out[u] = String(e)
        }
      }
      return json(out)
    }
    if (m === 'POST' && seg[1] === 'wind') {
      await env.CLOCK.get(env.CLOCK.idFromName('clock')).fetch('https://clock/wind')
      return json({ ok: true })
    }
  }

  return fail(404, 'not found')
}
