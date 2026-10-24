// The login's left side: terrain contours, field plots and a LoRaWAN network drawn in the brand
// colours (an illustration instead of a stock photo: no image rights, sharp at any size, ~2 KB).
import { BRAND } from './brand'

const W = 800, H = 1000

/** Contour lines: gentle waves stacked like a topographic map. */
function contours(): string[] {
  const out: string[] = []
  for (let i = 0; i < 18; i++) {
    const base = 80 + i * 52, amp = 18 + (i % 5) * 7, phase = i * 0.9, freq = 0.006 + (i % 3) * 0.0015
    let d = `M0 ${base.toFixed(1)}`
    for (let x = 20; x <= W; x += 20) d += ` L${x} ${(base + amp * Math.sin(x * freq + phase) + 10 * Math.sin(x * 0.021 + i)).toFixed(1)}`
    out.push(d)
  }
  return out
}

const PLOTS = [
  'M120 560 L300 520 L330 650 L150 700 Z', 'M330 500 L470 470 L500 600 L345 640 Z', 'M160 720 L340 670 L370 790 L190 840 Z',
  'M360 660 L520 620 L560 750 L385 790 Z', 'M540 610 L690 580 L720 700 L570 740 Z', 'M520 470 L650 445 L675 560 L545 590 Z',
]
const GATEWAY: [number, number] = [430, 560]
const SENSORS: [number, number][] = [[220, 610], [410, 560 + 70], [260, 760], [470, 710], [620, 660], [600, 515], [330, 470], [700, 770]]

export default function LoginArt() {
  const lines = contours()
  return (
    <svg className="login-art-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="la-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1d4366" />
          <stop offset=".55" stopColor={BRAND.navy} />
          <stop offset="1" stopColor="#0a1828" />
        </linearGradient>
        <radialGradient id="la-glow" cx={GATEWAY[0] / W} cy={GATEWAY[1] / H} r=".45">
          <stop offset="0" stopColor={BRAND.teal} stopOpacity=".28" />
          <stop offset="1" stopColor={BRAND.teal} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width={W} height={H} fill="url(#la-bg)" />
      <rect width={W} height={H} fill="url(#la-glow)" />
      <g fill="none" stroke={BRAND.teal} strokeOpacity=".16" strokeWidth="1.2">
        {lines.map((d, i) => <path key={i} d={d} strokeOpacity={i % 4 === 0 ? .3 : .14} />)}
      </g>
      <g fill={BRAND.teal} fillOpacity=".07" stroke={BRAND.teal} strokeOpacity=".35" strokeWidth="1.2">
        {PLOTS.map((d) => <path key={d} d={d} />)}
      </g>
      <g stroke={BRAND.teal} strokeOpacity=".55" strokeWidth="1.4" strokeDasharray="5 6">
        {SENSORS.map(([x, y]) => <line key={`${x}-${y}`} x1={GATEWAY[0]} y1={GATEWAY[1]} x2={x} y2={y} />)}
      </g>
      <g fill="none" stroke={BRAND.teal}>
        <circle cx={GATEWAY[0]} cy={GATEWAY[1]} r="46" strokeOpacity=".35" />
        <circle cx={GATEWAY[0]} cy={GATEWAY[1]} r="92" strokeOpacity=".2" />
        <circle cx={GATEWAY[0]} cy={GATEWAY[1]} r="150" strokeOpacity=".1" />
      </g>
      {SENSORS.map(([x, y]) => (
        <g key={`s${x}-${y}`}>
          <circle cx={x} cy={y} r="9" fill="#06a77d" fillOpacity=".25" />
          <circle cx={x} cy={y} r="4.5" fill="#2fd3a3" />
        </g>
      ))}
      <circle cx={GATEWAY[0]} cy={GATEWAY[1]} r="15" fill={BRAND.teal} />
      <circle cx={GATEWAY[0]} cy={GATEWAY[1]} r="6" fill="#fff" />
    </svg>
  )
}
