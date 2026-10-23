// Viewer mode: someone outside the team who opened a shared link. They explore the project and
// may try another height (nodes and gateways) or environment (nodes); those changes are theirs
// (project_viewers.overrides), the team's project never changes.
import type { HistoryAction } from './project'
import type { Project } from './types'

export interface Overrides {
  nodes?: Record<string, { height?: number; environment?: string }>
  gateways?: Record<string, { height?: number }>
}

const NODE_KEYS = new Set(['height', 'environment'])
const GATEWAY_KEYS = new Set(['height'])
const okHeight = (h: unknown): h is number => typeof h === 'number' && Number.isFinite(h) && h > 0 && h <= 100

/** What a viewer may do: change a height / environment, undo and redo. */
export function viewerAllows(a: HistoryAction): boolean {
  switch (a.type) {
    case 'undo':
    case 'redo':
    case 'open':
      return true
    case 'updateNode':
      return Object.keys(a.patch).every((k) => NODE_KEYS.has(k))
    case 'updateGateway':
      return Object.keys(a.patch).every((k) => GATEWAY_KEYS.has(k))
    default:
      return false
  }
}

/** The project with the viewer's changes on it (by name; changes to devices gone are ignored). */
export function applyOverrides(p: Project, o: Overrides | null | undefined, environments: string[]): Project {
  if (!o) return p
  const envs = new Set(environments)
  return {
    ...p,
    nodes: p.nodes.map((n) => {
      const c = o.nodes?.[n.name]
      if (!c) return n
      return { ...n, ...(okHeight(c.height) ? { height: c.height } : {}),
        ...(typeof c.environment === 'string' && envs.has(c.environment) ? { environment: c.environment } : {}) }
    }),
    gateways: p.gateways.map((g) => {
      const c = o.gateways?.[g.name]
      return c && okHeight(c.height) ? { ...g, height: c.height } : g
    }),
  }
}

/** The viewer's changes: what differs from the original project. */
export function overridesOf(base: Project, p: Project): Overrides {
  const nodes: NonNullable<Overrides['nodes']> = {}
  const gateways: NonNullable<Overrides['gateways']> = {}
  const baseNodes = new Map(base.nodes.map((n) => [n.name, n]))
  const baseGws = new Map(base.gateways.map((g) => [g.name, g]))
  for (const n of p.nodes) {
    const b = baseNodes.get(n.name)
    if (!b) continue
    const c: { height?: number; environment?: string } = {}
    if (n.height !== b.height) c.height = n.height
    if ((n.environment ?? '') !== (b.environment ?? '') && n.environment) c.environment = n.environment
    if (Object.keys(c).length) nodes[n.name] = c
  }
  for (const g of p.gateways) {
    const b = baseGws.get(g.name)
    if (b && g.height !== b.height) gateways[g.name] = { height: g.height }
  }
  return { ...(Object.keys(nodes).length ? { nodes } : {}), ...(Object.keys(gateways).length ? { gateways } : {}) }
}

export const changeCount = (o: Overrides) => Object.keys(o.nodes ?? {}).length + Object.keys(o.gateways ?? {}).length
