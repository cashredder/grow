// NEAR AI proof links and the list of a gardener's AI decisions.
import { aiProofUrl } from '../lib/live'
import type { AiDecision } from '../lib/store'
import { ago } from './ui'

/** A small "NEAR AI" chip that opens the decision's request, response and TEE signature. */
export function AiChip({ id }: { id?: number }) {
  if (!id) return null
  return <a className="ai-chip" href={aiProofUrl(id)} target="_blank" rel="noreferrer" title="Decided by a NEAR AI model in a TEE. Opens the signed request and answer.">NEAR AI</a>
}

function status(d: AiDecision) {
  if (d.error) return { text: 'Rules', cls: 'muted', tip: 'NEAR AI did not answer, so the rules decided' }
  if (d.signature_ok && d.attested) return { text: 'Signed in TEE', cls: 'up', tip: `Signed by ${d.signing_address}, the key named in NEAR AI's attestation report` }
  if (d.signature_ok) return { text: 'Signed', cls: 'up', tip: `Signed by ${d.signing_address}` }
  return { text: 'Unsigned', cls: 'warn-word', tip: 'No NEAR AI signature was available for this answer' }
}

/** The latest decisions of an AI gardener, each with its verification status and a link to the proof. */
export function AiDecisions({ list, empty }: { list?: AiDecision[]; empty: string }) {
  if (!list?.length) return <p className="muted mt-s">{empty}</p>
  return (
    <div className="mt-s ai-list">
      {list.slice(0, 8).map((d) => {
        const s = status(d)
        return (
          <div className="ai-row" key={d.id}>
            <div className="row between"><span className={`status-word ${s.cls}`} title={s.tip}>{s.text}</span><small className="muted">{ago(d.ts)} ago</small></div>
            <p>{d.summary}</p>
            <small className="muted">{d.model} · <a href={aiProofUrl(d.id)} target="_blank" rel="noreferrer">See the proof</a></small>
          </div>
        )
      })}
    </div>
  )
}
