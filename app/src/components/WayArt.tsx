// Pictures for the three ways to use gardeners on the home page. The gardeners are the same characters the
// site uses for them everywhere (Art), with a small drawing of what you do with each.
import { Art } from './Art'

const G = ({ art, size, dim = false }: { art: string; size: number; dim?: boolean }) => (
  <span className={`cover way-g ${dim ? 'dim' : ''}`} style={{ width: size, height: size, borderRadius: size * 0.28 }}><Art art={art} label="" hue={100} /></span>
)

/** Copy one: a gardener and your copy of it, smaller, following its moves. */
export function CopyArt() {
  return (
    <span className="way-art" aria-hidden="true">
      <G art="oak" size={64} />
      <svg viewBox="0 0 44 20" width="44" height="20"><path d="M2 10 H 34" stroke="var(--mid)" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="1 6" /><path d="M30 4 L 38 10 L 30 16" stroke="var(--mid)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" /></svg>
      <G art="oak" size={46} dim />
    </span>
  )
}

/** Create your own: a gardener and the limits you set for it. */
export function CreateArt() {
  return (
    <span className="way-art" aria-hidden="true">
      <G art="acorn" size={64} />
      <svg viewBox="0 0 64 60" width="64" height="60">
        {[[8, 40], [26, 18], [44, 50]].map(([y, v], i) => (
          <g key={i}>
            <rect x="0" y={y} width="64" height="6" rx="3" fill="var(--line)" />
            <rect x="0" y={y} width={v} height="6" rx="3" fill="var(--lime)" />
            <circle cx={v} cy={y + 3} r="6" fill="var(--surface)" stroke="var(--lime)" strokeWidth="2.5" />
          </g>
        ))}
      </svg>
    </span>
  )
}

/** Bring your agent: your own bot, plugged in with an API key, gardening for you. */
export function AgentArt() {
  return (
    <span className="way-art" aria-hidden="true">
      <svg viewBox="0 0 120 64" width="120" height="64">
        <rect x="6" y="14" width="52" height="40" rx="12" fill="var(--surface)" stroke="var(--mid)" strokeWidth="2.5" />
        <circle cx="22" cy="34" r="4" fill="var(--lime)" />
        <circle cx="42" cy="34" r="4" fill="var(--lime)" />
        <path d="M24 44 Q 32 49 40 44" stroke="var(--mid)" strokeWidth="2.5" strokeLinecap="round" fill="none" />
        <path d="M32 14 V 6" stroke="var(--mid)" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="32" cy="5" r="3.5" fill="var(--lime)" />
        <path d="M58 34 C 72 34, 72 22, 84 22" stroke="var(--mid)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
        <circle cx="94" cy="22" r="10" fill="none" stroke="var(--lime)" strokeWidth="3" />
        <path d="M104 22 H 116 M 112 22 V 28 M 116 22 V 27" stroke="var(--lime)" strokeWidth="3" strokeLinecap="round" />
      </svg>
    </span>
  )
}
