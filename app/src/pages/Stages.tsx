import Tree from '../components/Tree'
import { growth } from '../lib/engine'

// Development only: every growth stage side by side.
const CAPS = [3000, 7200, 12000, 20000, 40000, 60000, 100000, 150000]
export default function Stages() {
  return (
    <div className="grid" style={{ padding: 16, gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
      {CAPS.map((c) => <div key={c} className="card" style={{ height: 300, padding: 4 }}><small>${c}</small><div style={{ height: 270 }}><Tree growth={growth(c)} framed /></div></div>)}
      <div className="card" style={{ height: 300, padding: 4 }}><small>twin 300K</small><div style={{ height: 270 }}><Tree growth={growth(300000)} twin /></div></div>
    </div>
  )
}
