// Share: draws a square card of a token (its tree in a square window, then its picture, ticker, full name
// and its numbers as tiles) and offers it to download, copy, share or post.
import { useEffect, useState } from 'react'
import { capUsd, growth, holderCount, type Token } from '../lib/engine'
import { toast } from '../lib/store'
import { drawTree } from './Tree'
import { ICONS, Icon, fmtUsd, recentChange, useExit } from './ui'

const W = 1080, H = 1080
const LIME = '#86E01E'
const INK = '#edf2ec', MID = '#98a59b', FAINT = '#6c776f'

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

async function logoImage(): Promise<HTMLImageElement | null> {
  try {
    const svg = await (await fetch('/logo.svg')).text()
    const img = new Image()
    // The logo file is a mask shape; paint it lime for the card.
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace(/fill="[^"]*"/g, `fill="${LIME}"`).replace('<svg', `<svg fill="${LIME}"`))
    await img.decode()
    return img
  } catch {
    return null
  }
}

async function coverImage(src?: string): Promise<HTMLImageElement | null> {
  if (!src) return null
  try {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = src
    await img.decode()
    return img
  } catch {
    return null
  }
}

const font = (w: number, px: number) => `${w} ${px}px "Instrument Sans Variable", system-ui, sans-serif`

/** Draws text, shrinking it until it fits `max` pixels. */
function fitText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, max: number, weight: number, px: number, color: string) {
  let size = px
  ctx.font = font(weight, size)
  while (size > 18 && ctx.measureText(text).width > max) {
    size -= 2
    ctx.font = font(weight, size)
  }
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
}

/** The square card as a PNG: the tree in its square window, then the token and its numbers. */
export async function renderShareCard(t: Token): Promise<Blob> {
  const scale = 2
  const c = document.createElement('canvas')
  c.width = W * scale
  c.height = H * scale
  const ctx = c.getContext('2d')!
  ctx.scale(scale, scale)
  await Promise.all([document.fonts.load('700 64px "Instrument Sans Variable"'), document.fonts.load('500 24px "Instrument Sans Variable"')])

  ctx.fillStyle = '#0b100c'
  ctx.fillRect(0, 0, W, H)

  // The window: a square of black with green grass, the tree standing in it.
  const P = 48, S = 560, WX = (W - S) / 2, WY = P
  ctx.save()
  roundRect(ctx, WX, WY, S, S, 40)
  ctx.clip()
  ctx.fillStyle = '#000'
  ctx.fillRect(WX, WY, S, S)
  const ground = WY + S - 70
  const size = 1000
  const off = document.createElement('canvas')
  off.width = size
  off.height = size
  const o = off.getContext('2d')!
  drawTree(o, growth(capUsd(t)), size, size, !!t.parents)
  // Crop to the tree itself and scale it to fill most of the window, rooted in the grass.
  const { data } = o.getImageData(0, 0, size, size)
  let x0 = size, x1 = 0, y0 = size, y1 = 0
  for (let y = 0; y < size; y += 2) for (let x = 0; x < size; x += 2) if (data[(y * size + x) * 4 + 3] > 24) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
  if (x1 > x0 && y1 > y0) {
    const w = x1 - x0 + 2, h = y1 - y0 + 2
    const k = Math.min((S - 70 - 60) / h, (S - 90) / w, 6)
    ctx.drawImage(off, x0, y0, w, h, W / 2 - (w * k) / 2, ground + 14 - h * k, w * k, h * k)
  }
  // Grass: a green strip with blades along its top, drawn over the tree's base.
  const grass = ctx.createLinearGradient(0, ground, 0, WY + S)
  grass.addColorStop(0, '#5fbf1c')
  grass.addColorStop(1, '#2d7a0e')
  ctx.fillStyle = grass
  ctx.fillRect(WX, ground + 8, S, S)
  let seed = 7
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (let x = WX - 4; x < WX + S + 4; x += 7) {
    const h = 10 + rnd() * 18, lean = (rnd() - 0.5) * 8
    ctx.fillStyle = rnd() > 0.5 ? '#6fd11f' : '#55ad18'
    ctx.beginPath()
    ctx.moveTo(x - 4, ground + 12)
    ctx.quadraticCurveTo(x + lean * 0.4, ground + 4 - h * 0.4, x + lean, ground + 10 - h)
    ctx.quadraticCurveTo(x + lean * 0.6 + 2, ground + 4 - h * 0.3, x + 5, ground + 12)
    ctx.closePath()
    ctx.fill()
  }
  ctx.restore()

  // The token: its picture, ticker and full name, centred under the window.
  const IY = WY + S + 40, CV = 96
  ctx.font = font(700, 56)
  const tickerW = Math.min(ctx.measureText(`$${t.ticker}`).width, 560)
  ctx.font = font(500, 30)
  const nameW = Math.min(ctx.measureText(t.name).width, 560)
  const groupW = CV + 24 + Math.max(tickerW, nameW)
  const GX = (W - groupW) / 2
  const cover = await coverImage(t.image)
  ctx.save()
  roundRect(ctx, GX, IY, CV, CV, 24)
  ctx.clip()
  if (cover) ctx.drawImage(cover, GX, IY, CV, CV)
  else {
    ctx.fillStyle = LIME
    ctx.fillRect(GX, IY, CV, CV)
    ctx.fillStyle = '#0b100c'
    ctx.font = font(700, 38)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(t.ticker.slice(0, 2), GX + CV / 2, IY + CV / 2 + 2)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
  }
  ctx.restore()
  fitText(ctx, `$${t.ticker}`, GX + CV + 24, IY + 50, 560, 700, 56, INK)
  fitText(ctx, t.name, GX + CV + 24, IY + 90, 560, 500, 30, MID)

  // The numbers, as tiles like the ones on the home page.
  const change = recentChange(t)
  const stats: [string, string, string][] = [
    ['Market cap', fmtUsd(capUsd(t)), INK],
    ['Holders', String(holderCount(t)), INK],
    ['Change', `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`, change >= 0 ? LIME : '#ff6b5e'],
  ]
  const TY = IY + CV + 36, GAP = 16, TH = 124, TW = (W - 2 * P - GAP * 2) / 3
  stats.forEach(([label, value, color], i) => {
    const x = P + i * (TW + GAP)
    ctx.fillStyle = '#151a16'
    roundRect(ctx, x, TY, TW, TH, 26)
    ctx.fill()
    ctx.textAlign = 'center'
    ctx.fillStyle = MID
    ctx.font = font(500, 24)
    ctx.fillText(label, x + TW / 2, TY + 44)
    let px = 44
    ctx.font = font(700, px)
    while (px > 24 && ctx.measureText(value).width > TW - 32) {
      px -= 2
      ctx.font = font(700, px)
    }
    ctx.fillStyle = color
    ctx.fillText(value, x + TW / 2, TY + 96)
    ctx.textAlign = 'left'
  })

  // Footer: the logo and what grow. is.
  const FY = H - P + 4
  const logo = await logoImage()
  if (logo) ctx.drawImage(logo, P, FY - 52, 170, 52)
  else {
    ctx.fillStyle = LIME
    ctx.font = font(800, 54)
    ctx.fillText('grow.', P, FY)
  }
  ctx.fillStyle = FAINT
  ctx.font = font(500, 22)
  ctx.textAlign = 'right'
  ctx.fillText('Every token is a tree', W - P, FY - 7)
  ctx.textAlign = 'left'

  return await new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('could not draw the card'))), 'image/png'))
}

/** The Share button and its window with the card. */
export function ShareButton({ t }: { t: Token }) {
  const [open, setOpen] = useState(false)
  const [png, setPng] = useState<{ blob: Blob; url: string } | null>(null)
  const { visible, leaving } = useExit(open)
  useEffect(() => {
    if (!open) return
    let url = ''
    let alive = true
    renderShareCard(t).then((blob) => {
      if (!alive) return
      url = URL.createObjectURL(blob)
      setPng({ blob, url })
    }, () => toast('Could not draw the card', 'err'))
    return () => {
      alive = false
      if (url) URL.revokeObjectURL(url)
      setPng(null)
    }
    // Drawn once per opening: the numbers are those of the moment you share.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const page = `${location.origin}/token/${t.id}`
  const text = `$${t.ticker} is growing on grow. · ${fmtUsd(capUsd(t))} market cap, ${holderCount(t)} holders`
  const file = png ? new File([png.blob], `${t.ticker.toLowerCase()}-grow.png`, { type: 'image/png' }) : null
  const canShare = !!file && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })
  const copy = async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png!.blob })])
      toast('Card copied')
    } catch {
      toast('Your browser cannot copy images. Download it instead.', 'err')
    }
  }
  return (
    <>
      <button className="social-btn" onClick={() => setOpen(true)}><Icon d={ICONS.share} size={16} />Share</button>
      {visible && (
        <div className={`modal-back ${leaving ? 'leaving' : ''}`} onPointerDown={(e) => { if (e.target === e.currentTarget) setOpen(false) }}>
          <div className="modal share-modal" role="dialog" aria-modal="true" aria-label={`Share $${t.ticker}`}>
            <div className="row between"><h2>Share ${t.ticker}</h2><button className="btn icon" aria-label="Close" onClick={() => setOpen(false)}><Icon d={ICONS.x} /></button></div>
            <div className="share-preview">{png ? <img src={png.url} alt={`$${t.ticker} card: its tree, market cap, holders and change`} /> : <div className="skeleton" />}</div>
            <div className="share-actions">
              {png && <a className="btn primary small" href={png.url} download={`${t.ticker.toLowerCase()}-grow.png`}>Download</a>}
              {png && <button className="btn ghost small" onClick={copy}>Copy image</button>}
              {canShare && <button className="btn ghost small" onClick={() => navigator.share({ files: [file!], title: `$${t.ticker} on grow.`, text, url: page }).catch(() => {})}>Share…</button>}
              <a className="btn ghost small" href={`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(page)}`} target="_blank" rel="noreferrer">Post on X</a>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
