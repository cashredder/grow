// Fills a token's picture, description and links from its metadata file. Only files this API stored are read
// (content-addressed under /f/meta/), so a token cannot make the API fetch arbitrary URLs.
import type { Env } from '../env'
import { getFile } from '../lib/blobs'

const SOCIAL = {
  x: /^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}$/,
  telegram: /^https:\/\/t\.me\/[A-Za-z0-9_+/]{1,64}$/,
  website: /^https:\/\/[^\s"'<>]{4,200}$/,
}

export interface TokenMeta {
  name?: string
  ticker?: string
  description?: string
  image?: string
  x?: string
  telegram?: string
  website?: string
}

export function metaKey(env: Env, reference: string | null): string | null {
  if (!reference) return null
  const prefix = `${env.PUBLIC_URL}/f/`
  if (!reference.startsWith(prefix)) return null
  const key = reference.slice(prefix.length)
  return /^meta\/[0-9a-f]{64}\.json$/.test(key) ? key : null
}

export async function fillMeta(env: Env): Promise<void> {
  const r = await env.DB.prepare('SELECT id, reference FROM tokens WHERE meta_done = 0 LIMIT 20').all<{ id: string; reference: string | null }>()
  const stmts: D1PreparedStatement[] = []
  for (const t of r.results) {
    const key = metaKey(env, t.reference)
    let m: TokenMeta = {}
    if (key) {
      const obj = await getFile(env, key)
      if (obj) {
        try {
          m = JSON.parse(new TextDecoder().decode(obj.bytes)) as TokenMeta
        } catch {
          m = {}
        }
      }
    }
    const image = typeof m.image === 'string' && m.image.startsWith(`${env.PUBLIC_URL}/f/img/`) ? m.image : null
    const pick = (k: keyof typeof SOCIAL) => (typeof m[k] === 'string' && SOCIAL[k].test(m[k] as string) ? (m[k] as string) : null)
    stmts.push(
      env.DB.prepare('UPDATE tokens SET image = COALESCE(?, image), description = COALESCE(?, description), x = ?, telegram = ?, website = ?, meta_done = 1 WHERE id = ?').bind(
        image,
        typeof m.description === 'string' ? m.description.slice(0, 500) : null,
        pick('x'),
        pick('telegram'),
        pick('website'),
        t.id,
      ),
    )
  }
  if (stmts.length) await env.DB.batch(stmts)
}
