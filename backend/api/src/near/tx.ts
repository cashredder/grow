// Signing NEAR function-call transactions with an ed25519 key, without near-api-js (smaller, and it runs in a
// Worker as is). The byte layout is checked against @near-js/transactions in test/tx.test.ts.
import { ed25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha256'
import { base58Decode, base58Encode, Writer } from './encoding'

export interface KeyPair {
  secret: Uint8Array // 32-byte seed
  publicKey: Uint8Array
  publicKeyString: string
}

/** Accepts NEAR's "ed25519:<base58>" secret format (64 bytes seed+public, or a 32-byte seed). */
export function parseKey(s: string): KeyPair {
  const [type, data] = s.trim().split(':')
  if (type !== 'ed25519' || !data) throw new Error('only ed25519 keys are supported')
  const raw = base58Decode(data)
  const secret = raw.length === 64 ? raw.slice(0, 32) : raw
  if (secret.length !== 32) throw new Error('bad key length')
  const publicKey = ed25519.getPublicKey(secret)
  return { secret, publicKey, publicKeyString: `ed25519:${base58Encode(publicKey)}` }
}

export interface FunctionCall {
  method: string
  args: unknown
  gas: bigint
  deposit: bigint
}

export function serializeTransaction(signer: string, publicKey: Uint8Array, nonce: bigint, receiver: string, blockHash: Uint8Array, calls: FunctionCall[]): Uint8Array {
  const w = new Writer().string(signer).u8(0).fixed(publicKey).u64(nonce).string(receiver).fixed(blockHash).u32(calls.length)
  for (const c of calls) {
    w.u8(2) // Action::FunctionCall
      .string(c.method)
      .bytes(new TextEncoder().encode(JSON.stringify(c.args)))
      .u64(c.gas)
      .u128(c.deposit)
  }
  return w.done()
}

export function signTransaction(key: KeyPair, signer: string, nonce: bigint, receiver: string, blockHash: Uint8Array, calls: FunctionCall[]) {
  const tx = serializeTransaction(signer, key.publicKey, nonce, receiver, blockHash, calls)
  const hash = sha256(tx)
  const sig = ed25519.sign(hash, key.secret)
  const signed = new Uint8Array(tx.length + 1 + 64)
  signed.set(tx)
  signed[tx.length] = 0
  signed.set(sig, tx.length + 1)
  return { signed, hash: base58Encode(hash) }
}
