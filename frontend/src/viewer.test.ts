import { describe, expect, it } from 'vitest'
import { emptyProject } from './project'
import { tokenFromPath } from './share'
import type { Project, Settings } from './types'
import { applyOverrides, changeCount, overridesOf, viewerAllows } from './viewer'

const settings = { environment: 'Rural / Open' } as Settings
const base: Project = {
  ...emptyProject(settings),
  gateways: [{ name: 'GW-1', lat: 20, lon: -103, model: 'm', height: 6, tx_power: 27, gain: 3, cable_loss: 0, online: true }],
  nodes: [
    { name: 'N-1', lat: 20.01, lon: -103, model: 'n', type: 'sensor', sf: 10, tx_power: 20, height: 1.5, gain: 2, cable_loss: 0, environment: 'Rural / Open' },
    { name: 'N-2', lat: 20.02, lon: -103, model: 'n', type: 'sensor', sf: 10, tx_power: 20, height: 1.5, gain: 2, cable_loss: 0 },
  ],
}
const envs = ['Rural / Open', 'Crops (low)']

describe('viewer', () => {
  it('may only change heights and environments', () => {
    expect(viewerAllows({ type: 'updateNode', name: 'N-1', patch: { height: 3 } })).toBe(true)
    expect(viewerAllows({ type: 'updateNode', name: 'N-1', patch: { environment: 'Crops (low)' } })).toBe(true)
    expect(viewerAllows({ type: 'updateGateway', name: 'GW-1', patch: { height: 12 } })).toBe(true)
    expect(viewerAllows({ type: 'undo' })).toBe(true)
    expect(viewerAllows({ type: 'updateNode', name: 'N-1', patch: { height: 3, lat: 1 } })).toBe(false)
    expect(viewerAllows({ type: 'updateGateway', name: 'GW-1', patch: { tx_power: 30 } })).toBe(false)
    expect(viewerAllows({ type: 'move', kind: 'node', name: 'N-1', lat: 1, lon: 1 })).toBe(false)
    expect(viewerAllows({ type: 'remove', kind: 'node', name: 'N-1' })).toBe(false)
    expect(viewerAllows({ type: 'meta', name: 'mío' })).toBe(false)
    expect(viewerAllows({ type: 'load', project: base })).toBe(false)
  })

  it('keeps their changes apart from the shared project and puts them back on it', () => {
    const changed: Project = {
      ...base,
      nodes: [{ ...base.nodes[0], height: 3, environment: 'Crops (low)' }, base.nodes[1]],
      gateways: [{ ...base.gateways[0], height: 12 }],
    }
    const o = overridesOf(base, changed)
    expect(o).toEqual({ nodes: { 'N-1': { height: 3, environment: 'Crops (low)' } }, gateways: { 'GW-1': { height: 12 } } })
    expect(changeCount(o)).toBe(2)
    expect(applyOverrides(base, o, envs)).toEqual(changed)
    expect(overridesOf(base, base)).toEqual({})
  })

  it('ignores changes to devices that are gone and values that make no sense', () => {
    const p = applyOverrides(base, { nodes: { 'N-9': { height: 4 }, 'N-2': { height: -1, environment: 'Lunar' } },
      gateways: { 'GW-1': { height: 1e6 } } }, envs)
    expect(p).toEqual(base)
  })

  it('reads the token of a shared link', () => {
    const t = '0123456789abcdef0123456789abcdef'
    expect(tokenFromPath(`/v/${t}`)).toBe(t)
    expect(tokenFromPath(`/v/${t}/`)).toBe(t)
    expect(tokenFromPath('/v/../../etc')).toBeNull()
    expect(tokenFromPath('/')).toBeNull()
  })
})
