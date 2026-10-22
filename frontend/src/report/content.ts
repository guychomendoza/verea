// Report text and tables, shared by the PDF and the HTML versions (ui/report.py, in Spanish).
import { distance, num } from '../geo'
import { cellColor, linkColor } from '../mapStyle'
import type { NodeDevice } from '../types'
import type { NodeSection, ReportData } from './collect'

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

export function summary(d: ReportData): string[][] {
  const lora = d.project.nodes.filter((n) => !d.cellular.has(n.name))
  const cells = d.project.nodes.filter((n) => d.cellular.has(n.name)).map((n) => d.cells[n.name]?.state)
  const rows: string[][] = []
  if (d.project.gateways.length || lora.length) {
    const viable = lora.filter((n) => d.links[n.name]?.link?.viable).length
    rows.push(['Gateways', String(d.project.gateways.length)], ['Nodos LoRa', String(lora.length)])
    if (lora.length) rows.push(['Enlaces viables', `${viable} de ${lora.length}`])
  }
  if (cells.length) {
    const count = (...st: (string | undefined)[]) => String(cells.filter((s) => st.includes(s)).length)
    rows.push(['Sensores 4G', String(cells.length)],
      ['4G garantizado', count('ok')],
      ['4G incierto (cerca del borde de la cobertura)', count('edge', 'differentiated')],
      ['4G posible con LTE-M / NB-IoT (verificar en campo)', count('possible')],
      ['Sin 4G', count('none')])
    const unchecked = cells.filter((s) => !s).length
    if (unchecked) rows.push(['4G sin revisar (elige un operador)', String(unchecked)])
  }
  return rows
}

/** Alphabetical by owner (titular), then by node name. */
export function byOwner(a: NodeDevice, b: NodeDevice): number {
  const key = (n: NodeDevice) => (n.owner || n.name)
  return key(a).localeCompare(key(b), 'es', { sensitivity: 'base' }) || a.name.localeCompare(b.name, 'es')
}

/** "AGU-D0248 · Trinidad Torres Contreras", or just the name. */
export function nodeTitle(n: NodeDevice): string {
  return n.owner ? `${n.name} · ${n.owner}` : n.name
}

export const hectares = (v?: number) => (v == null ? '—' : `${num(v, 2)} ha`)

/** Settings in one line. */
export function settingsLine(d: ReportData): string {
  const s = d.project.settings
  return `${s.freq_mhz} MHz · margen de seguridad ${num(s.safety_margin, 1)} dB · modelo `
    + `${s.propagation_model === 'itm' ? 'ITM / ITU-R P.526' : 'simple'}${s.cell_operator ? ` · 4G: ${s.cell_operator}` : ''}`
}

function status(d: ReportData, name: string): string {
  if (d.cellular.has(name)) {
    const c = d.cells[name]
    return c ? c.short : 'Sin revisar'
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

/** LoRa nodes: one row each (null when the project has none). */
export function loraTable(d: ReportData): Table | null {
  const nodes = d.project.nodes.filter((n) => !d.cellular.has(n.name)).sort(byOwner)
  if (!nodes.length) return null
  const x = extras(nodes, true)
  return {
    title: 'Nodos LoRa',
    head: ['Nodo', ...x.head, 'Gateway', 'Distancia', 'Margen', 'Estado'],
    rows: nodes.map((n) => {
      const l = d.links[n.name]?.link
      return [n.name, ...x.cells(n), l?.gateway ?? '—', l ? distance(l.distance_m) : '—',
        l ? `${num(l.margin_db, 1)} dB` : '—', status(d, n.name)]
    }),
    colors: nodes.map((n) => statusColor(d, n.name)),
  }
}

/** 4G sensors: one row each (null when the project has none). */
export function cellTable(d: ReportData): Table | null {
  const nodes = d.project.nodes.filter((n) => d.cellular.has(n.name)).sort(byOwner)
  if (!nodes.length) return null
  const x = extras(nodes, true)
  return {
    title: `Sensores 4G${d.project.settings.cell_operator ? ` (${d.project.settings.cell_operator})` : ''}`,
    head: ['Nodo', ...x.head, 'Cubierto alrededor', 'Estado'],
    rows: nodes.map((n) => {
      const c = d.cells[n.name]
      return [n.name, ...x.cells(n), c?.nearby_share != null ? `${Math.round(c.nearby_share * 100)} %` : '—', status(d, n.name)]
    }),
    colors: nodes.map((n) => statusColor(d, n.name)),
  }
}

/** The few facts that matter for one node. */
export function nodeFacts(d: ReportData, s: NodeSection): string[][] {
  const n = s.node
  const model = d.catalog.node_profiles[n.model]?.label ?? n.model
  const info = [...(n.owner ? [['Titular', n.owner]] : []), ...(n.area_ha != null ? [['Superficie', hectares(n.area_ha)]] : [])]
  if (s.cellular) {
    const c = d.cells[n.name]
    return [
      ...info,
      ['Estado 4G', c ? c.text.replace(/^[^\p{L}\p{N}]+/u, '') : 'Sin revisar (elige un operador)'],
      ['Cubierto alrededor (300 m)', c?.nearby_share != null ? `${Math.round(c.nearby_share * 100)} %` : '—'],
      ...(c && !c.covered ? [['Cobertura más cercana', c.nearest_m != null ? distance(c.nearest_m) : '> 20 km']] : []),
      ['Modelo', model],
      ['Coordenadas', `${n.lat.toFixed(5)}, ${n.lon.toFixed(5)}`],
    ]
  }
  const l = d.links[n.name]?.link
  if (!l) return [...info, ['Modelo', model], ['Estado', status(d, n.name)], ['Coordenadas', `${n.lat.toFixed(5)}, ${n.lon.toFixed(5)}`]]
  return [
    ...info,
    ['Gateway', l.gateway],
    ['Distancia', distance(l.distance_m)],
    ['Margen del enlace', `${num(l.margin_db, 1)} dB`],
    ['RSSI / SNR', `${num(l.rssi_dbm, 0)} dBm / ${num(l.snr_db, 1)} dB`],
    ['SF · entorno', `SF${n.sf ?? '—'} · ${envLabel(d, n.environment)}`],
    ['Modelo', model],
  ]
}
