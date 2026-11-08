// Small pictures for the three ways to use gardeners on the home page. Drawn with the site's own colours
// (lime leaves, soil, the muted ink), so they follow the light and dark themes.

const Leaf = ({ x, y, r, flip = false, s = 1 }: { x: number; y: number; r: number; flip?: boolean; s?: number }) => (
  <path
    d="M0 0 C 6 -10, 20 -12, 26 -2 C 18 6, 6 6, 0 0 Z"
    transform={`translate(${x} ${y}) rotate(${r}) scale(${flip ? -s : s} ${s})`}
    fill="var(--lime)"
  />
)

function Sprout({ x, base, h = 34, s = 1 }: { x: number; base: number; h?: number; s?: number }) {
  return (
    <g>
      <path d={`M${x} ${base} C ${x - 2} ${base - h * 0.4}, ${x + 2} ${base - h * 0.7}, ${x} ${base - h}`} stroke="var(--lime)" strokeWidth={3 * s} strokeLinecap="round" fill="none" />
      <Leaf x={x} y={base - h} r={-20} s={s} />
      <Leaf x={x} y={base - h} r={20} flip s={s} />
    </g>
  )
}

const Soil = ({ x, w, y }: { x: number; w: number; y: number }) => <ellipse cx={x} cy={y} rx={w} ry={7} fill="var(--soil, #8a6a45)" opacity={0.85} />

/** Copy one: a gardener's sprout and the same sprout at your size, linked by an arrow. */
export function CopyArt() {
  return (
    <svg viewBox="0 0 160 84" className="way-art" aria-hidden="true">
      <Soil x={44} w={30} y={70} />
      <Sprout x={44} base={68} h={40} />
      <Soil x={118} w={22} y={70} />
      <Sprout x={118} base={68} h={28} s={0.75} />
      <path d="M72 40 H 96" stroke="var(--mid)" strokeWidth={2.5} strokeLinecap="round" strokeDasharray="1 6" />
      <path d="M92 34 L 100 40 L 92 46" stroke="var(--mid)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}

/** Create your own: a sprout with a strategy dial and two limit sliders. */
export function CreateArt() {
  return (
    <svg viewBox="0 0 160 84" className="way-art" aria-hidden="true">
      <Soil x={46} w={28} y={70} />
      <Sprout x={46} base={68} h={38} />
      <g transform="translate(92 14)">
        <rect x={0} y={4} width={58} height={6} rx={3} fill="var(--line)" />
        <rect x={0} y={4} width={36} height={6} rx={3} fill="var(--lime)" />
        <circle cx={36} cy={7} r={6} fill="var(--surface)" stroke="var(--lime)" strokeWidth={2.5} />
        <rect x={0} y={26} width={58} height={6} rx={3} fill="var(--line)" />
        <rect x={0} y={26} width={18} height={6} rx={3} fill="var(--lime)" />
        <circle cx={18} cy={29} r={6} fill="var(--surface)" stroke="var(--lime)" strokeWidth={2.5} />
        <rect x={0} y={48} width={58} height={6} rx={3} fill="var(--line)" />
        <rect x={0} y={48} width={46} height={6} rx={3} fill="var(--lime)" />
        <circle cx={46} cy={51} r={6} fill="var(--surface)" stroke="var(--lime)" strokeWidth={2.5} />
      </g>
    </svg>
  )
}

/** Bring your agent: a sprout with a plug: your own bot connects with an API key. */
export function AgentArt() {
  return (
    <svg viewBox="0 0 160 84" className="way-art" aria-hidden="true">
      <Soil x={50} w={28} y={70} />
      <Sprout x={50} base={68} h={38} />
      <path d="M78 48 C 92 48, 92 30, 106 30" stroke="var(--mid)" strokeWidth={2.5} fill="none" strokeLinecap="round" />
      <rect x={104} y={20} width={34} height={22} rx={6} fill="var(--surface)" stroke="var(--mid)" strokeWidth={2.5} />
      <circle cx={114} cy={31} r={2.6} fill="var(--lime)" />
      <circle cx={128} cy={31} r={2.6} fill="var(--lime)" />
      <path d="M121 20 V 12" stroke="var(--mid)" strokeWidth={2.5} strokeLinecap="round" />
      <circle cx={121} cy={10} r={3} fill="var(--lime)" />
      <path d="M112 46 H 130" stroke="var(--mid)" strokeWidth={2.5} strokeLinecap="round" />
    </svg>
  )
}
