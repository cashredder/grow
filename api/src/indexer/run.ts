import type { Env } from '../env'
import { applyEvents, type Applied } from './apply'
import { type ChainEvent, extractEvents, type NeardataBlock } from './events'
import { fillMeta } from './meta'
import { readAccounts, TOKENS_PER_RUN } from './txsource'

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
  if (env.TX_API_URL) return runByAccounts(env)
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

/** The per-account way (see txsource.ts): the launchpad every run, and a few token accounts in turn. */
const TOKENS_EVERY_MS = 10_000 // token accounts (transfers between holders) are read less often
const PAUSE_MS = 10_000 // after the transaction API refuses a request

async function runByAccounts(env: Env): Promise<Applied & { height: number; behind: number }> {
  const now = Date.now()
  const lpCursor0 = Number((await getState(env, 'block')) ?? (Number(env.START_BLOCK) || 0))
  if (Number((await getState(env, 'pause_until')) ?? 0) > now) return { count: 0, feed: [], height: lpCursor0, behind: 0 }
  try {
    return await readByAccounts(env, now)
  } catch (e) {
    if (/HTTP 429/.test(String((e as Error).message))) await setState(env, 'pause_until', String(now + PAUSE_MS))
    throw e
  }
}

async function readByAccounts(env: Env, now: number): Promise<Applied & { height: number; behind: number }> {
  const start = Number(env.START_BLOCK) || 0
  const lpCursor = Number((await getState(env, 'block')) ?? start)
  const turn = Number((await getState(env, 'token_turn')) ?? 0)
  const tokensDue = Number((await getState(env, 'tokens_at')) ?? 0) + TOKENS_EVERY_MS <= now
  const toks = tokensDue
    ? await env.DB.prepare('SELECT account FROM tokens ORDER BY created_ts LIMIT ? OFFSET ?').bind(TOKENS_PER_RUN, turn).all<{ account: string }>().catch(() => ({ results: [] as { account: string }[] }))
    : { results: [] as { account: string }[] }
  const accounts = [{ account: env.LAUNCHPAD, cursor: lpCursor }]
  for (const k of toks.results) accounts.push({ account: k.account, cursor: Number((await getState(env, `acct:${k.account}`)) ?? start) })
  const r = await readAccounts(env, accounts)
  const events: ChainEvent[] = []
  for (const b of r.blocks) events.push(...extractEvents(b, env.LAUNCHPAD))
  const all = await applyEvents(env, events)
  // Move each cursor only if nobody changed it meanwhile (an admin reset during this run wins).
  const before = new Map(accounts.map((a) => [a.account, a.cursor]))
  for (const [acct, c] of r.cursors) {
    const key = acct === env.LAUNCHPAD ? 'block' : `acct:${acct}`
    const was = String(before.get(acct))
    await env.DB.prepare('INSERT INTO ix_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE ix_state.value = ?').bind(key, String(c), was).run()
  }
  if (tokensDue) {
    await setState(env, 'token_turn', String(toks.results.length < TOKENS_PER_RUN ? 0 : turn + TOKENS_PER_RUN))
    await setState(env, 'tokens_at', String(now))
  }
  await setState(env, 'indexed_at', String(Date.now()))
  if (all.count) await fillMeta(env).catch(() => {})
  const height = r.cursors.find(([a]) => a === env.LAUNCHPAD)?.[1] ?? lpCursor
  return { ...all, height, behind: r.tip - height }
}
