// Report text and tables for the PDF (ui/report.py, in Spanish).
import { COLORS } from '../colors'
import { networkCounts, type KindCount } from '../counts'
import { nodeShortName } from '../project'
import { connectedNodes } from '../nodeStatus'
import { distance, num } from '../geo'
import { cellColor, cellShort, linkColor } from '../mapStyle'
import type { NodeDevice } from '../types'
import type { ReportData } from './collect'

/** A table; `colors[i]` is the status colour of row i (a dot in its last cell). */
export type Table = { title: string; head: string[]; rows: string[][]; colors: string[] }

const ALL_TERMS: [string, string][] = [
  ['Modelo de propagación', 'Cómo se estima la pérdida sobre el terreno. Se usa la mayor (la más '
    + 'conservadora) entre Longley-Rice (ITM), que recorre el perfil real con reflexión en el suelo y '
    + 'difracción sobre cada loma, y el modelo de trayecto corto ITU-R P.526 (difracción sobre colinas '
    + 'redondeadas más reflexión en el suelo), que también cubre enlaces de menos de ~1 km.'],
  ['Pérdida por terreno', 'Pérdida adicional sobre el espacio libre causada por el terreno del trayecto.'],
  ['Pérdida por entorno (clutter)', 'Pérdida por lo que rodea al sensor: cultivos, huertos, edificios.'],
  ['Margen de seguridad', 'Cuántos dB por encima del mínimo del gateway (sensibilidad) debe llegar la '
    + 'señal para considerar viable el enlace: la reserva para lluvia, follaje húmedo o en movimiento '
    + 'y la variación del día a día.'],
  ['Margen del enlace', 'dB que sobran por encima del margen de seguridad. Viable cuando es cero o más.'],
  ['Spreading factor (SF)', 'Velocidad de datos de LoRa. Un SF mayor alcanza más lejos, pero es más lento '
    + 'y ocupa más tiempo al aire. En US915 la subida admite SF7–SF10.'],
  ['Despeje de Fresnel', 'Qué tanto de la zona alrededor de la línea de vista está libre de terreno. '
    + 'Por debajo de 60% la señal empieza a perder potencia; negativo significa que la línea de vista está bloqueada.'],
  ['Modelos de equipo', 'Los valores de gateways y nodos vienen de las hojas de datos de los fabricantes. '
    + 'Donde un valor no está publicado (sobre todo ganancias de antena) se usa una cifra típica, que se '
    + 'afina con lecturas reales de RSSI de la red.'],
  ['Sensores 4G', 'Los sensores 4G (NB-IoT / LTE-M) envían datos por la red celular, no por un gateway '
    + 'LoRaWAN. Se revisan contra la cobertura 4G que el operador declara al regulador (LTE exterior).'],
  ['Cobertura garantizada / diferenciada', 'Garantizada: el operador se compromete con la calidad del '
    + 'servicio ahí. Diferenciada: hay señal pero sin ese compromiso. "Incierto" significa cubierto, pero '
    + 'cerca del borde: 125 m donde un cerro corta la señal y hasta 250 m en terreno plano, donde el borde '
    + 'depende de la distancia a la torre (huecos pequeños: 50 m). "Posible" significa fuera de la cobertura '
    + 'declarada pero a menos de 100–300 m de ella (o en un hueco pequeño): los sensores LTE-M / NB-IoT tienen '
    + '15–20 dB más de alcance que un teléfono, aunque un cultivo alto que los cubra (como la caña) les quita '
    + 'buena parte; hay que verificarlo en campo.'],
]

export const GLOSSARY = ALL_TERMS.filter(([k]) => ["Margen de seguridad", "Margen del enlace", "Spreading factor (SF)", "Despeje de Fresnel", "Modelo de propagación", "Sensores 4G", "Cobertura garantizada / diferenciada"].includes(k))

export const SOURCES = [
  'Elevación: Copernicus DEM GLO-90 (© DLR e.V. 2010-2014 y © Airbus Defence and Space GmbH 2014-2018, '
    + 'proporcionado bajo COPERNICUS por la Unión Europea y la ESA).',
  'Cobertura 4G: Mapas de cobertura del servicio móvil, Comisión Reguladora de Telecomunicaciones, '
    + 'datos.gob.mx (CC BY 4.0).',
  'Imágenes satelitales y nombres: © Esri y sus proveedores.',
]

export function envLabel(d: ReportData, key?: string): string {
  return (key && d.catalog.environments[key]?.label) || key || '—'
}

/** Pairs side by side: each criterion keeps its own columns, so its counts add up on their own. */
function sideBySide(columns: [string, [string, number][]][]): { head: string[]; rows: string[][] } {
  const height = Math.max(...columns.map(([, items]) => items.length))
  return {
    head: columns.flatMap(([title]) => [title, 'Cant.']),
    rows: Array.from({ length: height }, (_, i) =>
      columns.flatMap(([, items]) => (items[i] ? [items[i][0], String(items[i][1])] : ['', '']))),
  }
}

/** One summary per kind (gateways, LoRa, 4G; only those the project has): the total goes in the
 *  title and each way of counting (model, connection, state) in its own pair of columns. */
export function summaryTables(d: ReportData): Table[] {
  const c = networkCounts(d.project, d.catalog, d.links, d.cells, d.cellular)
  const block = (name: string, k: KindCount, split?: [string, [string, number][]]): Table => {
    const states = k.states.filter((x) => x.n)
    const { head, rows } = sideBySide([['Modelo', k.models], ...(split ? [split] : []),
      ['Estado', states.map((x) => [x.label, x.n] as [string, number])]])
    return { title: `${name}: ${k.total} en total`, head, rows, colors: rows.map((_, i) => states[i]?.color ?? '') }
  }
  const out: Table[] = []
  if (c.gateways.total) {
    out.push(block('Gateways', c.gateways, ['Conexión', ([['4G propio', c.gateways.cellular],
      ['WiFi / Ethernet', c.gateways.wired]] as [string, number][]).filter(([, n]) => n)]))
  }
  if (c.lora.total) out.push(block('Sensores LoRa', c.lora))
  if (c.cell.total) out.push(block('Sensores 4G', c.cell))
  return out
}

export function gatewayTable(d: ReportData): Table | null {
  const gws = [...d.project.gateways].sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }))
  if (!gws.length) return null
  const served = (name: string) => Object.values(d.links).filter((r) => r.link?.gateway === name).length
  return {
    title: '2. Gateways',
    head: ['Gateway', 'Modelo', 'Conexión', 'Nodos conectados', 'Estado'],
    rows: gws.map((g) => [
      g.name, d.catalog.gateway_profiles[g.model]?.label ?? g.model,
      (g.backhaul ?? d.catalog.gateway_profiles[g.model]?.backhaul) === '4g' ? '4G propio' : 'WiFi / Ethernet',
      String(served(g.name)), g.online ? 'En línea' : 'Fuera de línea',
    ]),
    colors: gws.map((g) => (g.online ? COLORS.gateway : COLORS.none)),
  }
}

export const hectares = (v?: number) => (v == null ? '—' : `${num(v, 2)} ha`)

/** Settings in one line. */
export function settingsLine(d: ReportData): string {
  const s = d.project.settings
  return `${s.freq_mhz} MHz · margen de seguridad ${num(s.safety_margin, 1)} dB · modelo `
    + `${s.propagation_model === 'itm' ? 'ITM / ITU-R P.526' : 'simple'}`
}

function status(d: ReportData, name: string): string {
  if (d.cellular.has(name)) {
    const c = d.cells[name]
    return c ? cellShort(c) : 'Sin revisar'
  }
  const r = d.links[name]
  return r?.link ? (r.link.viable ? 'Viable' : 'No viable') : (r?.error ?? 'Sin resultado')
}

export function statusColor(d: ReportData, name: string): string {
  return d.cellular.has(name) ? cellColor(d.cells[name]) : linkColor(d.links[name])
}

/** Optional columns (owner, area) only when some node has them. */
function extras(nodes: NodeDevice[], area: boolean) {
  const owner = nodes.some((n) => n.owner)
  const ha = area && nodes.some((n) => n.area_ha != null)
  return {
    head: [...(owner ? ['Titular'] : []), ...(ha ? ['Superficie'] : [])],
    cells: (n: NodeDevice) => [...(owner ? [n.owner ?? '—'] : []), ...(ha ? [hectares(n.area_ha)] : [])],
  }
}

/** A group of nodes in one state: its rows under a title with the state's colour and count. */
export type Group = Table & { color: string }
/** One kind of node (LoRa or 4G), split by state: the states that need attention last. */
export type Section = { title: string; groups: Group[] }

const byName = (a: NodeDevice, b: NodeDevice) =>
  nodeShortName(a).localeCompare(nodeShortName(b), 'es', { numeric: true, sensitivity: 'base' })

function grouped(nodes: NodeDevice[], states: { key: string; label: string; color: string }[], keyOf: (n: NodeDevice) => string,
  head: string[], row: (n: NodeDevice) => string[]): Group[] {
  return states.map((st) => {
    const ns = nodes.filter((n) => keyOf(n) === st.key).sort(byName)
    return { title: `${st.label} (${ns.length})`, head, rows: ns.map(row), colors: ns.map(() => st.color), color: st.color }
  }).filter((g) => g.rows.length)
}

const LORA_STATES = [
  { key: 'viable', label: 'Enlace viable', color: COLORS.viable },
  { key: 'marginal', label: 'Margen bajo (hasta 5 dB abajo)', color: COLORS.marginal },
  { key: 'fail', label: 'No viable', color: COLORS.fail },
  { key: 'none', label: 'Sin resultado', color: COLORS.none },
]

function loraState(d: ReportData, n: NodeDevice): string {
  const l = d.links[n.name]?.link
  return !l ? 'none' : l.viable ? 'viable' : l.margin_db > -5 ? 'marginal' : 'fail'
}

/** LoRa nodes grouped by the state of their link, alphabetical inside each group (null when none). */
export function loraSection(d: ReportData): Section | null {
  const nodes = d.project.nodes.filter((n) => !d.cellular.has(n.name))
  if (!nodes.length) return null
  const x = extras(nodes, true)
  return {
    title: '3. Nodos LoRa',
    groups: grouped(nodes, LORA_STATES, (n) => loraState(d, n),
      ['Nodo', ...x.head, 'Gateway', 'Distancia', 'Estado'], (n) => {
        const l = d.links[n.name]?.link
        return [nodeShortName(n), ...x.cells(n), l?.gateway ?? '—', l ? distance(l.distance_m) : '—', status(d, n.name)]
      }),
  }
}

const CELL_STATES = [
  { key: 'ok', label: 'Cobertura 4G garantizada', color: COLORS.cellOk },
  { key: 'edge', label: 'Incierta: cerca del borde', color: COLORS.cellEdge },
  { key: 'differentiated', label: 'Solo diferenciada (sin garantía)', color: COLORS.cellEdge },
  { key: 'possible', label: 'Posible con LTE-M / NB-IoT (verificar en campo)', color: COLORS.cellPossible },
  { key: 'none', label: 'Sin cobertura 4G', color: COLORS.cellNone },
  { key: 'unchecked', label: 'Sin revisar', color: COLORS.none },
]

/** 4G sensors grouped by their connection state, alphabetical inside each group (null when none). */
export function cellSection(d: ReportData): Section | null {
  const nodes = d.project.nodes.filter((n) => d.cellular.has(n.name))
  if (!nodes.length) return null
  const x = extras(nodes, true)
  return {
    title: '4. Sensores 4G',
    groups: grouped(nodes, CELL_STATES, (n) => d.cells[n.name]?.state ?? 'unchecked',
      ['Nodo', ...x.head, 'Cubierto alrededor', 'Estado'], (n) => {
        const c = d.cells[n.name]
        return [nodeShortName(n), ...x.cells(n), c?.nearby_share != null ? `${Math.round(c.nearby_share * 100)} %` : '—', status(d, n.name)]
      }),
  }
}

/** One table per gateway with the nodes connected to it, for the end of the report. */
export function gatewayNodeTables(d: ReportData): Table[] {
  const gws = [...d.project.gateways].sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }))
  return gws.map((g) => {
    const nodes = connectedNodes(d.project, d.links, g.name)
    const x = extras(nodes.map((c) => c.node), false)
    const viable = nodes.filter((c) => c.link.viable).length
    return {
      title: nodes.length ? `${g.name}: ${nodes.length} nodo${nodes.length === 1 ? '' : 's'} (${viable} viable${viable === 1 ? '' : 's'})`
        : `${g.name}: sin nodos conectados`,
      head: ['Nodo', ...x.head, 'Distancia', 'Estado'],
      rows: nodes.map(({ node, link }) => [nodeShortName(node), ...x.cells(node), distance(link.distance_m), status(d, node.name)]),
      colors: nodes.map(({ node }) => statusColor(d, node.name)),
    }
  })
}
