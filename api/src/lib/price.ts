import type { Env } from '../env'

const TTL = 60_000

/** NEAR in USD, cached for a minute. Falls back to the last known price, then to NEAR_USD_FALLBACK. */
export async function nearUsd(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT value, ts FROM prices WHERE key = 'near_usd'").first<{ value: number; ts: number }>()
  if (row && Date.now() - row.ts < TTL) return row.value
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd', { headers: { Accept: 'application/json' }, cf: { cacheTtl: 60 } } as RequestInit)
    if (res.ok) {
      const j = (await res.json()) as { near?: { usd?: number } }
      const v = j.near?.usd
      if (typeof v === 'number' && v > 0) {
        await env.DB.prepare("INSERT INTO prices (key, value, ts) VALUES ('near_usd', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, ts = excluded.ts").bind(v, Date.now()).run()
        return v
      }
    }
  } catch {
    // keep the last value
  }
  return row?.value ?? Number(env.NEAR_USD_FALLBACK || 2.5)
}
