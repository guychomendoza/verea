// Project state as pure functions (the reducer behind the app), mirroring
// core/profiles.py new_gateway / new_node and the app's device naming.
import type { Catalog, Gateway, NodeDevice, Project, Selection, Settings } from './types'

export const PROJECT_VERSION = 1
export const MAX_NAME_LEN = 40
export const DEFAULT_GATEWAY_MODEL = 'sensecap_m2'
export const DEFAULT_NODE_MODEL = 'dragino_se0x_lb'

export function emptyProject(settings: Settings): Project {
  return {
    version: PROJECT_VERSION, name: '', description: '',
    gateways: [], nodes: [], name_counters: {}, settings,
  }
}

export function nodePrefix(catalog: Catalog, model: string): string {
  const type = catalog.node_profiles[model]?.type
  return type === 'weather' ? 'WX' : type === 'cellular' ? '4G' : 'Node'
}

export function isCellular(catalog: Catalog, n: NodeDevice): boolean {
  return catalog.node_profiles[n.model]?.link === 'cellular'
}

export function isStation(catalog: Catalog, n: NodeDevice): boolean {
  return catalog.node_profiles[n.model]?.type === 'weather'
}

function allNames(p: Project): Set<string> {
  return new Set([...p.gateways.map((g) => g.name), ...p.nodes.map((n) => n.name)])
}

/** Next unused "<prefix>-<n>" name, and the updated counters. */
function nextName(p: Project, prefix: string): [string, Record<string, number>] {
  const counters = { ...p.name_counters }
  const names = allNames(p)
  let i = counters[prefix] ?? 0
  let name: string
  do {
    i += 1
    name = `${prefix}-${i}`
  } while (names.has(name))
  counters[prefix] = i
  return [name, counters]
}

export type Action =
  | { type: 'load'; project: Project }
  | { type: 'addGateway'; lat: number; lon: number; model?: string; catalog: Catalog }
  | { type: 'addNode'; lat: number; lon: number; model?: string; catalog: Catalog }
  | { type: 'move'; kind: 'gateway' | 'node'; name: string; lat: number; lon: number }
  | { type: 'updateGateway'; name: string; patch: Partial<Gateway> }
  | { type: 'updateNode'; name: string; patch: Partial<NodeDevice> }
  | { type: 'remove'; kind: 'gateway' | 'node'; name: string }
  | { type: 'settings'; patch: Partial<Settings> }
  | { type: 'meta'; name?: string; description?: string }
  | { type: 'removePlot'; id: string }
  | { type: 'bulkModel'; names: string[]; model: string; catalog: Catalog }
  | { type: 'addGateways'; points: { lat: number; lon: number }[]; model: string; height: number; catalog: Catalog }

export function reduce(p: Project, a: Action): Project {
  switch (a.type) {
    case 'load':
      return a.project
    case 'addGateway': {
      const model = a.model ?? DEFAULT_GATEWAY_MODEL
      const prof = a.catalog.gateway_profiles[model]
      const [name, counters] = nextName(p, 'GW')
      const gw: Gateway = {
        name, lat: a.lat, lon: a.lon, model, height: prof.height, tx_power: prof.tx_power,
        gain: prof.gain, cable_loss: prof.cable_loss, online: true, backhaul: prof.backhaul ?? 'red',
      }
      return { ...p, gateways: [...p.gateways, gw], name_counters: counters }
    }
    case 'addGateways': {
      // Several at once (accepted suggestions): one undo step
      let q = p
      for (const pt of a.points) {
        q = reduce(q, { type: 'addGateway', lat: pt.lat, lon: pt.lon, model: a.model, catalog: a.catalog })
        const last = q.gateways[q.gateways.length - 1]
        q = { ...q, gateways: [...q.gateways.slice(0, -1), { ...last, height: a.height, backhaul: '4g' }] }
      }
      return q
    }
    case 'addNode': {
      const model = a.model ?? DEFAULT_NODE_MODEL
      const prof = a.catalog.node_profiles[model]
      const [name, counters] = nextName(p, nodePrefix(a.catalog, model))
      const nd: NodeDevice = {
        name, lat: a.lat, lon: a.lon, model, type: prof.type, sf: prof.sf,
        tx_power: prof.tx_power, height: prof.height, gain: prof.gain,
        cable_loss: prof.cable_loss, environment: p.settings.environment,
      }
      return { ...p, nodes: [...p.nodes, nd], name_counters: counters }
    }
    case 'move':
      return a.kind === 'gateway'
        ? { ...p, gateways: p.gateways.map((g) => (g.name === a.name ? { ...g, lat: a.lat, lon: a.lon } : g)) }
        : { ...p, nodes: p.nodes.map((n) => (n.name === a.name ? { ...n, lat: a.lat, lon: a.lon } : n)) }
    case 'updateGateway':
      return { ...p, gateways: p.gateways.map((g) => (g.name === a.name ? { ...g, ...a.patch } : g)) }
    case 'updateNode':
      return { ...p, nodes: p.nodes.map((n) => (n.name === a.name ? { ...n, ...a.patch } : n)) }
    case 'remove':
      return a.kind === 'gateway'
        ? { ...p, gateways: p.gateways.filter((g) => g.name !== a.name) }
        : { ...p, nodes: p.nodes.filter((n) => n.name !== a.name) }
    case 'settings':
      return { ...p, settings: { ...p.settings, ...a.patch } }
    case 'meta':
      return { ...p, name: a.name ?? p.name, description: a.description ?? p.description }
    case 'bulkModel': {
      // New model's radio values; name, position, owner, area, plot and environment are kept
      const prof = a.catalog.node_profiles[a.model]
      if (!prof) return p
      const names = new Set(a.names)
      return { ...p, nodes: p.nodes.map((n) => (names.has(n.name)
        ? { ...n, model: a.model, type: prof.type, sf: prof.sf, tx_power: prof.tx_power, height: prof.height,
          gain: prof.gain, cable_loss: prof.cable_loss }
        : n)) }
    }
    case 'removePlot':
      return { ...p, plots: (p.plots ?? []).filter((pl) => pl.id !== a.id),
        nodes: p.nodes.map((n) => (n.plot === a.id ? { ...n, plot: undefined } : n)) }
  }
}

/** Why a new name is not valid ('' when it is). */
export function nameError(p: Project, current: string, next: string): string {
  const n = next.trim()
  if (!n) return 'El nombre no puede estar vacío'
  if (n.length > MAX_NAME_LEN) return `Máximo ${MAX_NAME_LEN} caracteres`
  if (n !== current && allNames(p).has(n)) return `"${n}" ya está en uso`
  return ''
}

/** Rename a device; the selection follows it. */
export function rename(p: Project, kind: 'gateway' | 'node', current: string, next: string): Project {
  const n = next.trim()
  return kind === 'gateway'
    ? { ...p, gateways: p.gateways.map((g) => (g.name === current ? { ...g, name: n } : g)) }
    : { ...p, nodes: p.nodes.map((d) => (d.name === current ? { ...d, name: n } : d)) }
}

export function selected(p: Project, s: Selection): Gateway | NodeDevice | undefined {
  if (!s) return undefined
  return s.kind === 'gateway' ? p.gateways.find((g) => g.name === s.name) : p.nodes.find((n) => n.name === s.name)
}

// ── undo / redo ──
export interface History { present: Project; past: Project[]; future: Project[] }
export type HistoryAction = Action | { type: 'undo' } | { type: 'redo' } | { type: 'open'; project: Project }
const MAX_HISTORY = 50

/** The project with its undo history; 'open' (another project) starts a new history. */
export function reduceHistory(h: History, a: HistoryAction): History {
  switch (a.type) {
    case 'undo':
      return h.past.length ? { present: h.past[h.past.length - 1], past: h.past.slice(0, -1), future: [h.present, ...h.future] } : h
    case 'redo':
      return h.future.length ? { present: h.future[0], past: [...h.past, h.present], future: h.future.slice(1) } : h
    case 'open':
      return { present: a.project, past: [], future: [] }
    default: {
      const next = reduce(h.present, a)
      if (next === h.present) return h
      return { present: next, past: [...h.past, h.present].slice(-MAX_HISTORY), future: [] }
    }
  }
}
