// Quick trading: buys and sells from the trading balance on the launchpad, signed in the browser with a key
// that can only call quick_buy and quick_sell there. Such a key cannot attach NEAR, so it cannot move money
// out: withdrawing from the balance always goes through the wallet.
//
// The key is made here, added to the account in one wallet approval (together with the first deposit), and
// kept in this browser only. Loaded only when needed, like the wallet code.
import { KeyPair, type KeyPairString } from '@near-js/crypto'
import { actionCreators, createTransaction, Signature, SignedTransaction } from '@near-js/transactions'
import { baseDecode } from '@near-js/utils'
import { failureText, TGAS } from './chain'
import { LAUNCHPAD, RPC_URL } from './config'
import { callMany } from './near'

const STORE = 'grow.quick.v1'
export const QUICK_METHODS = ['quick_buy', 'quick_sell']
/** Gas the key may spend before it has to be added again (about 800 quick trades). */
const ALLOWANCE = 250_000_000_000_000_000_000_000n

function stored(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(STORE) || '{}') as Record<string, string>
  } catch {
    return {}
  }
}

function save(all: Record<string, string>) {
  try {
    localStorage.setItem(STORE, JSON.stringify(all))
  } catch {
    // private window: quick trading lasts for this page only
  }
}

const memory: Record<string, string> = {}
const secretOf = (account: string) => memory[account] ?? stored()[account]

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'q', method, params }) })
  const j = (await res.json()) as { result?: T; error?: { message?: string; data?: unknown; cause?: { name?: string; info?: unknown } } }
  if (j.error) throw new Error(j.error.cause?.name || j.error.message || 'RPC error')
  return j.result as T
}

interface AccessKeyView { nonce: number; block_hash: string; permission: unknown }

/** The key for this account if it is still on the account (the owner may have removed it in the wallet). */
export async function quickKey(account: string): Promise<KeyPair | null> {
  const secret = secretOf(account)
  if (!secret) return null
  const kp = KeyPair.fromString(secret as KeyPairString)
  const ok = await rpc<AccessKeyView>('query', { request_type: 'view_access_key', finality: 'final', account_id: account, public_key: kp.getPublicKey().toString() }).then(() => true).catch(() => false)
  if (!ok) {
    forget(account)
    return null
  }
  return kp
}

export function forget(account: string) {
  delete memory[account]
  const all = stored()
  delete all[account]
  save(all)
}

/**
 * One wallet approval: adds the quick-trading key to the account (unless it is there already) and deposits
 * `deposit` yoctoNEAR into the trading balance.
 */
export async function enableQuick(account: string, deposit: bigint): Promise<void> {
  const have = await quickKey(account)
  const kp = have ?? KeyPair.fromRandom('ed25519')
  const calls = []
  if (!have) {
    calls.push({ receiver: account, raw: [actionCreators.addKey(kp.getPublicKey(), actionCreators.functionCallAccessKey(LAUNCHPAD, QUICK_METHODS, ALLOWANCE))] })
  }
  if (deposit > 0n) calls.push({ receiver: LAUNCHPAD, method: 'deposit_trade', args: {}, deposit, tgas: 30 })
  // Keep the key before the wallet opens: a redirecting wallet reloads the page.
  memory[account] = kp.toString()
  save({ ...stored(), [account]: kp.toString() })
  try {
    await callMany(calls)
  } catch (e) {
    if (!have) forget(account)
    throw e
  }
}

interface Outcome { status: { SuccessValue?: string; Failure?: unknown }; receipts_outcome: { outcome: { status: { Failure?: unknown } } }[] }

/** Signs one launchpad call with the quick key and waits until it has run. */
export async function quickCall(account: string, method: 'quick_buy' | 'quick_sell', args: object, tgas = 200): Promise<void> {
  const kp = await quickKey(account)
  if (!kp) throw new Error('Quick trading is off in this browser. Turn it on in the wallet menu.')
  const pk = kp.getPublicKey()
  const ak = await rpc<AccessKeyView>('query', { request_type: 'view_access_key', finality: 'final', account_id: account, public_key: pk.toString() })
  const tx = createTransaction(account, pk, LAUNCHPAD, BigInt(ak.nonce) + 1n, [actionCreators.functionCall(method, args, BigInt(tgas) * TGAS, 0n)], baseDecode(ak.block_hash))
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', tx.encode() as BufferSource))
  const sig = kp.sign(hash)
  const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: pk.keyType, data: sig.signature }) })
  const b64 = btoa(String.fromCharCode(...signed.encode()))
  const out = await rpc<Outcome>('send_tx', { signed_tx_base64: b64, wait_until: 'EXECUTED_OPTIMISTIC' })
  if (out.status.Failure) throw new Error(failureText(out.status.Failure))
  // A sale that misses its price limit fails inside the launchpad and the coins come back: say so.
  const inner = out.receipts_outcome.find((r) => r.outcome.status.Failure)
  if (inner) throw new Error(failureText(inner.outcome.status.Failure))
}
