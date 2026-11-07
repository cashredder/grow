import { memo } from 'react'

// Sticker-style token covers. A vector keeps them sharp at any size and adds almost no weight.
const Eyes = ({ x = 32, y = 30, gap = 9, r = 4.6 }: { x?: number; y?: number; gap?: number; r?: number }) => (
  <g>
    <circle cx={x - gap} cy={y} r={r} fill="#fff" /><circle cx={x + gap} cy={y} r={r} fill="#fff" />
    <circle cx={x - gap + 1.2} cy={y + 0.8} r={r * 0.5} fill="#14110f" /><circle cx={x + gap + 1.2} cy={y + 0.8} r={r * 0.5} fill="#14110f" />
  </g>
)
const Smile = ({ x = 32, y = 38, w = 6 }: { x?: number; y?: number; w?: number }) => <path d={`M${x - w} ${y}q${w} ${w * 0.9} ${w * 2} 0`} fill="none" stroke="#14110f" strokeWidth="2" strokeLinecap="round" />

const ART: Record<string, { bg: string; draw: React.ReactNode }> = {
  oak: { bg: '#2e6b43', draw: <>
    <rect x="27" y="40" width="10" height="18" rx="2" fill="#6b4a2f" />
    <circle cx="20" cy="27" r="13" fill="#7cc242" /><circle cx="44" cy="27" r="13" fill="#7cc242" /><circle cx="32" cy="19" r="14" fill="#94d64f" /><circle cx="32" cy="32" r="14" fill="#86cc47" />
    <Eyes y={28} /><Smile y={35} /></> },
  moss: { bg: '#dfeaa0', draw: <>
    <path d="M6 50c0-17 12-28 26-28s26 11 26 28c0 5-52 5-52 0z" fill="#5f9c3a" />
    <circle cx="19" cy="33" r="5" fill="#79b84a" /><circle cx="46" cy="36" r="6" fill="#79b84a" /><circle cx="34" cy="26" r="4" fill="#8ccb58" />
    <Eyes y={38} /><Smile y={45} /></> },
  acorn: { bg: '#f4bd4f', draw: <>
    <path d="M16 28h32c0 18-7 28-16 30-9-2-16-12-16-30z" fill="#a9662c" />
    <path d="M12 28c0-9 9-15 20-15s20 6 20 15c0 2-40 2-40 0z" fill="#5d3a1e" /><rect x="30" y="6" width="4" height="9" rx="2" fill="#5d3a1e" />
    <Eyes y={38} gap={8} /><Smile y={45} w={5} /></> },
  bonsai: { bg: '#f1e4d3', draw: <>
    <path d="M18 48h28l-3 10H21z" fill="#c2553a" /><rect x="15" y="45" width="34" height="5" rx="2" fill="#a2452e" />
    <path d="M31 46c0-7-7-9-5-16h6c-1 6 6 8 4 16z" fill="#6b4a2f" />
    <ellipse cx="22" cy="25" rx="13" ry="9" fill="#3f8a4a" /><ellipse cx="42" cy="21" rx="13" ry="10" fill="#4f9f56" /><Eyes x={34} y={21} gap={7} r={3.6} /></> },
  clover: { bg: '#117a55', draw: <>
    <rect x="30.500" y="38" width="3" height="20" rx="1.500" fill="#b7f08a" />
    {[[20, 20], [44, 20], [20, 40], [44, 40]].map(([x, y]) => <circle key={`${x}${y}`} cx={x} cy={y} r="12" fill="#a4ec5e" />)}
    <circle cx="32" cy="30" r="9" fill="#a4ec5e" /><Eyes y={28} gap={7} r={4} /><Smile y={34} w={4} /></> },
  truffle: { bg: '#2c211b', draw: <>
    <path d="M12 38c-3-13 6-23 19-23 15 0 23 9 21 22-2 12-12 19-22 18-9-1-16-7-18-17z" fill="#6f4e3a" />
    <circle cx="22" cy="24" r="3" fill="#8a6a54" /><circle cx="44" cy="30" r="3.500" fill="#8a6a54" /><circle cx="36" cy="46" r="2.500" fill="#8a6a54" />
    <Eyes y={34} gap={8} /><Smile y={41} w={4} /></> },
  willow: { bg: '#a7dcd3', draw: <>
    <rect x="29" y="30" width="6" height="28" rx="2" fill="#7a5a3c" />
    <ellipse cx="32" cy="20" rx="24" ry="13" fill="#5aa86a" />
    {[11, 18, 25, 39, 46, 53].map((x, i) => <path key={x} d={`M${x} 22q${i < 3 ? -2 : 2} 14 0 ${24 + (i % 3) * 5}`} fill="none" stroke="#3f8d55" strokeWidth="4" strokeLinecap="round" />)}
    <Eyes y={20} gap={8} r={4} /></> },
  pollen: { bg: '#ffd744', draw: <>
    {Array.from({ length: 12 }, (_, i) => { const a = (i / 12) * 6.283; return <line key={i} x1={32 + Math.cos(a) * 15} y1={32 + Math.sin(a) * 15} x2={32 + Math.cos(a) * 25} y2={32 + Math.sin(a) * 25} stroke="#e98a15" strokeWidth="4" strokeLinecap="round" /> })}
    <circle cx="32" cy="32" r="18" fill="#f5a623" /><Eyes y={29} gap={7} r={4} /><Smile y={37} w={5} /></> },
  fern: { bg: '#0d4a3a', draw: <>
    <path d="M32 60C31 42 34 26 44 8" fill="none" stroke="#5fd47f" strokeWidth="3.500" strokeLinecap="round" />
    {[[33, 50, -1], [34, 40, -1], [36, 30, -1], [39, 21, -1], [33, 50, 1], [34, 40, 1], [36, 30, 1], [39, 21, 1]].map(([x, y, s], i) => <ellipse key={i} cx={x + s * 9} cy={y - 2} rx="9" ry="3.800" fill="#5fd47f" transform={`rotate(${s * -24} ${x} ${y})`} />)}
    <Eyes x={33} y={38} gap={5} r={3.200} /></> },
  thorn: { bg: '#e8532b', draw: <>
    <path d="M32 6l9 19 15 5-10 12 3 16-17-7-17 7 3-16L8 30l15-5z" fill="#3d1b12" />
    <Eyes y={33} gap={8} /><path d="M26 44l3-3 3 3 3-3 3 3" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></> },
  ivy: { bg: '#d7f27a', draw: <>
    <path d="M32 8c4 7 11 8 19 7-1 8 0 14 5 20-7 2-11 6-13 13-4-1-7 0-11 4-4-4-7-5-11-4-2-7-6-11-13-13 5-6 6-12 5-20 8 1 15 0 19-7z" fill="#2f9147" />
    <path d="M32 52v8" stroke="#1f6b33" strokeWidth="3" strokeLinecap="round" /><Eyes y={28} gap={8} /><Smile y={36} w={5} /></> },
  sapling: { bg: '#bfe4ff', draw: <>
    <path d="M8 58c6-9 15-12 24-12s18 3 24 12z" fill="#7a5436" />
    <path d="M32 48V26" stroke="#4fa32f" strokeWidth="4" strokeLinecap="round" />
    <path d="M32 28C22 28 15 22 13 11c11 0 18 6 19 17z" fill="#7bd13f" /><path d="M32 28c10 0 17-6 19-17-11 0-18 6-19 17z" fill="#9ce55a" />
    <Eyes y={39} gap={6} r={3.400} /></> },
}

const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h) }

export const Art = memo(function Art({ art, label, hue }: { art?: string; label: string; hue: number }) {
  const a = art ? ART[art] : undefined
  if (a) return <svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" fill={a.bg} />{a.draw}</svg>
  // Fallback for a token without an uploaded image: a pattern unique to its ticker.
  const h = hash(label)
  const c1 = `hsl(${(hue + (h % 40)) % 360} 58% 42%)`, c2 = `hsl(${(hue + 40 + (h % 80)) % 360} 70% 72%)`
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <defs><linearGradient id={`g${h}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={c2} /><stop offset="1" stopColor={c1} /></linearGradient></defs>
      <rect width="64" height="64" fill={`url(#g${h})`} />
      <text x="32" y="41" textAnchor="middle" fontFamily="var(--sans)" fontWeight="600" fontSize="24" fill="#fff">{label.slice(0, 2)}</text>
    </svg>
  )
})
