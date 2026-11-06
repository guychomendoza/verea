import { describe, expect, it } from 'vitest'
import { withoutOwnerInfo, type ReportInput } from './redact'
import type { CellStatus, LinkResult, Project } from '../types'

const input = (): ReportInput => ({
  project: {
    name: 'P', description: '', settings: {}, gateways: [{ name: 'GW-1' }],
    plots: [{ id: 'p1', name: 'Parcela 1', geometry: { type: 'Polygon', coordinates: [] } }],
    nodes: [
      { name: 'AGU-D0311 Alfonso Maciel', owner: 'Alfonso Maciel Guzman', area_ha: 7.6, plot: 'p1', lat: 20, lon: -103, model: 'x' },
      { name: 'AGU-D0400', owner: 'Ana Torres', area_ha: 3, lat: 20, lon: -103, model: 'x' },
      { name: '4G-1 Beto Ruiz', owner: 'Beto Ruiz', lat: 20, lon: -103, model: 'y' },
      { name: 'WX-1', lat: 20, lon: -103, model: 'z' },
    ],
  } as unknown as Project,
  links: { 'AGU-D0311 Alfonso Maciel': { link: { gateway: 'GW-1' } } } as unknown as Record<string, LinkResult>,
  cells: { '4G-1 Beto Ruiz': { state: 'ok' } } as unknown as Record<string, CellStatus>,
  cellular: new Set(['4G-1 Beto Ruiz']), stations: new Set(['WX-1']),
  legend: [{ color: '#000', label: 'Gateway' }, { color: '#000', line: true, label: 'Parcela (contorno)' }],
})

describe('withoutOwnerInfo', () => {
  const r = withoutOwnerInfo(input())

  it('leaves nothing personal anywhere in the report data', () => {
    const text = JSON.stringify({ ...r, cellular: [...r.cellular], stations: [...r.stations] })
    for (const s of ['Alfonso', 'Maciel', 'Ana Torres', 'Beto', 'area_ha', 'owner', 'Parcela']) expect(text).not.toContain(s)
    expect(r.project.plots).toBeUndefined()
  })

  it('keeps results tied to the shortened names', () => {
    expect(r.project.nodes.map((n) => n.name)).toEqual(['AGU-D0311', 'AGU-D0400', '4G-1', 'WX-1'])
    expect(r.links['AGU-D0311'].link?.gateway).toBe('GW-1')
    expect(r.cells['4G-1'].state).toBe('ok')
    expect(r.cellular.has('4G-1') && r.stations.has('WX-1')).toBe(true)
  })

  it('does not touch the project it was given', () => {
    const before = input()
    withoutOwnerInfo(before)
    expect(before.project.nodes[0].owner).toBe('Alfonso Maciel Guzman')
    expect(before.project.plots).toHaveLength(1)
  })

  it('keeps two nodes with the same folio apart', () => {
    const i = input()
    i.project.nodes[1] = { ...i.project.nodes[1], name: 'AGU-D0311 Ana Torres' }
    expect(withoutOwnerInfo(i).project.nodes.map((n) => n.name).slice(0, 2)).toEqual(['AGU-D0311', 'AGU-D0311 (2)'])
  })
})
