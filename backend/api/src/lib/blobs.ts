// Content-addressed file storage: R2 when the FILES bucket is bound, otherwise a D1 table (for accounts
// without R2 turned on). D1 rows are limited to about 2 MB, so pictures there must be a little smaller.
import type { Env } from '../env'

export const maxFileBytes = (env: Env): number => (env.FILES ? 2 * 1024 * 1024 : 1_900_000)

export async function hasFile(env: Env, key: string): Promise<boolean> {
  if (env.FILES) return !!(await env.FILES.head(key))
  return !!(await env.DB.prepare('SELECT 1 AS x FROM files WHERE key = ?').bind(key).first())
}

export async function putFile(env: Env, key: string, bytes: Uint8Array, type: string): Promise<void> {
  if (await hasFile(env, key)) return
  if (env.FILES) {
    await env.FILES.put(key, bytes, { httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' } })
    return
  }
  await env.DB.prepare('INSERT OR IGNORE INTO files (key, type, data, ts) VALUES (?, ?, ?, ?)').bind(key, type, bytes, Date.now()).run()
}

export async function getFile(env: Env, key: string): Promise<{ bytes: Uint8Array; type: string } | null> {
  if (env.FILES) {
    const obj = await env.FILES.get(key)
    return obj ? { bytes: new Uint8Array(await obj.arrayBuffer()), type: obj.httpMetadata?.contentType || 'application/octet-stream' } : null
  }
  const row = await env.DB.prepare('SELECT type, data FROM files WHERE key = ?').bind(key).first<{ type: string; data: ArrayBuffer | number[] }>()
  if (!row) return null
  return { bytes: row.data instanceof ArrayBuffer ? new Uint8Array(row.data) : Uint8Array.from(row.data), type: row.type }
}
