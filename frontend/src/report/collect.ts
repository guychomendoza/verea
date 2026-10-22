// Everything a report needs, gathered once and shared by the PDF and the HTML versions:
// the general map, and for every node a map image of its link, plus the elevation profile for
// LoRa nodes with a link. Maps come from a hidden map (snapshots.ts): the user's view stays put.
import { api } from '../api'
import { mapToPng, type LegendItem } from '../exportImage'
import { cardLegend } from '../legend'
import { loadPlotly } from '../plotly'
import { PLOTLY_CONFIG, profileFigure, profileTitle } from '../profilePlot'
import { isCellular } from '../project'
import type { Catalog, CellStatus, Gateway, LinkDetail, LinkResult, NodeDevice, Project } from '../types'
import { SNAPSHOT_SIZE, SnapshotMap } from './snapshots'

export interface NodeSection {
  node: NodeDevice
  cellular: boolean
  gateway?: Gateway             // LoRa node with a link
  detail?: LinkDetail
  title?: string
  figure?: ReturnType<typeof profileFigure>
  profileJpg?: string           // elevation profile (JPEG data URL)
  mapJpg: string                // the node / its link on the map
  legend: LegendItem[]          // symbols in mapJpg
}

export interface ReportData {
  project: Project
  catalog: Catalog
  author: string
  generatedAt: Date
  mapImg: string | null         // general map, framed with legend (JPEG data URL)
  mapSize: [number, number]
  links: Record<string, LinkResult>
  cells: Record<string, CellStatus>
  cellular: Set<string>
  stations: Set<string>
  legend: LegendItem[]          // general map symbology
  nodes: NodeSection[]
  showCoverage: boolean
}

export const PROFILE_SIZE: [number, number] = [1000, 480]

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(b)
  })
}

export async function collectReport(args: {
  project: Project; catalog: Catalog; author: string
  links: Record<string, LinkResult>; cells: Record<string, CellStatus>; cellular: Set<string>; stations: Set<string>
  legend: LegendItem[]; showCoverage: boolean; onProgress: (text: string, fraction: number) => void
}): Promise<ReportData> {
  const { project, onProgress } = args
  const base = { project, links: args.links, cells: args.cells, cellular: args.cellular, stations: args.stations }
  onProgress('Preparando el mapa…', 0.02)
  const snap = await SnapshotMap.create()
  const holder = document.createElement('div')
  holder.style.cssText = `position:fixed;left:-10000px;top:0;width:${PROFILE_SIZE[0]}px;height:${PROFILE_SIZE[1]}px`
  document.body.appendChild(holder)
  const hasProfiles = project.nodes.some((n) => !isCellular(args.catalog, n) && args.links[n.name]?.link)
  const Plotly = hasProfiles ? await loadPlotly() : null
  const nodes: NodeSection[] = []
  let mapImg: string | null = null
  try {
    onProgress('Mapa general…', 0.05)
    const canvas = await snap.overview(base, { coverage: args.showCoverage })
    if (canvas) {
      mapImg = await blobToDataUrl(await mapToPng(canvas, {
        title: project.name.trim() || 'Proyecto Verea',
        subtitle: `${project.gateways.length} gateways · ${project.nodes.length} nodos`,
        // the PDF draws the symbology itself (sharper than inside the image)
        attribution: 'Imágenes y nombres © Esri' + (args.showCoverage ? ' · Cobertura 4G: CRT / datos.gob.mx (CC BY 4.0)' : ''),
      }, 'image/jpeg', 0.85))
    }
    for (const [i, node] of project.nodes.entries()) {
      const cellular = isCellular(args.catalog, node)
      const link = cellular ? null : args.links[node.name]?.link
      const gateway = link ? project.gateways.find((g) => g.name === link.gateway) : undefined
      onProgress(`Nodo ${i + 1} de ${project.nodes.length}: ${node.name}`, 0.08 + 0.88 * (i / project.nodes.length))
      const mapJpg = await snap.capture({ ...base, highlight: { node: node.name, gateway: gateway?.name } },
        { coverage: cellular })
      const section: NodeSection = { node, cellular, mapJpg, legend: cardLegend(base, node.name, gateway?.name) }
      if (gateway && Plotly) {
        const detail = await api.link(gateway, node, project.settings)
        const title = profileTitle(detail.profile, { gateway: gateway.name, node: node.name, sf: node.sf, freqMhz: project.settings.freq_mhz })
        const figure = profileFigure(detail.profile, title)
        await Plotly.newPlot(holder, figure.data as Plotly.Data[], figure.layout as Partial<Plotly.Layout>,
          { ...PLOTLY_CONFIG, responsive: false, staticPlot: true } as Partial<Plotly.Config>)
        const profileJpg = await Plotly.toImage(holder, { format: 'jpeg', width: PROFILE_SIZE[0], height: PROFILE_SIZE[1], scale: 1.6 })
        Object.assign(section, { gateway, detail, title, figure, profileJpg })
      }
      nodes.push(section)
    }
  } finally {
    if (Plotly) Plotly.purge(holder)
    holder.remove()
    snap.destroy()
  }
  onProgress('Armando el documento…', 0.97)
  return {
    ...base, catalog: args.catalog, author: args.author, generatedAt: new Date(),
    mapImg, mapSize: SNAPSHOT_SIZE, legend: args.legend, nodes, showCoverage: args.showCoverage,
  }
}
