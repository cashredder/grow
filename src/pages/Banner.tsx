import { useEffect, useRef, useState } from 'react'
import { drawTree } from '../components/Tree'
import { growth } from '../lib/engine'

// Development only: draws the X (Twitter) header and saves it through the dev server.
const W = 1500, H = 500, SCALE = 2
const LIME = '#86E01E'

async function render(c: HTMLCanvasElement) {
  const ctx = c.getContext('2d')!
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0)
  await document.fonts.load('500 40px "Instrument Sans Variable"')

  ctx.fillStyle = '#090b0a'; ctx.fillRect(0, 0, W, H)

  // The same tree at five ages. Sizes grow by one constant ratio, and each tree is measured
  // by its dense outline (stray leaves ignored), so the gaps between crowns are truly equal.
  const ground = 472, GAP = 26, RIGHT = 1480
  const caps = [3000, 15000, 60000, 250000, 1_000_000]
  const big = 410, ratio = 1.78
  const art = caps.map((cap) => {
    const size = 900
    const off = document.createElement('canvas'); off.width = size; off.height = size
    const o = off.getContext('2d')!
    drawTree(o, growth(cap), size, size)
    const { data } = o.getImageData(0, 0, size, size)
    const cols = new Array(size).fill(0), rows = new Array(size).fill(0)
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (data[(y * size + x) * 4 + 3] > 24) { cols[x]++; rows[y]++ }
    const edge = (arr: number[], share: number) => { const lim = Math.max(...arr) * share; const first = arr.findIndex((v) => v >= lim); let last = arr.length - 1; while (last > 0 && arr[last] < lim) last--; return [first, last] }
    const [x0, x1] = edge(cols, 0.1)
    const [y0] = edge(rows, 0.1)
    let y1 = size - 1; while (y1 > 0 && rows[y1] === 0) y1--
    return { off, x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
  })
  const heights = caps.map((_, i) => big / ratio ** (caps.length - 1 - i))
  const widths = art.map((a, i) => (a.w * heights[i]) / a.h)
  let tx = RIGHT - widths.reduce((n, w) => n + w, 0) - GAP * (caps.length - 1)
  const boxes = art.map((a, i) => {
    const h = heights[i], w = widths[i], k = h / a.h
    // draw the whole tree, positioned by its dense outline
    ctx.drawImage(a.off, tx - a.x0 * k, ground - h - a.y0 * k, a.off.width * k, a.off.height * k)
    const box = { x: tx, y: ground - h, w, h }
    tx += w + GAP
    return box
  })

  // leaves falling, like the site's animation when a token's cap drops
  let seed = 41
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  const colors = ['#2f6e1e', '#3f8820', '#55a322', '#6dbd21', '#86d41f']
  for (let placed = 0, tries = 0; placed < 46 && tries < 400; tries++) {
    const lx = 40 + rand() * (W - 80), ly = 24 + rand() * (H - 70)
    if (lx < 620 && ly > 110 && ly < 400) continue // keep the slogan clear
    const sp = boxes[0]
    if (lx > sp.x - 40 && lx < sp.x + sp.w + 40 && ly > sp.y - 40) continue // and the sprout
    if (lx < 600 && rand() < 0.55) continue // fewer on the left, most fall near the trees
    const s = 4.5 + rand() * 6.5, rot = rand() * Math.PI * 2
    ctx.save(); ctx.translate(lx, ly); ctx.rotate(rot); ctx.scale(1, 0.3 + Math.abs(Math.cos(rot * 1.7)) * 0.7)
    ctx.globalAlpha = 0.55 + rand() * 0.45
    ctx.beginPath(); ctx.moveTo(-s, 0); ctx.quadraticCurveTo(0, s * 0.7, s, 0); ctx.quadraticCurveTo(0, -s * 0.7, -s, 0)
    ctx.fillStyle = colors[Math.floor(rand() * colors.length)]; ctx.fill()
    ctx.restore()
    placed++
  }
  ctx.globalAlpha = 1

  // slogan: "Let tokens" in the heading style, then "grow." as the wordmark itself
  const size = 104
  ctx.textAlign = 'left'
  ctx.fillStyle = '#edf2ec'
  ctx.font = `500 ${size}px "Instrument Sans Variable", sans-serif`
  ;(ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${-0.035 * size}px`
  const x = 70, line1 = 214
  ctx.fillText('Let tokens', x, line1)
  const svg = await (await fetch('/logo.svg')).text()
  const d = svg.match(/ d="([^"]+)"/)![1]
  const k = 470 / 2829.56 // wordmark width in px
  const baseline = 627 // logo units: bottom of r, o, w and the dot
  const line2 = line1 + 132
  ctx.save(); ctx.translate(x + 4, line2 - baseline * k); ctx.scale(k, k); ctx.fillStyle = LIME; ctx.fill(new Path2D(d)); ctx.restore()
}

export default function Banner() {
  const ref = useRef<HTMLCanvasElement>(null)
  const [status, setStatus] = useState('Drawing…')
  useEffect(() => {
    const c = ref.current!
    render(c).then(async () => {
      const big = c.toDataURL('image/png')
      const small = document.createElement('canvas'); small.width = W; small.height = H
      const s = small.getContext('2d')!; s.imageSmoothingQuality = 'high'; s.drawImage(c, 0, 0, W, H)
      for (const [name, url] of [['grow-banner@2x.png', big], ['grow-banner.png', small.toDataURL('image/png')]]) {
        await fetch(`/__save?name=${encodeURIComponent(name)}`, { method: 'POST', body: url })
      }
      setStatus('Saved grow-banner.png and grow-banner@2x.png')
    }, (e) => setStatus('Failed: ' + e))
  }, [])
  return (
    <div style={{ padding: 16 }}>
      <p id="banner-status">{status}</p>
      <canvas ref={ref} width={W * SCALE} height={H * SCALE} style={{ width: '100%', maxWidth: W, display: 'block' }} />
    </div>
  )
}
