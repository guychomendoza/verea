import { describe, expect, it } from 'vitest'
import { connectedNodes } from './nodeStatus'
import type { LinkResult, NodeDevice, Project } from './types'

const node = (name: string) => ({ name, lat: 20, lon: -103, model: 'dragino_lse01' }) as NodeDevice
const link = (gateway: string, viable: boolean) =>
  ({ link: { gateway, viable, margin_db: viable ? 5 : -8, distance_m: 900, rssi_dbm: -110, reasons: [] } }) as unknown as LinkResult

describe('connectedNodes', () => {
  const project = { nodes: ['Nodo 10', 'Nodo 2', 'Nodo 1', 'Otro'].map(node), gateways: [] } as unknown as Project
  const links = { 'Nodo 10': link('GW-1', true), 'Nodo 2': link('GW-1', false), 'Nodo 1': link('GW-1', true), Otro: link('GW-2', true) }

  it('lists the nodes whose best link is the gateway, viable or not, in natural order', () => {
    const got = connectedNodes(project, links, 'GW-1')
    expect(got.map((c) => c.node.name)).toEqual(['Nodo 1', 'Nodo 2', 'Nodo 10'])
    expect(got.filter((c) => c.link.viable)).toHaveLength(2)
  })

  it('is empty for a gateway no node uses, and skips nodes without a result', () => {
    expect(connectedNodes(project, links, 'GW-3')).toEqual([])
    expect(connectedNodes(project, { 'Nodo 1': {} as LinkResult }, 'GW-1')).toEqual([])
  })
})
