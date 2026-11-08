// The launch moment: a sprout pushes out of the soil, the stem rises and the two leaves unfold. Shown over
// the create page while the launch goes through (wallet approval, then the chain).

export default function Planting({ ticker, live }: { ticker: string; live: boolean }) {
  return (
    <div className="planting" role="status" aria-live="polite">
      <div className="planting-scene">
        <svg viewBox="0 0 240 240" aria-hidden="true">
          <defs>
            <clipPath id="above-soil"><rect x="0" y="0" width="240" height="176" /></clipPath>
            <linearGradient id="leaf-a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#a6ee4a" /><stop offset="1" stopColor="#5fb81a" /></linearGradient>
            <linearGradient id="leaf-b" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#9be43c" /><stop offset="1" stopColor="#4fa313" /></linearGradient>
          </defs>
          <g clipPath="url(#above-soil)">
            <g className="planting-sprout">
              <path className="planting-stem" d="M120 236 C 115 196, 125 140, 120 84" stroke="#6cc522" strokeWidth="7" strokeLinecap="round" fill="none" />
              <g className="planting-leaf planting-leaf-l"><path d="M120 86 C 104 60, 70 56, 58 76 C 74 94, 104 96, 120 86 Z" fill="url(#leaf-a)" /><path d="M120 86 C 100 78, 82 74, 62 76" stroke="#4d9a12" strokeWidth="1.6" fill="none" opacity=".6" /></g>
              <g className="planting-leaf planting-leaf-r"><path d="M120 86 C 136 60, 170 56, 182 76 C 166 94, 136 96, 120 86 Z" fill="url(#leaf-b)" /><path d="M120 86 C 140 78, 158 74, 178 76" stroke="#4d9a12" strokeWidth="1.6" fill="none" opacity=".6" /></g>
            </g>
          </g>
          <ellipse className="planting-mound" cx="120" cy="182" rx="78" ry="16" fill="#7a5a3a" />
          <ellipse cx="120" cy="177" rx="64" ry="9" fill="#946f48" />
          <g className="planting-crumbs" fill="#7a5a3a">
            <circle cx="104" cy="172" r="3" /><circle cx="134" cy="170" r="2.5" /><circle cx="116" cy="168" r="2" /><circle cx="128" cy="174" r="2" />
          </g>
        </svg>
      </div>
      <b className="planting-title">Planting ${ticker || 'your token'}</b>
      <small className="muted">{live ? 'Confirm in your wallet. The page opens once the tree is on chain.' : 'Your tree is coming up.'}</small>
    </div>
  )
}
