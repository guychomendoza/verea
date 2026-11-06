// A report without personal data: no owners, areas or plots, and no owner inside a node's name
// (imports leave names like "AGU-D0311 Alfonso Maciel"). Keys of links and cells follow the names.
import type { LegendItem } from '../exportImage'
import { nodeShortName } from '../project'
import type { CellStatus, LinkResult, Project } from '../types'

export interface ReportInput {
  project: Project
  links: Record<string, LinkResult>
  cells: Record<string, CellStatus>
  cellular: Set<string>
  stations: Set<string>
  legend: LegendItem[]
}

export function withoutOwnerInfo(r: ReportInput): ReportInput {
  const renamed = new Map<string, string>()
  const taken = new Set(r.project.gateways.map((g) => g.name))
  const nodes = r.project.nodes.map((n) => {
    const short = nodeShortName(n)
    let name = short
    for (let k = 2; taken.has(name); k++) name = `${short} (${k})`   // two nodes with the same folio
    taken.add(name)
    renamed.set(n.name, name)
    const node = { ...n, name }
    delete node.owner
    delete node.area_ha
    delete node.plot
    return node
  })
  const rekey = <T,>(rec: Record<string, T>) =>
    Object.fromEntries(Object.entries(rec).map(([k, v]) => [renamed.get(k) ?? k, v]))
  const reset = (s: Set<string>) => new Set([...s].map((k) => renamed.get(k) ?? k))
  const project = { ...r.project, nodes }
  delete project.plots
  return {
    project,
    links: rekey(r.links), cells: rekey(r.cells), cellular: reset(r.cellular), stations: reset(r.stations),
    legend: r.legend.filter((it) => !it.label.startsWith('Parcela')),
  }
}
