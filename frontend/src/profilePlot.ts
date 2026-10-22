// Elevation profile figure (Plotly), shared by the app panel and the reports.
// Same traces and look as ui/profile_interactive.py: gateway at the left, node at the right.
import type { Profile } from './types'

export const PROFILE_BG = '#0e1117'
export const PROFILE_INK = '#e9ecef'
export const PROFILE_MUTED = '#adb5bd'

/** Plotly in Spanish: toolbar tooltips and number format. */
export const PLOTLY_LOCALE = {
  moduleType: 'locale',
  name: 'es',
  dictionary: {
    'Zoom in': 'Acercar', 'Zoom out': 'Alejar', 'Reset axes': 'Restablecer ejes',
    'Autoscale': 'Autoescalar', 'Pan': 'Desplazar', 'Zoom': 'Zoom',
    'Download plot as a png': 'Descargar como PNG', 'Download plot': 'Descargar gráfica',
    'Toggle Spike Lines': 'Líneas guía', 'Show closest data on hover': 'Dato más cercano',
    'Compare data on hover': 'Comparar datos', 'Produced with Plotly.js': 'Hecho con Plotly.js',
    'Double-click to zoom back out': 'Doble clic para alejar',
  },
}

export interface ProfileTitle {
  gateway: string
  node: string
  sf?: number
  freqMhz: number
}

/** Ground slope (%) over ~60 m: DEM cells are 90 m, so neighbour differences are mostly 0. */
export function slopes(p: Profile): number[] {
  const d = p.distances_m
  const e = p.elevations_m
  const n = e.length
  if (n < 2) return e.map(() => 0)
  const w = Math.max(1, Math.round(30 / ((d[1] - d[0]) || 1)))
  return e.map((_, i) => {
    const lo = Math.max(0, i - w)
    const hi = Math.min(n - 1, i + w)
    const run = d[hi] - d[lo]
    return run > 0 ? ((e[hi] - e[lo]) / run) * 100 : 0
  })
}

export function profileTitle(p: Profile, t: ProfileTitle): string {
  const km = (p.distances_m[p.distances_m.length - 1] / 1000).toFixed(2)
  return `${t.gateway} → ${t.node} | ${km} km${t.sf ? ` | SF${t.sf}` : ''} | ${t.freqMhz} MHz`
}

export const TERRAIN_TRACE = 1
export const PIN_TRACE = 9

export function profileFigure(p: Profile, title: string, pins: number[] = []) {
  const x = p.distances_m.map((v) => v / 1000)
  const elev = p.elevations_m
  const eff = p.effective_terrain_m
  const los = p.los_m
  const fr = p.fresnel_radius_m
  const up = los.map((h, i) => h + fr[i])
  const lo = los.map((h, i) => h - fr[i])
  const slope = slopes(p)
  const obstructed = p.clearance_m.map((c, i) => (c < 0 ? i : -1)).filter((i) => i >= 0)
  const all = [...elev, ...eff, ...up, ...lo, p.gw_antenna_asl, p.node_antenna_asl]
  const yMin = Math.min(...all)
  const yMax = Math.max(...all)
  const pad = Math.max((yMax - yMin) * 0.15, 5)
  const base = x.map(() => yMin - pad)
  const last = x.length - 1
  const custom = x.map((_, i) => [p.coordinates[i][0], p.coordinates[i][1], p.clearance_m[i], slope[i]])

  const data = [
    { x, y: base, mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false },
    {
      x, y: elev, name: 'Terreno', mode: 'lines', fill: 'tonexty',
      fillcolor: 'rgba(45,106,79,0.5)', line: { color: '#40916c', width: 1.5 }, customdata: custom,
      hovertemplate: '<b>%{x:.2f} km</b> · %{y:.0f} m<br>pendiente %{customdata[3]:+.1f}% · '
        + 'despeje Fresnel %{customdata[2]:.0f} m<br><span style="font-size:10px">'
        + '%{customdata[0]:.5f}, %{customdata[1]:.5f}</span><extra></extra>',
    },
    { x, y: eff, name: 'Terreno efectivo (k=4/3)', mode: 'lines', line: { color: '#95d5b2', width: 1, dash: 'dash' }, hoverinfo: 'skip' },
    { x, y: lo, mode: 'lines', line: { color: 'rgba(255,209,102,0.5)', width: 0.5 }, hoverinfo: 'skip', showlegend: false },
    {
      x, y: up, name: 'Fresnel F1', mode: 'lines', fill: 'tonexty', fillcolor: 'rgba(255,209,102,0.15)',
      line: { color: 'rgba(255,209,102,0.5)', width: 0.5 }, hoverinfo: 'skip',
    },
    { x, y: los, name: 'Línea de vista', mode: 'lines', line: { color: '#e0e0e0', width: 1.5 }, hoverinfo: 'skip' },
    {
      x: obstructed.map((i) => x[i]), y: obstructed.map((i) => eff[i]), name: 'Obstrucción', mode: 'markers',
      marker: { color: '#ef476f', symbol: 'triangle-up', size: 8 }, hoverinfo: 'skip',
    },
    {
      x: [x[0], x[0]], y: [elev[0], p.gw_antenna_asl], name: 'Gateway', mode: 'lines+markers+text',
      line: { color: '#4cc3e8', width: 4 }, marker: { symbol: 'square', size: [0, 12], color: '#4cc3e8' },
      text: ['', 'GW'], textposition: 'top right', textfont: { color: '#4cc3e8', size: 11 }, hoverinfo: 'skip',
    },
    {
      x: [x[last], x[last]], y: [elev[last], p.node_antenna_asl], name: 'Nodo', mode: 'lines+markers+text',
      line: { color: '#06d6a0', width: 4 }, marker: { symbol: 'square', size: [0, 12], color: '#06d6a0' },
      text: ['', 'Nodo'], textposition: 'top left', textfont: { color: '#06d6a0', size: 11 }, hoverinfo: 'skip',
    },
    {
      x: pins.map((i) => x[i]), y: pins.map((i) => elev[i]), text: pins.map((_, k) => String(k + 1)),
      name: 'Puntos', mode: 'markers+text', showlegend: false, textposition: 'top center',
      textfont: { size: 11, color: '#ffffff' },
      marker: { color: '#ef476f', size: 10, line: { color: '#ffffff', width: 1.5 } }, hoverinfo: 'skip',
    },
  ]
  const layout = {
    title: { text: title, font: { color: PROFILE_INK, size: 14 } },
    paper_bgcolor: PROFILE_BG, plot_bgcolor: PROFILE_BG,
    font: { color: PROFILE_MUTED, family: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
    margin: { l: 64, r: 24, t: 44, b: 64 },
    hovermode: 'x',
    hoverlabel: { font: { size: 11, color: PROFILE_INK }, bgcolor: '#1a1d24', bordercolor: '#495057' },
    xaxis: {
      title: { text: 'Distancia (km)' }, range: [x[0], x[last]], gridcolor: '#262b33', zeroline: false, hoverformat: '.2f',
      showline: true, linecolor: '#495057', ticks: 'outside', tickcolor: '#495057',
      showspikes: true, spikemode: 'across', spikecolor: '#ffd166', spikethickness: 1, spikedash: 'solid',
    },
    yaxis: {
      title: { text: 'Elevación (m s.n.m.)' }, range: [yMin - pad, yMax + pad], gridcolor: '#262b33',
      zeroline: false, showline: true, linecolor: '#495057', ticks: 'outside', tickcolor: '#495057',
    },
    legend: { orientation: 'h', y: -0.2, x: 0.5, xanchor: 'center', yanchor: 'top', font: { size: 10 }, bgcolor: 'rgba(0,0,0,0)' },
  }
  return { data, layout }
}

export const PLOTLY_CONFIG = {
  responsive: true,
  displaylogo: false,
  locale: 'es',
  scrollZoom: true,
  modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d'],
}
