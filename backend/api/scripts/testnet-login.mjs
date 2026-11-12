// Signs in to a grow. API with a testnet account's key from the near-cli legacy keychain (NEP-413), for
// end-to-end checks from the command line. Writes the session token to the given file, never to the screen.
//   node scripts/testnet-login.mjs <api-url> <account> <out-file>
import { ed25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha256'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const [api, account, out] = process.argv.slice(2)
if (!api || !account || !out) throw new Error('usage: testnet-login.mjs <api-url> <account> <out-file>')
const B = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const b58d = (s) => { let n = 0n; for (const c of s) n = n * 58n + BigInt(B.indexOf(c)); const bytes = []; while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n } for (const c of s) { if (c !== '1') break; bytes.unshift(0) } return Uint8Array.from(bytes) }
const cred = JSON.parse(readFileSync(join(homedir(), '.near-credentials', 'testnet', `${account}.json`), 'utf8'))
const secret = b58d(cred.private_key.split(':')[1]).slice(0, 32)
const { nonce, message, recipient } = await (await fetch(`${api}/auth/nonce`)).json()
const n = Uint8Array.from(Buffer.from(nonce, 'base64'))
// borsh: u32 tag, string message, [u8;32] nonce, string recipient, Option<string> callbackUrl = None
const str = (s) => { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]) }
const tag = Buffer.alloc(4); tag.writeUInt32LE(2147484061)
const payload = Buffer.concat([tag, str(message), Buffer.from(n), str(recipient), Buffer.from([0])])
const sig = ed25519.sign(sha256(payload), secret)
const res = await fetch(`${api}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5174' }, body: JSON.stringify({ accountId: account, publicKey: cred.public_key, signature: Buffer.from(sig).toString('base64'), nonce }) })
const j = await res.json()
if (!res.ok) throw new Error(`login failed: ${res.status} ${JSON.stringify(j)}`)
writeFileSync(out, j.token)
console.log(`signed in as ${j.account}`)
