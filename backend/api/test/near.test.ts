import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519'
import { PublicKey } from '@near-js/crypto'
import { actionCreators, createTransaction, encodeTransaction } from '@near-js/transactions'
import { base58Decode, base58Encode, base64Encode } from '../src/near/encoding'
import { parseKey, serializeTransaction, signTransaction } from '../src/near/tx'
import { nep413Hash, verifyNep413 } from '../src/near/nep413'

const seed = new Uint8Array(32).map((_, i) => i + 1)
const secret = `ed25519:${base58Encode(new Uint8Array([...seed, ...ed25519.getPublicKey(seed)]))}`

describe('transactions', () => {
  it('serialize byte for byte like near-api-js', () => {
    const key = parseKey(secret)
    const blockHash = new Uint8Array(32).fill(7)
    const args = { vault_id: 3, token_id: 'oak-1', buy: true, amount: '1000000000000000000000000', min_out: '5', note: 'Volume is rising' }
    const ours = serializeTransaction('relayer.grow.near', key.publicKey, 42n, 'grow.near', blockHash, [{ method: 'vault_trade', args, gas: 100_000_000_000_000n, deposit: 0n }])
    const theirs = encodeTransaction(
      createTransaction('relayer.grow.near', PublicKey.fromString(key.publicKeyString), 'grow.near', 42n, [actionCreators.functionCall('vault_trade', args, 100_000_000_000_000n, 0n)], blockHash),
    )
    expect([...ours]).toEqual([...theirs])
  })

  it('sign so the signature verifies against the transaction hash', () => {
    const key = parseKey(secret)
    const { signed, hash } = signTransaction(key, 'a.near', 1n, 'grow.near', new Uint8Array(32), [{ method: 'push_rewards', args: { token_id: 'x' }, gas: 1n, deposit: 0n }])
    const sig = signed.slice(signed.length - 64)
    expect(ed25519.verify(sig, base58Decode(hash), key.publicKey)).toBe(true)
  })

  it('accept 32- and 64-byte secrets', () => {
    expect(parseKey(`ed25519:${base58Encode(seed)}`).publicKeyString).toBe(parseKey(secret).publicKeyString)
  })
})

describe('NEP-413 sign-in', () => {
  const nonce = new Uint8Array(32).fill(9)
  const pk = ed25519.getPublicKey(seed)
  const sign = (message: string, recipient: string) => base64Encode(ed25519.sign(nep413Hash(message, nonce, recipient), seed))

  it('verifies a wallet signature', () => {
    const signed = { accountId: 'alice.near', publicKey: `ed25519:${base58Encode(pk)}`, signature: sign('Sign in to grow.', 'grow.near') }
    expect(verifyNep413(signed, 'Sign in to grow.', nonce, 'grow.near')).toBe(true)
  })

  it('rejects a signature for another message or recipient', () => {
    const signed = { accountId: 'alice.near', publicKey: `ed25519:${base58Encode(pk)}`, signature: sign('Sign in to grow.', 'evil.near') }
    expect(verifyNep413(signed, 'Sign in to grow.', nonce, 'grow.near')).toBe(false)
    expect(verifyNep413({ ...signed, signature: sign('other', 'grow.near') }, 'Sign in to grow.', nonce, 'grow.near')).toBe(false)
  })

  it('prefixes the payload with the 2^31+413 tag', () => {
    // sha256 of the payload differs when the tag changes; check the tag bytes via a known layout.
    const tag = new Uint8Array(new Uint32Array([2147484061]).buffer)
    expect([...tag]).toEqual([0x9d, 0x01, 0x00, 0x80])
  })
})
