// Report text and tables, shared by the PDF and the HTML versions (ui/report.py, in Spanish).
import { distance, num } from '../geo'
import type { NodeSection, ReportData } from './collect'

export type Table = { title: string; head: string[]; rows: string[][] }

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
    + 'cerca de una zona sin señal: al menos 250 m donde un cerro corta la señal y hasta 500 m en terreno '
    + 'plano, donde el borde depende de la distancia a la torre. Los huecos pequeños se toman con 100 m.'],
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
  const res = lora.map((n) => d.links[n.name]?.link)
  const viable = res.filter((l) => l?.viable).length
  const cells = d.project.nodes.filter((n) => d.cellular.has(n.name)).map((n) => d.cells[n.name]?.state)
  const rows = [
    ['Gateways', String(d.project.gateways.length)],
    ['Nodos LoRa', String(lora.length)],
    ['Enlaces viables', `${viable} de ${lora.length}`],
    ['Enlaces no viables o sin resultado', String(lora.length - viable)],
  ]
  if (cells.length) {
    rows.push(['Sensores 4G', String(cells.length)],
      ['4G garantizado / incierto / sin 4G',
        `${cells.filter((s) => s === 'ok').length} / ${cells.filter((s) => s === 'edge' || s === 'differentiated').length} / ${cells.filter((s) => s === 'none').length}`])
  }
  return rows
}

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

/** One row per node: the connectivity at a glance. */
export function overviewTable(d: ReportData): Table {
  return {
    title: 'Conectividad por nodo',
    head: ['Nodo', 'Tipo', 'Gateway', 'Distancia', 'Margen', 'Estado'],
    rows: d.project.nodes.map((n) => {
      const l = d.cellular.has(n.name) ? null : d.links[n.name]?.link
      return [n.name, d.cellular.has(n.name) ? '4G' : 'LoRa', l?.gateway ?? '—',
        l ? distance(l.distance_m) : '—', l ? `${num(l.margin_db, 1)} dB` : '—', status(d, n.name)]
    }),
  }
}

/** The few facts that matter for one node. */
export function nodeFacts(d: ReportData, s: NodeSection): string[][] {
  const n = s.node
  const model = d.catalog.node_profiles[n.model]?.label ?? n.model
  if (s.cellular) {
    const c = d.cells[n.name]
    return [
      ['Modelo', model],
      ['Estado 4G', c ? c.text.replace(/^[^\p{L}\p{N}]+/u, '') : 'Sin revisar (elige un operador)'],
      ['Cubierto alrededor (300 m)', c?.nearby_share != null ? `${Math.round(c.nearby_share * 100)} %` : '—'],
      c?.covered
        ? ['Señal declarada', c.level_dbm != null ? `${c.level_dbm} dBm` : '—']
        : ['Cobertura más cercana', c?.nearest_m != null ? distance(c.nearest_m) : '> 20 km'],
      ['Coordenadas', `${n.lat.toFixed(5)}, ${n.lon.toFixed(5)}`],
    ]
  }
  const l = d.links[n.name]?.link
  if (!l) return [['Modelo', model], ['Estado', status(d, n.name)], ['Coordenadas', `${n.lat.toFixed(5)}, ${n.lon.toFixed(5)}`]]
  return [
    ['Gateway', l.gateway],
    ['Distancia', distance(l.distance_m)],
    ['Margen del enlace', `${num(l.margin_db, 1)} dB`],
    ['RSSI / SNR', `${num(l.rssi_dbm, 0)} dBm / ${num(l.snr_db, 1)} dB`],
    ['SF · entorno', `SF${n.sf ?? '—'} · ${envLabel(d, n.environment)}`],
    ['Modelo', model],
  ]
}
