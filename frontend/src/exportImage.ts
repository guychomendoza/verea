// PNG downloads of the terrain chart and the map, with a title, a legend and the
// data attribution drawn around them.

export interface LegendItem {
  color: string
  label: string
  line?: boolean          // a line sample instead of a dot
}

interface Frame {
  title: string
  subtitle?: string
  legend?: LegendItem[]
  attribution?: string
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
const PAD = 16

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
    const w = 21 + g.measureText(item.label).width + 16
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
function framed(content: CanvasImageSource, w: number, h: number, f: Frame, scale: number): Promise<Blob> {
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
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, W, H)
  g.fillStyle = '#1d2433'
  g.font = `600 16px ${FONT}`
  g.fillText(f.title, PAD, 24)
  if (f.subtitle) {
    g.fillStyle = '#5b6475'
    g.font = `13px ${FONT}`
    g.fillText(f.subtitle, PAD, 42)
  }
  g.drawImage(content, PAD, headH, w, h)
  let y = headH + h
  g.font = `12px ${FONT}`
  for (const row of rows) {
    let x = PAD
    for (const item of row) {
      g.fillStyle = item.color
      g.strokeStyle = item.color
      if (item.line) {
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
      g.fillStyle = '#1d2433'
      g.fillText(item.label, x + 21, y + 19)
      x += 21 + g.measureText(item.label).width + 16
    }
    y += 22
  }
  if (rows.length) y += 4
  if (f.attribution) {
    g.fillStyle = '#5b6475'
    g.font = `11px ${FONT}`
    g.fillText(f.attribution, PAD, y + 16)
  }
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not create the image'))), 'image/png'))
}

/** Copy the computed colours and fonts into a clone, so the SVG renders the same outside the page. */
function inlineStyles(src: Element, dst: Element) {
  const cs = getComputedStyle(src)
  const el = dst as SVGElement
  for (const prop of ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'font-size', 'font-family', 'font-weight']) {
    el.style.setProperty(prop, cs.getPropertyValue(prop))
  }
  for (let i = 0; i < src.children.length; i++) inlineStyles(src.children[i], dst.children[i])
}

export async function svgToPng(svg: SVGSVGElement, f: Frame, width = 640): Promise<Blob> {
  const clone = svg.cloneNode(true) as SVGSVGElement
  inlineStyles(svg, clone)
  const vb = svg.viewBox.baseVal
  const height = Math.round((width * vb.height) / vb.width)
  clone.setAttribute('width', String(width))
  clone.setAttribute('height', String(height))
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return await framed(img, width, height, f, 2)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** The map as it is on screen (needs preserveDrawingBuffer on the map). */
export function mapToPng(canvas: HTMLCanvasElement, f: Frame): Promise<Blob> {
  const ratio = canvas.width / canvas.clientWidth || 1
  return framed(canvas, canvas.clientWidth, canvas.clientHeight, f, ratio)
}
