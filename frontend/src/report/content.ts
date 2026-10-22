// Report text and tables, shared by the PDF and the HTML versions (ui/report.py, in Spanish).
import { distance, num } from '../geo'
import type { ReportData } from './collect'

export type Table = { title: string; head: string[]; rows: string[][] }

export const GLOSSARY: [string, string][] = [
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

export const SOURCES = [
  'Elevación: Copernicus DEM GLO-90 (© DLR e.V. 2010-2014 y © Airbus Defence and Space GmbH 2014-2018, '
    + 'proporcionado bajo COPERNICUS por la Unión Europea y la ESA).',
  'Cobertura 4G: Mapas de cobertura del servicio móvil, Comisión Reguladora de Telecomunicaciones, '
    + 'datos.gob.mx (CC BY 4.0).',
  'Imágenes satelitales y nombres: © Esri y sus proveedores.',
]

const MODEL_NAMES: Record<string, string> = { itm: 'ITM', short: 'P.526', simple: 'Simple' }

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

export function tables(d: ReportData): Table[] {
  const s = d.project.settings
  const t: Table[] = [{
    title: 'Configuración de radio',
    head: ['Parámetro', 'Valor'],
    rows: [
      ['Frecuencia', `${s.freq_mhz} MHz`],
      ['Modelo de propagación', s.propagation_model === 'itm' ? 'ITM + ITU-R P.526 (el más conservador)' : 'Simple'],
      ['Margen de seguridad', `${num(s.safety_margin, 1)} dB`],
      ['Entorno por defecto', envLabel(d, s.environment)],
      ['Operador 4G', s.cell_operator ?? '—'],
    ],
  }]
  if (d.project.gateways.length) {
    t.push({
      title: 'Gateways',
      head: ['Nombre', 'Modelo', 'Latitud', 'Longitud', 'Altura', 'Potencia', 'Ganancia', 'Estado'],
      rows: d.project.gateways.map((g) => [
        g.name, d.catalog.gateway_profiles[g.model]?.label ?? g.model, g.lat.toFixed(6), g.lon.toFixed(6),
        `${num(g.height ?? 0, 1)} m`, `${num(g.tx_power ?? 0, 0)} dBm`, `${num(g.gain ?? 0, 1)} dBi`,
        g.online ? 'En línea' : 'Fuera de línea',
      ]),
    })
  }
  const lora = d.project.nodes.filter((n) => !d.cellular.has(n.name))
  if (lora.length) {
    t.push({
      title: 'Nodos LoRa',
      head: ['Nombre', 'Modelo', 'Gateway', 'Distancia', 'Margen', 'RSSI', 'SNR', 'SF', 'Entorno', 'Estado'],
      rows: lora.map((n) => {
        const r = d.links[n.name]
        const l = r?.link
        return [
          n.name, d.catalog.node_profiles[n.model]?.label ?? n.model, l?.gateway ?? '—',
          l ? distance(l.distance_m) : '—', l ? `${num(l.margin_db, 1)} dB` : '—',
          l ? `${num(l.rssi_dbm, 0)} dBm` : '—', l ? `${num(l.snr_db, 1)} dB` : '—', `SF${n.sf ?? '—'}`,
          envLabel(d, n.environment), l ? (l.viable ? 'Viable' : 'No viable') : (r?.error ?? 'Sin resultado'),
        ]
      }),
    })
  }
  const cell = d.project.nodes.filter((n) => d.cellular.has(n.name))
  if (cell.length) {
    t.push({
      title: 'Sensores 4G',
      head: ['Nombre', 'Modelo', 'Latitud', 'Longitud', 'Estado'],
      rows: cell.map((n) => [
        n.name, d.catalog.node_profiles[n.model]?.label ?? n.model, n.lat.toFixed(6), n.lon.toFixed(6),
        d.cells[n.name]?.text.replace(/^[^\p{L}\p{N}]+/u, '') ?? 'Sin revisar (elige un operador)',
      ]),
    })
  }
  return t
}

/** Link budget of one section, as rows. */
export function budgetRows(b: Record<string, unknown>): string[][] {
  const f = (k: string, unit = 'dB', digits = 1) => {
    const v = b[k]
    return typeof v === 'number' ? `${num(v, digits)} ${unit}` : '—'
  }
  return [
    ['Potencia TX del nodo', f('tx_power_dbm', 'dBm')],
    ['PIRE (EIRP)', f('eirp_dbm', 'dBm')],
    ['Pérdida en espacio libre', f('fspl_db')],
    ['Pérdida por terreno', `${f('terrain_loss_db')} (${MODEL_NAMES[String(b.propagation_model)] ?? b.propagation_model})`],
    ['Pérdida por entorno', f('clutter_loss_db')],
    ['Pérdida total del trayecto', f('total_path_loss_db')],
    ['Potencia recibida (RSSI)', f('rx_power_dbm', 'dBm')],
    ['Sensibilidad del gateway', f('sensitivity_dbm', 'dBm')],
    ['Margen de seguridad', f('fading_margin_db')],
    ['Margen del enlace', f('link_margin_db')],
    ['SNR (requerida)', `${f('snr_db')} (${f('snr_required_db')})`],
    ['Despeje mínimo de Fresnel', f('fresnel_min_clearance_pct', '%', 0)],
  ]
}
