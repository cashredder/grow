// Base58, base64 and the small subset of Borsh that NEAR transactions and NEP-413 messages need.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  let n = 0n
  for (const b of bytes) n = n * 256n + BigInt(b)
  let out = ''
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out
    n /= 58n
  }
  return '1'.repeat(zeros) + out
}

export function base58Decode(s: string): Uint8Array {
  let zeros = 0
  while (zeros < s.length && s[zeros] === '1') zeros++
  let n = 0n
  for (const c of s) {
    const i = B58.indexOf(c)
    if (i < 0) throw new Error('bad base58')
    n = n * 58n + BigInt(i)
  }
  const out: number[] = []
  while (n > 0n) {
    out.unshift(Number(n % 256n))
    n /= 256n
  }
  return new Uint8Array([...new Array(zeros).fill(0), ...out])
}

export const base64Encode = (b: Uint8Array): string => btoa(String.fromCharCode(...b))
export const base64Decode = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

export class Writer {
  private parts: number[] = []
  u8(v: number) {
    this.parts.push(v & 0xff)
    return this
  }
  u32(v: number) {
    for (let i = 0; i < 4; i++) this.parts.push((v >>> (8 * i)) & 0xff)
    return this
  }
  u64(v: bigint) {
    for (let i = 0n; i < 8n; i++) this.parts.push(Number((v >> (8n * i)) & 0xffn))
    return this
  }
  u128(v: bigint) {
    for (let i = 0n; i < 16n; i++) this.parts.push(Number((v >> (8n * i)) & 0xffn))
    return this
  }
  fixed(b: Uint8Array) {
    for (const x of b) this.parts.push(x)
    return this
  }
  bytes(b: Uint8Array) {
    this.u32(b.length)
    return this.fixed(b)
  }
  string(s: string) {
    return this.bytes(new TextEncoder().encode(s))
  }
  done(): Uint8Array {
    return new Uint8Array(this.parts)
  }
}
