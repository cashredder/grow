import type { Env } from '../env'
import { base58Decode, base64Encode } from './encoding'
import { type FunctionCall, type KeyPair, signTransaction } from './tx'

async function rpc<T>(env: Env, method: string, params: unknown): Promise<T> {
  const res = await fetch(env.RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'grow', method, params }),
  })
  if (!res.ok) throw new Error(`rpc ${method}: HTTP ${res.status}`)
  const j = (await res.json()) as { result?: T; error?: { message?: string; data?: unknown; cause?: { name?: string } } }
  if (j.error) throw new Error(`rpc ${method}: ${j.error.cause?.name || j.error.message || 'error'} ${JSON.stringify(j.error.data ?? '')}`)
  return j.result as T
}

/** Calls a view method and parses its JSON result. */
export async function view<T>(env: Env, contract: string, method: string, args: unknown = {}): Promise<T> {
  const r = await rpc<{ result: number[] }>(env, 'query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: contract,
    method_name: method,
    args_base64: base64Encode(new TextEncoder().encode(JSON.stringify(args))),
  })
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result))) as T
}

export interface AccessKeyView {
  nonce: number | string
  permission: 'FullAccess' | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } }
  block_hash: string
}

export function accessKey(env: Env, account: string, publicKey: string) {
  return rpc<AccessKeyView>(env, 'query', { request_type: 'view_access_key', finality: 'final', account_id: account, public_key: publicKey })
}

export interface TxOutcome {
  hash: string
  ok: boolean
  error?: string
  value?: unknown
}

/** Signs and sends one transaction of function calls, waiting until it is executed. */
export async function sendCalls(env: Env, key: KeyPair, signer: string, receiver: string, calls: FunctionCall[], nonceHint?: bigint): Promise<TxOutcome & { nonce: bigint }> {
  const ak = await accessKey(env, signer, key.publicKeyString)
  let nonce = BigInt(ak.nonce) + 1n
  if (nonceHint !== undefined && nonceHint > nonce) nonce = nonceHint
  const { signed, hash } = signTransaction(key, signer, nonce, receiver, base58Decode(ak.block_hash), calls)
  type Status = { status: { SuccessValue?: string; Failure?: unknown }; transaction_outcome: unknown; receipts_outcome: { outcome: { status: { Failure?: unknown } } }[] }
  const r = await rpc<Status>(env, 'send_tx', { signed_tx_base64: base64Encode(signed), wait_until: 'EXECUTED_OPTIMISTIC' })
  const failure = r.status.Failure ?? r.receipts_outcome.find((o) => o.outcome.status.Failure)?.outcome.status.Failure
  let value: unknown
  if (r.status.SuccessValue) {
    try {
      value = JSON.parse(atob(r.status.SuccessValue))
    } catch {
      value = r.status.SuccessValue
    }
  }
  return { hash, ok: !failure, error: failure ? JSON.stringify(failure).slice(0, 500) : undefined, value, nonce }
}

export async function finalHeight(env: Env): Promise<number> {
  const b = await rpc<{ header: { height: number } }>(env, 'block', { finality: 'final' })
  return b.header.height
}
