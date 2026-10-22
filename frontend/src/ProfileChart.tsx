import type { Profile } from './types'

const W = 320
const H = 150
const PAD = { l: 38, r: 8, t: 8, b: 22 }

/** Terrain between gateway (left) and node (right): ground, line of sight and first Fresnel zone. */
export default function ProfileChart({ profile }: { profile: Profile }) {
  const d = profile.distances_m
  const ground = profile.elevations_m
  const los = profile.los_m
  const fresnelLow = los.map((h, i) => h - (profile.fresnel_radius_m[i] ?? 0))
  const total = d[d.length - 1] || 1
  const lo = Math.min(...ground, ...fresnelLow)
  const hi = Math.max(...ground, ...los)
  const span = Math.max(hi - lo, 10)
  const x = (v: number) => PAD.l + (v / total) * (W - PAD.l - PAD.r)
  const y = (v: number) => PAD.t + (1 - (v - lo + span * 0.05) / (span * 1.1)) * (H - PAD.t - PAD.b)
  const line = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(d[i]).toFixed(1)},${y(v).toFixed(1)}`).join('')
  const area = `${line(ground)}L${x(total)},${H - PAD.b}L${x(0)},${H - PAD.b}Z`
  const worst = profile.worst_point_idx
  const ticks = [lo + span * 0.05, (lo + hi) / 2, hi]

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Terrain profile">
      <path d={area} fill="var(--terrain)" />
      <path d={line(fresnelLow)} fill="none" stroke="var(--fresnel)" strokeDasharray="4 3" strokeWidth={1.2} />
      <path d={line(los)} fill="none" stroke="var(--los)" strokeWidth={1.5} />
      <circle cx={x(d[worst])} cy={y(ground[worst])} r={3.5} fill="var(--worst)" />
      {ticks.map((t) => (
        <text key={t} x={PAD.l - 4} y={y(t) + 3} textAnchor="end" className="fill-current text-[9px] opacity-60">
          {Math.round(t)}
        </text>
      ))}
      <text x={PAD.l} y={H - 6} className="fill-current text-[9px] opacity-60">0 km</text>
      <text x={W - PAD.r} y={H - 6} textAnchor="end" className="fill-current text-[9px] opacity-60">
        {(total / 1000).toFixed(2)} km
      </text>
    </svg>
  )
}
