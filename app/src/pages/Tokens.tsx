import { useDeferredValue, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Page, PageTabs, TokenRow } from '../components/ui'
import { capUsd, progress } from '../lib/engine'
import { useS } from '../lib/store'

type Tab = 'trending' | 'top' | 'new' | 'close' | 'pool' | 'watch'
const TABS: { id: Tab; label: string }[] = [{ id: 'trending', label: 'Trending' }, { id: 'top', label: 'Top' }, { id: 'new', label: 'New' }, { id: 'close', label: 'Near pool' }, { id: 'pool', label: 'In pool' }, { id: 'watch', label: 'Watchlist' }]

export default function Tokens() {
  const tokens = useS((s) => s.tokens)
  const favorites = useS((s) => s.favorites)
  const [params] = useSearchParams()
  const [q, setQ] = useState('')
  const [tab, setTab] = useState<Tab>((params.get('tab') as Tab) || 'trending')
  const dq = useDeferredValue(q.trim().toLowerCase())
  const list = useMemo(() => {
    const all = Object.values(tokens).filter((t) => !dq || t.name.toLowerCase().includes(dq) || t.ticker.toLowerCase().includes(dq) || t.id.includes(dq))
    switch (tab) {
      case 'trending': return all.sort((a, b) => b.volume - a.volume)
      case 'top': return all.sort((a, b) => capUsd(b) - capUsd(a))
      case 'new': return all.sort((a, b) => b.createdAt - a.createdAt)
      case 'close': return all.filter((t) => t.phase === 'curve').sort((a, b) => progress(b) - progress(a))
      case 'pool': return all.filter((t) => t.phase === 'pool').sort((a, b) => capUsd(b) - capUsd(a))
      case 'watch': return all.filter((t) => favorites.includes(t.id))
    }
  }, [tokens, dq, tab, favorites])
  const empty = tab === 'watch' ? 'Tap the star on any token to follow it here.' : 'Try another name, or launch this one yourself.'
  return (
    <Page title="Tokens" action={<Link to="/create" className="btn primary">Create token</Link>}>
      <PageTabs value={tab} onChange={setTab} options={TABS} />
      <div className="toolbar">
        <input className="input" type="search" placeholder="Search name, ticker or address" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search tokens" />
      </div>
      {list.length
        ? <div className="card list" key={tab}>
            <div className="list-head"><span /><span>Token</span><span>Cap</span><span>Change</span><span className="hide-m">Volume</span><span className="hide-m">Holders</span><span className="hide-m">Trend</span><span className="hide-m">To pool</span></div>
            {list.map((t, i) => <TokenRow key={t.id} t={t} i={i} />)}
          </div>
        : <div className="card empty-card"><h2>Nothing here yet</h2><p className="muted">{empty}</p><Link to="/create" className="btn primary">Create token</Link></div>}
    </Page>
  )
}
