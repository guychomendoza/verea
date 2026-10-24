// PNG download of the map inside a dark frame with title, legend and attribution, in the
// same style as the elevation profile (Plotly, profilePlot.ts).

import { BRAND } from './brand'
import { deviceIconCanvas } from './deviceIcons'
import type { LegendItem } from './legend'

export type { LegendItem }

interface Frame {
  title: string
  subtitle?: string
  legend?: LegendItem[]
  attribution?: string
}

const FONT = '"Inter Variable", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'   // the app's font (loaded by then)
const PAD = 16
const BG = BRAND.navyDeep
const INK = '#e6edf4'
const MUTED = '#9fb0c3'
const FAINT = '#7d90a6'

export function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

export function safeName(s: string): string {
  return (s.trim() || 'verea').replace(/[^\w-]+/g, '_').slice(0, 60)
}

/** Legend items split into rows that fit the width. */
function legendRows(items: LegendItem[], width: number): LegendItem[][] {
  const g = document.createElement('canvas').getContext('2d')!
  g.font = `12px ${FONT}`
  const rows: LegendItem[][] = [[]]
  let x = 0
  for (const item of items) {
    const w = (item.heading ? 0 : 21) + g.measureText(item.label).width + (item.heading ? 8 : 16)
    if (x + w > width && rows[rows.length - 1].length) {
      rows.push([])
      x = 0
    }
    rows[rows.length - 1].push(item)
    x += w
  }
  return rows
}

/** Draws `content` (w × h CSS pixels) inside a white frame with title, legend and attribution. */
function framed(content: CanvasImageSource, w: number, h: number, f: Frame, scale: number,
  type = 'image/png', quality?: number): Promise<Blob> {
  const rows = f.legend?.length ? legendRows(f.legend, w) : []
  const legendH = rows.length * 22 + (rows.length ? 4 : 0)
  const headH = f.subtitle ? 50 : 34
  const footH = f.attribution ? 22 : 0
  const W = w + 2 * PAD
  const H = headH + h + legendH + footH + PAD
  const c = document.createElement('canvas')
  c.width = Math.round(W * scale)
  c.height = Math.round(H * scale)
  const g = c.getContext('2d')!
  g.scale(scale, scale)
  g.fillStyle = BG
  g.fillRect(0, 0, W, H)
  g.textAlign = 'center'
  g.fillStyle = INK
  g.font = `600 16px ${FONT}`
  g.fillText(f.title, W / 2, 24)
  if (f.subtitle) {
    g.fillStyle = MUTED
    g.font = `13px ${FONT}`
    g.fillText(f.subtitle, W / 2, 42)
  }
  g.textAlign = 'left'
  g.drawImage(content, PAD, headH, w, h)
  let y = headH + h
  g.font = `12px ${FONT}`
  for (const row of rows) {
    let x = PAD
    for (const item of row) {
      if (item.heading) {
        g.fillStyle = MUTED
        g.font = `600 12px ${FONT}`
        g.fillText(item.label, x, y + 19)
        x += g.measureText(item.label).width + 8
        g.font = `12px ${FONT}`
        continue
      }
      g.fillStyle = item.color
      g.strokeStyle = item.color
      if (item.icon) {
        g.drawImage(deviceIconCanvas(item.icon, item.color, 64), x - 2, y + 6, 18, 18)
      } else if (item.line) {
        g.lineWidth = 3
        g.beginPath()
        g.moveTo(x, y + 15)
        g.lineTo(x + 16, y + 15)
        g.stroke()
      } else {
        g.beginPath()
        g.arc(x + 6, y + 15, 5, 0, 2 * Math.PI)
        g.fill()
      }
      g.fillStyle = INK
      g.fillText(item.label, x + 21, y + 19)
      x += 21 + g.measureText(item.label).width + 16
    }
    y += 22
  }
  if (rows.length) y += 4
  if (f.attribution) {
    g.fillStyle = FAINT
    g.font = `11px ${FONT}`
    g.fillText(f.attribution, PAD, y + 16)
  }
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo crear la imagen'))), type, quality))
}

/** The map as it is on screen (needs preserveDrawingBuffer on the map). */
export function mapToPng(canvas: HTMLCanvasElement, f: Frame, type = 'image/png', quality?: number): Promise<Blob> {
  const ratio = canvas.width / canvas.clientWidth || 1
  return framed(canvas, canvas.clientWidth, canvas.clientHeight, f, ratio, type, quality)
}
