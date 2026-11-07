/// <reference types="node" />
// End-to-end against a real local D1 (via wrangler's platform proxy): contract events in, API answers out.
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { getPlatformProxy } from 'wrangler'
import type { Env } from '../src/env'
import { applyEvents } from '../src/indexer/apply'
import type { ChainEvent } from '../src/indexer/events'
import { handleV1 } from '../src/routes/v1'
import { runKeeper } from '../src/agents/runner'
import { VIRTUAL_NEAR, VIRTUAL_TOKENS, SUPPLY, YOCTO, TOKEN_UNIT } from '../src/lib/units'

let proxy: Awaited<ReturnType<typeof getPlatformProxy>>
let env: Env
const LP = 'grow.testnet'
const T0 = 1_800_000_000_000
let seq = 0

const g = (event: string, data: Record<string, unknown>, ts = T0, block = 1): ChainEvent => ({ receipt: `r${++seq}`, idx: 0, block, ts, contract: LP, standard: 'grow', event, data })
const ft = (token: string, event: string, data: Record<string, unknown>, ts = T0, block = 1): ChainEvent => ({ receipt: `r${++seq}`, idx: 0, block, ts, contract: `${token}.${LP}`, standard: 'nep141', event, data })
const near = (n: number) => (BigInt(Math.round(n * 1e6)) * (YOCTO / 1_000_000n)).toString()
const toks = (n: number) => (BigInt(Math.round(n)) * TOKEN_UNIT).toString()

async function get(path: string) {
  const res = await handleV1(new Request(`http://x${path}`), env, new URL(`http://x${path}`))
  return (await res.json()) as Record<string, any>
}

beforeAll(async () => {
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 }))
  proxy = await getPlatformProxy({ configPath: 'wrangler.toml', persist: false })
  env = { ...(proxy.env as unknown as Env), LAUNCHPAD: LP, NEAR_USD_FALLBACK: '2.5' }
  const sql = readFileSync('schema.sql', 'utf8').replace(/--.*$/gm, '')
  for (const stmt of sql.split(';').map((s: string) => s.trim()).filter(Boolean)) await env.DB.prepare(stmt).run()
}, 60_000)

afterAll(async () => {
  await proxy?.dispose()
})

describe('indexing and reading', () => {
  it('builds tokens, holders, trades and candles from events', async () => {
    const reserveAfter = (VIRTUAL_TOKENS - 30_000_000n * TOKEN_UNIT).toString()
    const nearAfter = (VIRTUAL_NEAR + 40n * YOCTO).toString()
    const events: ChainEvent[] = [
      g('token_created', { token_id: 'oak-1', account: `oak-1.${LP}`, name: 'Old Oak', ticker: 'OAK', creator: 'dev.testnet', fee_bps: 100, redirect_pct: 0, redirect_to: 'holders', dev_vault: null, near_reserve: VIRTUAL_NEAR.toString(), tok_reserve: VIRTUAL_TOKENS.toString() }),
      ft('oak-1', 'ft_mint', { owner_id: LP, amount: SUPPLY.toString() }),
      g('trade', { token_id: 'oak-1', account_id: 'alice.testnet', side: 'buy', near: near(40), tokens: toks(30_000_000), fee: near(0.4), rate_bps: 100, price_e18: '0', near_reserve: nearAfter, tok_reserve: reserveAfter, burned: '0', phase: 'Curve', referrer: 'ref.testnet', vault_id: null }, T0 + 1_000, 2),
      g('fees', { token_id: 'oak-1', dev: near(0.12), holders: near(0.04), buyback: '0', referrer: near(0.024), referrer_id: 'ref.testnet', platform: near(0.216), to_vault: null }, T0 + 1_000, 2),
      ft('oak-1', 'ft_transfer', { old_owner_id: LP, new_owner_id: 'alice.testnet', amount: toks(30_000_000) }, T0 + 1_000, 2),
      g('referral', { account_id: 'alice.testnet', referrer: 'ref.testnet' }, T0 + 1_000, 2),
    ]
    const r = await applyEvents(env, events)
    expect(r.count).toBe(events.length)
    // Applying the same block again changes nothing.
    expect((await applyEvents(env, events)).count).toBe(0)

    const list = await get('/v1/tokens?tab=new')
    expect(list.tokens).toHaveLength(1)
    const t = list.tokens[0]
    expect(t.ticker).toBe('OAK')
    expect(t.holders).toBe(1)
    expect(t.trades).toBe(1)
    expect(t.progress).toBeGreaterThan(0.03)
    expect(t.price).toBeCloseTo(1240 / 1.043e9, 12)

    const holders = await get('/v1/tokens/oak-1/holders')
    expect(holders.holders).toEqual([expect.objectContaining({ account: 'alice.testnet', balance: 30_000_000 })])

    const c = await get('/v1/tokens/oak-1/candles?tf=1m')
    expect(c.candles).toHaveLength(1)

    const one = await get('/v1/tokens/oak-1')
    expect(one.token.risk).toMatchObject({ holders: 1, snipers: 1 })
    expect(one.token.dev_fees).toBeCloseTo(0.12, 6)

    const lb = await get('/v1/leaderboard?tab=traders')
    expect(lb.traders[0].account).toBe('alice.testnet')
  })

  it('mirrors gardeners and lists ours first', async () => {
    await applyEvents(env, [
      g('vault_created', { vault_id: 1, kind: 'House', owner: 'house.testnet', agent: 'relayer.testnet', name: 'Linden', strategy: 'trend', budget: near(100), fire_bps: 3000, daily_limit: near(50), allowed: 'All', expires_ms: 0, leader: null, per_trade: '0' }, T0, 3),
      g('vault_created', { vault_id: 2, kind: 'User', owner: 'bob.testnet', agent: 'relayer.testnet', name: 'Mine', strategy: 'dip', budget: near(10), fire_bps: 2000, daily_limit: near(5), allowed: 'All', expires_ms: 0, leader: null, per_trade: '0' }, T0, 3),
      g('vault_created', { vault_id: 3, kind: 'Copy', owner: 'carol.testnet', agent: 'relayer.testnet', name: 'Copy of Linden', strategy: 'trend', budget: near(20), fire_bps: 3000, daily_limit: near(1e9), allowed: 'All', expires_ms: 0, leader: 1, per_trade: near(5) }, T0, 3),
      g('vault_trade', { vault_id: 1, kind: 'House', token_id: 'oak-1', side: 'buy', near: near(10), tokens: toks(5_000_000), note: 'Volume is rising', copied_from: null, leader_seq: null, seq: 1 }, T0 + 5_000, 4),
      g('vault_equity', { vault_id: 1, equity: near(99), peak: near(100), cash: near(90) }, T0 + 5_000, 4),
    ])
    const list = await get('/v1/gardeners')
    expect(list.gardeners.map((x: { name: string }) => x.name)).toEqual(['Linden', 'Mine'])
    expect(list.gardeners[0].copiers).toBe(1)
    const one = await get('/v1/gardeners/1')
    expect(one.log[0]).toMatchObject({ side: 'buy', note: 'Volume is rising', ticker: 'OAK' })
    expect(one.gardener.positions).toEqual([{ token_id: 'oak-1', amount: toks(5_000_000) }])
  })

  it('a crossing replaces two tokens with one', async () => {
    await applyEvents(env, [
      g('token_created', { token_id: 'moss-2', account: `moss-2.${LP}`, name: 'Moss', ticker: 'MOSS', creator: 'ben.testnet', fee_bps: 100, near_reserve: VIRTUAL_NEAR.toString(), tok_reserve: VIRTUAL_TOKENS.toString() }, T0, 5),
      g('cross_proposed', { cross_id: 1, a: 'oak-1', b: 'moss-2', proposer: 'dev.testnet', partner: 'ben.testnet', split_bps: 6000, name: 'Oak Moss', ticker: 'OMOSS' }, T0, 5),
      g('cross_accepted', { cross_id: 1, ends_ms: T0 + 1000 }, T0, 6),
      g('cross_done', { cross_id: 1, a: 'oak-1', b: 'moss-2', token_id: 'omoss-3', account: `omoss-3.${LP}`, rate_a: '1', rate_b: '1', price_e18: '1', pool_near: near(40), pool_tokens: toks(900_000_000), creator: 'dev.testnet', co_dev: 'ben.testnet', split_bps: 6000 }, T0 + 2_000, 7),
    ])
    const list = await get('/v1/tokens?tab=top')
    expect(list.tokens.map((x: { ticker: string }) => x.ticker)).toEqual(['OMOSS'])
    expect(list.tokens[0].parents).toEqual(['Old Oak', 'Moss'])
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE text LIKE '%became $OMOSS%'").first<{ n: number }>()
    expect(n?.n).toBe(2)
  })

  it('the keeper queues reward pushes and fires vaults past their limit', async () => {
    await env.DB.prepare("UPDATE tokens SET holder_pending = 0.5 WHERE id = 'omoss-3'").run()
    await env.DB.prepare("UPDATE vaults SET peak = 1000 WHERE id = 2").run()
    await runKeeper(env)
    const jobs = await env.DB.prepare('SELECT method, args FROM jobs ORDER BY id').all<{ method: string; args: string }>()
    expect(jobs.results.map((j) => j.method)).toEqual(expect.arrayContaining(['push_rewards', 'check_vault']))
  })
})
