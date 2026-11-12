import { memo, useEffect, useRef } from 'react'

/*
 * A procedural oak drawn on canvas.
 * The final tree is generated once. `growth` (0..1) reveals it: limbs extend, thicken and leaf out.
 * The painted tree is cached, so sway is a cheap transform of one bitmap.
 */
interface Limb { pts: number[]; birth: number; dur: number; depth: number; root?: boolean }
interface Leaf { x: number; y: number; cos: number; sin: number; size: number; tone: number; birth: number; death: number; back: boolean }
interface Model { limbs: Limb[]; leaves: Leaf[]; streaks: { off: number; from: number; to: number }[]; halfW: number; top: number }

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function build(twin: boolean, seed?: number): Model {
  const r = rng(seed ?? (twin ? 41 : 11))
  const limbs: Limb[] = []
  const leaves: Leaf[] = []
  const MAX = 5

  // Extra leaves come from their own generator, so the grown tree keeps its shape.
  const extra = rng(twin ? 77 : 23)
  const addLeaves = (x: number, y: number, count: number, spread: number, birth: number, death: number, size: number, rand = r, jitter = 0.05) => {
    const bias = (rand() - 0.5) * 1.5
    for (let i = 0; i < count; i++) {
      const a = rand() * 6.283
      const d = Math.sqrt(rand()) * spread
      const dx = Math.cos(a) * d
      const dy = Math.sin(a) * d * 0.82
      // light from the upper left, per cluster, so the crown reads as clumps
      const lit = (-dx * 0.55 - dy * 0.85) / spread + (-(y + dy) / 1000) * 2.4 + (-(x + dx) / 1000) * 0.7 + bias + (rand() - 0.5) * 1.3
      const ang = rand() * 6.283
      leaves.push({
        x: x + dx, y: y + dy, cos: Math.cos(ang), sin: Math.sin(ang), size: size * (0.8 + rand() * 0.5),
        tone: Math.max(0, Math.min(6, Math.round(lit + 2.2))), birth: birth + rand() * jitter, death, back: rand() < 0.38,
      })
    }
  }

  const grow = (x: number, y: number, angle: number, len: number, rad: number, depth: number, birth: number, base = true) => {
    const steps = depth === 0 ? 12 : Math.max(4, 8 - depth)
    const end = rad * (depth === 0 ? 0.58 : 0.62)
    const dur = depth === 0 ? 0.15 : 0.085
    const pts: number[] = []
    let a = angle
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      // The trunk flares where it meets the ground (not where two trunks join into one).
      const flare = depth === 0 && base ? 1 + 0.75 * Math.exp(-t * 11) : 1
      pts.push(x, y, (rad + (end - rad) * t) * flare)
      a += (r() - 0.5) * (depth === 0 ? 0.11 : 0.34)
      if (depth >= 3) a += a > 0 ? 0.015 : -0.015 // tips droop outward
      x += (Math.sin(a) * len) / steps
      y -= (Math.cos(a) * len) / steps
    }
    limbs.push({ pts, birth, dur, depth })
    // When a limb's growing tip passes a point along it, matching how `paint` eases the limb out.
    const passes = (p: number) => birth + dur * (1 - (1 - p) ** (1 / 3)) - 0.012

    // Young limbs carry leaves that drop as the crown fills out.
    if (depth >= 1 && depth <= 2) {
      for (let i = 2; i <= steps; i += 2) {
        addLeaves(pts[i * 3], pts[i * 3 + 1], 12, 42, passes(i / steps), 0.46 + depth * 0.08, 24, r, 0.012)
      }
    }
    // Thin limbs leaf out as they extend, so a young tree never shows bare twigs.
    if (depth >= 3) {
      for (let i = 1; i < steps; i += 2) {
        addLeaves(pts[i * 3], pts[i * 3 + 1], depth === 3 ? 7 : depth === 4 ? 5 : 3, 30, passes(i / steps), 0.68, 20, extra, 0)
      }
    }
    if (depth >= 3) {
      const count = depth === MAX ? 24 : 10
      for (let i = depth === MAX ? steps : steps - 1; i <= steps; i++) {
        addLeaves(pts[i * 3], pts[i * 3 + 1], count, depth === MAX ? 76 : 60, passes(0.8), 9, 17, r, 0.02)
      }
    }
    if (depth >= MAX) return

    const kids = depth === 0 ? 4 : depth === 1 ? 3 : r() > 0.4 ? 2 : 3
    for (let k = 0; k < kids; k++) {
      const place = depth === 0 ? 0.68 + r() * 0.32 : 0.5 + r() * 0.5
      const i = Math.round(place * steps)
      // Main limbs fan out evenly so the crown stays round; smaller ones vary.
      const side = depth === 0 ? ((k + 0.5) / kids - 0.5) * 1.95 + (r() - 0.5) * 0.14 : (k % 2 ? 1 : -1) * (0.26 + r() * 0.58)
      const spread = depth === 0 ? side : side * 0.92
      const childLen = len * (depth === 0 ? 0.76 - Math.abs(((k + 0.5) / kids - 0.5)) * 0.18 : 0.7 + r() * 0.14)
      grow(pts[i * 3], pts[i * 3 + 1], angle + spread, childLen, Math.max(1.5, end * (0.66 + r() * 0.24)), depth + 1, birth + (dur * i) / steps)
    }
  }

  // Roots spread along the ground once the tree is old enough.
  const addRoot = (dir: number, reach: number, rad: number, off: number) => {
    const pts: number[] = []
    const steps = 7
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      pts.push(off + dir * reach * t, -rad * 1.2 * (1 - t) ** 2 + 13 * t * t + (r() - 0.5) * 3, Math.max(0.3, rad * (1 - t) ** 0.8))
    }
    limbs.push({ pts, birth: 0.42 + r() * 0.1, dur: 0.38, depth: 0, root: true })
  }
  if (twin) {
    // A crossed token: one tree whose trunk forks low into two trunks that rise side by side, slightly apart,
    // under one shared crown (a twin-stem tree).
    for (const [d, w] of [[-1, 1], [1, 1], [-1, 0.6], [1, 0.6], [1, 0.4]]) addRoot(d, (150 + r() * 80) * w, 28 * (0.5 + w * 0.5), d * 22 * w)
    const FORK = 62
    const pts: number[] = []
    for (let i = 0; i <= 6; i++) {
      const t = i / 6
      pts.push(0, -FORK * t, (62 + (54 - 62) * t) * (1 + 0.7 * Math.exp(-t * 9)))
    }
    limbs.push({ pts, birth: 0, dur: 0.05, depth: 0 })
    grow(-13, -FORK + 8, -0.15, 250, 35, 0, 0.04, false)
    grow(13, -FORK + 8, 0.15, 250, 35, 0, 0.04, false)
  } else {
    for (const [d, w] of [[-1, 1], [1, 1], [-1, 0.6], [1, 0.6], [1, 0.4]]) addRoot(d, (140 + r() * 80) * w, 26 * (0.5 + w * 0.5), d * 20 * w)
    grow(0, 0, 0, 280, 55, 0, 0)
  }

  // Draw back leaves first, then by age for stable overlap.
  const streaks = Array.from({ length: 13 }, () => ({ off: r() * 1.7 - 0.85, from: r() * 0.5, to: 0.35 + r() * 0.6 }))
  let halfW = 0, top = 0
  for (const l of leaves) { halfW = Math.max(halfW, Math.abs(l.x)); top = Math.max(top, -l.y) }
  return { limbs, leaves, streaks, halfW: halfW + 24, top: top + 24 }
}

const cache: Record<string, Model> = {}
const model = (twin: boolean) => (cache[String(twin)] ??= build(twin))

const clamp = (v: number) => Math.max(0, Math.min(1, v))
const ease = (v: number) => 1 - (1 - v) ** 3
const mix = (a: number, b: number, t: number) => a + (b - a) * t
const hex = (c: number[]) => `rgb(${c.map((v) => Math.round(v)).join(',')})`

const FRONT = ['#24591c', '#2f6e1e', '#3f8820', '#55a322', '#6dbd21', '#86d41f', '#a2e545']
const BACK = ['#173f16', '#1d4c18', '#245a1b', '#2b681d', '#33761e', '#3a831f', '#428f21']
const BASE_DIP = 0.5
const STEM = [122, 170, 62], BARK = [86, 65, 47], BARK_D = [40, 29, 21], BARK_L = [146, 118, 88]

/** How far the tree reaches right now, so a small tree can be framed to fill its card. */
function reach(m: Model, g: number, S: number) {
  let top = 0, half = 0
  for (const b of m.limbs) {
    const f = ease(clamp((b.depth === 0 && !b.root ? 0.38 : 0) + (g - b.birth) / b.dur))
    if (f <= 0.003) continue
    const n = Math.min(b.pts.length / 3 - 1, Math.ceil(f * (b.pts.length / 3 - 1)))
    for (let i = 0; i <= n; i++) { top = Math.max(top, -b.pts[i * 3 + 1]); half = Math.max(half, Math.abs(b.pts[i * 3])) }
  }
  for (const l of m.leaves) {
    if (g <= l.birth || g >= l.death + 0.1) continue
    top = Math.max(top, -l.y + l.size); half = Math.max(half, Math.abs(l.x) + l.size)
  }
  // the sprout's first leaves reach past the tip of the stem
  const young = Math.max(0, 1 - clamp((g - 0.11) / 0.1))
  return { top: top + (62 * young) / S, half: half + (62 * young) / S }
}

/** Paints the whole tree in world units with the base at the origin. */
function paint(ctx: CanvasRenderingContext2D, m: Model, g: number, W: number, H: number, fill: boolean, framed: boolean) {
  const fit = Math.max(0.01, Math.min((H - 44) / m.top, W / (m.halfW * 2)))
  const zoom = mix(2.9, 1, ease(clamp(g / 0.3)))
  const unit = fit * zoom
  const S = 0.42 + 0.58 * g ** 0.8
  const baseY = H - 30
  const thick = 0.075 + 0.925 * g ** 1.18
  // `fill` lets a mature tree use the whole canvas instead of waiting for $1M.
  let px = unit * (fill ? mix(S, 1, clamp(g / 0.45)) : S)
  if (framed) {
    const r = reach(m, g, S)
    px = Math.min(fit * 3, (H - 60) / Math.max(1, r.top), (W - 28) / Math.max(1, r.half * 2))
  }

  ctx.clearRect(0, 0, W, H)

  ctx.save()
  ctx.translate(W / 2, baseY)
  ctx.scale(px, px)

  const tones = (list: string[], back: boolean) => {
    const size = 1 / S ** 0.62
    const paths = list.map(() => new Path2D())
    for (const l of m.leaves) {
      if (l.back !== back || g <= l.birth || g >= l.death + 0.1) continue
      const k = ease(clamp((g - l.birth) / 0.07)) * (g > l.death ? 1 - (g - l.death) / 0.1 : 1)
      if (k < 0.04) continue
      const s = l.size * k * size
      const c = l.cos * s, n = l.sin * s
      const p = paths[l.tone]
      p.moveTo(l.x - c, l.y - n)
      p.quadraticCurveTo(l.x - n * 0.62, l.y + c * 0.62, l.x + c, l.y + n)
      p.quadraticCurveTo(l.x + n * 0.62, l.y - c * 0.62, l.x - c, l.y - n)
    }
    paths.forEach((p, i) => { ctx.fillStyle = list[i]; ctx.fill(p) })
  }

  tones(BACK, true)

  // limbs
  const greenness = 1 - clamp((g - 0.05) / 0.22)
  const bark = hex(BARK.map((v, i) => mix(v, STEM[i], greenness)))
  const dark = hex(BARK_D.map((v, i) => mix(v, STEM[i] * 0.55, greenness)))
  const light = hex(BARK_L.map((v, i) => mix(v, STEM[i] * 1.25, greenness)))
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const tips: [number, number][] = []
  for (const b of m.limbs) {
    const started = b.depth === 0 && !b.root ? 0.38 : 0
    const f = ease(clamp(started + (g - b.birth) / b.dur))
    if (f <= 0.003) continue
    const n = b.pts.length / 3 - 1
    const reach = f * n
    const last = Math.floor(reach)
    const left: number[] = [], right: number[] = []
    let tipX = 0, tipY = 0
    const centre: number[] = []
    for (let i = 0; i <= last + 1 && i <= n; i++) {
      let x = b.pts[i * 3], y = b.pts[i * 3 + 1], rad = b.pts[i * 3 + 2] * thick
      if (i > reach) {
        const t = reach - last
        x = b.pts[last * 3] + (x - b.pts[last * 3]) * t
        y = b.pts[last * 3 + 1] + (y - b.pts[last * 3 + 1]) * t
        rad *= t
      }
      const j = Math.min(n, i + 1), h = Math.max(0, i - 1)
      const dx = b.pts[j * 3] - b.pts[h * 3], dy = b.pts[j * 3 + 1] - b.pts[h * 3 + 1]
      const l = Math.hypot(dx, dy) || 1
      left.push(x - (dy / l) * rad, y + (dx / l) * rad)
      right.push(x + (dy / l) * rad, y - (dx / l) * rad)
      centre.push(x, y, rad, dy / l, -dx / l)
      tipX = x; tipY = y
    }
    ctx.beginPath()
    ctx.moveTo(left[0], left[1])
    for (let i = 2; i < left.length; i += 2) ctx.lineTo(left[i], left[i + 1])
    for (let i = right.length - 2; i >= 0; i -= 2) ctx.lineTo(right[i], right[i + 1])
    // The trunk settles into the ground on a rounded base.
    if (b.depth === 0 && !b.root) ctx.quadraticCurveTo(centre[0], centre[1] + centre[2] * BASE_DIP, left[0], left[1])
    ctx.closePath()
    ctx.fillStyle = bark
    ctx.fill()

    // round shading on anything thick enough to see
    const vis = (centre[2] || 0) * px
    if (vis > 1.6) {
      // Shading follows the limb's own taper and stays inside its outline.
      const strip = (side: number, color: string, alpha: number, width: number) => {
        ctx.strokeStyle = color
        ctx.globalAlpha = alpha
        for (let i = 0; i + 5 < centre.length; i += 5) {
          ctx.beginPath()
          ctx.moveTo(centre[i] + centre[i + 3] * centre[i + 2] * side, centre[i + 1] + centre[i + 4] * centre[i + 2] * side)
          ctx.lineTo(centre[i + 5] + centre[i + 8] * centre[i + 7] * side, centre[i + 6] + centre[i + 9] * centre[i + 7] * side)
          ctx.lineWidth = centre[i + 2] * width
          ctx.stroke()
        }
        ctx.globalAlpha = 1
      }
      ctx.save()
      ctx.clip()
      strip(0.52, dark, 0.5, 0.82)
      strip(-0.56, light, 0.34, 0.42)
      if (b.depth === 0 && !b.root && vis > 7) {
        ctx.strokeStyle = dark
        ctx.lineWidth = 2.1
        ctx.globalAlpha = 0.42
        for (const st of m.streaks) {
          ctx.beginPath()
          const count = centre.length / 5
          const a = Math.floor(st.from * count), z = Math.floor(st.to * count)
          for (let i = a; i < z; i++) {
            const o = i * 5
            const w = Math.sin(i * 1.9 + st.off * 7) * 0.05
            const x = centre[o] + centre[o + 3] * centre[o + 2] * (st.off + w)
            const y = centre[o + 1] + centre[o + 4] * centre[o + 2] * (st.off + w)
            if (i > a) ctx.lineTo(x, y); else ctx.moveTo(x, y)
          }
          ctx.stroke()
        }
        ctx.globalAlpha = 1
      }
      ctx.restore()
    }
    if (b.depth === 0 && !b.root) tips.push([tipX, tipY])
  }

  tones(FRONT, false)

  // the first true leaves of the sprout
  const young = 1 - clamp((g - 0.11) / 0.1)
  if (young > 0) {
    const pair = (tx: number, ty: number) => {
      const blades: [number, number, number][] = [[-1, -0.95, 1], [1, 0.95, 1]]
      for (const [side, ang, scale] of blades) {
        const len = 62 * scale * young / S
        ctx.save()
        ctx.translate(tx, ty)
        ctx.rotate(ang)
        ctx.beginPath()
        ctx.moveTo(0, 0)
        ctx.bezierCurveTo(side * len * 0.34, -len * 0.28, side * len * 0.3, -len * 0.84, 0, -len)
        ctx.bezierCurveTo(-side * len * 0.3, -len * 0.84, -side * len * 0.3, -len * 0.28, 0, 0)
        const grad = ctx.createLinearGradient(-len * 0.3, -len, len * 0.3, 0)
        grad.addColorStop(0, '#a2e545')
        grad.addColorStop(1, '#4f9c20')
        ctx.fillStyle = grad
        ctx.fill()
        ctx.beginPath()
        ctx.moveTo(0, 0)
        ctx.lineTo(0, -len * 0.9)
        ctx.strokeStyle = 'rgba(40,90,20,.45)'
        ctx.lineWidth = 1.3 / S
        ctx.stroke()
        ctx.restore()
      }
    }
    tips.forEach(([x, y]) => pair(x, y))
  }
  ctx.restore()
  return { baseY, px }
}

interface Fall { x: number; y: number; vx: number; vy: number; rot: number; spin: number; life: number; size: number; color: string }
const motionOK = () => !matchMedia('(prefers-reduced-motion: reduce)').matches

function Tree({ growth, twin = false, sway = false, fill = false, framed = false, className }: { growth: number; twin?: boolean; sway?: boolean; fill?: boolean; framed?: boolean; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const target = useRef(growth)
  const wake = useRef<(dir?: number) => void>(() => {})

  useEffect(() => {
    const dir = growth > target.current ? 1 : growth < target.current ? -1 : 0
    target.current = growth
    wake.current(dir)
  }, [growth])

  useEffect(() => {
    const c = ref.current!
    const ctx = c.getContext('2d')!
    const buf = document.createElement('canvas')
    const bctx = buf.getContext('2d')!
    const m = model(twin)
    const motion = motionOK()
    // A tree on view grows from a sprout when the page opens.
    let g = sway && motion ? 0 : target.current, painted = -1
    let W = 0, H = 0, dpr = 1, baseY = 0, px = 1
    let raf = 0, last = 0, lastPaint = 0, visible = true
    let bend = 0, bendV = 0
    let falling: Fall[] = []

    const repaint = () => {
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const start = performance.now()
      const r = paint(bctx, m, g, W, H, fill, framed)
      if (import.meta.env.DEV) (window as unknown as { __tree?: unknown }).__tree = { leaves: m.leaves.length, ms: performance.now() - start }
      baseY = r.baseY; px = r.px; painted = g
    }

    const present = (t: number) => {
      const ambient = sway && motion ? Math.sin(t / 2100) * 0.0065 + Math.sin(t / 830) * 0.0022 : 0
      const k = (ambient + bend) * clamp(g * 3)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, c.width, c.height)
      ctx.setTransform(1, 0, -k, 1, k * baseY * dpr, 0)
      ctx.drawImage(buf, 0, 0)
      if (falling.length) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        for (const f of falling) {
          ctx.save()
          ctx.globalAlpha = clamp(f.life * 2.2)
          ctx.translate(f.x, f.y)
          ctx.rotate(f.rot)
          ctx.scale(1, Math.abs(Math.cos(f.rot * 0.7)) * 0.7 + 0.3)
          ctx.beginPath()
          ctx.moveTo(-f.size, 0)
          ctx.quadraticCurveTo(0, f.size * 0.7, f.size, 0)
          ctx.quadraticCurveTo(0, -f.size * 0.7, -f.size, 0)
          ctx.fillStyle = f.color
          ctx.fill()
          ctx.restore()
        }
      }
    }

    const frame = (t: number) => {
      raf = 0
      const dt = Math.min(50, t - (last || t - 16))
      if (sway && motion && t - last < 28 && g === target.current && !falling.length) { schedule(); return }
      last = t
      if (g !== target.current) {
        g += (target.current - g) * (1 - Math.exp(-dt / 620))
        if (Math.abs(target.current - g) < 0.00015) g = target.current
      }
      // Skip repaints too small to see: most trades barely change the shape.
      if (Math.abs(g - painted) > 0.0012 && t - lastPaint > 40) { repaint(); lastPaint = t }
      // a damped spring: a trade feels like a gust of wind
      bendV += (-bend * 0.0009 - bendV * 0.0045) * dt
      bend += bendV * dt
      if (Math.abs(bend) < 0.00005 && Math.abs(bendV) < 0.000005) { bend = 0; bendV = 0 }
      falling = falling.filter((f) => {
        f.life -= dt / 2600
        f.vy = Math.min(1.1, f.vy + 0.002 * dt)
        f.x += (f.vx + Math.sin(f.life * 11) * 0.5) * (dt / 16)
        f.y += f.vy * (dt / 16)
        f.rot += f.spin * (dt / 16)
        return f.life > 0 && f.y < baseY + 2
      })
      present(t)
      if (g !== target.current || falling.length || bend !== 0 || (sway && motion)) schedule()
    }
    function schedule() { if (!raf && visible && !document.hidden) raf = requestAnimationFrame(frame) }

    wake.current = (dir = 0) => {
      if (motion && dir) {
        bendV += dir * 0.000028 * (0.6 + Math.random())
        if (dir < 0 && falling.length < 22 && g > 0.14) {
          const pool = m.leaves
          for (let i = 0; i < 4; i++) {
            const l = pool[Math.floor(Math.random() * pool.length)]
            if (l.birth > g) continue
            falling.push({ x: W / 2 + l.x * px, y: baseY + l.y * px, vx: (Math.random() - 0.3) * 0.5, vy: 0.2, rot: Math.random() * 6, spin: (Math.random() - 0.5) * 0.09, life: 1, size: 3.5 + Math.random() * 2.5, color: FRONT[1 + Math.floor(Math.random() * 5)] })
          }
        }
      }
      schedule()
    }

    const resize = () => {
      const rect = c.getBoundingClientRect()
      dpr = Math.min(2, devicePixelRatio || 1)
      W = rect.width; H = rect.height
      if (!W || !H) return
      c.width = buf.width = Math.round(W * dpr)
      c.height = buf.height = Math.round(H * dpr)
      repaint(); present(performance.now())
    }
    resize()
    const ro = new ResizeObserver(resize); ro.observe(c)
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) schedule() }); io.observe(c)
    const onVis = () => schedule()
    document.addEventListener('visibilitychange', onVis)
    if (sway) schedule()
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect(); io.disconnect()
      document.removeEventListener('visibilitychange', onVis)
      wake.current = () => {}
    }
  }, [twin, sway, fill, framed])

  return <canvas ref={ref} className={className} aria-hidden="true" style={{ width: '100%', height: '100%', display: 'block' }} />
}

/** Draws one still tree, for exported images. */
/** `seed` gives a differently shaped tree; the site always uses the default shape. */
export function drawTree(ctx: CanvasRenderingContext2D, growthValue: number, W: number, H: number, twin = false, seed?: number) {
  const m = seed === undefined ? model(twin) : (cache[`${twin}:${seed}`] ??= build(twin, seed))
  paint(ctx, m, growthValue, W, H, false, false)
}

export default memo(Tree)
