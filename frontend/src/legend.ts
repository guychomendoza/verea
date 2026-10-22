// Map symbology (legend) for exported images and reports: device types (glyph) first, then the
// status colours, showing only what the project has.
import { COLORS } from './colors'
import { KIND_LABELS, type DeviceKind } from './deviceIcons'
import { cellColor, nodeKindOf, type MapData } from './mapStyle'

export interface LegendItem {
  color: string
  label: string
  line?: boolean          // a line sample instead of a dot
  icon?: DeviceKind       // device symbol (circle + glyph) instead of a dot
  heading?: boolean       // group title, no sample
}

/** Neutral colour for the device-type samples (the colour on the map is the status). */
export const TYPE_SAMPLE = '#5a6b80'

export function mapLegend(d: MapData, showCoverage: boolean): LegendItem[] {
  const kinds = new Set<DeviceKind>(d.project.nodes.map((n) => nodeKindOf(d, n.name)))
  if (d.project.gateways.length) kinds.add('gateway')
  const order: DeviceKind[] = ['gateway', 'lora', 'station', 'cellular']
  const out: LegendItem[] = []
  if (kinds.size) {
    out.push({ heading: true, color: '', label: 'Símbolos:' })
    for (const k of order) if (kinds.has(k)) out.push({ icon: k, color: TYPE_SAMPLE, label: KIND_LABELS[k] })
  }
  const lora = kinds.has('lora') || kinds.has('station')
  const state: LegendItem[] = []
  if (d.project.gateways.length) state.push({ color: COLORS.gateway, label: 'Gateway en línea' })
  if (d.project.gateways.some((g) => !g.online)) state.push({ color: COLORS.none, label: 'Gateway fuera de línea' })
  if (lora) {
    state.push({ color: COLORS.viable, label: 'Enlace viable' }, { color: COLORS.marginal, label: 'Marginal (hasta −5 dB)' },
      { color: COLORS.fail, label: 'No viable' })
    if (d.project.nodes.some((n) => !d.cellular.has(n.name) && !d.links[n.name]?.link)) {
      state.push({ color: COLORS.none, label: 'Sin resultado' })
    }
  }
  if (kinds.has('cellular') || showCoverage) {
    state.push({ color: COLORS.cellOk, label: '4G garantizado' },
      { color: COLORS.cellEdge, label: '4G incierto (cerca del borde)' },
      { color: COLORS.cellPossible, label: '4G posible (LTE-M / NB-IoT, verificar)' },
      { color: COLORS.cellNone, label: 'Sin 4G declarado' })
  }
  if (state.length) out.push({ heading: true, color: '', label: 'Estado (color):' }, ...state)
  return out
}

/** Legend of one report card: its gateway, the node and the state of its link. */
export function cardLegend(d: MapData, node: string, gateway?: string): LegendItem[] {
  const kind = nodeKindOf(d, node)
  const out: LegendItem[] = []
  if (gateway) out.push({ icon: 'gateway', color: COLORS.gateway, label: `${gateway} (gateway)` })
  const l = d.links[node]?.link
  const c = d.cells[node]
  const color = kind === 'cellular'
    ? cellColor(c)
    : (!l ? COLORS.none : l.viable ? COLORS.viable : l.margin_db > -5 ? COLORS.marginal : COLORS.fail)
  out.push({ icon: kind, color, label: `${node} (${KIND_LABELS[kind]})` })
  if (l) out.push({ line: true, color, label: l.viable ? 'Enlace viable' : l.margin_db > -5 ? 'Enlace marginal' : 'Enlace no viable' })
  if (kind === 'cellular') {
    out.push({ color: COLORS.cellOk, label: '4G garantizado' }, { color: COLORS.cellEdge, label: '4G incierto' },
      { color: COLORS.cellPossible, label: '4G posible' },
      { color: COLORS.cellNone, label: 'Sin 4G' })
  }
  if (d.project.gateways.length + d.project.nodes.length > (gateway ? 2 : 1)) {
    out.push({ color: '#9aa4b2', label: 'Otros dispositivos (atenuados)' })
  }
  return out
}
