import { describe, expect, it, vi } from 'vitest'
import { cellSection, gatewayNodeTables, gatewayTable, loraSection, summaryTables } from './content'
import { gatewayBackhaul } from '../project'
import type { ReportData } from './collect'

vi.mock('maplibre-gl', () => ({ default: {} }))     // needs a browser; the tables only use its colours

const link = (gateway: string, viable: boolean, distance_m = 1200) =>
  ({ link: { gateway, viable, margin_db: viable ? 4 : -9, distance_m, rssi_dbm: -112, reasons: [] } })

const data = {
  project: {
    name: 'Prueba', description: '', settings: {},
    gateways: [
      { name: 'GW-1', lat: 20, lon: -103, model: 'sensecap_m2', online: true, height: 3, backhaul: 'red' },
      { name: 'GW-2', lat: 20, lon: -103, model: 'milesight_sg50', online: false, height: 3, backhaul: '4g' },
    ],
    nodes: [
      { name: 'N2', lat: 20, lon: -103, model: 'lse01', owner: 'Ana' },
      { name: 'N1', lat: 20, lon: -103, model: 'lse01' },
      { name: 'C1', lat: 20, lon: -103, model: 'se0x_cs' },
    ],
  },
  catalog: {
    gateway_profiles: { sensecap_m2: { label: 'SenseCAP M2' }, milesight_sg50: { label: 'SG50' } },
    node_profiles: { lse01: { label: 'LSE01' }, se0x_cs: { label: 'SE0X-CS' } },
    environments: {},
  },
  links: { N1: link('GW-1', true), N2: link('GW-1', false) },
  cells: { C1: { state: 'ok', text: 'ok', nearby_share: 1, covered: true } },
  cellular: new Set(['C1']),
} as unknown as ReportData

describe('summaryTables', () => {
  const [gws, lora, cell] = summaryTables(data)

  it('puts the total in the title, never in a row', () => {
    expect(gws.title).toBe('Gateways: 2 en total')
    expect(lora.title).toBe('Sensores LoRa: 2 en total')
    expect(cell.title).toBe('Sensores 4G: 1 en total')
    expect(gws.rows.flat()).not.toContain('Total')
  })

  it('each row is a real group: a model next to its own connection', () => {
    expect(gws.head).toEqual(['Modelo', 'Conexión', 'Cantidad', 'En línea', 'Fuera de línea'])
    expect(gws.rows).toEqual(expect.arrayContaining([
      ['SenseCAP M2', 'WiFi / Ethernet', '1', '1', '0'],
      ['SG50', '4G propio', '1', '0', '1'],
    ]))
  })

  it('agrees with the gateway table row by row', () => {
    const detail = gatewayTable(data)!.rows.map((r) => [r[1], r[2]])
    for (const [model, conn] of detail) expect(gws.rows.some((r) => r[0] === model && r[1] === conn)).toBe(true)
  })

  it('splits a model with two connections', () => {
    const gateways = [
      { name: 'A', lat: 20, lon: -103, model: 'sensecap_m2', online: true, backhaul: 'red' },
      { name: 'B', lat: 20, lon: -103, model: 'sensecap_m2', online: true, backhaul: 'red' },
      { name: 'C', lat: 20, lon: -103, model: 'sensecap_m2', online: true, backhaul: '4g' },
    ]
    const [t] = summaryTables({ ...data, project: { ...data.project, gateways } } as unknown as ReportData)
    expect(t.rows).toEqual([['SenseCAP M2', 'WiFi / Ethernet', '2', '2'], ['SenseCAP M2', '4G propio', '1', '1']])
  })

  it('counts each model by state, in columns that add up across the row', () => {
    expect(lora.head).toEqual(['Modelo', 'Cantidad', 'Enlace viable', 'No viable'])
    expect(lora.rows).toEqual([['LSE01', '2', '1', '1']])
    expect(cell.rows).toEqual([['SE0X-CS', '1', '1']])
    expect(lora.headColors).toHaveLength(lora.head.length)
    expect(lora.headColors!.filter(Boolean)).toHaveLength(2)
  })
})

describe('a gateway with no connection saved', () => {
  // saved before the field existed: it takes its model's, and every place must say the same
  const catalog = { ...data.catalog, gateway_profiles: { sg50: { label: 'SG50', backhaul: '4g' } } }
  const gateways = [{ name: 'GW-9', lat: 20, lon: -103, model: 'sg50', online: true }]
  const d = { ...data, catalog, links: {}, project: { ...data.project, gateways, nodes: [] } } as unknown as ReportData

  it('reads the same in both tables and in the app', () => {
    expect(gatewayBackhaul(d.catalog, d.project.gateways[0])).toBe('4g')
    expect(gatewayTable(d)!.rows[0][2]).toBe('4G propio')
    expect(summaryTables(d)[0].rows[0].slice(0, 3)).toEqual(['SG50', '4G propio', '1'])
  })

  it('what is set on the gateway wins over its model', () => {
    const wired = { ...gateways[0], backhaul: 'red' } as (typeof d.project.gateways)[0]
    expect(gatewayBackhaul(d.catalog, wired)).toBe('red')
    const p = { ...d, project: { ...d.project, gateways: [wired] } } as ReportData
    expect(gatewayTable(p)!.rows[0][2]).toBe('WiFi / Ethernet')
    expect(summaryTables(p)[0].rows[0].slice(0, 3)).toEqual(['SG50', 'WiFi / Ethernet', '1'])
  })
})

describe('detail tables', () => {
  it('has neither height nor margin columns', () => {
    expect(gatewayTable(data)!.head).not.toContain('Altura')
    const head = loraSection(data)!.groups[0].head
    expect(head).not.toContain('Margen')
    expect(head).toContain('Distancia')
  })

  it('numbers the sections', () => {
    expect([gatewayTable(data)!.title, loraSection(data)!.title, cellSection(data)!.title])
      .toEqual(['2. Gateways', '3. Nodos LoRa', '4. Sensores 4G'])
  })

  it('lists each gateway with its nodes; 4G sensors are not in them', () => {
    const [one, two] = gatewayNodeTables(data)
    expect(one.title).toBe('GW-1: 2 nodos (1 viable)')
    expect(one.head).toEqual(['Nodo', 'Titular', 'Distancia', 'Estado'])
    expect(one.rows.map((r) => r[0])).toEqual(['N1', 'N2'])
    expect(one.rows.flat()).not.toContain('C1')
    expect(two.title).toBe('GW-2: sin nodos conectados')
    expect(two.rows).toEqual([])
  })
})
