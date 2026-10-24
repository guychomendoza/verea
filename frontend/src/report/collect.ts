// What the PDF report needs: the whole project on a map (from a hidden map, snapshots.ts, so the
// user's view stays put) and the data behind the tables. The detail of each node is in the app
// itself, through the shared link printed in the PDF.
import { mapToPng, type LegendItem } from '../exportImage'
import type { Catalog, CellStatus, LinkResult, Project } from '../types'
import { SNAPSHOT_SIZE, SnapshotMap } from './snapshots'

export interface ReportData {
  project: Project
  catalog: Catalog
  generatedAt: Date
  mapImg: string | null         // general map, framed (JPEG data URL)
  mapSize: [number, number]
  links: Record<string, LinkResult>
  cells: Record<string, CellStatus>
  cellular: Set<string>
  stations: Set<string>
  legend: LegendItem[]          // general map symbology
  showCoverage: boolean
  shareUrl: string | null       // "Ver este proyecto a detalle en verea.app" (cloud projects)
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(b)
  })
}

export async function collectReport(args: {
  project: Project; catalog: Catalog
  signal?: AbortSignal          // Cancel in the dialog
  links: Record<string, LinkResult>; cells: Record<string, CellStatus>; cellular: Set<string>; stations: Set<string>
  legend: LegendItem[]; showCoverage: boolean; shareUrl: string | null
  onProgress: (text: string, fraction: number) => void
}): Promise<ReportData> {
  const { project, signal } = args
  const onProgress = (text: string, fraction: number) => {
    if (signal?.aborted) throw new DOMException('Reporte cancelado', 'AbortError')
    args.onProgress(text, fraction)
  }
  const base = { project, links: args.links, cells: args.cells, cellular: args.cellular, stations: args.stations }
  const generatedAt = new Date()
  onProgress('Preparando el mapa…', 0.05)
  const snap = await SnapshotMap.create()
  let mapImg: string | null = null
  try {
    onProgress('Mapa general…', 0.2)
    const canvas = await snap.overview(base, { coverage: args.showCoverage })
    if (canvas) {
      mapImg = await blobToDataUrl(await mapToPng(canvas, {
        title: project.name.trim() || 'Proyecto Verea',
        subtitle: `${project.gateways.length} ${project.gateways.length === 1 ? 'gateway' : 'gateways'} · ${project.nodes.length} ${project.nodes.length === 1 ? 'nodo' : 'nodos'}`,
        // the PDF draws the symbology itself (sharper than inside the image)
        attribution: 'Imágenes y nombres © Esri' + (args.showCoverage ? ' · Cobertura 4G: CRT / datos.gob.mx (CC BY 4.0)' : ''),
      }, 'image/jpeg', 0.85))
    }
  } finally {
    snap.destroy()
  }
  onProgress('Armando el documento…', 0.8)
  return { ...base, catalog: args.catalog, generatedAt, mapImg, mapSize: SNAPSHOT_SIZE, legend: args.legend,
    showCoverage: args.showCoverage, shareUrl: args.shareUrl }
}
