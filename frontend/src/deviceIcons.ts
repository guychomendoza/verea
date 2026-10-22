// Map symbology: a white glyph per device type, drawn inside the status-coloured circle.
// The same glyphs are used on the map (MapLibre images), in the side panel (inline SVG) and in
// the report legends (PNG for the PDF).
import type maplibregl from 'maplibre-gl'

export type DeviceKind = 'gateway' | 'lora' | 'cellular' | 'station'

export const KIND_LABELS: Record<DeviceKind, string> = {
  gateway: 'Gateway', lora: 'Sensor LoRa', cellular: 'Sensor 4G', station: 'Estación meteorológica',
}

// 24×24 stroke paths (round caps, width 2)
const GLYPHS: Record<DeviceKind, { stroke: string[]; fill?: string[] }> = {
  // mast with signal waves, like the logo
  gateway: {
    stroke: ['M12 11v10', 'M8.5 21h7', 'M8.6 7.6a4.8 4.8 0 0 1 6.8 0', 'M5.6 4.6a9 9 0 0 1 12.8 0'],
    fill: ['M12 8.4a1.8 1.8 0 1 1 0 3.6a1.8 1.8 0 1 1 0-3.6z'],
  },
  // soil probe: housing, ground line, probe into the soil
  lora: {
    stroke: ['M9 3.5h6v7.5H9z', 'M12 11v9.5', 'M4.5 15.5h15'],
  },
  // cellular signal bars
  cellular: {
    stroke: ['M5 20v-3', 'M9.7 20v-6.5', 'M14.3 20v-10', 'M19 20V6.5'],
  },
  // sun behind a cloud
  station: {
    stroke: ['M7 19.5h9.5a3.6 3.6 0 0 0 0-7.2h-.6A5 5 0 0 0 6.3 14a2.8 2.8 0 0 0 .7 5.5z',
      'M9.2 9.2a3.2 3.2 0 0 1 4.6-3', 'M10.5 2.5v1.2', 'M5.6 4.6l.9.9', 'M3.8 9.5H5'],
  },
}

const CIRCLE_R = 10.5

/** The glyph alone, for MapLibre (drawn over the circle layer). */
function glyphCanvas(kind: DeviceKind, px: number, color = '#ffffff'): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = c.height = px
  const g = c.getContext('2d')!
  g.scale(px / 24, px / 24)
  g.strokeStyle = g.fillStyle = color
  g.lineWidth = 2
  g.lineCap = g.lineJoin = 'round'
  for (const d of GLYPHS[kind].stroke) g.stroke(new Path2D(d))
  for (const d of GLYPHS[kind].fill ?? []) g.fill(new Path2D(d))
  return c
}

const IMAGE_PX = 48
export const iconImageId = (kind: DeviceKind) => `icon-${kind}`

/** Add the glyph images: all once the map loads, or earlier when a layer first asks for one. */
export function registerDeviceIcons(map: maplibregl.Map) {
  const add = (id: string) => {
    const kind = id.replace(/^icon-/, '') as DeviceKind
    if (!(kind in GLYPHS) || map.hasImage(id)) return
    const g = glyphCanvas(kind, IMAGE_PX).getContext('2d')!
    map.addImage(id, g.getImageData(0, 0, IMAGE_PX, IMAGE_PX), { pixelRatio: 2 })
  }
  map.on('styleimagemissing', (e: { id: string }) => add(e.id))
  map.once('load', () => (Object.keys(GLYPHS) as DeviceKind[]).forEach((k) => add(iconImageId(k))))
}

/** PNG glyphs for the standalone HTML report (its map registers them the same way). */
export function glyphPngs(): Record<string, string> {
  return Object.fromEntries((Object.keys(GLYPHS) as DeviceKind[]).map((k) => [iconImageId(k), glyphCanvas(k, IMAGE_PX).toDataURL('image/png')]))
}

/** Circle + glyph as SVG text: side panel and HTML legend. */
export function deviceIconSvg(kind: DeviceKind, color: string, size = 18): string {
  const glyph = GLYPHS[kind]
  const s = 0.68                             // glyph scale inside the circle
  const off = 12 - 12 * s
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">`
    + `<circle cx="12" cy="12" r="${CIRCLE_R}" fill="${color}" stroke="#fff" stroke-width="1.5"/>`
    + `<g transform="translate(${off} ${off}) scale(${s})" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">`
    + glyph.stroke.map((d) => `<path d="${d}"/>`).join('')
    + (glyph.fill ?? []).map((d) => `<path d="${d}" fill="#fff" stroke="none"/>`).join('')
    + '</g></svg>'
}

/** Circle + glyph as a PNG data URL: PDF legend and exported image legends. */
export function deviceIconCanvas(kind: DeviceKind, color: string, px = 48): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = c.height = px
  const g = c.getContext('2d')!
  g.scale(px / 24, px / 24)
  g.beginPath()
  g.arc(12, 12, CIRCLE_R, 0, Math.PI * 2)
  g.fillStyle = color
  g.fill()
  g.lineWidth = 1.5
  g.strokeStyle = '#ffffff'
  g.stroke()
  const s = 0.68
  g.translate(12 - 12 * s, 12 - 12 * s)
  g.scale(s, s)
  g.drawImage(glyphCanvas(kind, 96), 0, 0, 24, 24)
  return c
}
