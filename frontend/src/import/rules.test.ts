import { describe, expect, it } from 'vitest'
import { areaHa, interiorPoint } from './geometry'
import { readCsv } from './readers'
import { detectRoles, fixCoord, nodeName, parseArea, parsePair, rowsFromFeatures, rowsFromTable, sameName } from './rules'
import type { Feature } from 'geojson'

// ≈100 m × 100 m square (1 ha) at Tamazula
const dLon = 100 / (111_320 * Math.cos((19.6 * Math.PI) / 180))
const dLat = 100 / 111_320
const square = (lon: number, lat: number) => [[[lon, lat], [lon + dLon, lat], [lon + dLon, lat + dLat], [lon, lat + dLat], [lon, lat]]]
const poly = (name: string, lon: number, lat: number, extra = {}): Feature =>
  ({ type: 'Feature', properties: { name, ...extra }, geometry: { type: 'Polygon', coordinates: square(lon, lat) } })
const pin = (name: string, lon: number, lat: number): Feature =>
  ({ type: 'Feature', properties: { name }, geometry: { type: 'Point', coordinates: [lon, lat] } })

describe('coordinates', () => {
  it('repairs what Excel breaks', () => {
    expect(fixCoord(196452863, 'lat')).toEqual({ value: 19.6452863, note: 'coordenada sin punto decimal (corregida)' })
    expect(fixCoord(-1032716705, 'lon')?.value).toBeCloseTo(-103.2716705, 7)
    expect(fixCoord(103.27, 'lon')).toEqual({ value: -103.27, note: 'longitud sin signo negativo (corregida)' })
    expect(fixCoord(19.64, 'lat')).toEqual({ value: 19.64 })
    expect(fixCoord(48.85, 'lat')).toBeNull()              // Paris: not repaired into Mexico
  })
  it('reads pairs, Google Maps links and degrees-minutes-seconds', () => {
    expect(parsePair('19.6452863, -103.2716705')).toEqual([19.6452863, -103.2716705])
    expect(parsePair('https://www.google.com/maps?q=19.6452863,-103.2716705')).toEqual([19.6452863, -103.2716705])
    expect(parsePair('https://www.google.com/maps/@19.5,-103.4,15z')).toEqual([19.5, -103.4])
    const dms = parsePair(`19°38'43.0"N 103°16'18.0"W`)!
    expect(dms[0]).toBeCloseTo(19.645278, 5)
    expect(dms[1]).toBeCloseTo(-103.271667, 5)
  })
})

describe('areas', () => {
  it('reads back areas Excel turned into dates', () => {
    expect(parseArea({ v: 46178, fmt: 'dd.mm' })).toMatchObject({ value: 5.06 })      // 5 June 2026
    expect(parseArea({ v: 46376, fmt: 'd.m' })).toMatchObject({ value: 20.12 })      // 20 December
    expect(parseArea({ v: 4.19, fmt: '' })).toEqual({ value: 4.19 })
    expect(parseArea({ v: '2,5 ha' })).toEqual({ value: 2.5 })
    expect(parseArea({ v: 3.5, fmt: '0.00' })).toEqual({ value: 3.5 })
  })
})

describe('tables', () => {
  it('detects the Tamazula columns and builds the rows', () => {
    const t = readCsv('Folio,Nombre,Nombre (lista),Latitud,Longitud,Altitud (m),"Lat, Lon",Google Maps,Superficie (ha),Rubro,Nota\n'
      + 'AGU-D0248,Trinidad Torres Contreras,TRINIDAD,196452863,-1032716705,1157.4,"19.6452863, -103.2716705",,5.06,riego,\n'
      + 'AGU-D0277,Liliana Campos,LILIANA,19.5598981,-103.4257053,1260.9,"19.5598981, -103.4257053",,4.19,riego,"En el KML no tiene folio"\n')
    const roles = detectRoles(t)
    expect(roles.slice(0, 5)).toEqual(['folio', 'owner', 'ignore', 'lat', 'lon'])
    expect(roles[8]).toBe('area')
    expect(roles[10]).toBe('notes')
    const rows = rowsFromTable(t, roles)
    expect(rows[0]).toMatchObject({ folio: 'AGU-D0248', owner: 'Trinidad Torres Contreras', lat: 19.6452863, area_ha: 5.06 })
    expect(rows[0].notes).toContain('coordenada sin punto decimal (corregida)')
    expect(rows[1].issues).toContain('nota del archivo: En el KML no tiene folio')
  })
  it('uses the combined column or a Maps link when there are no lat / lon columns', () => {
    const t = readCsv('clave;titular;ubicación\nX-100;Ana;https://maps.google.com/?q=19.6,-103.3\n')
    const rows = rowsFromTable(t, detectRoles(t))
    expect(rows[0]).toMatchObject({ folio: 'X-100', owner: 'Ana', lat: 19.6, lon: -103.3 })
  })
})

describe('KML: pins and plots joined by location', () => {
  it('joins a pin with the plot that contains it, measures the area, flags conflicts', () => {
    const rows = rowsFromFeatures([
      poly('Trinidad Torres Contreras (AGU-D0248)', -103.30, 19.60),
      pin('AGU-D0248', -103.30 + dLon / 2, 19.60 + dLat / 2),
      poly('Marcos Ignacio Barbosa Urzua', -103.32, 19.61),                    // no folio on the plot
      pin('Marco Ignacio Barbosa Urzua AGU-D0297', -103.32 + dLon / 3, 19.61 + dLat / 3),
      poly('Juan Jose Barajas (AGU-D0398)', -103.34, 19.62),
      pin('AGU-D0399', -103.34 + dLon / 2, 19.62 + dLat / 2),                 // pin says another folio
      poly('Ana Lopez (AGU-D0500)', -103.36, 19.63),                           // plot without a pin
      pin('Sin parcela AGU-D0600', -103.40, 19.65),
    ]).rows
    const by = Object.fromEntries(rows.map((r) => [r.folio, r]))
    expect(by['AGU-D0248']).toMatchObject({ owner: 'Trinidad Torres Contreras' })
    expect(by['AGU-D0248'].area_ha).toBeCloseTo(1, 1)
    expect(by['AGU-D0248'].plot?.id).toBe('AGU-D0248')
    expect(by['AGU-D0297'].notes.join()).toContain('la parcela no tiene folio')  // folio from the pin, plot by location
    expect(by['AGU-D0297'].notes.join()).toContain('ortografía distinta')
    expect(by['AGU-D0297'].owner).toBe('Marcos Ignacio Barbosa Urzua')
    expect(by['AGU-D0398'].issues.join()).toContain('el pin dice AGU-D0399 y la parcela AGU-D0398')
    expect(by['AGU-D0500'].notes).toContain('parcela sin pin: sensor propuesto en el centro de la parcela')
    expect(by['AGU-D0600'].plot).toBeUndefined()
    expect(rows).toHaveLength(5)
  })
  it('compares names without accents and allows small spelling differences', () => {
    expect(sameName('Virgina Gutiérrez', 'virginia gutierrez')).toBe('close')
    expect(sameName('José Luis', 'jose luis')).toBe('same')
    expect(sameName('Jose Luis Ceballos Cervantes', 'Francisco Javier Ceballos Cervantes')).toBe('different')
  })
})

describe('geometry and names', () => {
  it('measures plots and finds a point inside L-shaped ones', () => {
    expect(areaHa({ type: 'Polygon', coordinates: square(-103.3, 19.6) })).toBeCloseTo(1, 2)
    const L = { type: 'Polygon' as const, coordinates: [[[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2], [0, 0]]] }
    const [x, y] = interiorPoint(L)
    expect(x < 1 || y < 1).toBe(true)
  })
  it('names nodes by folio, folio + owner or owner, within 40 characters', () => {
    const r = { key: 'a', folio: 'AGU-D0281', owner: 'Conrado Gabriel Gutierrez Monarrez', lat: 0, lon: 0, notes: [], issues: [] }
    expect(nodeName(r, 'folio')).toBe('AGU-D0281')
    expect(nodeName(r, 'folio_owner').length).toBeLessThanOrEqual(40)
    expect(nodeName(r, 'owner')).toBe('Conrado Gabriel Gutierrez Monarrez')
  })
})

describe('apply', () => {
  it('adds new sensors and updates existing ones by name or plot', async () => {
    const { applyImport } = await import('./apply')
    const prof = { label: '', type: 'cellular', link: 'cellular', tx_power: 23, gain: 0, cable_loss: 0, height: 1.5, sf: 10, source: '', estimated: [] }
    const catalog = { node_profiles: { dragino_se0x_cs: prof } } as never
    const project = {
      version: 1, name: '', description: '', gateways: [], name_counters: {},
      settings: { freq_mhz: 915, propagation_model: 'itm', safety_margin: 11, environment: 'Rural / Open' },
      nodes: [{ name: 'AGU-D0248', lat: 19.7, lon: -103.3, model: 'dragino_se0x_cs' }],
    } as never
    const geometry = { type: 'Polygon' as const, coordinates: square(-103.3, 19.6) }
    const rows = [
      { key: 'a', folio: 'AGU-D0248', owner: 'Trinidad', lat: 19.6, lon: -103.3, area_ha: 1, notes: [], issues: [],
        plot: { id: 'AGU-D0248', name: 'x', geometry } },
      { key: 'b', folio: 'AGU-D0277', owner: 'Liliana', lat: 19.5, lon: -103.4, notes: [], issues: [] },
      { key: 'c', lat: NaN, lon: NaN, notes: [], issues: [] },
    ]
    const [p, sum] = applyImport(project, catalog, rows, { model: 'dragino_se0x_cs', naming: 'folio', movePositions: false })
    expect(sum).toEqual({ added: 1, updated: 1, plots: 1, skipped: 1 })
    expect(p.nodes[0]).toMatchObject({ name: 'AGU-D0248', owner: 'Trinidad', lat: 19.7, plot: 'AGU-D0248' })   // not moved
    expect(p.nodes[1]).toMatchObject({ name: 'AGU-D0277', owner: 'Liliana', type: 'cellular', tx_power: 23 })
    expect(p.plots).toHaveLength(1)
  })
})
