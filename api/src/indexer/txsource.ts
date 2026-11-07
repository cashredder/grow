// A second way to read events: FastNEAR's per-account transaction API (tx.<net>.fastnear.com) instead of every
// block from neardata. Far fewer requests (one per watched account per run), which matters because neardata
// limits requests from shared Cloudflare addresses. Used when TX_API_URL is set.
//
// Each watched account (the launchpad, plus its tokens in turn) has a block cursor. A run takes the
// transactions between the cursor and a few blocks behind the final tip, so every receipt has executed, and
// turns their receipts into the same block shape extractEvents reads. Events are stored by receipt, so reading
// a transaction twice (it touches the launchpad and a token) is harmless.
import type { Env } from '../env'
import { finalHeight } from '../near/rpc'
import type { NeardataBlock } from './events'

const LAG = 8 // blocks behind final, so a transaction's later receipts have run
const PAGE = 100
const TOKENS_PER_RUN = 4

interface AccountTx { transaction_hash: string; tx_block_height: number }
interface TxReceipt {
  receipt: { receipt_id: string; predecessor_id: string; receiver_id: string }
  execution_outcome: { id: string; block_height: number; block_timestamp: number | string; block_hash: string; outcome: { executor_id: string; logs: string[]; status: Record<string, unknown> } }
}
interface TxDetail { transaction: { hash: string }; receipts: TxReceipt[] }

async function post<T>(env: Env, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${env.TX_API_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`tx api ${path}: HTTP ${res.status}`)
  return (await res.json()) as T
}

export interface TxSourceResult { blocks: NeardataBlock[]; cursors: [string, number][]; safe: number; tip: number }

/** Reads new transactions of the given accounts. `cursors` holds each account's last finished block. */
export async function readAccounts(env: Env, accounts: { account: string; cursor: number }[]): Promise<TxSourceResult> {
  const tip = await finalHeight(env)
  const safe = tip - LAG
  const hashes = new Set<string>()
  const cursors: [string, number][] = []
  for (const a of accounts) {
    if (a.cursor >= safe) continue
    const r = await post<{ account_txs: AccountTx[] }>(env, '/v0/account', { account_id: a.account, from_tx_block_height: a.cursor + 1, to_tx_block_height: safe, desc: false, limit: PAGE })
    const txs = r.account_txs ?? []
    for (const t of txs) hashes.add(t.transaction_hash)
    // A full page may stop inside a block: go on from that block next time (seen receipts are skipped).
    cursors.push([a.account, txs.length >= PAGE ? txs[txs.length - 1].tx_block_height - 1 : safe])
  }
  const list = [...hashes]
  const byBlock = new Map<number, NeardataBlock>()
  const seenReceipts = new Set<string>()
  for (let i = 0; i < list.length; i += 20) {
    const d = await post<{ transactions: (TxDetail | null)[] }>(env, '/v0/transactions', { tx_hashes: list.slice(i, i + 20) })
    for (const tx of d.transactions ?? []) {
      if (!tx) continue
      for (const r of tx.receipts ?? []) {
        const eo = r.execution_outcome
        if (!eo || seenReceipts.has(eo.id)) continue
        seenReceipts.add(eo.id)
        let b = byBlock.get(eo.block_height)
        if (!b) {
          b = { block: { header: { height: eo.block_height, timestamp: 0, timestamp_nanosec: String(eo.block_timestamp), hash: eo.block_hash } }, shards: [{ shard_id: 0, receipt_execution_outcomes: [] }] }
          byBlock.set(eo.block_height, b)
        }
        b.shards[0].receipt_execution_outcomes.push({ tx_hash: tx.transaction.hash, receipt: r.receipt, execution_outcome: { id: eo.id, outcome: eo.outcome } })
      }
    }
  }
  const blocks = [...byBlock.values()].sort((x, y) => x.block.header.height - y.block.header.height)
  return { blocks, cursors, safe, tip }
}

export { TOKENS_PER_RUN }
