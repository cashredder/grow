import { describe, expect, it } from 'vitest'
import { extractEvents, type NeardataBlock } from '../src/indexer/events'
import { decide, type MarketToken, remember, type VaultSnapshot } from '../src/agents/strategies'
import { marketFigures, nearRaw, priceFromE18, toNear, VIRTUAL_NEAR, VIRTUAL_TOKENS } from '../src/lib/units'
import { sniff, socialUrl } from '../src/routes/files'
import { cleanHandle, LINK_RULES } from '../src/routes/me'
import { num } from '../src/http'

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

describe('query numbers', () => {
  it('a missing parameter takes the default', () => {
    expect(num(null, 64, 1, 500)).toBe(64)
    expect(num('', 64, 1, 500)).toBe(64)
    expect(num('9999', 64, 1, 500)).toBe(500)
    expect(num('abc', 64, 1, 500)).toBe(64)
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

  it('on a small market (MARKET_SCALE) the rules scale their thresholds down', async () => {
    const { setMarketScale } = await import('../src/agents/strategies')
    const quiet = [tok({ id: 'q', ticker: 'Q', phase: 'Curve', volume_1h: 1, buyers_1h: 1, change_1h: 10 })]
    expect(decide('trend', vault({}), quiet, { entries: {} }, Date.now())).toHaveLength(0)
    setMarketScale(0.02)
    try {
      expect(decide('trend', vault({}), quiet, { entries: {} }, Date.now())).toMatchObject([{ token_id: 'q', buy: true }])
    } finally {
      setMarketScale(1)
    }
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

describe('NEAR AI decisions', async () => {
  const { secp256k1 } = await import('@noble/curves/secp256k1')
  const { keccak_256 } = await import('@noble/hashes/sha3')
  const { recoverAddress, signedTexts, jsonIn } = await import('../src/agents/nearai')
  const { aiTrades, aiTreasury } = await import('../src/agents/ai')
  const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

  function personalSign(text: string, sk: Uint8Array) {
    const msg = new TextEncoder().encode(text)
    const digest = keccak_256(new Uint8Array([...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`), ...msg]))
    const sig = secp256k1.sign(digest, sk)
    return '0x' + hex(sig.toCompactRawBytes()) + (27 + sig.recovery).toString(16)
  }

  it('recovers the EIP-191 signer like NEAR AI verification expects', () => {
    const sk = secp256k1.utils.randomPrivateKey()
    const address = '0x' + hex(keccak_256(secp256k1.getPublicKey(sk, false).slice(1)).slice(-20))
    const [text] = signedTexts('z/model', 'a'.repeat(64), 'b'.repeat(64))
    expect(text).toBe(`z/model:${'a'.repeat(64)}:${'b'.repeat(64)}`)
    expect(recoverAddress(text, personalSign(text, sk))).toBe(address)
    expect(recoverAddress(text + 'x', personalSign(text, sk))).not.toBe(address)
  })

  it('reads JSON out of a chatty answer', () => {
    expect(jsonIn<{ a: number }>('<think>hmm {"no":1}</think>Sure: ```json\n{"a": 2}\n```')).toEqual({ a: 2 })
    expect(jsonIn('no json here')).toBe(null)
  })

  // A fake NEAR AI Cloud and a database that only records what is saved.
  function env(answer: object) {
    const saved: unknown[] = []
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith('/chat/completions')) return new Response(JSON.stringify({ id: 'chat-1', choices: [{ message: { content: JSON.stringify(answer) } }] }))
      // No signature for this chat (a 2xx with error_code): the decision is kept as unverified.
      return new Response(JSON.stringify({ error_code: 'unavailable', message: 'no signature' }))
    }) as typeof fetch
    const db = { prepare: () => ({ bind: (...a: unknown[]) => ({ first: async () => (saved.push(a), { id: saved.length }), run: async () => ({}) }) }) }
    return { e: { NEARAI_KEY: 'k', AI_MODEL: 'm', DB: db } as never, saved }
  }
  const t = (o: Partial<MarketToken>): MarketToken => ({ id: 'a', ticker: 'A', phase: 'Curve', price: 1, mcap: 1000, progress: 0.4, holders: 30, volume_1h: 5, buyers_1h: 3, change_1h: 2, change_24h: 4, high_24h: 1, ...o })
  const v = (o: Partial<VaultSnapshot>): VaultSnapshot => ({ id: 7, kind: 'User', strategy: 'ai', cash: 10, equity: 10, budget: 10, daily_limit: 5, spent_today: 0, allowed: 'All', positions: [], ...o })

  it('keeps only allowed AI trades, within the vault limits', async () => {
    const { e, saved } = env({ decisions: [{ token_id: 'a', side: 'buy', near: 50, reason: 'Holders are growing' }, { token_id: 'ghost', side: 'buy', near: 1 }, { token_id: 'b', side: 'sell', fraction: 0.5 }] })
    const r = await aiTrades(e, v({}), [t({}), t({ id: 'b' })], { entries: {} }, Date.now())
    // 20% of equity at most, unknown tokens and sells of coins it does not hold are dropped.
    expect(r.decisions).toEqual([{ token_id: 'a', buy: true, near: 2, note: 'Holders are growing' }])
    expect(r.aiId).toBe(1)
    expect(saved).toHaveLength(1)
  })

  it('the treasurer stays within a quarter of the treasury and the dev limit', async () => {
    const { e } = env({ actions: [{ action: 'pay_dev', near: 9, reason: 'Healthy week' }, { action: 'buyback', near: 9 }, { action: 'withdraw', near: 1 }] })
    const r = await aiTreasury(e, v({ kind: 'Dev', strategy: 'treasurer', cash: 4, daily_limit: 100 }), t({}))
    expect(r.actions).toEqual([{ action: 'pay_dev', near: 0.8, note: 'Healthy week' }, { action: 'buyback', near: 0.2, note: 'AI treasury decision' }])
  })

  it('an unchanged market is not asked again, and a failed call is not paid for', async () => {
    const { e, saved } = env({ decisions: [] })
    const first = await aiTrades(e, v({}), [t({})], { entries: {} }, Date.now())
    expect(first.aiId).toBe(1)
    const again = await aiTrades(e, v({}), [t({})], { entries: {}, ai_fp: first.fp }, Date.now())
    expect(again.aiId).toBe(null)
    expect(saved).toHaveLength(1)
    globalThis.fetch = (async () => new Response('{"error":{"message":"No spending limit configured"}}', { status: 402 })) as typeof fetch
    const failed = await aiTrades(e, v({}), [t({ price: 2 })], { entries: {} }, Date.now())
    expect(failed.aiId).toBe(null)
  })

  it('without a key the treasurer follows the rules', async () => {
    const r = await aiTreasury({ DB: {} } as never, v({ kind: 'Dev', cash: 2, daily_limit: 100 }), t({ price: 0.8, high_24h: 1 }))
    expect(r.actions[0]).toMatchObject({ action: 'buyback', near: 0.3 })
    expect(r.aiId).toBe(null)
  })
})
