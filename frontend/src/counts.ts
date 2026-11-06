// How many devices of each kind and model, and how many links / 4G states of each colour:
// the counter on the map and the summary tables of the report.
import { COLORS } from './colors'
import { gatewayBackhaul } from './project'
import type { Catalog, CellStatus, LinkResult, Project } from './types'

export interface StateCount { label: string; color: string; n: number; names: string[] }
export interface KindCount { total: number; models: [string, number][]; states: StateCount[] }
export interface NetworkCounts {
  gateways: KindCount & { cellular: number; wired: number }
  lora: KindCount
  cell: KindCount
}

function byModel(models: string[], label: (k: string) => string): [string, number][] {
  const m = new Map<string, number>()
  for (const k of models) m.set(label(k), (m.get(label(k)) ?? 0) + 1)
  return [...m].sort((a, b) => b[1] - a[1])
}

export function networkCounts(p: Project, catalog: Catalog, links: Record<string, LinkResult>,
  cells: Record<string, CellStatus>, cellular: Set<string>): NetworkCounts {
  const lora = p.nodes.filter((n) => !cellular.has(n.name))
  const cell = p.nodes.filter((n) => cellular.has(n.name))
  const nodeLabel = (k: string) => catalog.node_profiles[k]?.label ?? k
  const gwLabel = (k: string) => catalog.gateway_profiles[k]?.label ?? k
  const linkOf = (name: string) => links[name]?.link
  const cellOf = (name: string) => cells[name]?.state
  const count = <T,>(items: T[], test: (x: T) => boolean) => items.filter(test).length
  const state = <T extends { name: string },>(label: string, color: string, items: T[], test: (x: T) => boolean): StateCount => {
    const names = items.filter(test).map((x) => x.name)
    return { label, color, n: names.length, names }
  }
  return {
    gateways: {
      total: p.gateways.length,
      models: byModel(p.gateways.map((g) => g.model), gwLabel),
      cellular: count(p.gateways, (g) => gatewayBackhaul(catalog, g) === '4g'),
      wired: count(p.gateways, (g) => gatewayBackhaul(catalog, g) !== '4g'),
      states: [
        state('En línea', COLORS.gateway, p.gateways, (g) => g.online),
        state('Fuera de línea', COLORS.none, p.gateways, (g) => !g.online),
      ],
    },
    lora: {
      total: lora.length,
      models: byModel(lora.map((n) => n.model), nodeLabel),
      states: [
        state('Enlace viable', COLORS.viable, lora, (n) => !!linkOf(n.name)?.viable),
        state('Marginal', COLORS.marginal, lora, (n) => { const l = linkOf(n.name); return !!l && !l.viable && l.margin_db > -5 }),
        state('No viable', COLORS.fail, lora, (n) => { const l = linkOf(n.name); return !!l && !l.viable && l.margin_db <= -5 }),
        state('Sin resultado', COLORS.none, lora, (n) => !linkOf(n.name)),
      ],
    },
    cell: {
      total: cell.length,
      models: byModel(cell.map((n) => n.model), nodeLabel),
      states: [
        state('4G garantizado', COLORS.cellOk, cell, (n) => cellOf(n.name) === 'ok'),
        state('4G incierto', COLORS.cellEdge, cell, (n) => ['edge', 'differentiated'].includes(cellOf(n.name) ?? '')),
        state('4G posible (LTE-M)', COLORS.cellPossible, cell, (n) => cellOf(n.name) === 'possible'),
        state('Sin 4G', COLORS.cellNone, cell, (n) => cellOf(n.name) === 'none'),
        state('Sin revisar', COLORS.none, cell, (n) => !cellOf(n.name)),
      ],
    },
  }
}
