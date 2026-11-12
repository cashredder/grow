// NEAR AI Cloud: the gardeners' decisions come from a model that runs inside a TEE, and every answer is
// signed there (https://docs.near.ai/cloud/verification). For each decision we keep the exact request and
// response bytes, their SHA-256 hashes, and NEAR AI's signature of
//   "<model>:<request_hash>:<response_hash>"  (signed by the model's TEE), or
//   "<request_hash>:<response_hash>"          (signed by the NEAR AI gateway),
// check that the signature recovers to the signing address (ECDSA, EIP-191), and check that this address is
// the one named in a fresh attestation report bound to our nonce. Anyone can repeat these checks from the
// stored request, response and signature (GET /v1/ai/decisions/{id}).
//
// What we do not do here: verify the Intel TDX quote itself (DCAP); the report and its quote are stored by
// hash, and docs.near.ai explains how to verify them with dcap-qvl.
import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'
import type { Env } from '../env'
import { sha256Hex } from '../http'

const API = 'https://cloud-api.near.ai/v1'
export const DEFAULT_MODEL = 'z-ai/glm-5.3-flash'
const ATTEST_EVERY_MS = 6 * 3_600_000

export interface AiProof {
  chat_id: string
  model: string
  request_hash: string
  response_hash: string
  signed_text: string
  signature: string
  signing_address: string
  signature_ok: boolean
  attested: boolean
}

export interface AiAnswer {
  content: string
  request: string
  response: string
  proof: AiProof | null
  error?: string
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
const fromHex = (s: string) => Uint8Array.from((s.replace(/^0x/, '').match(/../g) ?? []).map((h) => parseInt(h, 16)))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** EIP-191 personal_sign recovery: the address that signed `text`. */
export function recoverAddress(text: string, signature: string): string | null {
  try {
    const msg = new TextEncoder().encode(text)
    const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`)
    const digest = keccak_256(new Uint8Array([...prefix, ...msg]))
    const sig = fromHex(signature)
    if (sig.length !== 65) return null
    const v = sig[64] >= 27 ? sig[64] - 27 : sig[64]
    const pub = secp256k1.Signature.fromCompact(sig.slice(0, 64)).addRecoveryBit(v).recoverPublicKey(digest).toRawBytes(false)
    return '0x' + hex(keccak_256(pub.slice(1)).slice(-20))
  } catch {
    return null
  }
}

/** The texts NEAR AI may have signed for this request and response. */
export const signedTexts = (model: string, requestHash: string, responseHash: string) => [`${model}:${requestHash}:${responseHash}`, `${requestHash}:${responseHash}`]

async function signatureOf(env: Env, chatId: string): Promise<{ text: string; signature: string; signing_address: string } | null> {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`${API}/signature/${encodeURIComponent(chatId)}?signing_algo=ecdsa`, { headers: { Accept: 'application/json', Authorization: `Bearer ${env.NEARAI_KEY!.trim()}` } })
    if (res.status === 404) {
      await sleep(500 * (i + 1))
      continue
    }
    if (!res.ok) return null
    const j = (await res.json()) as { text?: string; signature?: string; signing_address?: string; error_code?: string }
    if (j.error_code || !j.text || !j.signature || !j.signing_address) return null
    return { text: j.text, signature: j.signature, signing_address: j.signing_address }
  }
  return null
}

/**
 * Whether `address` is the signer named in a fresh NEAR AI attestation report for `model`, bound to our
 * nonce (the last 32 bytes of report_data). Cached for a few hours per address.
 */
async function attested(env: Env, model: string, address: string): Promise<boolean> {
  const key = `att:${address.toLowerCase()}`
  const cached = await env.DB.prepare('SELECT value FROM ix_state WHERE key = ?').bind(key).first<{ value: string }>()
  if (cached) {
    const [ts, ok] = cached.value.split(':')
    if (Date.now() - Number(ts) < ATTEST_EVERY_MS) return ok === '1'
  }
  const nonce = hex(crypto.getRandomValues(new Uint8Array(32)))
  const url = `${API}/attestation/report?signing_algo=ecdsa&nonce=${nonce}&model=${encodeURIComponent(model)}&provider=near&include_tls_fingerprint=false`
  let ok = false
  let reportHash = ''
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', 'x-no-aliasing': 'true' } })
    if (res.ok) {
      const text = await res.text()
      reportHash = await sha256Hex(text)
      const r = JSON.parse(text) as { gateway_attestation?: { signing_address?: string; report_data?: string; intel_quote?: string }; model_attestations?: { signing_address?: string; report_data?: string; intel_quote?: string }[] }
      const reports = [r.gateway_attestation, ...(r.model_attestations ?? [])].filter(Boolean) as { signing_address?: string; report_data?: string; intel_quote?: string }[]
      ok = reports.some((a) => a.signing_address?.toLowerCase() === address.toLowerCase() && !!a.intel_quote && (a.report_data ?? '').toLowerCase().endsWith(nonce))
    }
  } catch {
    ok = false
  }
  await env.DB.prepare('INSERT INTO ix_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').bind(key, `${Date.now()}:${ok ? 1 : 0}:${reportHash}`).run()
  return ok
}

/** Asks the model; returns its text and the proof. Never throws: errors come back in `error`. */
export async function askNearAi(env: Env, system: string, user: string): Promise<AiAnswer> {
  const model = env.AI_MODEL || DEFAULT_MODEL
  const request = JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.2, max_tokens: 1500 })
  try {
    const res = await fetch(`${API}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.NEARAI_KEY!.trim()}`, 'x-no-aliasing': 'true', 'Accept-Encoding': 'identity' },
      body: request,
    })
    const response = await res.text()
    if (!res.ok) return { content: '', request, response, proof: null, error: `NEAR AI: HTTP ${res.status} ${response.slice(0, 200)}` }
    const j = JSON.parse(response) as { id?: string; choices?: { message?: { content?: string } }[] }
    const content = j.choices?.[0]?.message?.content ?? ''
    const [requestHash, responseHash] = await Promise.all([sha256Hex(request), sha256Hex(response)])
    let proof: AiProof | null = null
    if (j.id) {
      const sig = await signatureOf(env, j.id)
      if (sig) {
        const textOk = signedTexts(model, requestHash, responseHash).includes(sig.text)
        const signer = recoverAddress(sig.text, sig.signature)
        const signatureOk = textOk && !!signer && signer.toLowerCase() === sig.signing_address.toLowerCase()
        proof = {
          chat_id: j.id,
          model,
          request_hash: requestHash,
          response_hash: responseHash,
          signed_text: sig.text,
          signature: sig.signature,
          signing_address: sig.signing_address,
          signature_ok: signatureOk,
          attested: signatureOk ? await attested(env, model, sig.signing_address) : false,
        }
      }
    }
    return { content, request, response, proof }
  } catch (e) {
    return { content: '', request, response: '', proof: null, error: `NEAR AI: ${String((e as Error).message || e).slice(0, 200)}` }
  }
}

/** The first JSON object in a model's answer (models sometimes wrap it in a code block or add a sentence). */
export function jsonIn<T>(content: string): T | null {
  const s = content.replace(/<think>[\s\S]*?<\/think>/g, '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(s.slice(start, end + 1)) as T
  } catch {
    return null
  }
}

/** Stores a decision with its proof; returns its id. */
export async function saveDecision(env: Env, vaultId: number, kind: 'trade' | 'treasury', a: AiAnswer, output: unknown): Promise<number> {
  const p = a.proof
  const r = await env.DB.prepare(
    `INSERT INTO ai_decisions (vault_id, ts, kind, model, chat_id, request, response, request_hash, response_hash, signed_text, signature, signing_address, signature_ok, attested, output, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(vaultId, Date.now(), kind, env.AI_MODEL || DEFAULT_MODEL, p?.chat_id ?? null, a.request, a.response, p?.request_hash ?? null, p?.response_hash ?? null, p?.signed_text ?? null, p?.signature ?? null, p?.signing_address ?? null, p?.signature_ok ? 1 : 0, p?.attested ? 1 : 0, JSON.stringify(output ?? null), a.error ?? null)
    .first<{ id: number }>()
  return r?.id ?? 0
}
