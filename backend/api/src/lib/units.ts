// Units and the curve constants, mirroring contracts/common. Exact maths stays on-chain (quotes are contract
// views); these are for display, sorting and agent decisions.
export const YOCTO = 10n ** 24n
export const TOKEN_UNIT = 10n ** 18n
export const SUPPLY = 1_000_000_000n * TOKEN_UNIT
export const VIRTUAL_TOKENS = 1_073_000_000n * TOKEN_UNIT
export const VIRTUAL_NEAR = 1_200n * YOCTO
export const CURVE_END_TOKENS = 280_000_000n * TOKEN_UNIT
export const CURVE_SOLD = VIRTUAL_TOKENS - CURVE_END_TOKENS

const scale = (v: bigint, unit: bigint) => Number(v / (unit / 1_000_000n)) / 1_000_000

export const toNear = (raw: string | bigint): number => scale(BigInt(raw), YOCTO)
export const toTokens = (raw: string | bigint): number => scale(BigInt(raw), TOKEN_UNIT)

/** NEAR as a yoctoNEAR string, rounded down to 1e-6 NEAR. */
export function nearRaw(near: number): string {
  if (!(near >= 0) || !Number.isFinite(near)) throw new Error('bad amount')
  return (BigInt(Math.floor(near * 1e6)) * (YOCTO / 1_000_000n)).toString()
}

export function tokensRaw(tokens: number): string {
  if (!(tokens >= 0) || !Number.isFinite(tokens)) throw new Error('bad amount')
  return (BigInt(Math.floor(tokens * 1e6)) * (TOKEN_UNIT / 1_000_000n)).toString()
}

/** Price in NEAR per whole token from the contract's `price_e18` (NEAR units per token unit, x1e18). */
export const priceFromE18 = (e18: string | bigint): number => Number(BigInt(e18)) / 1e24

export interface Market {
  phase: string
  near_reserve_raw: string
  tok_reserve_raw: string
  burned_raw: string
}

export function marketFigures(m: Market) {
  const near = BigInt(m.near_reserve_raw)
  const tok = BigInt(m.tok_reserve_raw)
  const price = tok > 0n ? Number((near * 10n ** 18n) / tok) / 1e24 : 0
  const circulating = toTokens(SUPPLY - BigInt(m.burned_raw))
  const progress = m.phase === 'Curve' ? Math.max(0, Math.min(1, Number(VIRTUAL_TOKENS - tok) / Number(CURVE_SOLD))) : m.phase === 'Deploying' ? 0 : 1
  return { price, mcap: price * circulating, progress }
}

/** Tree growth for a market cap in USD: a sprout around $2.8K, a full oak at $1M (same as the site). */
export function growth(usd: number, max = 1_000_000): number {
  const v = Math.max(0, usd * (1_000_000 / max) - 2800)
  return Math.min(1, Math.log1p(v / 8000) / Math.log1p(1_000_000 / 8000))
}
