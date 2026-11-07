// The grow. API (grow-backend/api). Reads are open; writes carry the session from a wallet sign-in.
import { API_URL } from './config'

const SESSION_KEY = 'grow.session'

export function session(): { token: string; account: string } | null {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') as { token: string; account: string; expires: number } | null
    return s && s.expires > Date.now() ? s : null
  } catch {
    return null
  }
}

export function setSession(s: { token: string; account: string; expires: number } | null) {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s))
    else localStorage.removeItem(SESSION_KEY)
  } catch {
    // storage blocked: the session lasts for this page only
  }
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) }
  const s = session()
  if (s) headers.Authorization = `Bearer ${s.token}`
  let body = init.body
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(init.json)
  }
  const res = await fetch(API_URL + path, { ...init, headers, body })
  const j = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) {
    if (res.status === 401 && s) setSession(null)
    throw new ApiError(res.status, j.error || `HTTP ${res.status}`)
  }
  return j
}

export const streamUrl = () => API_URL.replace(/^http/, 'ws') + '/v1/stream'
