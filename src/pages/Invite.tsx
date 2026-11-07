import { ConnectGate, Page, fmtNear } from '../components/ui'
import { claimRef, toast, useS } from '../lib/store'

export default function Invite() {
  const code = useS((s) => s.refCode)
  const invited = useS((s) => s.invited)
  const earned = useS((s) => s.refEarned)
  const claimed = useS((s) => s.refClaimed)
  const link = `${location.origin}/?ref=${code}`
  const copy = () => navigator.clipboard?.writeText(link).then(() => toast('Link copied'), () => toast('Could not copy', 'err'))
  return (
    <Page title="Invite friends" sub="Earn 10% of the platform's fee share from their trades for 90 days.">
      <ConnectGate text="Get your invite link">
        <div className="card mb">
          <label className="field"><span>Your link</span><div className="row gap-s"><input className="input grow-1" readOnly value={link} /><button className="btn primary" onClick={copy}>Copy</button></div></label>
        </div>
        <div className="summary-grid">
          <div className="card"><small className="muted">Invited</small><div className="big-num xl">{invited}</div></div>
          <div className="card"><small className="muted">Earned</small><div className="big-num xl">{fmtNear(earned)}</div></div>
          <div className="card"><small className="muted">Available</small><div className="big-num xl">{fmtNear(earned - claimed)}</div></div>
        </div>
        <button className="btn primary" disabled={earned - claimed <= 0} onClick={claimRef}>Claim earnings</button>
      </ConnectGate>
    </Page>
  )
}
