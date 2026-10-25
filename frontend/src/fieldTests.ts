// 4G field tests (docs/modo-campo.md): what a sensor really got at a place, against what the
// coverage map predicted there. Recorded on the phone first (a queue in localStorage: in the red
// areas there is often no signal for the phone either) and uploaded when there is connection; the
// client_id made here keeps a retry from duplicating a test.
import type { CellStatus, NodeDevice } from './types'
import { COLORS } from './colors'
import { haversine } from './geo'

export type Observed = 'stable' | 'intermittent' | 'none'
export type Predicted = CellStatus['state']

export interface FieldTest {
  client_id: string
  project_id: string | null
  taken_at: string
  lat: number
  lon: number
  accuracy_m: number | null
  operator: string
  predicted: Predicted | null           // null: recorded without signal, asked to the map on upload
  observed: Observed
  delivered: boolean | null
  rssi_dbm: number | null
  notes: string
  author_id?: string
}

export const OBSERVED: Record<Observed, { label: string; hint: string; color: string }> = {
  stable: { label: 'Señal estable', hint: 'Llegan todos los datos', color: COLORS.cellOk },
  intermittent: { label: 'Intermitente', hint: 'Llegan algunos datos', color: COLORS.cellEdge },
  none: { label: 'Sin señal', hint: 'No llega nada', color: COLORS.cellNone },
}

/** What the map's state means for a sensor: guaranteed (green) → stable; near the edge (yellow),
 *  differentiated or possible (orange) → intermittent; none (red) → no signal. */
export const EXPECTED: Record<Predicted, Observed> = {
  ok: 'stable', edge: 'intermittent', differentiated: 'intermittent', possible: 'intermittent', none: 'none',
}
const RANK: Record<Observed, number> = { none: 0, intermittent: 1, stable: 2 }

/** Whether what was observed is what the map predicts (null: no prediction yet). */
export function agrees(predicted: Predicted | null, observed: Observed): boolean | null {
  return predicted ? EXPECTED[predicted] === observed : null
}

/** «mejor» when the sensor got more than the map predicts, «peor» when less, null when equal or unknown. */
export function comparedToMap(predicted: Predicted | null, observed: Observed): 'mejor' | 'peor' | null {
  if (!predicted) return null
  const d = RANK[observed] - RANK[EXPECTED[predicted]]
  return d > 0 ? 'mejor' : d < 0 ? 'peor' : null
}

// ── the queue on the phone ──
const QUEUE_KEY = 'verea.fieldQueue'

export function queued(): FieldTest[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]') as FieldTest[]
  } catch {
    return []
  }
}

function writeQueue(q: FieldTest[]) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q))
  } catch { /* full or private mode: the test lives only in memory until uploaded */ }
}

export function enqueue(t: FieldTest) {
  writeQueue([...queued().filter((x) => x.client_id !== t.client_id), t])
}

export function dequeue(ids: string[]) {
  const done = new Set(ids)
  writeQueue(queued().filter((t) => !done.has(t.client_id)))
}

export const newClientId = () => crypto.randomUUID()

// ── the prediction, corrected near a test ──
// A test speaks for this far around it: it repaints the coverage map there and corrects the sensors
// inside. Between the steep (125 m) and flat (250 m) edge margins of core/cellular.py; uncalibrated.
export const NEAR_M = 200

/** The most recent test within NEAR_M of a point (null if none). */
export function testNear(lat: number, lon: number, tests: FieldTest[]): FieldTest | null {
  let best: FieldTest | null = null
  for (const t of tests) {
    if (haversine([lat, lon], [t.lat, t.lon]) > NEAR_M) continue
    if (!best || t.taken_at > best.taken_at) best = t
  }
  return best
}

const STATE_OF: Record<Observed, Predicted> = { stable: 'ok', intermittent: 'edge', none: 'none' }

/** 4G states with field tests applied: a sensor near a test takes the measured state, marked as
 *  verified in the field (map colour, lists, panel and report all follow). */
export function withFieldTests(cells: Record<string, CellStatus>, nodes: NodeDevice[], cellular: Set<string>,
  tests: FieldTest[]): Record<string, CellStatus> {
  if (!tests.length) return cells
  const out = { ...cells }
  for (const n of nodes) {
    if (!cellular.has(n.name)) continue
    const t = testNear(n.lat, n.lon, tests)
    if (!t) continue
    const when = new Date(t.taken_at).toLocaleDateString('es-MX', { dateStyle: 'medium' })
    const base = cells[n.name] ?? ({ name: n.name } as CellStatus)
    out[n.name] = {
      ...base,
      state: STATE_OF[t.observed],
      text: `Verificado en campo el ${when}: ${OBSERVED[t.observed].label.toLowerCase()} (${OBSERVED[t.observed].hint.toLowerCase()})`,
      short: `${OBSERVED[t.observed].label} (en campo)`,
      field: true,
    }
  }
  return out
}
