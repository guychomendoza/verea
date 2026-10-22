// Distances and number formats used by the map, the ruler and the reports.

const EARTH_RADIUS_M = 6_371_000

/** Great-circle distance (m) between two [lat, lon] points. */
export function haversine(a: [number, number], b: [number, number]): number {
  const toRad = Math.PI / 180
  const dLat = (b[0] - a[0]) * toRad
  const dLon = (b[1] - a[1]) * toRad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h))
}

/** Initial bearing (degrees, 0 = north) from a to b. */
export function bearing(a: [number, number], b: [number, number]): number {
  const toRad = Math.PI / 180
  const y = Math.sin((b[1] - a[1]) * toRad) * Math.cos(b[0] * toRad)
  const x = Math.cos(a[0] * toRad) * Math.sin(b[0] * toRad)
    - Math.sin(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.cos((b[1] - a[1]) * toRad)
  return (Math.atan2(y, x) / toRad + 360) % 360
}

export function num(v: number, digits = 1): string {
  return v.toLocaleString('es-MX', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

/** "850 m" below 1 km, "1.23 km" above. */
export function distance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${num(m / 1000, 2)} km`
}

export function db(v: number): string {
  return `${v >= 0 ? '' : '−'}${num(Math.abs(v), 1)} dB`
}
