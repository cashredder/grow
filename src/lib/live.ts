// The site on the real contracts and API. Reads come from the API (and a few contract views), and every
// action is a wallet transaction or an API call. The data is shaped like the built-in market's, so pages work
// the same in both modes.
import { api, ApiError, session, setSession, streamUrl } from './api'
import { API_URL, LAUNCHPAD } from './config'
import { setNearUsd, type GardenerAction, type Token } from './engine'
import { failureText, fromUnits, fromYocto, nearBalance, units, view, yocto } from './chain'
import type { Call } from './near'

// The wallet libraries are large; they load on first use.
const wallet = () => import('./near')
const quickLib = () => import('./quick')
const call = async (c: Call) => (await wallet()).call(c)
const callMany = async (c: Call[]) => (await wallet()).callMany(c)
const signIn = async (id: string) => (await wallet()).signIn(id)
const signOut = async () => (await wallet()).signOut()
const signedInAccount = async () => (await wallet()).signedInAccount()
const signMessage = async (m: string, n: Uint8Array, r: string) => (await wallet()).signMessage(m, n, r)
import { DAY, getState, patch, toast, type AiDecision, type Copy, type Crossing, type Feed, type Hired, type House, type Lot, type NewToken, type Notice, type ProfileLinks } from './store'

// ---------------------------------------------------------------- shapes from the API

interface ApiToken {
  id: string; account: string; name: string; ticker: string; creator: string; co_dev: string | null; split_bps: number
  image: string | null; description: string | null; x: string | null; telegram: string | null; website: string | null
  fee_bps: number; redirect_pct: number; redirect_to: string; dev_vault: number | null; phase: string
  price: number; mcap: number; progress: number; volume: number; trades: number; holders: number
  dev_fees: number; holder_fees: number; burned_tokens: number; created_ts: number; graduated_ts: number | null
  merged_into: string | null; parents: [string, string] | null; spark?: number[]; change?: number
  near_reserve_raw: string; tok_reserve_raw: string; burned_raw: string
}
interface ApiVault {
  id: number; kind: string; owner: string; agent?: string; name: string; strategy: string; status: string; stop_reason?: string | null; art: string | null
  budget: number; cash: number; equity: number; peak: number; fire_bps: number; trades: number; wins: number; created_ts: number; fired_ts: number | null
  copiers?: number; drawdown_pct?: number; daily_limit?: number; expires_ts?: number; leader?: number | null; per_trade?: number; allowed?: string; key_id?: string | null
  positions?: { token_id: string; amount: string }[] | string
}

const hueOf = (s: string) => [...s].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % 160 + 40

export function toToken(a: ApiToken, prev?: Token): Token {
  const near = Number(BigInt(a.near_reserve_raw || '0')) / 1e24
  const tok = Number(BigInt(a.tok_reserve_raw || '0')) / 1e18
  const spark = a.spark ?? []
  const prices: [number, number][] = prev && prev.prices.length > spark.length ? prev.prices : spark.map((p, i) => [Date.now() - (spark.length - i) * 60_000, p])
  if (!prices.length) prices.push([a.created_ts, a.price])
  return {
    id: a.id, name: a.name, ticker: a.ticker, desc: a.description ?? '', image: a.image ?? undefined, hue: hueOf(a.id),
    dev: a.creator, coDev: a.co_dev ?? undefined, createdAt: a.created_ts, feePct: a.fee_bps / 100,
    phase: a.phase === 'Pool' ? 'pool' : 'curve', base: near, tok, supply: 1e9, burned: Number(BigInt(a.burned_raw || '0')) / 1e18,
    holders: prev?.holders ?? {}, holderCount: a.holders, rewardPool: a.holder_fees, devEarned: prev?.devEarned ?? a.dev_fees, devClaimed: prev?.devClaimed ?? 0,
    redirect: { pct: a.redirect_pct, to: a.redirect_to === 'buyback' ? 'buyback' : 'holders' }, gardener: a.dev_vault !== null, devVault: a.dev_vault ?? undefined,
    log: prev?.log ?? [], trades: prev?.trades ?? [], prices, parents: a.parents ?? undefined, split: a.co_dev ? a.split_bps / 100 : undefined, vestUntil: prev?.vestUntil,
    socials: { x: a.x ?? undefined, tg: a.telegram ?? undefined, web: a.website ?? undefined }, comments: prev?.comments ?? [], volume: a.volume, txns: a.trades, account: a.account,
  }
}

const statusOf = (v: ApiVault): House['status'] => (v.status === 'Fired' ? 'fired' : (v.drawdown_pct ?? (v.peak > 0 ? (1 - v.equity / v.peak) * 100 : 0)) >= 18 ? 'warning' : 'active')

function toHouse(v: ApiVault, prev?: House): House {
  return {
    id: String(v.id), name: v.name, art: v.art ?? 'sapling', strategy: v.strategy, status: statusOf(v), start: v.budget, equity: v.equity, peak: v.peak,
    trades: v.trades, wins: v.wins, hiredAt: v.created_ts, firedAt: v.fired_ts ?? undefined, history: prev?.history ?? [[v.created_ts, v.budget], [Date.now(), v.equity]],
    log: prev?.log ?? [], owner: v.kind === 'House' ? undefined : v.owner, copiers: v.copiers ?? 0,
  }
}

const KINDS: Record<string, string> = { buy: 'Buy', sell: 'Sell', buyback: 'Buyback', rewards: 'Holder rewards', pay_dev: 'Dev pay', ai_fee: 'AI fee' }
const DONE: Record<string, string> = { buy: 'Bought', sell: 'Sold', buyback: 'Bought back', rewards: 'Rewarded holders of', pay_dev: 'Paid the dev of' }

/** Gardener log rows. A note ending in "#ai<id>" came from a NEAR AI decision: the tag becomes a link to its proof. */
const logOf = (rows: { ts: number; ticker?: string; token_id: string; side: string; near: number; note: string | null }[]): GardenerAction[] =>
  rows.map((r, i) => {
    const m = (r.note ?? '').match(/\s*#ai(\d+)$/)
    const note = m ? (r.note ?? '').slice(0, m.index) : r.note
    return { id: r.ts + i, t: r.ts, kind: KINDS[r.side] ?? r.side, note: note || `${DONE[r.side] ?? r.side} $${r.ticker ?? r.token_id}`, near: r.near, tx: '', aiId: m ? Number(m[1]) : undefined }
  })

interface ApiAi { id: number; ts: number; kind: string; model: string; signing_address: string | null; signature_ok: boolean; attested: boolean; error: string | null; output: { decisions?: { token_id: string; buy: boolean; near?: number; fraction?: number; note: string }[]; actions?: { action: string; near: number; note: string }[] } | null }

const aiOf = (rows: ApiAi[] = []): AiDecision[] =>
  rows.map((d) => {
    const parts = d.kind === 'treasury'
      ? (d.output?.actions ?? []).map((a) => `${KINDS[a.action] ?? a.action} ${a.near} NEAR: ${a.note}`)
      : (d.output?.decisions ?? []).map((x) => `${x.buy ? `Buy ${x.token_id} for ${x.near} NEAR` : `Sell ${Math.round((x.fraction ?? 1) * 100)}% of ${x.token_id}`}: ${x.note}`)
    return { id: d.id, ts: d.ts, kind: d.kind, model: d.model, signing_address: d.signing_address, signature_ok: d.signature_ok, attested: d.attested, error: d.error, summary: d.error ? 'The model did not answer; the rules decided instead.' : parts.join(' · ') || 'Decided to wait.' }
  })

/** Where anyone can read a NEAR AI decision with its request, response and signature. */
export const aiProofUrl = (id: number) => `${API_URL}/v1/ai/decisions/${id}`

// ---------------------------------------------------------------- loading

function merge(list: ApiToken[]) {
  const tokens = { ...getState().tokens }
  for (const a of list) tokens[a.id] = toToken(a, tokens[a.id])
  patch({ tokens })
}

export async function loadTokens() {
  const [top, fresh] = await Promise.all([
    api<{ tokens: ApiToken[]; near_usd: number }>('/v1/tokens?tab=top&limit=100'),
    api<{ tokens: ApiToken[] }>('/v1/tokens?tab=new&limit=100'),
  ])
  setNearUsd(top.near_usd)
  const keep = new Set([...top.tokens, ...fresh.tokens].map((t) => t.id))
  const tokens: Record<string, Token> = {}
  for (const [id, t] of Object.entries(getState().tokens)) if (keep.has(id) || getState().lots[id]) tokens[id] = t
  patch({ tokens })
  merge([...top.tokens, ...fresh.tokens])
}

/** Everything the token page shows: details, recent trades for the chart, holders, comments, gardener log. */
export async function loadToken(id: string) {
  const [one, trades, holders, comments] = await Promise.all([
    api<{ token: ApiToken }>(`/v1/tokens/${encodeURIComponent(id)}`),
    api<{ trades: { id: number; account: string; side: 'buy' | 'sell'; near: number; tokens: number; price: number; ts: number }[] }>(`/v1/tokens/${encodeURIComponent(id)}/trades?limit=200`),
    api<{ holders: { account: string; balance: number }[] }>(`/v1/tokens/${encodeURIComponent(id)}/holders?limit=20`),
    api<{ comments: { id: number; account: string; text: string; ts: number }[] }>(`/v1/tokens/${encodeURIComponent(id)}/comments`),
  ])
  const prev = getState().tokens[id]
  const t = toToken(one.token, prev)
  t.trades = trades.trades.map((x) => ({ id: x.id, who: x.account, side: x.side, near: x.near, tokens: x.tokens, t: x.ts }))
  const pts = [...trades.trades].reverse().map((x) => [x.ts, x.price] as [number, number])
  if (pts.length) t.prices = pts
  t.holders = Object.fromEntries(holders.holders.map((h) => [h.account, h.balance]))
  t.comments = comments.comments.map((c) => ({ id: c.id, who: c.account, text: c.text, t: c.ts }))
  if (one.token.dev_vault !== null) {
    const g = await api<{ log: Parameters<typeof logOf>[0]; ai?: ApiAi[]; gardener: ApiVault }>(`/v1/gardeners/${one.token.dev_vault}`).catch(() => null)
    if (g) {
      t.log = logOf(g.log)
      t.treasury = { cash: g.gardener.cash, ai: aiOf(g.ai) }
    }
  }
  patch({ tokens: { ...getState().tokens, [id]: t } })
}

export async function loadGardeners() {
  const r = await api<{ gardeners: ApiVault[] }>('/v1/gardeners')
  const prev = new Map(getState().house.map((h) => [h.id, h]))
  patch({ house: r.gardeners.map((v) => toHouse(v, prev.get(String(v.id)))) })
}

export async function loadGardener(id: string) {
  const r = await api<{ gardener: ApiVault; log: Parameters<typeof logOf>[0]; history: { ts: number; equity: number }[]; ai?: ApiAi[] }>(`/v1/gardeners/${encodeURIComponent(id)}`)
  const h = toHouse(r.gardener)
  h.log = logOf(r.log)
  h.ai = aiOf(r.ai)
  if (r.history.length > 1) h.history = r.history.map((p) => [p.ts, p.equity])
  const house = getState().house.filter((x) => x.id !== h.id)
  patch({ house: [...house, h] })
}

export async function loadFeed() {
  const r = await api<{ feed: { token_id: string; ticker: string; account: string; side: string; near?: number; ts: number }[] }>('/v1/feed')
  patch({ feed: r.feed.map((f, i) => feedItem(f, i)) })
}

function feedItem(f: { token_id: string; ticker: string; account: string; side: string; near?: number; ts: number }, i: number): Feed {
  const text = f.side === 'new' ? `$${f.ticker} was just planted` : `${f.account} ${f.side === 'buy' ? 'bought' : 'sold'} $${f.ticker} for ${(f.near ?? 0).toFixed(1)} NEAR`
  return { id: f.ts * 100 + i, text, tokenId: f.token_id, side: f.side === 'new' ? 'new' : f.side === 'sell' ? 'sell' : 'buy', t: f.ts }
}

export interface Board {
  traders: { account: string; value: number }[]
  devs: { account: string; tokens: number; cap: number }[]
}
export async function loadBoard() {
  const [t, d] = await Promise.all([api<{ traders: Board['traders'] }>('/v1/leaderboard?tab=traders'), api<{ devs: Board['devs'] }>('/v1/leaderboard?tab=devs')])
  patch({ board: { traders: t.traders, devs: d.devs } })
}

export interface PublicUser {
  profile: { account: string; bio: string; avatar: string | null; x?: string | null; tg?: string | null; discord?: string | null }
  held: string[]
  created: string[]
}
export async function loadUser(account: string) {
  const r = await api<{ profile: PublicUser['profile']; held: ApiToken[]; created: ApiToken[] }>(`/v1/users/${encodeURIComponent(account)}`)
  merge([...r.held, ...r.created])
  patch({ users: { ...getState().users, [account]: { profile: r.profile, held: r.held.map((t) => t.id), created: r.created.map((t) => t.id) } } })
  return r
}

interface HoldInfo { balance: string; since_day: number; held_days: number; multiplier: number; claimable: string }
interface ChainToken { dev_earned: string; dev_claimed: string; vest_until_ms: number; split_bps: number }

/** The signed-in account: wallet, positions with live hold tiers and rewards, created tokens' dev rewards. */
export async function loadMe() {
  const me = getState().me
  if (!me) return
  const [balance, user] = await Promise.all([nearBalance(me).catch(() => getState().balance), loadUser(me).catch(() => null)])
  const lots: Record<string, Lot[]> = {}
  const rewards: Record<string, number> = {}
  if (user) {
    const infos = await Promise.all(user.held.map((t) => view<HoldInfo>(t.account, 'hold_info', { account_id: me }).catch(() => null)))
    user.held.forEach((t, i) => {
      const h = infos[i]
      if (!h) return
      // The contract keeps hold time in whole days. When that day is the day of the first buy, show the real
      // time of it instead of midnight (otherwise a fresh buy reads "20h ago").
      const since = (t as { held_since?: number }).held_since
      const start = since && Math.floor(since / DAY) === h.since_day ? since : h.since_day * DAY
      lots[t.id] = [{ amt: fromUnits(h.balance), t: start }]
      rewards[t.id] = fromYocto(h.claimable)
    })
    const tokens = { ...getState().tokens }
    await Promise.all(
      user.created.map(async (c) => {
        const ct = await view<ChainToken | null>(LAUNCHPAD, 'get_token', { token_id: c.id }).catch(() => null)
        if (ct && tokens[c.id]) tokens[c.id] = { ...tokens[c.id], devEarned: fromYocto(ct.dev_earned), devClaimed: fromYocto(ct.dev_claimed), vestUntil: Number(ct.vest_until_ms) || undefined }
      }),
    )
    const p = user.profile
    patch({ tokens, avatar: p.avatar || 'sapling', bio: p.bio || '', links: { x: p.x || undefined, tg: p.tg || undefined, discord: p.discord || undefined } })
  }
  const credits = await view<string>(LAUNCHPAD, 'credits_of', { account_id: me }).catch(() => '0')
  patch({ balance, lots, rewards, refEarned: fromYocto(credits), refClaimed: 0 })
  void loadQuick()
  const cr = await api<{ crossings: { id: number; a: string; b: string; split_bps: number; name: string; ticker: string; status: string; ends_ts: number; created_ts: number; proposer: string; partner: string }[] }>(`/v1/crossings?account=${encodeURIComponent(me)}`).catch(() => null)
  if (cr) patch({ crossings: cr.crossings.map((c): Crossing => ({ id: String(c.id), a: c.a, b: c.b, split: c.split_bps / 100, name: c.name, ticker: c.ticker, status: c.status === 'Proposed' ? 'waiting' : 'window', endsAt: c.ends_ts, createdAt: c.created_ts, proposer: c.proposer, partner: c.partner })) })
  if (session()?.account === me) await loadPrivate().catch(() => {})
}

/** Parts that need a signed-in session: notifications, API keys, own gardeners, invite stats. */
async function loadPrivate() {
  const [n, keys, mine, invite] = await Promise.all([
    api<{ notifications: { id: number; text: string; link: string; ts: number; seen: number }[]; unseen: number }>('/me/notifications'),
    api<{ keys: { id: string; name: string; hint: string; daily_limit: number; created: number }[] }>('/me/api-keys'),
    api<{ vaults: ApiVault[] }>('/me/gardeners'),
    api<{ code: string; invited: number; earned: number; available: number }>('/me/invite'),
  ])
  const notices: Notice[] = n.notifications.map((x) => ({ id: x.id, text: x.text, to: x.link, t: x.ts }))
  const hired: Hired[] = []
  const copies: Copy[] = []
  for (const v of mine.vaults) {
    if (v.kind === 'Copy') {
      copies.push({ id: String(v.id), agentId: String(v.leader), perTrade: v.per_trade ?? 0, budget: v.budget, stopLoss: v.fire_bps / 100, pnl: v.equity - v.budget, trades: v.trades, stopped: v.status !== 'Active', startedAt: v.created_ts, log: [] })
    } else if (v.kind === 'User') {
      hired.push({
        id: String(v.id), name: v.name, strategy: v.strategy, budget: v.budget, dailyLimit: v.daily_limit ?? 0, stopLoss: v.fire_bps / 100, until: v.expires_ts || Date.now() + 365 * DAY,
        allowed: (v.allowed ?? '').includes('PoolOnly') ? 'graduated' : 'all', paused: v.status === 'Paused', fired: v.status === 'Fired', pnl: v.equity - v.budget, trades: v.trades, wins: v.wins,
        createdAt: v.created_ts, history: [[v.created_ts, v.budget], [Date.now(), v.equity]], log: [], apiKeyId: v.key_id ?? undefined,
      })
    }
  }
  patch({
    notices, seenNotices: notices.length - n.unseen, hired, copies,
    apiKeys: keys.keys.map((k) => ({ id: k.id, name: k.name, hint: k.hint, createdAt: k.created, dailyLimit: k.daily_limit })),
    refCode: invite.code, invited: invite.invited, refEarned: invite.earned, refClaimed: Math.max(0, invite.earned - invite.available),
  })
}

// ---------------------------------------------------------------- session

const PENDING = 'grow.pending-login'

/** Signs in to the API with a NEP-413 message, once per 30 days. Needed for profile, comments and keys. */
export async function ensureSession(): Promise<boolean> {
  const me = getState().me
  if (!me) return false
  if (session()?.account === me) return true
  const n = await api<{ nonce: string; message: string; recipient: string }>('/auth/nonce')
  try {
    sessionStorage.setItem(PENDING, n.nonce)
  } catch {
    // fine: browser wallets that redirect will need another try
  }
  const signed = await signMessage(n.message, Uint8Array.from(atob(n.nonce), (c) => c.charCodeAt(0)), n.recipient)
  if (!signed) return false
  await finishLogin({ ...signed, nonce: n.nonce })
  return true
}

async function finishLogin(b: { accountId: string; publicKey: string; signature: string; nonce: string }) {
  const r = await api<{ token: string; account: string; expires: number }>('/auth/login', { method: 'POST', json: b })
  setSession(r)
  try {
    sessionStorage.removeItem(PENDING)
  } catch {
    // ignore
  }
  await loadPrivate().catch(() => {})
}

/** A wallet that redirects for signMessage comes back with the signature in the URL fragment. */
async function resumeLogin() {
  const h = new URLSearchParams(location.hash.slice(1))
  const signature = h.get('signature'), publicKey = h.get('publicKey'), accountId = h.get('accountId')
  let nonce: string | null = null
  try {
    nonce = sessionStorage.getItem(PENDING)
  } catch {
    nonce = null
  }
  if (!signature || !publicKey || !accountId || !nonce) return
  history.replaceState(null, '', location.pathname + location.search)
  await finishLogin({ accountId, publicKey, signature, nonce }).catch((e) => toast(String(e.message || e), 'err'))
}

async function needSession(): Promise<boolean> {
  try {
    if (await ensureSession()) return true
    toast('Your wallet could not sign the sign-in message', 'err')
  } catch (e) {
    toast(String((e as Error).message || e), 'err')
  }
  return false
}

// ---------------------------------------------------------------- start

let started = false
export function startLive() {
  if (started) return
  started = true
  const refresh = () => Promise.all([loadTokens(), loadFeed(), loadGardeners()]).catch(() => {})
  void refresh()
  void signedInAccount().then(async (me) => {
    if (me) {
      patch({ me })
      await loadMe().catch(() => {})
      await resumeLogin()
    }
  })
  // Live feed: new trades and launches refresh the lists (at most once every 2 s).
  let pending: ReturnType<typeof setTimeout> | undefined
  const open = () => {
    let ws: WebSocket
    try {
      ws = new WebSocket(streamUrl())
    } catch {
      return
    }
    ws.onmessage = (m) => {
      try {
        const items = JSON.parse(String(m.data)) as { type: string; data: { token_id: string; ticker: string; account: string; side: string; near: number; ts: number } }[]
        const fresh = items.filter((i) => i.type === 'trade' || i.type === 'token_created').map((i, k) => feedItem({ ...i.data, side: i.type === 'token_created' ? 'new' : i.data.side }, k))
        if (fresh.length) patch({ feed: [...fresh.reverse(), ...getState().feed].slice(0, 30) })
      } catch {
        // not JSON
      }
      clearTimeout(pending)
      pending = setTimeout(() => {
        void loadTokens().catch(() => {})
        if (getState().me) void loadMe().catch(() => {})
      }, 2000)
    }
    ws.onclose = () => setTimeout(open, 5000)
  }
  open()
  setInterval(() => {
    if (!document.hidden) void refresh()
  }, 30_000)
}

// ---------------------------------------------------------------- actions

async function run(label: string, f: () => Promise<unknown>, after?: () => Promise<unknown>) {
  try {
    await f()
    toast(label)
    await after?.()
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : failureText((e as Error).message ?? e)
    if (!/reject|cancel|closed/i.test(String((e as Error).message))) toast(msg === 'The transaction failed' ? String((e as Error).message || msg) : msg, 'err')
  }
}

const refreshAll = (tokenId?: string) => Promise.all([loadMe(), tokenId ? loadToken(tokenId) : loadTokens()])

export async function connectWith(walletId: string) {
  try {
    const me = await signIn(walletId)
    if (!me) return
    patch({ me, walletOpen: false })
    toast('Wallet connected')
    await loadMe()
    // One signature proves the wallet to the API (profile, comments, keys). Skipping it only limits those.
    await ensureSession().catch(() => false)
  } catch (e) {
    toast(String((e as Error).message || 'Could not connect'), 'err')
  }
}

export async function disconnectLive() {
  await signOut().catch(() => {})
  setSession(null)
  patch({ me: null, lots: {}, rewards: {}, hired: [], copies: [], apiKeys: [], notices: [], crossings: [] })
}

let referrer: string | null = null
export async function applyRefLive(code: string) {
  const r = await api<{ referrer: string }>(`/ref/${encodeURIComponent(code)}`).catch(() => null)
  if (r) referrer = r.referrer
}

const STORAGE = 1_250_000_000_000_000_000_000n

async function registered(tokenAccount: string, me: string) {
  return !!(await view<unknown>(tokenAccount, 'storage_balance_of', { account_id: me }).catch(() => null))
}

// ---------------------------------------------------------------- quick trading

const versions: Record<string, number> = {}
/** Tokens launched before quick trading cannot sell through the launchpad (version 1). */
async function tokenVersion(account: string): Promise<number> {
  versions[account] ??= await view<number>(account, 'grow_token_version').catch(() => 1)
  return versions[account]
}

export async function loadQuick() {
  const me = getState().me
  if (!me) return patch({ quick: undefined })
  const [kp, bal] = await Promise.all([(await quickLib()).quickKey(me).catch(() => null), view<string>(LAUNCHPAD, 'trade_balance_of', { account_id: me }).catch(() => '0')])
  patch({ quick: { on: !!kp, balance: fromYocto(bal) } })
}

/** Adds the key (first time) and deposits `near` NEAR into the trading balance: one wallet approval. */
export function quickTurnOn(near: number) {
  const me = getState().me!
  void run(getState().quick?.on ? 'Added to your trading balance' : 'Quick trading is on', async () => {
    await (await quickLib()).enableQuick(me, yocto(near))
  }, () => Promise.all([loadQuick(), loadMe()]))
}

export function quickWithdraw() {
  void run('The trading balance is back in your wallet', async () => {
    await call({ receiver: LAUNCHPAD, method: 'withdraw_trade', args: {}, deposit: 1n, tgas: 30 })
  }, () => Promise.all([loadQuick(), loadMe()]))
}

/** Withdraws the balance and removes the key from the account, in one approval. */
export function quickTurnOff() {
  const me = getState().me!
  void run('Quick trading is off', async () => {
    const q = await quickLib()
    const kp = await q.quickKey(me)
    const { callMany } = await wallet()
    const { actionCreators } = await import('@near-js/transactions')
    const calls: Call[] = []
    if ((getState().quick?.balance ?? 0) > 0) calls.push({ receiver: LAUNCHPAD, method: 'withdraw_trade', args: {}, deposit: 1n, tgas: 30 })
    if (kp) calls.push({ receiver: me, raw: [actionCreators.deleteKey(kp.getPublicKey())] })
    if (calls.length) await callMany(calls)
    q.forget(me)
  }, () => Promise.all([loadQuick(), loadMe()]))
}

export function buy(id: string, near: number, minOut: number) {
  const s = getState()
  const t = s.tokens[id]
  const me = s.me!
  void run(`Bought $${t.ticker}`, async () => {
    const reg = await registered(t.account!, me)
    const cost = near + (reg ? 0 : fromYocto(STORAGE))
    if (s.quick?.on && s.quick.balance >= cost) {
      await (await quickLib()).quickCall(me, 'quick_buy', { token_id: id, amount: (yocto(near) + (reg ? 0n : STORAGE)).toString(), min_out: units(minOut).toString(), referrer: referrer && referrer !== me ? referrer : null }, 150)
      return
    }
    await call({ receiver: LAUNCHPAD, method: 'buy', args: { token_id: id, min_out: units(minOut).toString(), referrer: referrer && referrer !== me ? referrer : null }, deposit: yocto(near) + (reg ? 0n : STORAGE), tgas: 150 })
  }, () => refreshAll(id))
}

export function sell(id: string, tokens: number, minOut: number) {
  const s = getState()
  const t = s.tokens[id]
  const me = s.me!
  void run(`Sold $${t.ticker}`, async () => {
    // Selling (almost) everything sends the exact balance, so no dust is left behind.
    const held = (s.lots[id] ?? []).reduce((n, l) => n + l.amt, 0)
    const amount = tokens >= held * 0.9999 ? await view<string>(t.account!, 'ft_balance_of', { account_id: me }) : units(tokens).toString()
    if (s.quick?.on && (await tokenVersion(t.account!)) >= 2) {
      // The NEAR goes to the trading balance, ready for the next quick buy.
      await (await quickLib()).quickCall(me, 'quick_sell', { token_id: id, amount, min_out: yocto(minOut).toString() }, 200)
      return
    }
    await call({ receiver: t.account!, method: 'ft_transfer_call', args: { receiver_id: LAUNCHPAD, amount, msg: JSON.stringify({ action: 'sell', min_out: yocto(minOut).toString(), referrer: referrer && referrer !== me ? referrer : null }) }, deposit: 1n, tgas: 150 })
  }, () => refreshAll(id))
}

export function swapLive(from: string, to: string, amount: number, outMin: number, midNear: number) {
  if (from === 'near') return buy(to, amount, outMin)
  if (to === 'near') return sell(from, amount, outMin)
  // Token to token: sell for NEAR, then buy with what the sale returns at worst.
  const s = getState()
  const a = s.tokens[from], b = s.tokens[to]
  void run('Swap sent', async () => {
    const reg = await registered(b.account!, s.me!)
    await callMany([
      { receiver: a.account!, method: 'ft_transfer_call', args: { receiver_id: LAUNCHPAD, amount: units(amount).toString(), msg: JSON.stringify({ action: 'sell', min_out: yocto(midNear).toString() }) }, deposit: 1n, tgas: 150 },
      { receiver: LAUNCHPAD, method: 'buy', args: { token_id: to, min_out: units(outMin).toString(), referrer: null }, deposit: yocto(midNear) + (reg ? 0n : STORAGE), tgas: 150 },
    ])
  }, () => refreshAll())
}

export function claimRewardLive(id: string) {
  const t = getState().tokens[id]
  void run('Reward claimed', () => call({ receiver: t.account!, method: 'claim_rewards', args: {}, tgas: 30 }), loadMe)
}

export function claimAllLive() {
  const s = getState()
  const calls: Call[] = Object.entries(s.rewards).filter(([id, v]) => v > 0 && s.tokens[id]).map(([id]) => ({ receiver: s.tokens[id].account!, method: 'claim_rewards', args: {}, tgas: 30 }))
  if (!calls.length) return
  void run('Rewards claimed', () => callMany(calls), loadMe)
}

export const claimDevLive = (id: string) => void run('Dev rewards claimed', () => call({ receiver: LAUNCHPAD, method: 'claim_dev', args: { token_id: id }, tgas: 30 }), loadMe)
export const claimRefLive = () => void run('Referral earnings claimed', () => call({ receiver: LAUNCHPAD, method: 'claim_credits', args: {}, tgas: 30 }), loadMe)

interface Config { create_fee: string; token_storage: string }
let config: Config | null = null
const getConfig = async () => (config ??= await view<Config>(LAUNCHPAD, 'get_config'))

export async function createCost(devBuy: number): Promise<number> {
  const c = await getConfig()
  return fromYocto(BigInt(c.create_fee) + BigInt(c.token_storage)) + devBuy + (devBuy > 0 ? 0.00125 : 0)
}

/** Picture and metadata go to the API (content-addressed), then one transaction launches the token. */
export function createTokenLive(n: NewToken, onDone: (id: string) => void, onFail?: () => void) {
  const me = getState().me!
  void run(`$${n.ticker.toUpperCase()} is live`, async () => {
    try {
    if (!(await needSession())) throw new Error('Sign in to upload the picture')
    let image: string | undefined
    if (n.image?.startsWith('data:')) {
      const blob = await (await fetch(n.image)).blob()
      const form = new FormData()
      form.append('file', blob, 'image')
      image = (await api<{ url: string }>('/upload', { method: 'POST', body: form })).url
    }
    const meta = await api<{ reference: string; reference_hash: string }>('/meta', { method: 'POST', json: { name: n.name, ticker: n.ticker, description: n.desc, image, x: n.socials.x, telegram: n.socials.tg, website: n.socials.web } })
    const c = await getConfig()
    const deposit = BigInt(c.create_fee) + BigInt(c.token_storage) + yocto(n.devBuy) + (n.devBuy > 0 ? STORAGE : 0n)
    await call({
      receiver: LAUNCHPAD,
      method: 'create_token',
      args: { args: { name: n.name.trim(), ticker: n.ticker.trim().toUpperCase(), reference: meta.reference, reference_hash: meta.reference_hash, fee_bps: Math.round(n.feePct * 100), redirect_pct: n.redirect.pct, redirect_to: n.redirect.to, gardener: n.gardener, dev_buy: n.devBuy > 0 ? yocto(n.devBuy).toString() : null } },
      deposit,
      tgas: 300,
    })
    } catch (e) {
      onFail?.()
      throw e
    }
  }, async () => {
    // The indexer picks the launch up within seconds; open its page once it is there.
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 2000))
      const u = await api<{ created: ApiToken[] }>(`/v1/users/${encodeURIComponent(me)}`).catch(() => null)
      const t = u?.created.find((x) => x.ticker === n.ticker.trim().toUpperCase())
      if (t) {
        merge([t])
        onDone(t.id)
        return
      }
    }
    onFail?.()
  })
}

export function proposeCrossLive(a: string, b: string, split: number, name: string, ticker: string) {
  void run('Crossing proposal sent', async () => {
    const c = await getConfig()
    await call({ receiver: LAUNCHPAD, method: 'propose_cross', args: { a, b, split_bps: Math.round(split * 100), name: name.trim(), ticker: ticker.trim().toUpperCase(), reference: null }, deposit: BigInt(c.token_storage), tgas: 50 })
  }, loadMe)
}
export const cancelCrossLive = (id: string) => void run('Crossing cancelled', () => call({ receiver: LAUNCHPAD, method: 'cancel_cross', args: { cross_id: Number(id) }, tgas: 30 }), loadMe)
export const acceptCrossLive = (id: string) => void run('Crossing accepted. Holders can exit now.', () => call({ receiver: LAUNCHPAD, method: 'accept_cross', args: { cross_id: Number(id) }, tgas: 30 }), loadMe)

export function hireLive(name: string, strategy: string, budget: number, dailyLimit: number, stopLoss: number, days: number, allowed: Hired['allowed'], apiKeyId?: string) {
  void run(`${name.trim()} started`, async () => {
    const id = await call({
      receiver: LAUNCHPAD,
      method: 'create_vault',
      args: { name: name.trim(), strategy: apiKeyId ? 'custom' : strategy, agent: null, daily_limit: yocto(dailyLimit).toString(), stop_loss_bps: Math.round(stopLoss * 100), allowed: allowed === 'graduated' ? 'PoolOnly' : 'All', days: Math.max(1, Math.min(365, Math.round(days))) },
      deposit: yocto(budget),
      tgas: 50,
    })
    if (apiKeyId && typeof id === 'number' && (await needSession())) {
      // The vault appears in the API a few seconds after the transaction.
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 2000))
        const ok = await api(`/me/api-keys/${apiKeyId}/vaults`, { method: 'POST', json: { vault_id: id } }).then(() => true, () => false)
        if (ok) break
      }
    }
  }, async () => {
    await loadMe()
    await loadGardeners()
  })
}

export const copyLive = (agentId: string, perTrade: number, budget: number, stopLoss: number) =>
  void run('Copying started', () => call({ receiver: LAUNCHPAD, method: 'copy_vault', args: { leader_id: Number(agentId), per_trade: yocto(perTrade).toString(), stop_loss_bps: Math.round(stopLoss * 100) }, deposit: yocto(budget), tgas: 50 }), loadMe)

export const closeVaultLive = (id: string) => void run('Stopped. The NEAR and coins are back in your wallet.', () => call({ receiver: LAUNCHPAD, method: 'close_vault', args: { vault_id: Number(id) }, tgas: 300 }), loadMe)
export const pauseVaultLive = (id: string, paused: boolean) => void run(paused ? 'Paused' : 'Resumed', () => call({ receiver: LAUNCHPAD, method: 'set_vault_paused', args: { vault_id: Number(id), paused }, tgas: 30 }), loadMe)

export async function saveProfileLive(p: { avatar: string; bio: string; links: ProfileLinks }) {
  if (!(await needSession())) return
  await run('Profile saved', () => api('/me/profile', { method: 'PUT', json: p }), loadMe)
}

export async function commentLive(id: string, text: string) {
  if (!(await needSession())) return
  try {
    await api(`/tokens/${encodeURIComponent(id)}/comments`, { method: 'POST', json: { text } })
    await loadToken(id)
  } catch (e) {
    toast(String((e as Error).message), 'err')
  }
}

export async function favoriteLive(id: string, on: boolean) {
  if (!(await needSession())) return
  await api(`/tokens/${encodeURIComponent(id)}/favorite`, { method: on ? 'PUT' : 'DELETE' }).catch((e) => toast(String(e.message), 'err'))
}

export async function createKeyLive(name: string, dailyLimit: number): Promise<string> {
  if (!(await needSession())) return ''
  try {
    const r = await api<{ key: string }>('/me/api-keys', { method: 'POST', json: { name, daily_limit: dailyLimit } })
    await loadPrivate()
    return r.key
  } catch (e) {
    toast(String((e as Error).message), 'err')
    return ''
  }
}

export async function revokeKeyLive(id: string) {
  if (!(await needSession())) return
  await run('Key revoked. Its gardeners no longer take orders from it.', () => api(`/me/api-keys/${id}`, { method: 'DELETE' }), loadPrivate)
}

export async function seenLive() {
  if (session()?.account === getState().me) await api('/me/notifications/seen', { method: 'POST' }).catch(() => {})
}
