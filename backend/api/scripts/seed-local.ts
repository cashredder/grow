/// <reference types="node" />
// Fills the LOCAL dev database (the one `wrangler dev` uses) with contract events made with the real curve
// maths, so the site can be tried against the API before the contracts are on testnet.
//   npx vitest run -c vitest.seed.config.ts
// Never point this at a remote database: it writes made-up activity.
import { readFileSync } from 'node:fs'
import { it } from 'vitest'
import { getPlatformProxy } from 'wrangler'
import type { Env } from '../src/env'
import { applyEvents } from '../src/indexer/apply'
import type { ChainEvent } from '../src/indexer/events'
import { CURVE_END_TOKENS, SUPPLY, TOKEN_UNIT, VIRTUAL_NEAR, VIRTUAL_TOKENS, YOCTO } from '../src/lib/units'

const LP = 'grow.testnet'
const POOL_TOKENS = 207_000_000n * TOKEN_UNIT
let n = 0
const ev = (contract: string, standard: string, event: string, data: Record<string, unknown>, ts: number): ChainEvent => ({ receipt: `seed${++n}`, idx: 0, block: Math.floor(ts / 1000), ts, contract, standard, event, data })
const yocto = (near: number) => BigInt(Math.round(near * 1e6)) * (YOCTO / 1_000_000n)

interface Market { near: bigint; tok: bigint; phase: 'Curve' | 'Pool'; holders: Map<string, bigint> }

it('seeds the local database', async () => {
  // GROW_PERSIST: the folder `wrangler dev --persist-to` uses (short on Windows, where long paths fail).
  const proxy = await getPlatformProxy({ configPath: 'wrangler.toml', persist: process.env.GROW_PERSIST ? { path: process.env.GROW_PERSIST } : true })
  const env = { ...(proxy.env as unknown as Env), LAUNCHPAD: LP }
  const sql = readFileSync('schema.sql', 'utf8').replace(/--.*$/gm, '')
  for (const s of sql.split(';').map((x: string) => x.trim()).filter(Boolean)) await env.DB.prepare(s).run()
  for (const t of ['events', 'tokens', 'trades', 'balances', 'vaults', 'vault_log', 'vault_equity', 'comments', 'profiles']) await env.DB.prepare(`DELETE FROM ${t}`).run()

  const now = Date.now()
  const traders = ['oak.testnet', 'fern.testnet', 'lime.testnet', 'rain.testnet', 'bark.testnet', 'moss.testnet', 'dew.testnet', 'seed.testnet', 'root.testnet', 'twig.testnet']
  const defs: [string, string, string, number][] = [
    ['Old Oak', 'OAK', 'The first big tree in the forest.', 3900], ['Moss', 'MOSS', 'Slow, soft, and everywhere.', 900], ['Acorn', 'ACORN', 'Small coin. Big plans.', 420],
    ['Clover', 'CLVR', 'Four leaves, one chart.', 160], ['Willow', 'WILO', 'Bends and never breaks.', 60], ['Sapling', 'SAPL', 'Just planted this morning.', 12],
  ]
  const events: ChainEvent[] = []
  defs.forEach(([name, ticker, desc, spend], i) => {
    const id = `${ticker.toLowerCase()}-${i + 1}`
    const account = `${id}.${LP}`
    const created = now - (6 - i) * 86_400_000
    const creator = traders[i]
    events.push(ev(LP, 'grow', 'token_created', { token_id: id, account, name, ticker, creator, fee_bps: 100, redirect_pct: 0, redirect_to: 'holders', dev_vault: null, near_reserve: VIRTUAL_NEAR.toString(), tok_reserve: VIRTUAL_TOKENS.toString(), description: desc }, created))
    events.push(ev(account, 'nep141', 'ft_mint', { owner_id: LP, amount: SUPPLY.toString() }, created))
    const m: Market = { near: VIRTUAL_NEAR, tok: VIRTUAL_TOKENS, phase: 'Curve', holders: new Map() }
    const steps = 80
    for (let k = 0; k < steps; k++) {
      const ts = created + ((now - created) * (k + 1)) / (steps + 1)
      const who = traders[(k * 7 + i) % traders.length]
      const held = m.holders.get(who) ?? 0n
      const sellNow = held > 0n && k % 3 === 2
      if (!sellNow) {
        const amount = yocto((spend / steps) * (0.6 + ((k * 13) % 10) / 10))
        const fee = amount / 100n
        let net = amount - fee
        let out = (m.tok * net) / (m.near + net)
        let grad = false
        if (m.phase === 'Curve' && m.tok - out <= CURVE_END_TOKENS) {
          out = m.tok - CURVE_END_TOKENS
          net = (m.near * out) / (m.tok - out)
          grad = true
        }
        m.near += net
        m.tok -= out
        m.holders.set(who, held + out)
        if (grad) {
          m.near -= VIRTUAL_NEAR
          m.tok = POOL_TOKENS
          m.phase = 'Pool'
        }
        events.push(ev(LP, 'grow', 'trade', { token_id: id, account_id: who, side: 'buy', near: amount.toString(), tokens: out.toString(), fee: fee.toString(), rate_bps: 100, near_reserve: m.near.toString(), tok_reserve: m.tok.toString(), burned: '0', phase: m.phase, vault_id: null }, ts))
        events.push(ev(LP, 'grow', 'fees', { token_id: id, dev: ((fee * 30n) / 100n).toString(), holders: (fee / 10n).toString(), buyback: '0', referrer: '0', referrer_id: null, platform: ((fee * 60n) / 100n).toString(), to_vault: null }, ts))
        events.push(ev(account, 'nep141', 'ft_transfer', { old_owner_id: LP, new_owner_id: who, amount: out.toString() }, ts))
        if (grad) events.push(ev(LP, 'grow', 'graduated', { token_id: id, pool_near: m.near.toString(), pool_tokens: m.tok.toString() }, ts))
      } else {
        const amount = held / 2n
        const gross = (m.near * amount) / (m.tok + amount)
        const fee = gross / 100n
        m.near -= gross
        m.tok += amount
        m.holders.set(who, held - amount)
        events.push(ev(LP, 'grow', 'trade', { token_id: id, account_id: who, side: 'sell', near: (gross - fee).toString(), tokens: amount.toString(), fee: fee.toString(), rate_bps: 100, near_reserve: m.near.toString(), tok_reserve: m.tok.toString(), burned: '0', phase: m.phase, vault_id: null }, ts))
        events.push(ev(account, 'nep141', 'ft_transfer', { old_owner_id: who, new_owner_id: LP, amount: amount.toString() }, ts))
      }
    }
  })
  const house: [string, string][] = [['Rowan', 'steady'], ['Hazel', 'dip'], ['Sage', 'exit'], ['Bram', 'trend'], ['Linden', 'grad']]
  house.forEach(([name, strategy], i) => {
    const ts = now - 20 * 86_400_000
    events.push(ev(LP, 'grow', 'vault_created', { vault_id: i + 1, kind: 'House', owner: 'house.grow.testnet', agent: 'relayer.grow.testnet', name, strategy, budget: yocto(1000).toString(), fire_bps: 3000, daily_limit: yocto(300).toString(), allowed: 'All', expires_ms: 0, leader: null, per_trade: '0' }, ts))
    for (let d = 0; d < 20; d++) {
      const equity = 1000 * (1 + (i - 1.5) * 0.012 * d + Math.sin(d + i) * 0.03)
      events.push(ev(LP, 'grow', 'vault_equity', { vault_id: i + 1, equity: yocto(equity).toString(), peak: yocto(Math.max(1000, equity * 1.02)).toString(), cash: yocto(equity * 0.6).toString() }, ts + d * 86_400_000))
    }
    events.push(ev(LP, 'grow', 'vault_trade', { vault_id: i + 1, kind: 'House', token_id: 'oak-1', side: 'buy', near: yocto(40).toString(), tokens: (3_000_000n * TOKEN_UNIT).toString(), note: 'Volume and buyers are rising on $OAK', copied_from: null, leader_seq: null, seq: 1 }, now - 3_600_000))
  })
  // Apply in block order, a few hundred at a time, like the indexer does.
  events.sort((a, b) => a.ts - b.ts)
  for (let i = 0; i < events.length; i += 200) await applyEvents(env, events.slice(i, i + 200))
  await env.DB.prepare("INSERT INTO comments (token_id, account, text, ts) VALUES ('oak-1', 'fern.testnet', 'Who else is in since the sprout?', ?), ('oak-1', 'lime.testnet', 'Almost at the pool.', ?)").bind(now - 600_000, now - 300_000).run()
  const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM tokens').first<{ n: number }>()
  console.log(`seeded ${events.length} events, ${c?.n} tokens`)
  await proxy.dispose()
}, 120_000)
