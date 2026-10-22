// File readers for the import: KML / KMZ (placemarks as GeoJSON features) and tables
// (XLSX / CSV). Everything runs in the browser: the file is never uploaded.
import type { Feature, FeatureCollection } from 'geojson'

/** A table cell: its value and, for XLSX numbers, the display format (to spot dates). */
export interface Cell { v: string | number | null; fmt?: string }
export type Table = { headers: string[]; rows: Cell[][] }
export type ReadResult = { kind: 'features'; features: Feature[] } | { kind: 'table'; table: Table }

export async function readFile(file: File): Promise<ReadResult> {
  const ext = file.name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'kml') return { kind: 'features', features: await kmlFeatures(await file.text()) }
  if (ext === 'kmz') {
    const { default: JSZip } = await import('jszip')
    const zip = await JSZip.loadAsync(await file.arrayBuffer())
    const doc = zip.file('doc.kml') ?? zip.file(/\.kml$/i)[0]
    if (!doc) throw new Error('El KMZ no contiene un archivo KML')
    return { kind: 'features', features: await kmlFeatures(await doc.async('string')) }
  }
  if (ext === 'xlsx') return { kind: 'table', table: await readXlsx(await file.arrayBuffer()) }
  if (ext === 'csv' || ext === 'txt' || ext === 'tsv') return { kind: 'table', table: readCsv(await file.text()) }
  if (ext === 'xls') throw new Error('Formato .xls antiguo: guárdalo como .xlsx o .csv desde Excel')
  throw new Error('Formato no reconocido: usa KML, KMZ, XLSX o CSV')
}

async function kmlFeatures(text: string): Promise<Feature[]> {
  const { kml } = await import('@tmcw/togeojson')
  const doc = new DOMParser().parseFromString(text, 'text/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new Error('El KML no se pudo leer (XML no válido)')
  const fc = kml(doc) as FeatureCollection
  return fc.features.filter((f) => f.geometry)
}

// ── CSV ──
export function readCsv(text: string): Table {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const delim = ['\t', ';', ','].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0]
  const rows: string[][] = []
  let row: string[] = [], field = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"' && field === '') quoted = true
    else if (c === delim) { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  const nonEmpty = rows.filter((r) => r.some((x) => x.trim() !== ''))
  const [headers = [], ...body] = nonEmpty
  return { headers: headers.map((h) => h.trim()), rows: body.map((r) => r.map((v) => ({ v: v.trim() === '' ? null : v.trim() }))) }
}

// ── XLSX (first sheet), read directly so the cell formats are kept ──
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57])

async function readXlsx(buf: ArrayBuffer): Promise<Table> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(buf)
  const xml = async (path: string) => {
    const f = zip.file(path)
    return f ? new DOMParser().parseFromString(await f.async('string'), 'text/xml') : null
  }
  const shared = [...((await xml('xl/sharedStrings.xml'))?.getElementsByTagName('si') ?? [])]
    .map((si) => [...si.getElementsByTagName('t')].map((t) => t.textContent ?? '').join(''))
  const styles = await xml('xl/styles.xml')
  const fmtCodes = new Map<number, string>()
  for (const n of styles?.getElementsByTagName('numFmt') ?? []) fmtCodes.set(Number(n.getAttribute('numFmtId')), n.getAttribute('formatCode') ?? '')
  const xfs = [...(styles?.getElementsByTagName('cellXfs')[0]?.getElementsByTagName('xf') ?? [])]
    .map((x) => Number(x.getAttribute('numFmtId') ?? 0))
  const fmtOf = (s: string | null) => {
    const id = xfs[Number(s ?? 0)] ?? 0
    return fmtCodes.get(id) ?? (BUILTIN_DATE_FORMATS.has(id) ? 'date' : '')
  }
  // First sheet of the workbook (follow the relationship, the file name is not always sheet1)
  const wb = await xml('xl/workbook.xml')
  const rels = await xml('xl/_rels/workbook.xml.rels')
  const rid = wb?.getElementsByTagName('sheet')[0]?.getAttribute('r:id')
  const target = [...(rels?.getElementsByTagName('Relationship') ?? [])].find((r) => r.getAttribute('Id') === rid)?.getAttribute('Target')
  const sheet = await xml(target ? `xl/${target.replace(/^\/?xl\//, '')}` : 'xl/worksheets/sheet1.xml')
  if (!sheet) throw new Error('El Excel no tiene hojas')
  const grid: Cell[][] = []
  for (const r of sheet.getElementsByTagName('row')) {
    const row: Cell[] = []
    for (const c of r.getElementsByTagName('c')) {
      const col = colIndex(c.getAttribute('r') ?? '')
      const t = c.getAttribute('t')
      const v = c.getElementsByTagName('v')[0]?.textContent ?? null
      let cell: Cell
      if (t === 's') cell = { v: v === null ? null : shared[Number(v)] ?? null }
      else if (t === 'inlineStr') cell = { v: c.getElementsByTagName('t')[0]?.textContent ?? null }
      else if (t === 'str' || t === 'b' || t === 'e') cell = { v }
      else cell = { v: v === null ? null : Number(v), fmt: fmtOf(c.getAttribute('s')) }
      row[col] = cell
    }
    grid.push(Array.from(row, (x) => x ?? { v: null }))
  }
  const nonEmpty = grid.filter((r) => r.some((c) => c.v !== null && String(c.v).trim() !== ''))
  const [head = [], ...body] = nonEmpty
  return { headers: head.map((c) => String(c.v ?? '').trim()), rows: body }
}

function colIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? 'A'
  return [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
}
