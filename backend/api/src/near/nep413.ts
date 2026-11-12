// Sign-in with a NEAR wallet (NEP-413 signMessage). The wallet signs sha256(borsh(tag, payload)); we check the
// signature and that the key is a full-access key of the account right now, so a leaked function-call key of a
// dapp cannot sign in as its owner.
import { ed25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha256'
import { base58Decode, base64Decode, Writer } from './encoding'

/** 2^31 + 413, the NEP-413 prefix tag. */
export const NEP413_TAG = 2147484061

export interface SignedMessage {
  accountId: string
  publicKey: string // "ed25519:..."
  signature: string // base64
}

export function nep413Hash(message: string, nonce: Uint8Array, recipient: string, callbackUrl?: string): Uint8Array {
  if (nonce.length !== 32) throw new Error('nonce must be 32 bytes')
  const w = new Writer().u32(NEP413_TAG).string(message).fixed(nonce).string(recipient)
  if (callbackUrl) w.u8(1).string(callbackUrl)
  else w.u8(0)
  return sha256(w.done())
}

export function verifyNep413(signed: SignedMessage, message: string, nonce: Uint8Array, recipient: string): boolean {
  const [type, data] = signed.publicKey.split(':')
  if (type !== 'ed25519' || !data) return false
  try {
    const pk = base58Decode(data)
    const sig = base64Decode(signed.signature)
    if (pk.length !== 32 || sig.length !== 64) return false
    return ed25519.verify(sig, nep413Hash(message, nonce, recipient), pk)
  } catch {
    return false
  }
}
