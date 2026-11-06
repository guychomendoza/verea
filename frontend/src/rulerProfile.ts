// Elevation profile of the ruler's path: its figures and chart (like Google Earth's).
import { BRAND } from './brand'
import { PROFILE_BG, PROFILE_INK, PROFILE_MUTED } from './profilePlot'

export interface PathProfile {
  distances_m: number[]
  elevations_m: number[]
  coordinates: [number, number][]
  vertices_m: number[]              // distance of each clicked point from the start
  elevation_source: string
}

export interface PathStats {
  length_m: number
  min_m: number
  max_m: number
  gain_m: number
  loss_m: number
  avg_slope_pct: number
  max_slope_pct: number
}

const SLOPE_WINDOW_M = 90           // DEM cells are 90 m: closer samples only show its steps

/** Slope (%) at each sample, measured across at least one DEM cell. */
export function pathSlopes(distances: number[], elevations: number[]): number[] {
  return distances.map((d, i) => {
    let j = i
    while (j < distances.length - 1 && distances[j] - d < SLOPE_WINDOW_M) j++
    let k = i
    while (k > 0 && distances[j] - distances[k] < SLOPE_WINDOW_M) k--
    const run = distances[j] - distances[k]
    return run > 0 ? ((elevations[j] - elevations[k]) / run) * 100 : 0
  })
}

export function pathStats(p: Pick<PathProfile, 'distances_m' | 'elevations_m'>): PathStats {
  const e = p.elevations_m
  let gain = 0, loss = 0
  for (let i = 1; i < e.length; i++) {
    const step = e[i] - e[i - 1]
    if (step > 0) gain += step
    else loss -= step
  }
  const length = p.distances_m[p.distances_m.length - 1] ?? 0
  const slopes = pathSlopes(p.distances_m, e).map(Math.abs)
  return {
    length_m: length, min_m: Math.min(...e), max_m: Math.max(...e), gain_m: gain, loss_m: loss,
    avg_slope_pct: length > 0 ? ((gain + loss) / length) * 100 : 0,
    max_slope_pct: Math.max(...slopes),
  }
}

/** Index of the sample nearest a distance along the path. */
function nearest(distances: number[], d: number): number {
  let best = 0
  distances.forEach((x, i) => { if (Math.abs(x - d) < Math.abs(distances[best] - d)) best = i })
  return best
}

export const PATH_TERRAIN_TRACE = 1

// Plotly leaves numbers in customdata unformatted: they go in already written
const signed = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`

export function pathFigure(p: PathProfile) {
  const x = p.distances_m.map((v) => v / 1000)
  const e = p.elevations_m
  const lo = Math.min(...e), hi = Math.max(...e)
  const pad = Math.max((hi - lo) * 0.15, 5)
  const slopes = pathSlopes(p.distances_m, e)
  const marks = p.vertices_m.map((d) => nearest(p.distances_m, d))
  const data = [
    { x, y: x.map(() => lo - pad), mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false },
    {
      x, y: e, mode: 'lines', fill: 'tonexty', fillcolor: 'rgba(45,106,79,0.5)', line: { color: '#40916c', width: 1.8 },
      customdata: x.map((_, i) => [p.coordinates[i][0].toFixed(5), p.coordinates[i][1].toFixed(5), signed(slopes[i])]), showlegend: false,
      hovertemplate: '<b>%{x:.2f} km</b> · %{y:.0f} m<br>pendiente %{customdata[2]}%<br>'
        + '<span style="font-size:10px">%{customdata[0]}, %{customdata[1]}</span><extra></extra>',
    },
    {
      x: marks.map((i) => x[i]), y: marks.map((i) => e[i]), mode: 'markers', showlegend: false, hoverinfo: 'skip',
      marker: { color: '#ffd166', size: 8, line: { color: '#000', width: 1 } }, cliponaxis: false,
    },
  ]
  const axis = { gridcolor: BRAND.navyLine, zeroline: false, showline: true, linecolor: BRAND.navyAxis, ticks: 'outside', tickcolor: BRAND.navyAxis }
  const layout = {
    paper_bgcolor: PROFILE_BG, plot_bgcolor: PROFILE_BG,
    font: { color: PROFILE_MUTED, size: 11, family: '"Inter Variable", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
    margin: { l: 52, r: 16, t: 8, b: 44 },
    hovermode: 'x',
    hoverlabel: { font: { size: 11, color: PROFILE_INK }, bgcolor: '#16304b', bordercolor: BRAND.navyAxis },
    xaxis: { ...axis, title: { text: 'Distancia (km)', standoff: 4 }, range: [x[0], x[x.length - 1]], hoverformat: '.2f',
      showspikes: true, spikemode: 'across', spikecolor: '#ffd166', spikethickness: 1, spikedash: 'solid' },
    yaxis: { ...axis, title: { text: 'm s.n.m.' }, range: [lo - pad, hi + pad] },
  }
  return { data, layout }
}
