import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Tree from '../components/Tree'
import { Check, Cover, Page, Slider, fmtNear, Tabs } from '../components/ui'
import { createToken, setWalletOpen, toast, useS } from '../lib/store'
import { LIVE } from '../lib/config'
import { createCost } from '../lib/live'

const MAX_IMG = 2 * 1024 * 1024
export default function Create() {
  const nav = useNavigate()
  const me = useS((s) => s.me)
  const balance = useS((s) => s.balance)
  const [name, setName] = useState('')
  const [ticker, setTicker] = useState('')
  const [desc, setDesc] = useState('')
  const [image, setImage] = useState<string>()
  const [fee, setFee] = useState(1)
  const [buy, setBuy] = useState('')
  const [pct, setPct] = useState(0)
  const [to, setTo] = useState<'holders' | 'buyback'>('holders')
  const [gardener, setGardener] = useState(false)
  const [x, setX] = useState('')
  const [tg, setTg] = useState('')
  const [web, setWeb] = useState('')
  const devBuy = Number(buy) || 0
  const nameErr = name.trim().length < 2 ? 'At least 2 characters' : ''
  const tickerErr = !/^[A-Za-z0-9]{2,8}$/.test(ticker.trim()) ? '2 to 8 letters or numbers' : ''
  const [launchFee, setLaunchFee] = useState(1)
  useEffect(() => { if (LIVE) void createCost(0).then(setLaunchFee).catch(() => {}) }, [])
  const cost = launchFee + devBuy
  const ok = !nameErr && !tickerErr && cost <= balance
  const onFile = (f?: File) => {
    if (!f) return
    if (!f.type.startsWith('image/')) return toast('Please choose an image', 'err')
    if (f.size > MAX_IMG) return toast('The image must be under 2 MB', 'err')
    const r = new FileReader()
    r.onload = () => setImage(String(r.result))
    r.readAsDataURL(f)
  }
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!ok) return
    const id = createToken({ name, ticker, desc, image, feePct: fee, devBuy, redirect: { pct, to }, gardener, socials: { x: x.trim() || undefined, tg: tg.trim() || undefined, web: web.trim() || undefined } }, (created) => nav(`/token/${created}`))
    if (id) nav(`/token/${id}`)
  }
  return (
    <Page title="Create token" sub="One transaction. Your tree starts growing with the first trade.">
      <div className="create">
        <form className="card form" onSubmit={submit}>
          <div className="two">
            <label className="field"><span>Name</span><input className="input" maxLength={32} value={name} onChange={(e) => setName(e.target.value)} placeholder="Old Oak" />{name && nameErr && <small className="down">{nameErr}</small>}</label>
            <label className="field"><span>Ticker</span><input className="input" maxLength={8} value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="OAK" />{ticker && tickerErr && <small className="down">{tickerErr}</small>}</label>
          </div>
          <label className="field"><span>Description</span><textarea className="input" rows={3} maxLength={280} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="What is this token about?" /></label>
          <label className="upload">
            <input type="file" accept="image/*" onChange={(e) => onFile(e.target.files?.[0])} />
            <Cover t={{ image, ticker: ticker || 'G', hue: 96 }} size={72} />
            <span><b>{image ? 'Change image' : 'Upload image'}</b><small className="muted block">Square works best. PNG, JPG or GIF, up to 2 MB.</small></span>
          </label>
          <div className="three">
            <label className="field"><span>X</span><input className="input" placeholder="https://x.com/…" value={x} onChange={(e) => setX(e.target.value)} /></label>
            <label className="field"><span>Telegram</span><input className="input" placeholder="https://t.me/…" value={tg} onChange={(e) => setTg(e.target.value)} /></label>
            <label className="field"><span>Website</span><input className="input" placeholder="https://…" value={web} onChange={(e) => setWeb(e.target.value)} /></label>
          </div>
          <details className="advanced">
            <summary>More options</summary>
            <div className="adv-body">
              <div className="field"><span>Trade fee</span><Slider label="Trade fee" min={0} max={5} step={0.5} value={fee} onChange={setFee} format={(v) => `${v}%`} marks={[0, 1, 2, 3, 4, 5]} /><small className="muted">You get 30% of it. It can't be changed after launch.</small></div>
              <label className="field"><span>Buy at launch (NEAR)</span><input className="input" inputMode="decimal" placeholder="0" value={buy} onChange={(e) => setBuy(e.target.value.replace(/[^0-9.]/g, ''))} /><small className="muted">Up to 10% of supply. Your share is shown on the token page.</small></label>
              <div className="field"><span>Share your rewards</span>
                <Tabs value={String(pct)} onChange={(v) => setPct(+v)} options={['0', '25', '50', '100'].map((v) => ({ id: v, label: v + '%' }))} />
                {pct > 0 && <Tabs value={to} onChange={setTo} options={[{ id: 'holders', label: 'To holders' }, { id: 'buyback', label: 'Buy back and burn' }]} />}
                <small className="muted">Fixed for the life of the token.</small>
              </div>
              <div className="field"><Check checked={gardener} onChange={setGardener}>Connect a gardener to manage dev rewards</Check><small className="muted">This can only be chosen now, at launch.</small></div>
            </div>
          </details>
          <div className="quote">
            <div className="row between"><span className="muted">Creation fee</span><span>{fmtNear(launchFee)}</span></div>
            <div className="row between"><b>Total</b><b>{fmtNear(cost)}</b></div>
          </div>
          {!me
            ? <button type="button" className="btn primary wide" onClick={() => setWalletOpen(true)}>Connect wallet</button>
            : <button className="btn primary wide" disabled={!ok}>{cost > balance ? 'Not enough NEAR' : 'Create token'}</button>}
        </form>
        <aside className="card preview">
          <div className="preview-tree"><Tree growth={0.02 + Math.min(0.06, (name.length + ticker.length) * 0.004)} sway /></div>
          <div className="row gap center-x">
            <Cover t={{ image, ticker: ticker || 'G', hue: 96 }} size={48} />
            <div><b>{name || 'Your token'}</b><small className="muted block">${ticker || 'TICKER'}</small></div>
          </div>
        </aside>
      </div>
    </Page>
  )
}
