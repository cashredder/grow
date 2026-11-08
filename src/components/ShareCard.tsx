// Share: draws a square card of a token (its tree as it is now in a window, then its picture, ticker, full
// name, market cap, holders and price change) and offers it to download, copy, share or post.
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

/** The square card as a PNG: the tree in its window, then the token and its numbers. */
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

  // The window: a night sky over a strip of soil, the tree standing on it.
  const P = 48, WX = P, WY = P, WW = W - 2 * P, WH = 600
  ctx.save()
  roundRect(ctx, WX, WY, WW, WH, 36)
  ctx.clip()
  const sky = ctx.createLinearGradient(0, WY, 0, WY + WH)
  sky.addColorStop(0, '#121b13')
  sky.addColorStop(1, '#1a2a17')
  ctx.fillStyle = sky
  ctx.fillRect(WX, WY, WW, WH)
  const glow = ctx.createRadialGradient(W / 2, WY + WH * 0.55, 10, W / 2, WY + WH * 0.55, WW * 0.55)
  glow.addColorStop(0, 'rgba(134, 224, 30, 0.24)')
  glow.addColorStop(1, 'rgba(134, 224, 30, 0)')
  ctx.fillStyle = glow
  ctx.fillRect(WX, WY, WW, WH)
  const ground = WY + WH - 64
  ctx.fillStyle = '#3b2a1b'
  ctx.fillRect(WX, ground, WW, WH)
  ctx.fillStyle = '#4c3623'
  ctx.fillRect(WX, ground, WW, 10)
  const size = 1000
  const off = document.createElement('canvas')
  off.width = size
  off.height = size
  const o = off.getContext('2d')!
  drawTree(o, growth(capUsd(t)), size, size, !!t.parents)
  // Crop to the tree itself and scale it to fill most of the window, standing on the soil.
  const { data } = o.getImageData(0, 0, size, size)
  let x0 = size, x1 = 0, y0 = size, y1 = 0
  for (let y = 0; y < size; y += 2) for (let x = 0; x < size; x += 2) if (data[(y * size + x) * 4 + 3] > 24) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
  if (x1 > x0 && y1 > y0) {
    const w = x1 - x0 + 2, h = y1 - y0 + 2
    const k = Math.min((WH - 64 - 70) / h, (WW - 120) / w, 6)
    ctx.drawImage(off, x0, y0, w, h, W / 2 - (w * k) / 2, ground + 6 - h * k, w * k, h * k)
  }
  ctx.restore()

  // The token: its picture, ticker and full name.
  const IY = WY + WH + 44
  const cover = await coverImage(t.image)
  ctx.save()
  roundRect(ctx, P, IY, 112, 112, 26)
  ctx.clip()
  if (cover) ctx.drawImage(cover, P, IY, 112, 112)
  else {
    ctx.fillStyle = LIME
    ctx.fillRect(P, IY, 112, 112)
    ctx.fillStyle = '#0b100c'
    ctx.font = font(700, 42)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(t.ticker.slice(0, 2), P + 56, IY + 58)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
  }
  ctx.restore()
  const TX = P + 112 + 28, TW = W - P - TX
  fitText(ctx, `$${t.ticker}`, TX, IY + 56, TW, 700, 60, INK)
  fitText(ctx, t.name, TX, IY + 100, TW, 500, 32, MID)

  // The numbers.
  const change = recentChange(t)
  const stats: [string, string, string][] = [
    ['Market cap', fmtUsd(capUsd(t)), INK],
    ['Holders', String(holderCount(t)), INK],
    ['Change', `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`, change >= 0 ? LIME : '#ff6b5e'],
  ]
  const SY = IY + 156, col = (W - 2 * P) / stats.length
  stats.forEach(([label, value, color], i) => {
    const x = P + i * col
    ctx.fillStyle = FAINT
    ctx.font = font(500, 24)
    ctx.fillText(label, x, SY + 26)
    fitText(ctx, value, x, SY + 76, col - 24, 700, 46, color)
  })

  // Footer: the logo and what grow. is.
  const FY = H - P - 4
  const logo = await logoImage()
  if (logo) ctx.drawImage(logo, P, FY - 34, 112, 34)
  else {
    ctx.fillStyle = LIME
    ctx.font = font(800, 36)
    ctx.fillText('grow.', P, FY)
  }
  ctx.fillStyle = FAINT
  ctx.font = font(500, 22)
  ctx.textAlign = 'right'
  ctx.fillText('Every token is a tree · on NEAR', W - P, FY - 6)
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
            <small className="muted">On X, attach the downloaded card to your post.</small>
          </div>
        </div>
      )}
    </>
  )
}
