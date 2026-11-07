export interface Env {
  DB: D1Database
  FILES: R2Bucket
  CLOCK: DurableObjectNamespace
  HUB: DurableObjectNamespace

  NETWORK: string
  RPC_URL: string
  NEARDATA_URL: string
  LAUNCHPAD: string
  RELAYER: string
  HOUSE_FUNDER: string
  PUBLIC_URL: string
  ALLOWED_ORIGINS: string
  START_BLOCK: string
  NEAR_USD_FALLBACK: string
  CLOCK_EVERY_MS: string
  AGENTS_ENABLED: string
  HOUSE_BUDGET_NEAR: string

  RELAYER_KEY?: string
  HOUSE_FUNDER_KEY?: string
  ADMIN_TOKEN?: string
  SESSION_SALT?: string
}
