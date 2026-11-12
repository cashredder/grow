// Transactions the API sends: one queue, processed by the clock one at a time per signer so nonces never
// collide. The relayer only holds a function-call key for the launchpad (it can trade vaults within their
// on-chain limits and run maintenance, never move funds); the house funder can open house gardeners.
import type { Env } from '../env'
import { sendCalls } from '../near/rpc'
import { parseKey } from '../near/tx'

export type Signer = 'relayer' | 'house'

const TGAS = 1_000_000_000_000n

export async function enqueue(env: Env, signer: Signer, method: string, args: unknown, opts: { dedupe?: string; deposit?: string; tgas?: number } = {}): Promise<number | null> {
  const now = Date.now()
  const r = await env.DB.prepare('INSERT OR IGNORE INTO jobs (signer, method, args, deposit, gas, dedupe, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
    .bind(signer, method, JSON.stringify(args), opts.deposit ?? '0', (BigInt(opts.tgas ?? 100) * TGAS).toString(), opts.dedupe ?? null, now, now)
    .first<{ id: number }>()
  return r?.id ?? null
}

const MAX_ATTEMPTS = 3

/** Sends up to `max` queued jobs. Returns how many were sent. */
export async function processJobs(env: Env, max = 6): Promise<number> {
  const r = await env.DB.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id ASC LIMIT ?").bind(max).all<{
    id: number
    signer: Signer
    method: string
    args: string
    deposit: string
    gas: string
    attempts: number
  }>()
  let sent = 0
  const nonces: Partial<Record<Signer, bigint>> = {}
  for (const job of r.results) {
    const keyText = job.signer === 'house' ? env.HOUSE_FUNDER_KEY : env.RELAYER_KEY
    const account = job.signer === 'house' ? env.HOUSE_FUNDER : env.RELAYER
    if (!keyText || !account) {
      await env.DB.prepare("UPDATE jobs SET status = 'failed', error = 'no key for this signer', updated = ? WHERE id = ?").bind(Date.now(), job.id).run()
      continue
    }
    await env.DB.prepare("UPDATE jobs SET status = 'sending', attempts = attempts + 1, updated = ? WHERE id = ?").bind(Date.now(), job.id).run()
    try {
      const out = await sendCalls(env, parseKey(keyText), account, env.LAUNCHPAD, [{ method: job.method, args: JSON.parse(job.args), gas: BigInt(job.gas), deposit: BigInt(job.deposit) }], nonces[job.signer])
      nonces[job.signer] = out.nonce + 1n
      await env.DB.prepare('UPDATE jobs SET status = ?, tx_hash = ?, error = ?, updated = ? WHERE id = ?').bind(out.ok ? 'done' : 'failed', out.hash, out.error ?? null, Date.now(), job.id).run()
      sent++
    } catch (e) {
      const msg = String((e as Error).message || e).slice(0, 500)
      const retry = job.attempts + 1 < MAX_ATTEMPTS && !/InvalidTx|does not exist|panicked/i.test(msg)
      await env.DB.prepare('UPDATE jobs SET status = ?, error = ?, updated = ? WHERE id = ?').bind(retry ? 'queued' : 'failed', msg, Date.now(), job.id).run()
    }
  }
  // Jobs stuck in "sending" after a crash go back to the queue once; old finished jobs are swept.
  await env.DB.batch([
    env.DB.prepare("UPDATE jobs SET status = 'queued' WHERE status = 'sending' AND updated < ? AND attempts < ?").bind(Date.now() - 120_000, MAX_ATTEMPTS),
    env.DB.prepare("DELETE FROM jobs WHERE status IN ('done', 'failed') AND updated < ?").bind(Date.now() - 7 * 86_400_000),
  ])
  return sent
}
