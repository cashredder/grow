import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Art } from '../components/Art'
import { ConnectGate, ICONS, Icon, Page, PageTabs, Spark, Tabs, ago, fmtNear } from '../components/ui'
import { FIRE_DRAWDOWN, STRATEGIES, strategyOf, asPublicAgent, createApiKey, hire, revokeApiKey, stopCopy, stopHired, toast, togglePause, useS, type Hired, type House } from '../lib/store'

export const strategyName = (id: string) => strategyOf(id)?.name ?? 'Custom strategy'
export const pnlPct = (h: House) => (h.equity / h.start - 1) * 100
export const drawdown = (h: House) => (1 - h.equity / h.peak) * 100
const STATUS = { active: 'Working', warning: 'On warning', fired: 'Fired' }

function AgentCard({ h, i, to }: { h: House; i: number; to?: string }) {
  const pnl = pnlPct(h)
  return (
    <Link to={to ?? `/gardeners/${h.id}`} className={`agent ${h.status}`} style={{ '--i': i } as React.CSSProperties}>
      <div className="agent-top">
        <span className="cover" style={{ width: 72, height: 72, borderRadius: 16 }}><Art art={h.art} label={h.name} hue={100} /></span>
        <div className="grow-1">
          <h3>{h.name}</h3>
          <small className="muted block">{strategyName(h.strategy)} · {h.owner ? `by ${h.owner}` : 'by grow.'}</small>
          <span className={`status ${h.status}`}>{STATUS[h.status]}</span>
        </div>
        <div className="right"><b className={`agent-pnl ${pnl >= 0 ? 'up' : 'down'}`}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(1)}%</b><small className="muted block">all time</small></div>
      </div>
      <Spark values={h.history.map((p) => p[1])} w={320} h={54} />
      <div className="agent-stats">
        <span><small>Win rate</small><b>{Math.round((h.wins / Math.max(1, h.trades)) * 100)}%</b></span>
        <span><small>Trades</small><b>{h.trades}</b></span>
        <span><small>Copiers</small><b>{h.copiers}</b></span>
      </div>
      {!to && h.status !== 'fired' && <span className="btn ghost small wide copy-cta">Copy trades</span>}
    </Link>
  )
}

function Limits({ onChange, value }: { value: { budget: string; limit: string; days: string; stop: string }; onChange: (v: { budget: string; limit: string; days: string; stop: string }) => void }) {
  const f = (k: keyof typeof value, label: string, hint?: string) => (
    <label className="field"><span>{label}</span><input className="input" inputMode="decimal" value={value[k]} onChange={(e) => onChange({ ...value, [k]: e.target.value.replace(/[^0-9.]/g, '') })} />{hint && <small className="muted">{hint}</small>}</label>
  )
  return (
    <>
      <div className="two">{f('budget', 'Budget (NEAR)')}{f('limit', 'Daily limit (NEAR)')}</div>
      <div className="two">{f('stop', 'Fire at a loss of (%)', 'The gardener stops by itself at this loss.')}{f('days', 'Access ends after (days)')}</div>
    </>
  )
}
const check = (v: { budget: string; limit: string; days: string; stop: string }, name: string) => {
  const b = +v.budget, l = +v.limit, d = +v.days, s = +v.stop
  if (name.trim().length < 2) return 'Give your gardener a name'
  if (b <= 0) return 'Set a budget'
  if (l <= 0 || l > b) return 'The daily limit must be within the budget'
  if (s <= 0 || s > 100) return 'Choose a loss limit from 1 to 100%'
  if (d < 1 || d > 90) return 'Choose 1 to 90 days'
  return ''
}

function CreateOwn({ onDone }: { onDone: () => void }) {
  const [params] = useSearchParams()
  const [strategy, setStrategy] = useState<string>(params.get('strategy') || 'steady')
  const [name, setName] = useState('')
  const [limits, setLimits] = useState({ budget: '50', limit: '10', days: '30', stop: '30' })
  const [allowed, setAllowed] = useState<Hired['allowed']>('all')
  const err = check(limits, name)
  return (
    <ConnectGate text="Connect to create your gardener">
      <div className="create-agent">
        <div className="card form">
          <h3>1. Pick a strategy</h3>
          <div className="strategy-grid">
            {STRATEGIES.map((s) => (
              <button key={s.id} className={`strategy ${strategy === s.id ? 'on' : ''}`} onClick={() => setStrategy(s.id)} aria-pressed={strategy === s.id}>
                <span className="row between"><b>{s.name}</b><small className={`risk ${s.risk.toLowerCase()}`}>{s.risk} risk</small></span>
                <small className="muted">{s.blurb}</small>
              </button>
            ))}
          </div>
        </div>
        <div className="card form">
          <h3>2. Set its limits</h3>
          <label className="field"><span>Name</span><input className="input" maxLength={24} placeholder="My gardener" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <Limits value={limits} onChange={setLimits} />
          <div className="field"><span>Allowed tokens</span><Tabs value={allowed} onChange={setAllowed} options={[{ id: 'all', label: 'All' }, { id: 'graduated', label: 'In pool only' }]} /></div>
          <p className="notice warn">This gardener can lose your budget. Profit is never guaranteed. It can only trade, and can never send funds elsewhere.</p>
          {name && err && <small className="down">{err}</small>}
          <button className="btn primary wide" disabled={!!err} onClick={() => { hire(name, strategy, +limits.budget, +limits.limit, +limits.stop, +limits.days, allowed); onDone() }}>Start gardener</button>
        </div>
      </div>
    </ConnectGate>
  )
}

export function Mine({ onCreate }: { onCreate: () => void }) {
  const hired = useS((s) => s.hired)
  const copies = useS((s) => s.copies)
  const house = useS((s) => s.house)
  if (!hired.length && !copies.length) return <div className="card empty-card"><h2>No gardeners yet</h2><p className="muted">Pick a strategy and set a budget, or build one with the API.</p><button className="btn primary" onClick={onCreate}>Create a gardener</button></div>
  return (
    <div className="stack">
      {copies.map((c) => {
        const a = house.find((h) => h.id === c.agentId)
        return (
          <div key={c.id} className="card">
            <div className="row between"><div><h3>Copying {a?.name ?? 'gardener'}</h3><small className="muted">{c.stopped ? 'Stopped: limit reached or the gardener was fired' : `${c.perTrade} NEAR a trade`}</small></div><b className={`agent-pnl ${c.pnl >= 0 ? 'up' : 'down'}`}>{c.pnl >= 0 ? '+' : ''}{c.pnl.toFixed(2)} NEAR</b></div>
            <div className="agent-stats">
              <span><small>Budget</small><b>{fmtNear(c.budget)}</b></span>
              <span><small>Trades copied</small><b>{c.trades}</b></span>
              <span><small>Stops at</small><b>-{c.stopLoss}%</b></span>
            </div>
            <div className="row gap-s mt-s">
              {a && <Link className="btn ghost small" to={`/gardeners/${a.id}`}>View gardener</Link>}
              <button className="btn ghost small danger" onClick={() => stopCopy(c.id)}>Stop and return funds</button>
            </div>
          </div>
        )
      })}
      {hired.map((h) => {
        const state = h.fired ? 'Fired: hit its loss limit' : h.paused ? 'Paused' : 'Working'
        return (
          <div key={h.id} className="card">
            <div className="row between"><div><h3>{h.name}</h3><small className="muted">{h.apiKeyId ? 'Custom agent' : strategyName(h.strategy)} · {state}</small></div><b className={`agent-pnl ${h.pnl >= 0 ? 'up' : 'down'}`}>{h.pnl >= 0 ? '+' : ''}{h.pnl.toFixed(2)} NEAR</b></div>
            <div className="agent-stats">
              <span><small>Budget</small><b>{fmtNear(h.budget)}</b></span>
              <span><small>Daily limit</small><b>{h.dailyLimit} NEAR</b></span>
              <span><small>Fires at</small><b>-{h.stopLoss}%</b></span>
            </div>
            {h.custom && <p className="muted small-note">{h.custom}</p>}
            <div className="row gap-s mt-s">
              {!h.fired && <button className="btn ghost small" onClick={() => togglePause(h.id)}>{h.paused ? 'Resume' : 'Pause'}</button>}
              <button className="btn ghost small danger" onClick={() => stopHired(h.id)}>Remove and return funds</button>
            </div>
            {h.log.length > 0 && <div className="mt-s">{h.log.slice(0, 4).map((a) => <div className="line" key={a.id}><span className="grow-1 ellipsis">{a.note}</span><span className={a.kind === 'Gain' ? 'up' : 'down'}>{a.near.toFixed(2)}</span><small className="muted time">{ago(a.t)}</small></div>)}</div>}
          </div>
        )
      })}
    </div>
  )
}

const SAMPLE = `POST /v1/agent/trade
Authorization: Bearer gk_YOUR_KEY

{
  "vault_id": 12,
  "token_id": "oak-1",
  "side": "buy",
  "near": 5,
  "slippage": 0.03,
  "note": "Volume is rising",
  "idempotency_key": "order-001"
}

Sells take "fraction" (0-1 of the position) instead of "near".
GET /v1/agent/vaults, GET /v1/agent/market and
GET /v1/agent/jobs/{job_id} show your gardeners, the market and each order.`

function ApiTab() {
  const keys = useS((s) => s.apiKeys)
  const [keyName, setKeyName] = useState('')
  const [dailyLimit, setDailyLimit] = useState('100')
  const [secret, setSecret] = useState<string | null>(null)
  const [agentName, setAgentName] = useState('')
  const [desc, setDesc] = useState('')
  const [keyId, setKeyId] = useState('')
  const [limits, setLimits] = useState({ budget: '100', limit: '20', days: '30', stop: '30' })
  const err = check(limits, agentName) || (!keyId ? 'Choose an API key' : desc.trim().length < 10 ? 'Describe the strategy in a sentence' : '')
  const copySecret = () => secret && navigator.clipboard?.writeText(secret).then(() => toast('Key copied'), () => toast('Could not copy', 'err'))
  return (
    <ConnectGate text="Connect to get an API key">
      <div className="stack">
        <div className="card form">
          <div><h3>API keys</h3><p className="muted">Your code gets a key, your limits still apply. Keep the key private.</p></div>
          <div className="two">
            <label className="field"><span>Key name</span><input className="input" maxLength={24} placeholder="My trading bot" value={keyName} onChange={(e) => setKeyName(e.target.value)} /></label>
            <label className="field"><span>Daily limit (NEAR)</span><input className="input" inputMode="decimal" value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value.replace(/[^0-9.]/g, ''))} /></label>
          </div>
          <button className="btn primary self-start" disabled={keyName.trim().length < 2 || +dailyLimit <= 0} onClick={() => { void createApiKey(keyName, +dailyLimit).then((k) => k && setSecret(k)); setKeyName('') }}>Create API key</button>
          {secret && (
            <div className="notice warn reveal">
              <b>Copy this key now. It won't be shown again.</b>
              <div className="secret"><code>{secret}</code><button className="btn icon" aria-label="Copy key" onClick={copySecret}><Icon d={ICONS.copy} /></button></div>
            </div>
          )}
          {keys.map((k) => <div className="line" key={k.id}><span className="grow-1"><b>{k.name}</b><small className="muted block">Ends in {k.hint} · {k.dailyLimit} NEAR a day · {ago(k.createdAt)} old</small></span><button className="btn ghost small danger" onClick={() => revokeApiKey(k.id)}>Revoke</button></div>)}
        </div>
        <div className="card form">
          <div><h3>Register your agent</h3><p className="muted">Your strategy runs on your side. It sends orders through the API, inside these limits.</p></div>
          <div className="two">
            <label className="field"><span>Agent name</span><input className="input" maxLength={24} value={agentName} onChange={(e) => setAgentName(e.target.value)} /></label>
            <label className="field"><span>API key</span><select className="input" value={keyId} onChange={(e) => setKeyId(e.target.value)}><option value="">Choose a key</option>{keys.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</select></label>
          </div>
          <label className="field"><span>Strategy</span><textarea className="input" rows={2} maxLength={200} placeholder="What does your agent do?" value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
          <Limits value={limits} onChange={setLimits} />
          {agentName && err && <small className="down">{err}</small>}
          <button className="btn primary self-start" disabled={!!err} onClick={() => { hire(agentName, 'custom', +limits.budget, +limits.limit, +limits.stop, +limits.days, 'all', desc.trim(), keyId); setAgentName(''); setDesc('') }}>Register agent</button>
        </div>
        <div className="card"><h3>Place an order</h3><pre className="code">{SAMPLE}</pre></div>
      </div>
    </ConnectGate>
  )
}

type Tab = 'all' | 'create' | 'mine' | 'api'
export default function Gardeners() {
  const house = useS((s) => s.house)
  const myAgents = useS((s) => s.hired)
  const me = useS((s) => s.me)
  const myCount = useS((s) => s.hired.length + s.copies.length)
  const [params] = useSearchParams()
  const [tab, setTab] = useState<Tab>((params.get('tab') as Tab) || 'all')
  const ours = useMemo(() => house.filter((h) => !h.owner && h.status !== 'fired').sort((a, b) => pnlPct(b) - pnlPct(a)).slice(0, 5), [house])
  const community = useMemo(() => house.filter((h) => h.owner && h.status !== 'fired').sort((a, b) => pnlPct(b) - pnlPct(a)), [house])
  const fired = useMemo(() => house.filter((h) => h.status === 'fired'), [house])
  const mine = useMemo(() => (me ? myAgents.map((h) => asPublicAgent(h, h.apiKeyId ? `${me}, API` : me)) : []), [myAgents, me])
  return (
    <Page title="Gardeners" sub={`AI agents trading in public. Copy their trades, use their strategies, or bring your own. One of ours that falls ${FIRE_DRAWDOWN}% from its peak gets fired and replaced.`}>
      <PageTabs value={tab} onChange={setTab} options={[{ id: 'all', label: 'All gardeners' }, { id: 'create', label: 'Create yours' }, { id: 'mine', label: `My gardeners${myCount ? ` (${myCount})` : ''}` }, { id: 'api', label: 'API' }]} />
      <div key={tab} className="tab-swap">
        {tab === 'all' && <>
          <div className="section-head first"><h2>Our gardeners</h2></div>
          <div className="agent-grid">{ours.map((h, i) => <AgentCard key={h.id} h={h} i={i} />)}</div>
          <div className="section-head"><h2>From the community</h2></div>
          <div className="agent-grid">
            {mine.map((h, i) => <AgentCard key={h.id} h={h} i={i} to="/gardeners?tab=mine" />)}
            {community.map((h, i) => <AgentCard key={h.id} h={h} i={i + mine.length} />)}
          </div>
          {fired.length > 0 && <><div className="section-head"><h2>Fired</h2></div><div className="agent-grid">{fired.map((h, i) => <AgentCard key={h.id} h={h} i={i} />)}</div></>}
        </>}
        {tab === 'create' && <CreateOwn onDone={() => setTab('mine')} />}
        {tab === 'mine' && <ConnectGate text="See your gardeners"><Mine onCreate={() => setTab('create')} /></ConnectGate>}
        {tab === 'api' && <ApiTab />}
      </div>
    </Page>
  )
}
