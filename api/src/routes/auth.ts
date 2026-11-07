// Sign-in: GET /auth/nonce, the wallet signs MESSAGE with it (NEP-413), POST /auth/login returns a session token.
import type { Env } from '../env'
import { body, fail, isAccount, json, sha256Hex } from '../http'
import { accessKey } from '../near/rpc'
import { base64Decode, base64Encode } from '../near/encoding'
import { verifyNep413, type SignedMessage } from '../near/nep413'

export const MESSAGE = 'Sign in to grow.'
const NONCE_TTL = 5 * 60_000
const SESSION_TTL = 30 * 86_400_000

export async function nonce(env: Env): Promise<Response> {
  const n = crypto.getRandomValues(new Uint8Array(32))
  const s = base64Encode(n)
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_nonces WHERE created < ?').bind(now - NONCE_TTL),
    env.DB.prepare('INSERT INTO auth_nonces (nonce, created) VALUES (?, ?)').bind(s, now),
  ])
  return json({ nonce: s, message: MESSAGE, recipient: env.LAUNCHPAD })
}

export async function login(req: Request, env: Env): Promise<Response> {
  const b = await body<SignedMessage & { nonce: string }>(req)
  if (!isAccount(b.accountId)) fail(400, 'bad account')
  if (typeof b.nonce !== 'string' || typeof b.publicKey !== 'string' || typeof b.signature !== 'string') fail(400, 'nonce, publicKey and signature are required')
  // One use per nonce.
  const used = await env.DB.prepare('DELETE FROM auth_nonces WHERE nonce = ? AND created > ? RETURNING nonce').bind(b.nonce, Date.now() - NONCE_TTL).first()
  if (!used) fail(401, 'the sign-in request expired, try again')
  let nonceBytes: Uint8Array
  try {
    nonceBytes = base64Decode(b.nonce)
  } catch {
    return fail(400, 'bad nonce')
  }
  if (!verifyNep413(b, MESSAGE, nonceBytes, env.LAUNCHPAD)) fail(401, 'bad signature')
  // The key must be a full-access key of that account right now.
  const ak = await accessKey(env, b.accountId, b.publicKey).catch(() => null)
  if (!ak || ak.permission !== 'FullAccess') fail(401, 'that key does not belong to this account')
  const token = base64Encode(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]!)
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(now),
    env.DB.prepare('INSERT INTO sessions (token_hash, account, expires, created) VALUES (?, ?, ?, ?)').bind(await sha256Hex(token), b.accountId, now + SESSION_TTL, now),
    env.DB.prepare("INSERT OR IGNORE INTO profiles (account, updated) VALUES (?, ?)").bind(b.accountId, now),
  ])
  return json({ token, account: b.accountId, expires: now + SESSION_TTL })
}

export async function logout(req: Request, env: Env): Promise<Response> {
  const t = bearer(req)
  if (t) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(t)).run()
  return json({ ok: true })
}

const bearer = (req: Request) => {
  const h = req.headers.get('Authorization') || ''
  return h.startsWith('Bearer ') ? h.slice(7).trim() : ''
}

/** The signed-in account, or null. */
export async function sessionAccount(req: Request, env: Env): Promise<string | null> {
  const t = bearer(req)
  if (!t || t.startsWith('gk_')) return null
  const r = await env.DB.prepare('SELECT account FROM sessions WHERE token_hash = ? AND expires > ?').bind(await sha256Hex(t), Date.now()).first<{ account: string }>()
  return r?.account ?? null
}

export async function requireAccount(req: Request, env: Env): Promise<string> {
  return (await sessionAccount(req, env)) ?? fail(401, 'sign in first')
}

export { bearer }
