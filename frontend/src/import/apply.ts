// Adds the reviewed import rows to a project: new sensors, or updates of the ones already there
// (same name or same plot), and their plots.
import type { Catalog, NodeDevice, Plot, Project } from '../types'
import { nodeName, valid, type ImportRow, type Naming } from './rules'

export interface ImportOptions {
  model: string
  naming: Naming
  movePositions: boolean        // existing sensors: move them to the file's position
}

export interface ImportSummary { added: number; updated: number; plots: number; skipped: number }

export function applyImport(p: Project, catalog: Catalog, rows: ImportRow[], o: ImportOptions): [Project, ImportSummary] {
  const prof = catalog.node_profiles[o.model]
  const nodes = [...p.nodes]
  const plots = new Map<string, Plot>((p.plots ?? []).map((pl) => [pl.id, pl]))
  const taken = new Set([...p.gateways.map((g) => g.name), ...nodes.map((n) => n.name)])
  const sum: ImportSummary = { added: 0, updated: 0, plots: 0, skipped: 0 }
  for (const r of rows) {
    if (!valid(r)) { sum.skipped++; continue }
    if (r.plot) {
      plots.set(r.plot.id, r.plot)
      sum.plots++
    }
    const name = nodeName(r, o.naming)
    const i = nodes.findIndex((n) => n.name === name || (r.plot && n.plot === r.plot.id))
    const info: Partial<NodeDevice> = {
      ...(r.owner ? { owner: r.owner } : {}),
      ...(r.area_ha != null ? { area_ha: r.area_ha } : {}),
      ...(r.plot ? { plot: r.plot.id } : {}),
    }
    if (i >= 0) {
      nodes[i] = { ...nodes[i], ...info, ...(o.movePositions ? { lat: r.lat, lon: r.lon } : {}) }
      sum.updated++
      continue
    }
    let unique = name
    for (let k = 2; taken.has(unique); k++) unique = `${name.slice(0, 36)} (${k})`
    taken.add(unique)
    nodes.push({
      name: unique, lat: r.lat, lon: r.lon, model: o.model, type: prof.type, sf: prof.sf,
      tx_power: prof.tx_power, height: prof.height, gain: prof.gain, cable_loss: prof.cable_loss,
      environment: p.settings.environment, ...info,
    })
    sum.added++
  }
  return [{ ...p, nodes, plots: [...plots.values()] }, sum]
}
