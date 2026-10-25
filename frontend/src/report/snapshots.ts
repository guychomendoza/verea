// The report's map image, from a hidden map of its own (same style as the main map), so the
// user's view does not move while the report is made.
import maplibregl, { type GeoJSONSource } from 'maplibre-gl'
import { registerDeviceIcons } from '../deviceIcons'
import { fieldAreasGeoJSON, testBounds, type FieldTest } from '../fieldTests'
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

  /** Every device, nothing highlighted: the general map (with the coverage as the field tests
   *  corrected it). Returns the canvas to frame it. */
  async overview(data: MapData, opts: { coverage: boolean; fieldTests?: FieldTest[] }): Promise<HTMLCanvasElement | null> {
    const m = this.map
    const pts = [...data.project.gateways, ...data.project.nodes]
    if (!pts.length) return null
    ;(m.getSource('devices') as GeoJSONSource).setData(devicesGeoJSON(data))
    ;(m.getSource('links') as GeoJSONSource).setData(linksGeoJSON(data))
    ;(m.getSource('plots') as GeoJSONSource).setData(plotsGeoJSON(data))
    ;(m.getSource('field-areas') as GeoJSONSource).setData(fieldAreasGeoJSON(opts.fieldTests))
    for (const id of ['coverage', 'field-areas', 'field-areas-line']) m.setLayoutProperty(id, 'visibility', opts.coverage ? 'visible' : 'none')
    const lons = pts.map((q) => q.lon)
    const lats = pts.map((q) => q.lat)
    m.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
      { padding: 80, maxZoom: 16, duration: 0 })
    await this.settle()
    return m.getCanvas()
  }

  /** Whether any of the tests' squares is on the map as framed now. */
  showsAny(tests: FieldTest[] = []): boolean {
    const b = this.map.getBounds()
    return tests.some((t) => {
      const [w, s, e, n] = testBounds(t)
      return e >= b.getWest() && w <= b.getEast() && n >= b.getSouth() && s <= b.getNorth()
    })
  }

  destroy() {
    this.map.remove()
    this.holder.remove()
  }
}
