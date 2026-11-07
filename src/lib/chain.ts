// Read-only chain access and units. Small on purpose: the wallet code (lib/near.ts) loads only when needed.
import { RPC_URL } from './config'

export const YOCTO = 10n ** 24n
export const UNIT = 10n ** 18n
export const TGAS = 1_000_000_000_000n

/** NEAR (a number) as yoctoNEAR, to 1e-6 NEAR. */
export const yocto = (near: number) => BigInt(Math.floor(Math.max(0, near) * 1e6)) * (YOCTO / 1_000_000n)
/** Whole tokens as base units, to 1e-6 tokens. */
export const units = (tokens: number) => BigInt(Math.floor(Math.max(0, tokens) * 1e6)) * (UNIT / 1_000_000n)
export const fromYocto = (raw: string | bigint) => Number(BigInt(raw) / (YOCTO / 1_000_000n)) / 1e6
export const fromUnits = (raw: string | bigint) => Number(BigInt(raw) / (UNIT / 1_000_000n)) / 1e6

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'g', method, params }) })
  const j = (await res.json()) as { result?: T; error?: { message?: string; cause?: { name?: string } } }
  if (j.error) throw new Error(j.error.cause?.name || j.error.message || 'RPC error')
  return j.result as T
}

export async function view<T>(contract: string, method: string, args: unknown = {}): Promise<T> {
  const r = await rpc<{ result: number[] }>('query', { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) })
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result))) as T
}

export async function nearBalance(account: string): Promise<number> {
  const r = await rpc<{ amount: string; storage_usage: number }>('query', { request_type: 'view_account', finality: 'final', account_id: account })
  // Keep what the account needs for its own storage out of the spendable balance.
  const locked = BigInt(r.storage_usage) * 10n ** 19n
  const free = BigInt(r.amount) - locked
  return fromYocto(free > 0n ? free : 0n)
}

/** Contract panics come back as nested JSON; show the panic message itself. */
export function failureText(f: unknown): string {
  const s = JSON.stringify(f)
  const m = s.match(/Smart contract panicked: ([^"\\]+)/)
  return m ? m[1] : 'The transaction failed'
}

