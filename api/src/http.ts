import type { Env } from './env'

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export const fail = (status: number, message: string): never => {
  throw new HttpError(status, message)
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } })
}

export async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  if (Number(req.headers.get('Content-Length') || 0) > 64_000) fail(413, 'request too large')
  try {
    return (await req.json()) as T
  } catch {
    return fail(400, 'send JSON')
  }
}

/** Reads are open to any origin; writes only from the site's own origins (they carry a session). */
export function cors(req: Request, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  const origin = req.headers.get('Origin') || ''
  const h: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
  if (req.method === 'GET') h['Access-Control-Allow-Origin'] = origin && allowed.includes(origin) ? origin : '*'
  else if (allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin
  return h
}

/** Removes control characters and trims. */
export const clean = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max) : ''

export const num = (v: string | null, def: number, min: number, max: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : def
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export const ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/

export const isAccount = (s: unknown): s is string => typeof s === 'string' && ACCOUNT.test(s)
