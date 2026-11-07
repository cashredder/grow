import type { Env } from '../env'
import { applyEvents, type Applied } from './apply'
import { type ChainEvent, extractEvents, type NeardataBlock } from './events'
import { fillMeta } from './meta'

const BATCH = 8 // blocks fetched in parallel per step
const MAX_STEPS = 6 // steps per run; the clock runs again a moment later

async function getState(env: Env, key: string): Promise<string | null> {
  const r = await env.DB.prepare('SELECT value FROM ix_state WHERE key = ?').bind(key).first<{ value: string }>()
  return r?.value ?? null
}

export const setState = (env: Env, key: string, value: string) =>
  env.DB.prepare('INSERT INTO ix_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').bind(key, value).run()

async function fetchBlock(env: Env, height: number): Promise<NeardataBlock | null> {
  const res = await fetch(`${env.NEARDATA_URL}/v0/block/${height}`, { headers: { Accept: 'application/json' } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`neardata ${height}: HTTP ${res.status}`)
  const text = await res.text()
  // Skipped heights (no block produced) come back as `null`.
  if (text === 'null' || !text) return null
  return JSON.parse(text) as NeardataBlock
}

async function lastFinal(env: Env): Promise<number> {
  const res = await fetch(`${env.NEARDATA_URL}/v0/last_block/final`, { headers: { Accept: 'application/json' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`neardata last block: HTTP ${res.status}`)
  const b = (await res.json()) as NeardataBlock
  return b.block.header.height
}

/** Reads new blocks and applies their events. Returns what changed, for the live feed. */
export async function runIndexer(env: Env): Promise<Applied & { height: number; behind: number }> {
  let cursor = Number((await getState(env, 'block')) ?? env.START_BLOCK)
  const tip = await lastFinal(env)
  if (!cursor) cursor = tip - 1
  const all: Applied = { count: 0, feed: [] }
  for (let step = 0; step < MAX_STEPS && cursor < tip; step++) {
    const heights = Array.from({ length: Math.min(BATCH, tip - cursor) }, (_, i) => cursor + 1 + i)
    const blocks = await Promise.all(heights.map((h) => fetchBlock(env, h)))
    const events: ChainEvent[] = []
    for (const b of blocks) if (b) events.push(...extractEvents(b, env.LAUNCHPAD))
    const r = await applyEvents(env, events)
    all.count += r.count
    all.feed.push(...r.feed)
    cursor = heights[heights.length - 1]
    await setState(env, 'block', String(cursor))
  }
  await setState(env, 'indexed_at', String(Date.now()))
  if (all.count) await fillMeta(env).catch(() => {})
  return { ...all, height: cursor, behind: tip - cursor }
}
