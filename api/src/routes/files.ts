// Pictures and token metadata, content-addressed in R2: the same bytes always get the same key, so a token's
// metadata link can never change after launch (like IPFS). From Spark's API.
import type { Env } from '../env'
import { body, clean, fail, json, sha256Hex } from '../http'
import { base64Encode } from '../near/encoding'
import { getFile, maxFileBytes, putFile } from '../lib/blobs'

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

/** Real image bytes, not just a claimed type: check the file signature. */
export function sniff(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return null
}

/** Normalises a social link to a full https URL on a fixed host, or returns null if it is not valid. */
export function socialUrl(v: unknown, kind: 'x' | 'telegram' | 'website'): string | null | '' {
  const s = clean(v, 200)
  if (!s) return ''
  if (kind === 'x') {
    const h = s.replace(/^@/, '').replace(/^(https?:\/\/)?(www\.)?(x|twitter)\.com\//i, '').split(/[/?#]/)[0]
    return /^[A-Za-z0-9_]{1,15}$/.test(h) ? `https://x.com/${h}` : null
  }
  if (kind === 'telegram') {
    const h = s.replace(/^@/, '').replace(/^(https?:\/\/)?(www\.)?(t\.me|telegram\.me)\//i, '').split(/[?#]/)[0]
    return /^[A-Za-z0-9_+/]{1,64}$/.test(h) ? `https://t.me/${h}` : null
  }
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
    return u.protocol === 'https:' && u.hostname.includes('.') ? u.toString() : null
  } catch {
    return null
  }
}

const putOnce = putFile

export async function upload(req: Request, env: Env): Promise<Response> {
  const form = await req.formData()
  const f = form.get('file')
  if (!f || typeof f === 'string') fail(400, 'no file')
  const file = f as unknown as File
  if (file.size > maxFileBytes(env)) fail(413, `the picture is larger than ${(maxFileBytes(env) / 1e6).toFixed(1)} MB`)
  const bytes = new Uint8Array(await file.arrayBuffer())
  const type = sniff(bytes) ?? fail(415, 'only PNG, JPEG, GIF or WebP')
  const key = `img/${await sha256Hex(bytes)}.${EXT[type]}`
  await putOnce(env, key, bytes, type)
  return json({ url: `${env.PUBLIC_URL}/f/${key}` })
}

/** Stores token metadata; returns the `reference` and `reference_hash` to pass to `create_token`. */
export async function meta(req: Request, env: Env): Promise<Response> {
  const b = await body(req)
  const out: Record<string, string> = { name: clean(b.name, 32), ticker: clean(b.ticker, 8).toUpperCase(), description: clean(b.description, 500) }
  if (!out.name || !out.ticker) fail(400, 'name and ticker are required')
  const image = clean(b.image, 256)
  if (image) {
    if (!image.startsWith(`${env.PUBLIC_URL}/f/img/`)) fail(400, 'upload the picture first')
    out.image = image
  }
  for (const k of ['x', 'telegram', 'website'] as const) {
    const s = socialUrl(b[k], k)
    if (s === null) fail(400, `bad ${k} link`)
    if (s) out[k] = s
  }
  const bytes = new TextEncoder().encode(JSON.stringify(out, Object.keys(out).sort()))
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  const hex = [...hash].map((x) => x.toString(16).padStart(2, '0')).join('')
  const key = `meta/${hex}.json`
  await putOnce(env, key, bytes, 'application/json')
  return json({ reference: `${env.PUBLIC_URL}/f/${key}`, reference_hash: base64Encode(hash) })
}

export async function file(key: string, env: Env): Promise<Response> {
  if (!/^(img\/[0-9a-f]{64}\.(png|jpg|gif|webp)|meta\/[0-9a-f]{64}\.json)$/.test(key)) fail(404, 'not found')
  const obj = await getFile(env, key)
  if (!obj) fail(404, 'not found')
  return new Response(obj!.bytes, {
    headers: {
      'Content-Type': obj!.type,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
