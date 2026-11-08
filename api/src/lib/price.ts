import type { Env } from '../env'

const TTL = 60_000

/** Public NEAR/USD prices. Tried in order: some refuse requests from shared Cloudflare addresses. */
const SOURCES: { name: string; url: string; read: (j: unknown) => number | undefined }[] = [
  { name: 'coinbase', url: 'https://api.coinbase.com/v2/prices/NEAR-USD/spot', read: (j) => Number((j as { data?: { amount?: string } }).data?.amount) },
  { name: 'kraken', url: 'https://api.kraken.com/0/public/Ticker?pair=NEARUSD', read: (j) => Number(Object.values((j as { result?: Record<string, { c?: string[] }> }).result ?? {})[0]?.c?.[0]) },
  { name: 'binance', url: 'https://api.binance.com/api/v3/ticker/price?symbol=NEARUSDT', read: (j) => Number((j as { price?: string }).price) },
  { name: 'coingecko', url: 'https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd', read: (j) => (j as { near?: { usd?: number } }).near?.usd },
]

export async function fetchNearUsd(): Promise<{ price: number; source: string } | null> {
  for (const s of SOURCES) {
    try {
      const res = await fetch(s.url, { headers: { Accept: 'application/json', 'User-Agent': 'grow-api' } })
      if (!res.ok) continue
      const v = s.read(await res.json())
      if (typeof v === 'number' && Number.isFinite(v) && v > 0.01 && v < 10_000) return { price: v, source: s.name }
    } catch {
      // next source
    }
  }
  return null
}

/** NEAR in USD, cached for a minute. Falls back to the last known price, then to NEAR_USD_FALLBACK. */
export async function nearUsd(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT value, ts FROM prices WHERE key = 'near_usd'").first<{ value: number; ts: number }>()
  if (row && Date.now() - row.ts < TTL) return row.value
  const got = await fetchNearUsd()
  if (got) {
    await env.DB.prepare("INSERT INTO prices (key, value, ts) VALUES ('near_usd', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, ts = excluded.ts").bind(got.price, Date.now()).run()
    return got.price
  }
  return row?.value ?? Number(env.NEAR_USD_FALLBACK || 2.5)
}
