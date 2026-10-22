// Map images for the report, one per node, from a hidden map of its own (same style as the
// main map), so the user's view does not move while the report is made.
import maplibregl, { type GeoJSONSource } from 'maplibre-gl'
import { registerDeviceIcons } from '../deviceIcons'
import { bbox } from '../import/geometry'
import { MAP_LOCALE, buildStyle, devicesGeoJSON, ensurePmtiles, linksGeoJSON, plotsGeoJSON, type MapData } from '../mapStyle'

export const SNAPSHOT_SIZE: [number, number] = [1000, 620]
const IDLE_TIMEOUT_MS = 10000

export class SnapshotMap {
  private map: maplibregl.Map
  private holder: HTMLDivElement

  private constructor(map: maplibregl.Map, holder: HTMLDivElement) {
    this.map = map
    this.holder = holder
  }

  static async create(): Promise<SnapshotMap> {
    ensurePmtiles()
    const holder = document.createElement('div')
    holder.style.cssText = `position:fixed;left:-20000px;top:0;width:${SNAPSHOT_SIZE[0]}px;height:${SNAPSHOT_SIZE[1]}px`
    document.body.appendChild(holder)
    const map = new maplibregl.Map({
      container: holder, style: buildStyle(), interactive: false, attributionControl: false,
      fadeDuration: 0, locale: MAP_LOCALE, pixelRatio: 1,
      canvasContextAttributes: { preserveDrawingBuffer: true },
    })
    registerDeviceIcons(map)
    await new Promise<void>((resolve) => map.once('load', () => resolve()))
    return new SnapshotMap(map, holder)
  }

  private async settle() {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, IDLE_TIMEOUT_MS)     // never hang the report on a slow tile
      this.map.once('idle', () => { clearTimeout(t); resolve() })
      this.map.triggerRepaint()
    })
  }

  /**
   * One node: with a gateway, framed on its link with both ends highlighted and the rest
   * dimmed; a 4G sensor alone, closer, over the 4G coverage.
   */
  async capture(data: MapData, opts: { coverage: boolean }): Promise<string> {
    const m = this.map
    const h = data.highlight!
    const node = data.project.nodes.find((n) => n.name === h.node)!
    const gw = h.gateway ? data.project.gateways.find((g) => g.name === h.gateway) : undefined
    ;(m.getSource('devices') as GeoJSONSource).setData(devicesGeoJSON(data))
    ;(m.getSource('links') as GeoJSONSource).setData(linksGeoJSON(data))
    ;(m.getSource('plots') as GeoJSONSource).setData(plotsGeoJSON(data))
    m.setLayoutProperty('coverage', 'visibility', opts.coverage ? 'visible' : 'none')
    // Frame the link, or the sensor; with its whole plot when it has one
    const plot = node.plot ? data.project.plots?.find((p) => p.id === node.plot) : undefined
    const pts: number[][] = [[node.lon, node.lat], ...(gw ? [[gw.lon, gw.lat]] : [])]
    if (plot) {
      const [w, s, e, n] = bbox(plot.geometry)
      pts.push([w, s], [e, n])
    }
    if (pts.length > 1) {
      const lons = pts.map((q) => q[0]), lats = pts.map((q) => q[1])
      m.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
        { padding: { top: 90, bottom: 90, left: 120, right: 120 }, maxZoom: gw ? 17 : 16, duration: 0 })
      if (!gw && m.getZoom() > 15.5 && !plot) m.jumpTo({ zoom: 15 })
    } else {
      m.jumpTo({ center: [node.lon, node.lat], zoom: 15 })
    }
    await this.settle()
    return m.getCanvas().toDataURL('image/jpeg', 0.85)
  }

  /** Every device, nothing highlighted: the general map. Returns the canvas to frame it. */
  async overview(data: MapData, opts: { coverage: boolean }): Promise<HTMLCanvasElement | null> {
    const m = this.map
    const pts = [...data.project.gateways, ...data.project.nodes]
    if (!pts.length) return null
    ;(m.getSource('devices') as GeoJSONSource).setData(devicesGeoJSON(data))
    ;(m.getSource('links') as GeoJSONSource).setData(linksGeoJSON(data))
    ;(m.getSource('plots') as GeoJSONSource).setData(plotsGeoJSON(data))
    m.setLayoutProperty('coverage', 'visibility', opts.coverage ? 'visible' : 'none')
    const lons = pts.map((q) => q.lon)
    const lats = pts.map((q) => q.lat)
    m.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
      { padding: 80, maxZoom: 16, duration: 0 })
    await this.settle()
    return m.getCanvas()
  }

  destroy() {
    this.map.remove()
    this.holder.remove()
  }
}
