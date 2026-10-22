import { describe, expect, it } from 'vitest'
import { emptyProject, nameError, reduce, rename } from './project'
import type { Catalog, Settings } from './types'

const settings: Settings = {
  freq_mhz: 915, propagation_model: 'itm', diffraction_method: 'dominant_knife_edge',
  safety_margin: 11, environment: 'Rural / Open',
}
const prof = { label: '', tx_power: 20, gain: 2, cable_loss: 0, height: 1.5, source: '', estimated: [] }
const catalog = {
  gateway_profiles: { sensecap_m2: { ...prof, tx_power: 27, height: 6 } },
  node_profiles: {
    dragino_se0x_lb: { ...prof, type: 'sensor', link: 'lorawan', sf: 10 },
    dragino_se0x_cs: { ...prof, type: 'cellular', link: 'cellular', sf: 10 },
    sensecap_s2120: { ...prof, type: 'weather', link: 'lorawan', sf: 10 },
  },
} as unknown as Catalog

describe('project', () => {
  it('names devices like the Streamlit app', () => {
    let p = emptyProject(settings)
    p = reduce(p, { type: 'addGateway', lat: 21, lon: -102, catalog })
    p = reduce(p, { type: 'addNode', lat: 21, lon: -102, catalog })
    p = reduce(p, { type: 'addNode', lat: 21, lon: -102, model: 'dragino_se0x_cs', catalog })
    p = reduce(p, { type: 'addNode', lat: 21, lon: -102, model: 'sensecap_s2120', catalog })
    p = reduce(p, { type: 'addNode', lat: 21, lon: -102, catalog })
    expect(p.gateways.map((g) => g.name)).toEqual(['GW-1'])
    expect(p.nodes.map((n) => n.name)).toEqual(['Node-1', '4G-1', 'WX-1', 'Node-2'])
    expect(p.gateways[0]).toMatchObject({ tx_power: 27, height: 6, online: true })
    expect(p.nodes[0]).toMatchObject({ sf: 10, type: 'sensor', environment: 'Rural / Open' })
  })

  it('skips names already taken (e.g. after a rename)', () => {
    let p = reduce(emptyProject(settings), { type: 'addNode', lat: 0, lon: 0, catalog })
    p = rename(p, 'node', 'Node-1', 'Node-2')
    p = reduce(p, { type: 'addNode', lat: 0, lon: 0, catalog })
    expect(p.nodes.map((n) => n.name)).toEqual(['Node-2', 'Node-3'])
  })

  it('validates names', () => {
    let p = reduce(emptyProject(settings), { type: 'addGateway', lat: 0, lon: 0, catalog })
    p = reduce(p, { type: 'addNode', lat: 0, lon: 0, catalog })
    expect(nameError(p, 'Node-1', 'GW-1')).toMatch(/already used/)
    expect(nameError(p, 'Node-1', '  ')).toMatch(/empty/)
    expect(nameError(p, 'Node-1', 'x'.repeat(41))).toMatch(/At most/)
    expect(nameError(p, 'Node-1', 'Node-1')).toBe('')
  })

  it('moves, updates and removes without touching other devices', () => {
    let p = reduce(emptyProject(settings), { type: 'addNode', lat: 0, lon: 0, catalog })
    p = reduce(p, { type: 'addNode', lat: 0, lon: 0, catalog })
    const other = p.nodes[1]
    p = reduce(p, { type: 'move', kind: 'node', name: 'Node-1', lat: 1, lon: 2 })
    p = reduce(p, { type: 'updateNode', name: 'Node-1', patch: { sf: 7 } })
    expect(p.nodes[0]).toMatchObject({ lat: 1, lon: 2, sf: 7 })
    expect(p.nodes[1]).toBe(other)
    p = reduce(p, { type: 'remove', kind: 'node', name: 'Node-1' })
    expect(p.nodes.map((n) => n.name)).toEqual(['Node-2'])
  })
})
