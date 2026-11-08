// Share: draws a 1200×630 card of a token (its tree as it is now, the ticker and name, market cap and
// holders) and offers it to download, copy, share or post.
import { useEffect, useState } from 'react'
import { capUsd, growth, holderCount, type Token } from '../lib/engine'
import { toast } from '../lib/store'
import { drawTree } from './Tree'
import { ICONS, Icon, fmtUsd, useExit } from './ui'

const W = 1200, H = 630
const LIME = '#86E01E'

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

/** The card as a PNG. */
export async function renderShareCard(t: Token): Promise<Blob> {
  const scale = 2
  const c = document.createElement('canvas')
  c.width = W * scale
  c.height = H * scale
  const ctx = c.getContext('2d')!
  ctx.scale(scale, scale)
  await Promise.all([document.fonts.load('700 64px "Instrument Sans Variable"'), document.fonts.load('500 24px "Instrument Sans Variable"')])
  const font = (w: number, px: number) => `${w} ${px}px "Instrument Sans Variable", system-ui, sans-serif`

  // Background: deep green night with a soft glow behind the tree.
  const bg = ctx.createLinearGradient(0, 0, W, H)
  bg.addColorStop(0, '#0b100c'); bg.addColorStop(1, '#121a13')
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H)
  const glow = ctx.createRadialGradient(340, 360, 20, 340, 360, 330)
  glow.addColorStop(0, 'rgba(134, 224, 30, 0.22)'); glow.addColorStop(1, 'rgba(134, 224, 30, 0)')
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H)

  // The tree as it is now, standing on the bottom edge of its half.
  const size = 1000
  const off = document.createElement('canvas'); off.width = size; off.height = size
  drawTree(off.getContext('2d')!, growth(capUsd(t)), size, size, !!t.parents)
  ctx.drawImage(off, 340 - 300, 630 - 600 + 12, 600, 600)

  // Text column.
  const x = 680
  const cover = await coverImage(t.image)
  if (cover) {
    ctx.save(); roundRect(ctx, x, 150, 76, 76, 18); ctx.clip(); ctx.drawImage(cover, x, 150, 76, 76); ctx.restore()
  } else {
    ctx.fillStyle = LIME; roundRect(ctx, x, 150, 76, 76, 18); ctx.fill()
    ctx.fillStyle = '#0b100c'; ctx.font = font(700, 30); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(t.ticker.slice(0, 2), x + 38, 189)
    ctx.textAlign = 'left'
  }
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = '#edf2ec'; ctx.font = font(700, 64)
  ctx.fillText(`$${t.ticker}`, x, 300, W - x - 60)
  ctx.fillStyle = '#98a59b'; ctx.font = font(500, 28)
  ctx.fillText(t.name, x, 342, W - x - 60)

  const stat = (label: string, value: string, sx: number) => {
    ctx.fillStyle = '#98a59b'; ctx.font = font(500, 22); ctx.fillText(label, sx, 418)
    ctx.fillStyle = '#edf2ec'; ctx.font = font(700, 44); ctx.fillText(value, sx, 466)
  }
  stat('Market cap', fmtUsd(capUsd(t)), x)
  stat('Holders', String(holderCount(t)), x + 250)

  // Footer: logo and where to find it.
  const logo = await logoImage()
  if (logo) ctx.drawImage(logo, x, 538, 104, 32)
  else { ctx.fillStyle = LIME; ctx.font = font(800, 34); ctx.fillText('grow.', x, 566) }
  ctx.fillStyle = '#6c776f'; ctx.font = font(500, 20)
  ctx.fillText('Every token is a tree · NEAR', x + 120, 562)

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
            <div className="share-preview">{png ? <img src={png.url} alt={`$${t.ticker} card: its tree, market cap and holders`} /> : <div className="skeleton" />}</div>
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
