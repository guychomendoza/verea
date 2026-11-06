// The map ruler's box (editor and field mode): total distance of the points clicked so far.
import { distance, haversine } from './geo'
import { Icon } from './icons'

const rulerTotal = (pts: [number, number][]) => pts.slice(1).reduce((sum, pt, i) => sum + haversine(pts[i], pt), 0)

export function RulerBox({ points, active, onDone, onClear }: {
  points: [number, number][]
  active: boolean
  onDone: () => void
  onClear: () => void
}) {
  if (!active && !points.length) return null
  return (
    <div className="ruler-box" role="region" aria-label="Regla">
      <strong className="inline-flex items-center gap-1"><Icon name="ruler" size={14} /> Regla</strong>{' '}
      {points.length < 2 ? <span>Marca puntos en el mapa para medir</span> : (
        <span>Total <b data-testid="ruler-total">{distance(rulerTotal(points))}</b> · {points.length - 1} tramo{points.length > 2 ? 's' : ''}</span>
      )}
      <span className="hint"> {active ? '· doble clic o Esc para terminar' : ''}</span>
      {active && points.length > 1 && <button className="btn-ghost underline ml-2" onClick={onDone}>Terminar</button>}
      <button className="btn-ghost underline ml-2" onClick={onClear}>Borrar</button>
    </div>
  )
}
