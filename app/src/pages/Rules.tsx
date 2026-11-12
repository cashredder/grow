import { Page } from '../components/ui'

export default function Rules() {
  return (
    <Page title="How it works" sub="Fees, rules and risks in one place.">
      <div className="stack">
        <div className="card">
          <h3>Where a 1% fee goes</h3>
          <div className="split-bar" aria-hidden="true"><i style={{ flex: 30 }}/><i style={{ flex: 10 }}/><i style={{ flex: 6 }} /><i style={{ flex: 54 }}/></div>
          <div className="line"><span className="grow-1">Token dev</span><b>30%</b></div>
          <div className="line"><span className="grow-1">Holder rewards</span><b>10%</b></div>
          <div className="line"><span className="grow-1">Referrer, if any</span><b>6%</b></div>
          <div className="line"><span className="grow-1">Platform</span><b>54%</b></div>
        </div>
        <div className="card">
          <h3>How a token works</h3>
          <div className="line"><span className="muted grow-1">Supply</span><span>1B: about 793M on the curve, 207M for the pool</span></div>
          <div className="line"><span className="muted grow-1">Trade fee on the curve</span><span>0–5%, set by the dev, default 1%</span></div>
          <div className="line"><span className="muted grow-1">Trade fee in the pool</span><span>0.5%</span></div>
          <div className="line"><span className="muted grow-1">First 60 seconds</span><span>Fee falls from 50% to normal</span></div>
          <div className="line"><span className="muted grow-1">Pool liquidity</span><span>Locked forever</span></div>
        </div>
        <div className="card">
          <h3>Hold rewards</h3>
          <p className="muted">Each token has its own pool, paid in NEAR from trading fees. No volume means no rewards.</p>
          <div className="line"><span className="grow-1">3 days</span><b>×1</b></div>
          <div className="line"><span className="grow-1">5 days</span><b>×1.5</b></div>
          <div className="line"><span className="grow-1">10 days</span><b>×2</b></div>
        </div>
        <div className="card">
          <h3>Risks</h3>
          <ul className="muted bullets">
            <li>Tokens can lose all their value. A growing tree is not a promise of profit.</li>
            <li>Gardeners can make losing trades within their limits.</li>
            <li>Smart contracts can contain bugs, even after an audit.</li>
            <li>A crossing replaces your coins. Sell during the exit window if you disagree.</li>
          </ul>
        </div>
      </div>
    </Page>
  )
}
