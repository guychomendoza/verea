// Import rules, no AI: which column / property is what, repairs of what Excel and KML exports
// usually break, and the pin ↔ plot (parcela) join by location. Pure functions (tested).
import type { Feature, Geometry, Position } from 'geojson'
import type { Plot, PlotGeometry } from '../types'
import { areaHa, contains, interiorPoint } from './geometry'
import type { Cell, Table } from './readers'

export type Role = 'folio' | 'owner' | 'lat' | 'lon' | 'latlon' | 'area' | 'notes' | 'ignore'
export const ROLE_LABELS: Record<Role, string> = {
  folio: 'Folio / clave', owner: 'Titular / nombre', lat: 'Latitud', lon: 'Longitud',
  latlon: 'Latitud y longitud juntas (o enlace de Google Maps)', area: 'Superficie (ha)', notes: 'Notas',
  ignore: 'No usar',
}

/** One sensor to add (or update), with what was fixed automatically and what needs a look. */
export interface ImportRow {
  key: string
  folio?: string
  owner?: string
  label?: string                 // original name in the file
  lat: number
  lon: number
  area_ha?: number
  plot?: Plot
  notes: string[]                // ℹ fixed automatically
  issues: string[]               // ⚠ please check
}

// Mexico (with a margin): coordinates outside are suspicious
export const MX = { latMin: 14, latMax: 33, lonMin: -118.5, lonMax: -86.5 }
export const FOLIO_RE = /\b[A-Z]{2,5}-?[A-Z]?-?\d{3,6}\b/

export function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

// ── which column is what ──
const HEADER_RULES: [Role, RegExp][] = [
  ['latlon', /(lat.*lon|lon.*lat|coordenad|ubicacion|google ?maps|maps|enlace|link|url)/],
  ['lat', /^(lat|latitud|latitude|y)\b/],
  ['lon', /^(lon|lng|long|longitud|longitude|x)\b/],
  ['folio', /(folio|clave|codigo|^id\b|expediente)/],
  ['area', /(superficie|hectar|\bha\b|area)/],
  ['notes', /(nota|observ|coment)/],
  ['owner', /(titular|nombre|propietario|productor|beneficiario|owner|name)/],
]

/** Role of every column, from its header and (for the folio) from its values. */
export function detectRoles(table: Table): Role[] {
  const roles: Role[] = table.headers.map((h) => HEADER_RULES.find(([, re]) => re.test(norm(h)))?.[0] ?? 'ignore')
  // Only the first column of each role is used (e.g. "Nombre" before "Nombre (lista)")
  const seen = new Set<Role>()
  roles.forEach((r, i) => { if (r !== 'ignore' && seen.has(r)) roles[i] = 'ignore'; seen.add(r) })
  if (!roles.includes('folio')) {
    const i = table.headers.findIndex((_, c) => roles[c] === 'ignore' && share(table, c, (v) => FOLIO_RE.test(String(v).toUpperCase())) > 0.6)
    if (i >= 0) roles[i] = 'folio'
  }
  // lat/lon split columns are preferred over a combined one when both exist
  if (roles.includes('lat') && roles.includes('lon')) roles.forEach((r, i) => { if (r === 'latlon') roles[i] = 'ignore' })
  return roles
}

function share(t: Table, col: number, test: (v: string | number) => boolean): number {
  const vals = t.rows.map((r) => r[col]?.v).filter((v): v is string | number => v !== null && v !== undefined && v !== '')
  return vals.length ? vals.filter(test).length / vals.length : 0
}

// ── coordinates ──
const inLat = (v: number) => v >= MX.latMin && v <= MX.latMax
const inLon = (v: number) => v >= MX.lonMin && v <= MX.lonMax

/** One coordinate, repaired when Excel dropped the decimal point (196452863 → 19.6452863). */
export function fixCoord(v: number, axis: 'lat' | 'lon'): { value: number; note?: string } | null {
  if (!Number.isFinite(v)) return null
  const ok = axis === 'lat' ? inLat : inLon
  if (ok(v)) return { value: v }
  if (axis === 'lon' && ok(-v)) return { value: -v, note: 'longitud sin signo negativo (corregida)' }
  for (const sign of axis === 'lon' && v > 0 ? [-1, 1] : [1]) {
    for (let k = 1; k <= 12; k++) {
      const c = (sign * v) / 10 ** k
      if (ok(c) && Math.abs(v) >= 1000) return { value: c, note: 'coordenada sin punto decimal (corregida)' }
    }
  }
  return null
}

function parseNumber(s: string): number {
  const t = s.trim().replace(/\s/g, '')
  return Number(/^-?\d+,\d+$/.test(t) ? t.replace(',', '.') : t)
}

/** Degrees from "19.645", "19,645", "19°38'43.0\"N", "103°16'18\"W" / "O". */
export function parseDegrees(s: string): number {
  const dms = s.match(/(-?\d+(?:[.,]\d+)?)\s*[°º]\s*(?:(\d+(?:[.,]\d+)?)\s*['′]\s*)?(?:(\d+(?:[.,]\d+)?)\s*(?:["″]|'')\s*)?([NSEWO])?/i)
  if (dms) {
    const [d, m = '0', sec = '0'] = [dms[1], dms[2], dms[3]].map((x) => x?.replace(',', '.'))
    let v = Math.abs(Number(d)) + Number(m) / 60 + Number(sec) / 3600
    if (d.startsWith('-') || /[SWO]/i.test(dms[4] ?? '')) v = -v
    return v
  }
  return parseNumber(s)
}

/** "lat, lon", a Google Maps link (q=, @, ll=) or two DMS values. */
export function parsePair(s: string): [number, number] | null {
  const url = s.match(/[?&](?:q|ll|query)=(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/) ?? s.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/)
  if (url) return [Number(url[1]), Number(url[2])]
  const parts = s.includes('°') ? s.split(/(?<=[NSEWO"″])\s*[,;\s]\s*/i) : s.split(/\s*[;,]\s*|\s+/)
  const nums = parts.filter((p) => p.trim()).map(parseDegrees)
  return nums.length === 2 && nums.every(Number.isFinite) ? [nums[0], nums[1]] : null
}

// ── areas ──
const DATE_FMT = /(^date$|[dmy])/i

/** Hectares; a value Excel turned into a date (5.06 → 5 June) is read back as day.month. */
export function parseArea(cell: Cell): { value?: number; note?: string } {
  if (cell.v === null || cell.v === '') return {}
  if (typeof cell.v === 'number') {
    if (cell.fmt && DATE_FMT.test(cell.fmt) && !/^[#0.,% ]+$/.test(cell.fmt) && cell.v > 20000) {
      const d = new Date(Date.UTC(1899, 11, 30) + cell.v * 86_400_000)
      const day = d.getUTCDate(), month = d.getUTCMonth() + 1
      const monthFirst = /m.*d/i.test(cell.fmt) && !/d.*m/i.test(cell.fmt)
      const [a, b] = monthFirst ? [month, day] : [day, month]
      const two = /dd|mm/i.test(cell.fmt)
      const value = Number(`${a}.${two ? String(b).padStart(2, '0') : b}`)
      return { value, note: `superficie que Excel convirtió en fecha; se leyó como ${value} ha (revisar)` }
    }
    return { value: cell.v }
  }
  const n = parseNumber(String(cell.v).replace(/\s*(ha|hect[aá]reas?)\.?$/i, ''))
  return Number.isFinite(n) ? { value: n } : {}
}

// ── table → rows ──
export function rowsFromTable(table: Table, roles: Role[]): ImportRow[] {
  const col = (r: Role) => roles.indexOf(r)
  const out: ImportRow[] = []
  table.rows.forEach((cells, i) => {
    const get = (r: Role) => (col(r) >= 0 ? cells[col(r)] ?? { v: null } : { v: null })
    const text = (r: Role) => { const v = get(r).v; return v === null || v === undefined ? '' : String(v).trim() }
    if (cells.every((c) => c.v === null || String(c.v).trim() === '')) return
    const notes: string[] = [], issues: string[] = []
    let lat: number | null = null, lon: number | null = null
    if (col('lat') >= 0 && col('lon') >= 0) {
      const rawLat = get('lat').v, rawLon = get('lon').v
      const a = fixCoord(typeof rawLat === 'number' ? rawLat : parseDegrees(String(rawLat ?? '')), 'lat')
      const b = fixCoord(typeof rawLon === 'number' ? rawLon : parseDegrees(String(rawLon ?? '')), 'lon')
      if (a && b) { lat = a.value; lon = b.value; for (const n of [a.note, b.note]) if (n) notes.push(n) }
    }
    if ((lat === null || lon === null) && col('latlon') >= 0) {
      const p = parsePair(text('latlon'))
      const a = p && fixCoord(p[0], 'lat'), b = p && fixCoord(p[1], 'lon')
      if (a && b) { lat = a.value; lon = b.value; for (const n of [a.note, b.note]) if (n) notes.push(n) }
    }
    if (lat === null || lon === null) {
      issues.push('sin coordenadas válidas en México: no se agrega')
      lat = NaN; lon = NaN
    }
    const area = parseArea(get('area'))
    if (area.note) issues.push(area.note)
    const folio = (text('folio').toUpperCase().match(FOLIO_RE)?.[0] ?? text('folio')) || undefined
    const owner = text('owner') || undefined
    const note = text('notes')
    if (note) issues.push(`nota del archivo: ${note}`)
    if (!folio) issues.push('sin folio')
    out.push({ key: `t${i}`, folio, owner, label: owner, lat, lon, area_ha: area.value, notes: [...new Set(notes)], issues })
  })
  return markDuplicates(out)
}

// ── KML → rows: pins and plots joined by location ──
interface Mark { name: string; folio?: string; owner?: string; listed?: string; declaredHa?: number; props: Record<string, unknown> }

/** "Folio: X<br>Nombre (lista): Y<br>Superficie aprox.: 5.06 ha" → {folio: X, ...} (Google Earth descriptions). */
export function descriptionFields(html: string): Record<string, string> {
  const text = html.replace(/<br\s*\/?>|<\/(p|div|tr|li)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([^:]{1,40}):\s*(.+?)\s*$/)
    if (m) out[norm(m[1])] = m[2]
  }
  return out
}

function describe(props: Record<string, unknown>, ownerKeys: string[]): Mark {
  const name = String(props.name ?? '').trim()
  const texts = [name, ...Object.entries(props).filter(([k]) => !['name', 'styleUrl', 'styleHash', 'styleMapHash', 'stroke', 'fill',
    'stroke-opacity', 'fill-opacity', 'stroke-width', 'icon', 'visibility'].includes(k)).map(([, v]) => String(v ?? ''))]
  const folio = texts.map((t) => t.toUpperCase().match(FOLIO_RE)?.[0]).find(Boolean)
  const ownerProp = ownerKeys.map((k) => props[k]).find((v) => typeof v === 'string' && v.trim()) as string | undefined
  // Owner: an owner-like property, else the name without the folio and its brackets / dashes
  const fromName = name.replace(FOLIO_RE, '').replace(/[()[\]]/g, ' ').replace(/^\s*[-–:,·]\s*|\s*[-–:,·]\s*$/g, '').replace(/\s+/g, ' ').trim()
  const owner = ownerProp?.trim() || (fromName && !/^(pin|punto|marcador|placemark|untitled|sin t[ií]tulo)\b/i.test(fromName) ? fromName : undefined)
  const fields = typeof props.description === 'string' ? descriptionFields(props.description) : {}
  const listed = Object.entries(fields).find(([k]) => /(nombre|titular|propietario|beneficiario)/.test(k))?.[1]
  const areaText = Object.entries(fields).find(([k]) => /(superficie|hectar|area)/.test(k))?.[1]
  const declaredHa = areaText ? parseArea({ v: areaText }).value : undefined
  return { name, folio, owner, listed, declaredHa, props }
}

function parts(g: Geometry): { points: Position[]; polys: number[][][][] } {
  if (g.type === 'Point') return { points: [g.coordinates], polys: [] }
  if (g.type === 'MultiPoint') return { points: g.coordinates, polys: [] }
  if (g.type === 'Polygon') return { points: [], polys: [g.coordinates] }
  if (g.type === 'MultiPolygon') return { points: [], polys: g.coordinates }
  if (g.type === 'GeometryCollection') {
    const all = g.geometries.map(parts)
    return { points: all.flatMap((p) => p.points), polys: all.flatMap((p) => p.polys) }
  }
  return { points: [], polys: [] }
}

/** Similar names ("Marco" / "Marcos", "Virgina" / "Virginia"): same after removing accents and few edits. */
export function sameName(a: string, b: string): 'same' | 'close' | 'different' {
  const x = norm(a), y = norm(b)
  if (x === y) return 'same'
  return editDistance(x, y) <= Math.max(2, Math.floor(Math.min(x.length, y.length) / 10)) ? 'close' : 'different'
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]
    d[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j]
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return d[b.length]
}

export function rowsFromFeatures(features: Feature[]): { rows: ImportRow[]; ignored: number } {
  const keys = new Set(features.flatMap((f) => Object.keys(f.properties ?? {})))
  const ownerKeys = [...keys].filter((k) => /(titular|nombre|propietario|productor|beneficiario|owner)/.test(norm(k)))
  const pins: { mark: Mark; lon: number; lat: number; used: boolean }[] = []
  const plots: { mark: Mark; geometry: PlotGeometry }[] = []
  let ignored = 0
  for (const f of features) {
    const mark = describe((f.properties ?? {}) as Record<string, unknown>, ownerKeys)
    const p = parts(f.geometry)
    for (const [lon, lat] of p.points) pins.push({ mark, lon, lat, used: false })
    if (p.polys.length) {
      plots.push({ mark, geometry: p.polys.length === 1 ? { type: 'Polygon', coordinates: p.polys[0] } : { type: 'MultiPolygon', coordinates: p.polys } })
    }
    if (!p.points.length && !p.polys.length) ignored++
  }
  const rows: ImportRow[] = []
  const extraPins: { pin: (typeof pins)[number]; plot: string; j: number }[] = []
  plots.forEach((pl, i) => {
    const inside = pins.filter((p) => !p.used && contains(pl.geometry, p.lon, p.lat))
    const area = Math.round(areaHa(pl.geometry) * 100) / 100
    const notes: string[] = [`superficie medida del polígono: ${area} ha`]
    const issues: string[] = []
    const pin = inside[0]
    for (const p of inside) p.used = true
    if (inside.length > 1) {
      issues.push(`hay ${inside.length} pines en esta parcela; se usó "${pin.mark.name}"`)
      inside.slice(1).forEach((p, j) => extraPins.push({ pin: p, plot: pl.mark.folio ?? pl.mark.name, j }))
    }
    let [lon, lat] = pin ? [pin.lon, pin.lat] : interiorPoint(pl.geometry)
    if (!pin) notes.push('parcela sin pin: sensor propuesto en el centro de la parcela')
    const folio = pl.mark.folio ?? pin?.mark.folio
    if (pin?.mark.folio && pl.mark.folio && pin.mark.folio !== pl.mark.folio) {
      issues.push(`el pin dice ${pin.mark.folio} y la parcela ${pl.mark.folio}; se usó el de la parcela`)
    }
    if (pin && !pin.mark.folio && pl.mark.folio) notes.push('el pin no tiene folio; se tomó el de su parcela')
    if (pin?.mark.folio && !pl.mark.folio) notes.push('la parcela no tiene folio; se tomó el de su pin')
    const owner = pl.mark.owner ?? pin?.mark.owner
    if (pin?.mark.owner && pl.mark.owner) {
      const s = sameName(pin.mark.owner, pl.mark.owner)
      if (s === 'close') notes.push(`ortografía distinta entre pin ("${pin.mark.owner}") y parcela ("${pl.mark.owner}")`)
      if (s === 'different') issues.push(`el pin dice "${pin.mark.owner}" y la parcela "${pl.mark.owner}": confirmar titular`)
    }
    // What the file declares, against what the polygon measures / the name it shows
    const declared = pl.mark.declaredHa ?? pin?.mark.declaredHa
    if (declared && Math.abs(area - declared) / declared > 0.1) {
      issues.push(`superficie declarada ${declared} ha, medida del polígono ${area} ha`)
    }
    const listed = pl.mark.listed ?? pin?.mark.listed
    if (listed && owner) {
      const s = sameName(listed, owner)
      if (s === 'close') notes.push(`ortografía distinta con la lista ("${listed}")`)
      if (s === 'different') issues.push(`en la lista aparece "${listed}": confirmar titular`)
    }
    if (!folio) issues.push('sin folio')
    if (!(inLat(lat) && inLon(lon))) issues.push('fuera de México')
    if (area > 5000) issues.push(`polígono muy grande (${Math.round(area)} ha): ¿es una parcela?`)
    ;[lon, lat] = [round7(lon), round7(lat)]
    const plot: Plot = { id: folio ?? `parcela-${i + 1}`, name: pl.mark.name, owner, area_ha: area, geometry: pl.geometry }
    rows.push({ key: `p${i}`, folio, owner, label: pl.mark.name || pin?.mark.name, lat, lon, area_ha: area, plot, notes, issues })
  })
  extraPins.forEach(({ pin: p, plot }, i) => rows.push({
    key: `x${i}`, folio: p.mark.folio, owner: p.mark.owner, label: p.mark.name, lat: round7(p.lat), lon: round7(p.lon),
    notes: [], issues: [`otro pin dentro de la parcela ${plot}`],
  }))
  pins.filter((p) => !p.used).forEach((p, i) => {
    const issues: string[] = []
    if (!p.mark.folio) issues.push('sin folio')
    if (!(inLat(p.lat) && inLon(p.lon))) issues.push('fuera de México')
    rows.push({
      key: `q${i}`, folio: p.mark.folio, owner: p.mark.owner, label: p.mark.name, lat: round7(p.lat), lon: round7(p.lon),
      notes: plots.length ? ['pin fuera de toda parcela'] : [], issues,
    })
  })
  return { rows: markDuplicates(rows), ignored }
}

const round7 = (v: number) => Math.round(v * 1e7) / 1e7

function markDuplicates(rows: ImportRow[]): ImportRow[] {
  const count = new Map<string, number>()
  for (const r of rows) if (r.folio) count.set(r.folio, (count.get(r.folio) ?? 0) + 1)
  for (const r of rows) if (r.folio && count.get(r.folio)! > 1) r.issues.push(`folio ${r.folio} repetido en el archivo`)
  return rows
}

/** Node name for a row: folio, folio + owner, or owner (max 40 characters). */
export type Naming = 'folio' | 'folio_owner' | 'owner'
export function nodeName(r: ImportRow, naming: Naming): string {
  const base = naming === 'owner' ? (r.owner ?? r.folio) : naming === 'folio_owner' && r.folio && r.owner ? `${r.folio} ${r.owner}` : (r.folio ?? r.owner)
  return (base ?? r.label ?? 'Parcela').trim().slice(0, 40).trim()
}

export const valid = (r: ImportRow) => Number.isFinite(r.lat) && Number.isFinite(r.lon)
