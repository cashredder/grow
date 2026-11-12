// Reads grow. events out of a neardata.xyz block (https://github.com/fastnear/neardata-server).
export interface NeardataBlock {
  block: { header: { height: number; timestamp: number | string; timestamp_nanosec?: string; hash: string } }
  shards: {
    shard_id: number
    receipt_execution_outcomes: {
      tx_hash?: string
      receipt: { receipt_id: string; predecessor_id: string; receiver_id: string }
      execution_outcome: { id: string; outcome: { executor_id: string; logs: string[]; status: Record<string, unknown> } }
    }[]
  }[]
}

export interface ChainEvent {
  receipt: string
  idx: number
  block: number
  ts: number
  contract: string
  standard: string
  event: string
  data: Record<string, unknown>
  tx?: string
}

/** Events from successful receipts of the launchpad and its token sub-accounts, in execution order. */
export function extractEvents(b: NeardataBlock, launchpad: string): ChainEvent[] {
  const out: ChainEvent[] = []
  const height = b.block.header.height
  const ns = b.block.header.timestamp_nanosec ?? String(b.block.header.timestamp)
  const ts = Number(BigInt(ns) / 1_000_000n)
  const suffix = `.${launchpad}`
  for (const shard of b.shards) {
    for (const r of shard.receipt_execution_outcomes) {
      const o = r.execution_outcome.outcome
      const ex = o.executor_id
      if (ex !== launchpad && !ex.endsWith(suffix)) continue
      // A failed receipt's state changes are reverted, so its logs describe nothing that happened.
      if ('Failure' in o.status) continue
      o.logs.forEach((log, i) => {
        if (!log.startsWith('EVENT_JSON:')) return
        let j: { standard?: string; event?: string; data?: unknown }
        try {
          j = JSON.parse(log.slice('EVENT_JSON:'.length))
        } catch {
          return
        }
        if (!j.standard || !j.event || !Array.isArray(j.data)) return
        // Only the launchpad may speak for "grow"; tokens may only speak NEP-141 and for themselves.
        if (j.standard === 'grow' && ex !== launchpad) return
        if ((j.standard === 'nep141' || j.standard === 'grow-token') && ex === launchpad) return
        j.data.forEach((d, k) => {
          if (d && typeof d === 'object') out.push({ receipt: r.execution_outcome.id, idx: i * 100 + k, block: height, ts, contract: ex, standard: j.standard!, event: j.event!, data: d as Record<string, unknown>, tx: r.tx_hash })
        })
      })
    }
  }
  return out
}
