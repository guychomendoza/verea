// 4G field tests (docs/modo-campo.md): what a sensor really got at a place, against what the
// coverage map predicted there. Recorded on the phone first (a queue in localStorage: in the red
// areas there is often no signal for the phone either) and uploaded when there is connection; the
// client_id made here keeps a retry from duplicating a test.
import type { CellStatus, NodeDevice } from './types'
import { COLORS } from './colors'

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
// A test speaks for a square NEAR_M each way around it: it repaints the coverage map there and
// corrects the sensors inside. Between the steep (125 m) and flat (250 m) edge margins of
// core/cellular.py; uncalibrated.
export const NEAR_M = 200
const GRID = 0.0004                     // the coverage tiles' raster cell (scripts/build_coverage_tiles.py)
const M_PER_DEG = 111320

/** The test's square, snapped outwards to the coverage cells: [west, south, east, north]. */
export function testBounds(t: { lat: number; lon: number }): [number, number, number, number] {
  const dLat = NEAR_M / M_PER_DEG
  const dLon = NEAR_M / (M_PER_DEG * Math.cos((t.lat * Math.PI) / 180))
  const down = (v: number) => Math.floor(v / GRID + 1e-9) * GRID
  const up = (v: number) => Math.ceil(v / GRID - 1e-9) * GRID
  return [down(t.lon - dLon), down(t.lat - dLat), up(t.lon + dLon), up(t.lat + dLat)]
}

/** The tests as coloured squares for the coverage map, the most recent on top (drawn last). */
export function fieldAreasGeoJSON(tests: FieldTest[] = []): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [...tests].sort((a, b) => a.taken_at.localeCompare(b.taken_at)).map((t) => {
      const [w, s, e, n] = testBounds(t)
      return { type: 'Feature', properties: { color: OBSERVED[t.observed].color },
        geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } }
    }),
  }
}

/** The most recent test whose square holds the point (null if none). */
export function testNear(lat: number, lon: number, tests: FieldTest[]): FieldTest | null {
  let best: FieldTest | null = null
  for (const t of tests) {
    const [w, s, e, n] = testBounds(t)
    if (lon < w || lon > e || lat < s || lat > n) continue
    if (!best || t.taken_at > best.taken_at) best = t
  }
  return best
}

// ── «¿llegó el dato?» ──
export type Delivery = 'yes' | 'no' | 'unknown'
export const deliveryOf = (t: FieldTest): Delivery => (t.delivered === true ? 'yes' : t.delivered === false ? 'no' : 'unknown')
export const DELIVERY: Record<Delivery, string> = { yes: 'Llegó', no: 'No llegó', unknown: 'Sin dato' }

/** Every test as CSV (Excel opens it: UTF-8 with BOM, «;» between fields), for calibrating the map. */
export function testsCsv(tests: FieldTest[], projectName: (id: string | null) => string): string {
  const cell = (v: unknown) => {
    const s = v == null ? '' : String(v)
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const head = ['fecha', 'latitud', 'longitud', 'precision_m', 'operador', 'mapa_decia', 'senal_reportada', 'llego_el_dato',
    'coincide', 'rssi_dbm', 'notas', 'proyecto']
  const rows = [...tests].sort((a, b) => a.taken_at.localeCompare(b.taken_at)).map((t) => [
    t.taken_at, t.lat.toFixed(6), t.lon.toFixed(6), t.accuracy_m ?? '', t.operator, t.predicted ?? '', t.observed,
    DELIVERY[deliveryOf(t)], agrees(t.predicted, t.observed) == null ? '' : agrees(t.predicted, t.observed) ? 'sí' : 'no',
    t.rssi_dbm ?? '', t.notes, projectName(t.project_id)])
  return '﻿' + [head, ...rows].map((r) => r.map(cell).join(';')).join('\r\n')
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
