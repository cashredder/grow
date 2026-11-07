import { describe, expect, it } from 'vitest'
import { extractEvents, type NeardataBlock } from '../src/indexer/events'
import { decide, type MarketToken, remember, type VaultSnapshot } from '../src/agents/strategies'
import { marketFigures, nearRaw, priceFromE18, toNear, VIRTUAL_NEAR, VIRTUAL_TOKENS } from '../src/lib/units'
import { sniff, socialUrl } from '../src/routes/files'
import { cleanHandle, LINK_RULES } from '../src/routes/me'

const LP = 'grow.near'

function block(outcomes: { executor: string; logs: string[]; failed?: boolean }[]): NeardataBlock {
  return {
    block: { header: { height: 100, timestamp: 0, timestamp_nanosec: '1800000000000000000', hash: 'h' } },
    shards: [
      {
        shard_id: 0,
        receipt_execution_outcomes: outcomes.map((o, i) => ({
          tx_hash: 't' + i,
          receipt: { receipt_id: 'r' + i, predecessor_id: 'x', receiver_id: o.executor },
          execution_outcome: { id: 'r' + i, outcome: { executor_id: o.executor, logs: o.logs, status: o.failed ? { Failure: {} } : { SuccessValue: '' } } },
        })),
      },
    ],
  }
}
const ev = (standard: string, event: string, data: object) => `EVENT_JSON:${JSON.stringify({ standard, version: '1.0.0', event, data: [data] })}`

describe('indexer events', () => {
  it('reads launchpad and token events with a millisecond time', () => {
    const b = block([
      { executor: LP, logs: [ev('grow', 'trade', { token_id: 'oak-1' }), 'not an event'] },
      { executor: 'oak-1.grow.near', logs: [ev('nep141', 'ft_transfer', { old_owner_id: LP, new_owner_id: 'a.near', amount: '1' })] },
    ])
    const e = extractEvents(b, LP)
    expect(e.map((x) => x.event)).toEqual(['trade', 'ft_transfer'])
    expect(e[0].ts).toBe(1_800_000_000_000)
  })

  it('ignores failed receipts, other contracts and spoofed standards', () => {
    const b = block([
      { executor: LP, logs: [ev('grow', 'trade', {})], failed: true },
      { executor: 'evil.near', logs: [ev('grow', 'trade', {})] },
      { executor: 'oak-1.grow.near', logs: [ev('grow', 'trade', {})] },
      { executor: LP, logs: [ev('nep141', 'ft_mint', {})] },
    ])
    expect(extractEvents(b, LP)).toEqual([])
  })
})

describe('units', () => {
  it('reads the curve like the contract', () => {
    const start = marketFigures({ phase: 'Curve', near_reserve_raw: VIRTUAL_NEAR.toString(), tok_reserve_raw: VIRTUAL_TOKENS.toString(), burned_raw: '0' })
    expect(start.progress).toBe(0)
    expect(start.price).toBeCloseTo(1200 / 1.073e9, 15)
    expect(start.mcap).toBeCloseTo((1200 / 1.073e9) * 1e9, 3)
    expect(priceFromE18((10n ** 24n * 10n ** 18n) / 10n ** 18n)).toBe(1e-6 * 1e6 * 1)
    expect(toNear(nearRaw(12.345678))).toBe(12.345678)
  })
})

describe('files and links', () => {
  it('checks image signatures, not names', () => {
    expect(sniff(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png')
    expect(sniff(new Uint8Array([0x3c, 0x73, 0x76, 0x67]))).toBe(null)
  })
  it('normalises socials to fixed hosts', () => {
    expect(socialUrl('@growdotnear', 'x')).toBe('https://x.com/growdotnear')
    expect(socialUrl('https://twitter.com/grow_near/status/1', 'x')).toBe('https://x.com/grow_near')
    expect(socialUrl('javascript:alert(1)', 'website')).toBe(null)
    expect(socialUrl('t.me/growchat', 'telegram')).toBe('https://t.me/growchat')
    expect(cleanHandle('https://discord.gg/grow-near')).toBe('grow-near')
    expect(LINK_RULES.tg.test(cleanHandle('@ab'))).toBe(false)
  })
})

const tok = (o: Partial<MarketToken>): MarketToken => ({ id: 'a', ticker: 'A', phase: 'Pool', price: 1, mcap: 1000, progress: 1, holders: 40, volume_1h: 0, buyers_1h: 0, change_1h: 0, change_24h: 0, high_24h: 1, ...o })
const vault = (o: Partial<VaultSnapshot>): VaultSnapshot => ({ id: 1, kind: 'House', strategy: 'trend', cash: 100, equity: 100, budget: 100, daily_limit: 100, spent_today: 0, allowed: 'All', positions: [], ...o })

describe('strategies', () => {
  it('trend rider buys rising volume and unique buyers, within limits', () => {
    const market = [tok({ id: 'hot', ticker: 'HOT', volume_1h: 80, buyers_1h: 12, change_1h: 22 }), tok({ id: 'calm', volume_1h: 2 })]
    const d = decide('trend', vault({ spent_today: 95 }), market, { entries: {} }, Date.now())
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ token_id: 'hot', buy: true })
    expect(d[0].near).toBe(5) // daily limit room
  })

  it('takes profit and cuts losses on held positions', () => {
    const now = Date.now()
    const v = vault({ positions: [{ token_id: 'up', amount: (10n ** 21n).toString() }, { token_id: 'down', amount: (10n ** 21n).toString() }] })
    const market = [tok({ id: 'up', price: 1.5 }), tok({ id: 'down', price: 0.8 })]
    const d = decide('trend', v, market, { entries: { up: { price: 1, ts: now }, down: { price: 1, ts: now } } }, now)
    expect(d.map((x) => [x.token_id, x.buy, x.fraction])).toEqual([['up', false, 1], ['down', false, 1]])
  })

  it('dev gardener only touches its own token', () => {
    const market = [tok({ id: 'mine', price: 0.8, high_24h: 1 }), tok({ id: 'other', price: 0.5, high_24h: 1 })]
    const d = decide('dev', vault({ kind: 'Dev', allowed: { Only: 'mine' }, cash: 20 }), market, { entries: {} }, Date.now())
    expect(d).toHaveLength(1)
    expect(d[0].token_id).toBe('mine')
  })

  it('take-profit steps are remembered', () => {
    const now = Date.now()
    const v = vault({ positions: [{ token_id: 'a', amount: (10n ** 21n).toString() }] })
    const market = [tok({ id: 'a', price: 1.25, change_24h: -1 })]
    const st = { entries: { a: { price: 1, ts: now } } }
    const d = decide('exit', v, market, st, now)
    expect(d[0]).toMatchObject({ buy: false, fraction: 0.25 })
    expect(remember(st, d, market, now).entries.a.steps).toBe(1)
  })
})
