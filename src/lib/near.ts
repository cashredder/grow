// NEAR access for the site: read-only RPC views, and the wallet (NEAR Wallet Selector) for signing.
import './node-globals'
import { Buffer } from 'buffer'
import { actionCreators, type Action } from '@near-js/transactions'
import { setupWalletSelector, type WalletSelector } from '@near-wallet-selector/core'
import { setupHotWallet } from '@near-wallet-selector/hot-wallet'
import { setupIntearWallet } from '@near-wallet-selector/intear-wallet'
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet'
import { NETWORK } from './config'
import { TGAS, failureText } from './chain'

let selector: Promise<WalletSelector> | null = null
export function wallets(): Promise<WalletSelector> {
  selector ??= setupWalletSelector({
    network: NETWORK,
    modules: [setupHotWallet(), setupMeteorWallet(), setupIntearWallet()],
  })
  return selector
}

/** Whether an account belongs to the network the site runs on. Some wallets hand back a mainnet account
 * even when asked for testnet; implicit (hex) accounts exist on both. */
export function onNetwork(account: string): boolean {
  if (/^[0-9a-f]{64}$/.test(account) || /^0x[0-9a-f]{40}$/.test(account)) return true
  return NETWORK === 'testnet' ? account.endsWith('.testnet') : !account.endsWith('.testnet')
}

export const wrongNetwork = (account: string) =>
  `${account} is a ${NETWORK === 'testnet' ? 'mainnet' : 'testnet'} account. This site runs on ${NETWORK}: pick a ${NETWORK} account in your wallet${NETWORK === 'testnet' ? ' (it ends in .testnet)' : ''}.`

export async function signedInAccount(): Promise<string | null> {
  const s = await wallets()
  const id = s.store.getState().accounts.find((a) => a.active)?.accountId ?? null
  if (id && !onNetwork(id)) {
    await signOut().catch(() => {})
    return null
  }
  return id
}

export async function signIn(walletId: string): Promise<string | null> {
  const s = await wallets()
  const w = await s.wallet(walletId)
  // No contractId: then wallets do not add an access key for the site, which costs a transaction (and fails on
  // an empty account). The site needs none: every trade is approved in the wallet.
  const accounts = await (w.signIn as (p: { methodNames: string[] }) => Promise<{ accountId: string }[]>)({ methodNames: [] })
  const id = accounts?.[0]?.accountId ?? s.store.getState().accounts.find((a) => a.active)?.accountId ?? null
  if (id && !onNetwork(id)) {
    await signOut().catch(() => {})
    throw new Error(wrongNetwork(id))
  }
  return id
}

export async function signOut(): Promise<void> {
  const s = await wallets()
  if (!s.isSignedIn()) return
  await (await s.wallet()).signOut()
}

export interface Call {
  receiver: string
  method?: string
  args?: object
  deposit?: bigint
  tgas?: number
  /** Ready actions instead of one function call (adding a key). */
  raw?: Action[]
}

const toActions = (c: Call): Action[] => c.raw ?? [actionCreators.functionCall(c.method!, c.args ?? {}, BigInt(c.tgas ?? 100) * TGAS, c.deposit ?? 0n)]

/** Signs and sends one call. Returns the method's return value when the wallet hands the outcome back. */
export async function call(c: Call): Promise<unknown> {
  const w = await (await wallets()).wallet()
  const out = await w.signAndSendTransaction({ receiverId: c.receiver, actions: toActions(c) })
  return outcomeValue(out)
}

/** Several transactions in one wallet approval (in order). */
export async function callMany(calls: Call[]): Promise<void> {
  const w = await (await wallets()).wallet()
  await w.signAndSendTransactions({ transactions: calls.map((c) => ({ receiverId: c.receiver, actions: toActions(c) })) })
}

function outcomeValue(out: unknown): unknown {
  const status = (out as { status?: { SuccessValue?: string; Failure?: unknown } } | undefined)?.status
  if (!status) return undefined
  if (status.Failure) throw new Error(failureText(status.Failure))
  if (!status.SuccessValue) return undefined
  try {
    return JSON.parse(atob(status.SuccessValue))
  } catch {
    return undefined
  }
}

export async function signMessage(message: string, nonce: Uint8Array, recipient: string): Promise<{ accountId: string; publicKey: string; signature: string } | null> {
  const w = await (await wallets()).wallet()
  if (!w.signMessage) return null
  const r = await w.signMessage({ message, nonce: Buffer.from(nonce), recipient, callbackUrl: location.href })
  return r ? { accountId: r.accountId, publicKey: r.publicKey, signature: r.signature } : null
}
