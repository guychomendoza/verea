import { describe, expect, it, vi } from 'vitest'
import { cellSection, gatewayNodeTables, gatewayTable, loraSection, summaryTables } from './content'
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

  it('gives each way of counting its own columns', () => {
    expect(gws.head).toEqual(['Modelo', 'Cant.', 'Conexión', 'Cant.', 'Estado', 'Cant.'])
    expect(lora.head).toEqual(['Modelo', 'Cant.', 'Estado', 'Cant.'])
    const column = (i: number) => gws.rows.map((r) => r[i]).filter(Boolean)
    expect(column(4)).toEqual(['En línea', 'Fuera de línea'])
    expect(column(5).map(Number).reduce((a, b) => a + b)).toBe(2)
  })

  it('colours the rows that have a state', () => {
    expect(gws.colors.every(Boolean)).toBe(true)
    expect(lora.colors.filter(Boolean)).toHaveLength(lora.rows.filter((r) => r[2]).length)
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
