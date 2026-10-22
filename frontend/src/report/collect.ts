// Everything a report needs, gathered once and shared by the PDF and the HTML versions.
import type maplibregl from 'maplibre-gl'
import { api } from '../api'
import { mapToPng, type LegendItem } from '../exportImage'
import { loadPlotly } from '../plotly'
import { PLOTLY_CONFIG, profileFigure, profileTitle } from '../profilePlot'
import { isCellular } from '../project'
import type { Catalog, CellStatus, Gateway, LinkDetail, LinkResult, NodeDevice, Project } from '../types'

export interface LinkSection {
  node: NodeDevice
  gateway: Gateway
  detail: LinkDetail
  title: string
  figure: ReturnType<typeof profileFigure>
  png: string                 // profile image (JPEG data URL)
}

export interface ReportData {
  project: Project
  catalog: Catalog
  author: string
  generatedAt: Date
  mapPng: string | null
  mapSize: [number, number]
  links: Record<string, LinkResult>
  cells: Record<string, CellStatus>
  cellular: Set<string>
  sections: LinkSection[]
  legend: LegendItem[]
  showCoverage: boolean
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(b)
  })
}

/** Map framing every device, as an image; the view is restored afterwards. */
async function captureMap(map: maplibregl.Map, project: Project, legend: LegendItem[], showCoverage: boolean)
  : Promise<{ png: string; size: [number, number] } | null> {
  const pts = [...project.gateways, ...project.nodes]
  if (!pts.length) return null
  const view = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() }
  const lons = pts.map((p) => p.lon)
  const lats = pts.map((p) => p.lat)
  map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
    { padding: 70, maxZoom: 16, duration: 0 })
  await new Promise<void>((resolve) => {
    const done = () => resolve()
    map.once('idle', done)
    setTimeout(done, 8000)          // never hang the report on a slow tile
  })
  try {
    const canvas = map.getCanvas()
    const blob = await mapToPng(canvas, {
      title: project.name.trim() || 'Proyecto Verea',
      subtitle: `${pts.length} dispositivos`,
      legend,
      attribution: 'Imágenes y nombres © Esri' + (showCoverage ? ' · Cobertura 4G: CRT / datos.gob.mx (CC BY 4.0)' : ''),
    }, 'image/jpeg', 0.85)       // JPEG: a PNG of satellite imagery is several MB
    return { png: await blobToDataUrl(blob), size: [canvas.clientWidth, canvas.clientHeight] }
  } finally {
    map.jumpTo(view)
  }
}

export async function collectReport(args: {
  project: Project; catalog: Catalog; author: string; map: maplibregl.Map | null
  links: Record<string, LinkResult>; cells: Record<string, CellStatus>; cellular: Set<string>
  legend: LegendItem[]; showCoverage: boolean; onProgress: (text: string, fraction: number) => void
}): Promise<ReportData> {
  const { project, onProgress } = args
  onProgress('Capturando el mapa…', 0.02)
  const shot = args.map ? await captureMap(args.map, project, args.legend, args.showCoverage) : null

  const pairs = project.nodes
    .filter((n) => !isCellular(args.catalog, n) && args.links[n.name]?.link)
    .map((n) => ({ node: n, gateway: project.gateways.find((g) => g.name === args.links[n.name]!.link!.gateway) }))
    .filter((x): x is { node: NodeDevice; gateway: Gateway } => !!x.gateway)

  const Plotly = pairs.length ? await loadPlotly() : null
  const holder = document.createElement('div')
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:1000px;height:520px'
  document.body.appendChild(holder)
  const sections: LinkSection[] = []
  try {
    for (const [i, { node, gateway }] of pairs.entries()) {
      onProgress(`Perfil de elevación ${i + 1} de ${pairs.length}: ${gateway.name} → ${node.name}`, 0.05 + 0.9 * (i / pairs.length))
      const detail = await api.link(gateway, node, project.settings)
      const title = profileTitle(detail.profile, { gateway: gateway.name, node: node.name, sf: node.sf, freqMhz: project.settings.freq_mhz })
      const figure = profileFigure(detail.profile, title)
      await Plotly!.newPlot(holder, figure.data as Plotly.Data[], figure.layout as Partial<Plotly.Layout>,
        { ...PLOTLY_CONFIG, responsive: false, staticPlot: true } as Partial<Plotly.Config>)
      const png = await Plotly!.toImage(holder, { format: 'jpeg', width: 1000, height: 520, scale: 1.6 })
      sections.push({ node, gateway, detail, title, figure, png })
    }
  } finally {
    if (Plotly) Plotly.purge(holder)
    holder.remove()
  }
  onProgress('Armando el documento…', 0.97)
  return {
    project, catalog: args.catalog, author: args.author, generatedAt: new Date(),
    mapPng: shot?.png ?? null, mapSize: shot?.size ?? [1, 1],
    links: args.links, cells: args.cells, cellular: args.cellular, sections,
    legend: args.legend, showCoverage: args.showCoverage,
  }
}
