// How many devices of each kind and model, and how many links / 4G states of each colour:
// the counter on the map and the summary tables of the report.
import { COLORS } from './colors'
import type { Catalog, CellStatus, LinkResult, Project } from './types'

export interface StateCount { label: string; color: string; n: number }
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
  return {
    gateways: {
      total: p.gateways.length,
      models: byModel(p.gateways.map((g) => g.model), gwLabel),
      cellular: count(p.gateways, (g) => (g.backhaul ?? catalog.gateway_profiles[g.model]?.backhaul) === '4g'),
      wired: count(p.gateways, (g) => (g.backhaul ?? catalog.gateway_profiles[g.model]?.backhaul) !== '4g'),
      states: [
        { label: 'En línea', color: COLORS.gateway, n: count(p.gateways, (g) => g.online) },
        { label: 'Fuera de línea', color: COLORS.none, n: count(p.gateways, (g) => !g.online) },
      ],
    },
    lora: {
      total: lora.length,
      models: byModel(lora.map((n) => n.model), nodeLabel),
      states: [
        { label: 'Enlace viable', color: COLORS.viable, n: count(lora, (n) => !!linkOf(n.name)?.viable) },
        { label: 'Marginal', color: COLORS.marginal, n: count(lora, (n) => { const l = linkOf(n.name); return !!l && !l.viable && l.margin_db > -5 }) },
        { label: 'No viable', color: COLORS.fail, n: count(lora, (n) => { const l = linkOf(n.name); return !!l && !l.viable && l.margin_db <= -5 }) },
        { label: 'Sin resultado', color: COLORS.none, n: count(lora, (n) => !linkOf(n.name)) },
      ],
    },
    cell: {
      total: cell.length,
      models: byModel(cell.map((n) => n.model), nodeLabel),
      states: [
        { label: '4G garantizado', color: COLORS.cellOk, n: count(cell, (n) => cellOf(n.name) === 'ok') },
        { label: '4G incierto', color: COLORS.cellEdge, n: count(cell, (n) => ['edge', 'differentiated'].includes(cellOf(n.name) ?? '')) },
        { label: '4G posible (LTE-M)', color: COLORS.cellPossible, n: count(cell, (n) => cellOf(n.name) === 'possible') },
        { label: 'Sin 4G', color: COLORS.cellNone, n: count(cell, (n) => cellOf(n.name) === 'none') },
        { label: 'Sin revisar', color: COLORS.none, n: count(cell, (n) => !cellOf(n.name)) },
      ],
    },
  }
}
