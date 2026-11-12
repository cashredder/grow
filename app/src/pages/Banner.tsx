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
  let seed = 7
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }

  ctx.fillStyle = '#090b0a'; ctx.fillRect(0, 0, W, H)

  // A tree drawn once per growth stage, cropped to its outline, optionally dimmed for distance.
  const cache = new Map<string, { off: HTMLCanvasElement; x0: number; y0: number; w: number; h: number }>()
  const tree = (cap: number, twin: boolean, shape: number) => {
    const key = cap + ':' + twin + ':' + shape
    if (cache.has(key)) return cache.get(key)!
    const size = 700, off = document.createElement('canvas'); off.width = size; off.height = size
    const o = off.getContext('2d')!
    drawTree(o, growth(cap), size, size, twin, shape)
    const { data } = o.getImageData(0, 0, size, size)
    let x0 = size, x1 = 0, y0 = size, y1 = 0
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (data[(y * size + x) * 4 + 3] > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
    const v = { off, x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
    cache.set(key, v)
    return v
  }
  const plant = (cap: number, x: number, ground: number, height: number, dim: number, flip: boolean, twin = false) => {
    const a = tree(cap, twin, 100 + Math.floor(rand() * 9000)), w = (a.w * height) / a.h
    ctx.save()
    ctx.translate(x, 0); if (flip) ctx.scale(-1, 1)
    ctx.filter = dim ? `brightness(${1 - dim}) saturate(${1 - dim * 0.5})` : 'none'
    ctx.drawImage(a.off, a.x0, a.y0, a.w, a.h, -w / 2, ground - height, w, height)
    ctx.restore()
  }

  // 1. one huge line of type across the whole header
  const size = 150
  ctx.font = `500 ${size}px "Instrument Sans Variable", sans-serif`
  ;(ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${-0.04 * size}px`
  const svg = await (await fetch('/logo.svg')).text()
  const d = svg.match(/ d="([^"]+)"/)![1]
  const words = 'Let tokens '
  const textW = ctx.measureText(words).width
  const k = (size * 0.55) / 529 // wordmark x-height (529 units, r top to baseline) matched to the type
  const logoW = 2829.56 * k
  const startX = (W - textW - logoW) / 2, baseline = 236
  ctx.fillStyle = '#edf2ec'; ctx.textAlign = 'left'
  ctx.fillText(words, startX, baseline)
  ctx.save(); ctx.translate(startX + textW, baseline - 627 * k); ctx.scale(k, k); ctx.fillStyle = LIME; ctx.fill(new Path2D(d)); ctx.restore()

  // 2. a forest in front of the words: far trees dim and small, near trees full colour
  // Every tree has its own shape. Bases sit below the frame, so only the crowns rise into view.
  const caps = [90000, 160000, 300000, 600000, 1_000_000]
  const pick = () => caps[Math.floor(rand() * caps.length)]
  // three layers: a dim far ridge, a middle row, and a few near crowns; heights vary so the skyline rolls
  for (let i = 0; i < 10; i++) plant(pick(), (i / 9) * (W + 120) - 60 + (rand() - 0.5) * 60, 548, 170 + rand() * 105, 0.74, rand() > 0.5, rand() > 0.8)
  for (let i = 0; i < 7; i++) plant(pick(), (i / 6) * (W + 100) - 50 + (rand() - 0.5) * 80, 610, 220 + rand() * 90, 0.45, rand() > 0.5, rand() > 0.85)
  for (let i = 0; i < 5; i++) plant(pick(), (i / 4) * (W + 60) - 30 + (rand() - 0.5) * 70, 668, 250 + rand() * 60, 0, rand() > 0.5)

  // 3. leaves on the wind
  const colors = ['#2f6e1e', '#3f8820', '#55a322', '#6dbd21', '#86d41f']
  for (let i = 0; i < 40; i++) {
    const lx = rand() * W, ly = 16 + rand() * 260, s = 4 + rand() * 6, rot = rand() * Math.PI * 2
    if (lx > startX - 20 && lx < startX + textW + logoW + 20 && ly > baseline - 135 && ly < baseline + 50) continue // keep the words clean
    ctx.save(); ctx.translate(lx, ly); ctx.rotate(rot); ctx.scale(1, 0.3 + Math.abs(Math.cos(rot * 1.7)) * 0.7)
    ctx.globalAlpha = 0.5 + rand() * 0.5
    ctx.beginPath(); ctx.moveTo(-s, 0); ctx.quadraticCurveTo(0, s * 0.7, s, 0); ctx.quadraticCurveTo(0, -s * 0.7, -s, 0)
    ctx.fillStyle = colors[Math.floor(rand() * colors.length)]; ctx.fill(); ctx.restore()
  }
  ctx.globalAlpha = 1
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
