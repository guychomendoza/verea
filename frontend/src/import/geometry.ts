// Plot geometry: geodesic area, point in polygon and a point inside the plot for its sensor.
import type { PlotGeometry } from '../types'

const R = 6378137                       // WGS84 equatorial radius, as turf / Google Earth

/** Area (m²) of a ring of [lon, lat] on the sphere (Chamberlain & Duquette). */
function ringArea(ring: number[][]): number {
  let total = 0
  const n = ring.length
  if (n < 3) return 0
  const rad = Math.PI / 180
  for (let i = 0; i < n; i++) {
    const [lon1, lat1] = ring[i]
    const [lon2, lat2] = ring[(i + 1) % n]
    total += (lon2 - lon1) * rad * (2 + Math.sin(lat1 * rad) + Math.sin(lat2 * rad))
  }
  return Math.abs(total * R * R / 2)
}

export const polygons = (g: PlotGeometry): number[][][][] => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates)

/** Area in hectares (holes subtracted). */
export function areaHa(g: PlotGeometry): number {
  let m2 = 0
  for (const [outer, ...holes] of polygons(g)) m2 += ringArea(outer) - holes.reduce((s, h) => s + ringArea(h), 0)
  return m2 / 10_000
}

function inRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export function contains(g: PlotGeometry, lon: number, lat: number): boolean {
  return polygons(g).some(([outer, ...holes]) => inRing(lon, lat, outer) && !holes.some((h) => inRing(lon, lat, h)))
}

export function bbox(g: PlotGeometry): [number, number, number, number] {
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const poly of polygons(g)) for (const [x, y] of poly[0]) {
    b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y)
  }
  return b
}

/**
 * A point inside the plot, where its sensor is proposed: the centroid of the largest part when
 * it falls inside, otherwise the inside point of a grid that is farthest from the border.
 */
export function interiorPoint(g: PlotGeometry): [number, number] {
  const parts = polygons(g)
  const main = parts.reduce((a, b) => (ringArea(b[0]) > ringArea(a[0]) ? b : a))
  const outer = main[0]
  let cx = 0, cy = 0, a2 = 0
  for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
    const f = outer[j][0] * outer[i][1] - outer[i][0] * outer[j][1]
    cx += (outer[j][0] + outer[i][0]) * f
    cy += (outer[j][1] + outer[i][1]) * f
    a2 += f
  }
  if (a2 !== 0) {
    const c: [number, number] = [cx / (3 * a2), cy / (3 * a2)]
    if (contains({ type: 'Polygon', coordinates: main }, c[0], c[1])) return c
  }
  const [w, s, e, n] = bbox({ type: 'Polygon', coordinates: main })
  let best: [number, number] = outer[0] as [number, number]
  let bestD = -1
  const steps = 24
  for (let i = 1; i < steps; i++) for (let j = 1; j < steps; j++) {
    const x = w + ((e - w) * i) / steps
    const y = s + ((n - s) * j) / steps
    if (!contains({ type: 'Polygon', coordinates: main }, x, y)) continue
    let d = Infinity
    for (let k = 0, m = outer.length - 1; k < outer.length; m = k++) d = Math.min(d, segDist(x, y, outer[m], outer[k]))
    if (d > bestD) { bestD = d; best = [x, y] }
  }
  return best
}

function segDist(x: number, y: number, a: number[], b: number[]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const t = dx || dy ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy))) : 0
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy))
}
