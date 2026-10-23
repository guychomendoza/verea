// PDF report (A4) built in the browser with jsPDF; loaded only when a report is made.
// A summary: the whole project on the map and one table per kind of device. The detail of
// each node is in the app itself: the shared link (and its QR code) under the map.
import { BRAND, LOGO_RATIO, logoSvg, markSvg, svgToPng } from '../brand'
import { deviceIconCanvas } from '../deviceIcons'
import type { LegendItem } from '../legend'
import type { ReportData } from './collect'
import { SOURCES, cellTable, gatewayTable, loraTable, settingsLine, summaryTables, type Table } from './content'

const M = 14                       // page margin (mm)
const W = 210 - 2 * M
type RGB = [number, number, number]
const rgb = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB
const INK: RGB = rgb('#162a40')
const MUTED: RGB = rgb('#5a6b80')
const NAVY: RGB = rgb(BRAND.navy)
const TEAL: RGB = rgb(BRAND.teal)

/** jsPDF's built-in fonts only cover Latin-1 (Spanish is fine): replace the rest. */
function t(s: string): string {
  return s
    .replace(/→/g, '->').replace(/[−–—]/g, '-').replace(/≈/g, '~').replace(/✓/g, 'OK')
    .replace(/\s+/g, ' ').replace(/[^ -\xff]/g, '').trim()
}

export async function buildPdf(d: ReportData): Promise<Blob> {
  const [{ jsPDF }, { default: autoTable }, { default: qrcode }] = await Promise.all(
    [import('jspdf'), import('jspdf-autotable'), import('qrcode-generator')])
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true })
  const [logo, mark] = await Promise.all([
    svgToPng(logoSvg('#ffffff', BRAND.teal), 860, Math.round(860 * LOGO_RATIO)),
    svgToPng(markSvg(BRAND.navy, BRAND.teal), 96, 96),
  ])
  const iconPngs = new Map<string, string>()
  const iconPng = (it: LegendItem) => {
    const key = `${it.icon}${it.color}`
    if (!iconPngs.has(key)) iconPngs.set(key, deviceIconCanvas(it.icon!, it.color, 64).toDataURL('image/png'))
    return iconPngs.get(key)!
  }
  const pageH = doc.internal.pageSize.getHeight()
  let y = M

  const ensure = (h: number) => {
    if (y + h > pageH - M - 6) {
      doc.addPage()
      y = M
    }
  }
  const heading = (text: string, size = 13) => {
    ensure(14)
    doc.setFont('helvetica', 'bold').setFontSize(size).setTextColor(...NAVY)
    doc.text(t(text), M, y + 5)
    y += 9
  }
  /** Text that may run over several pages (a long project description). */
  const paragraph = (text: string, size = 9.5, color = MUTED) => {
    doc.setFont('helvetica', 'normal').setFontSize(size).setTextColor(...color)
    const lh = size * 0.42
    for (const line of doc.splitTextToSize(t(text), W) as string[]) {
      ensure(lh + 1)
      doc.text(line, M, y + 4)
      y += lh
    }
    y += 3
  }
  /** A table; `colors[i]` puts a dot of that colour in column `dotCol` (default: the last) of row i. */
  const table = (head: string[] | null, rows: string[][], widths: number[] = [], colors: string[] = [],
    o: { dotCol?: number; boldLast?: boolean } = {}) => {
    const dot = o.dotCol ?? (head ? head.length - 1 : -1)
    autoTable(doc, {
      startY: y, head: head ? [head.map(t)] : undefined, body: rows.map((r) => r.map(t)),
      margin: { left: M, right: M, bottom: 18 },
      styles: { fontSize: 8.5, cellPadding: 1.6, textColor: INK, lineColor: [220, 224, 230], lineWidth: 0.1 },
      headStyles: { fillColor: NAVY, textColor: [230, 237, 244], fontStyle: 'bold' },
      alternateRowStyles: { fillColor: rgb(BRAND.rowAlt) },
      columnStyles: {
        ...Object.fromEntries(widths.map((w, i) => [i, { cellWidth: w, ...(i === 0 && !head ? { fontStyle: 'bold' } : {}) }])),
        ...(colors.some(Boolean) ? { [dot]: { cellPadding: { top: 1.6, bottom: 1.6, right: 1.6, left: 6 } } } : {}),
      },
      didParseCell: (h) => {
        if (o.boldLast && h.section === 'body' && h.row.index === rows.length - 1) {
          h.cell.styles.fontStyle = 'bold'
          h.cell.styles.fillColor = rgb('#dce3eb')
        }
      },
      didDrawCell: (h) => {
        if (h.section !== 'body' || h.column.index !== dot || !colors[h.row.index]) return
        doc.setFillColor(...rgb(colors[h.row.index])).circle(h.cell.x + 3, h.cell.y + h.cell.height / 2, 1.3, 'F')
      },
    })
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 5
  }
  /** The summary tables one under the other, each with its title. */
  const stacked = (tables: Table[]) => {
    for (const tb of tables) {
      heading(tb.title, 11)
      table(tb.head, tb.rows, [120, W - 120], tb.colors, { dotCol: 0, boldLast: true })
    }
  }


  const image = (dataUrl: string, ratio: number, maxH: number) => {
    const w = Math.min(W, maxH / ratio)
    const h = w * ratio
    ensure(h + 2)
    doc.addImage(dataUrl, 'JPEG', M + (W - w) / 2, y, w, h, undefined, 'FAST')
    y += h + 4
  }
  /** Symbology in one or more rows: device symbols, line samples, dots and group titles. */
  const legend = (items: LegendItem[], size = 8) => {
    if (!items.length) return
    const h = size * 0.5                     // row height (mm)
    const s = h * 0.9                        // sample size
    doc.setFontSize(size)
    let x = M
    ensure(h + 2)
    const rowY = () => y + h / 2
    for (const it of items) {
      doc.setFont('helvetica', it.heading ? 'bold' : 'normal')
      const label = t(it.label)
      const w = (it.heading ? 0 : s + 1.4) + doc.getTextWidth(label) + (it.heading ? 2 : 4)
      if (x + w > M + W && x > M) {
        x = M
        y += h + 1.2
        ensure(h + 2)
      }
      if (it.heading) {
        doc.setTextColor(...INK).text(label, x, rowY() + size * 0.13)
        x += w
        continue
      }
      if (it.icon) doc.addImage(iconPng(it), 'PNG', x, rowY() - s / 2, s, s)
      else if (it.line) doc.setFillColor(...rgb(it.color)).roundedRect(x, rowY() - 0.6, s, 1.2, 0.5, 0.5, 'F')
      else doc.setFillColor(...rgb(it.color)).circle(x + s / 2, rowY(), s * 0.32, 'F')
      doc.setTextColor(...MUTED).text(label, x + s + 1.4, rowY() + size * 0.13)
      x += w
    }
    y += h + 3
  }
  /** Box with the shared link and its QR code: "see this project in detail online". */
  const onlineBox = (url: string) => {
    const qr = qrcode(0, 'M')
    qr.addData(url)
    qr.make()
    const n = qr.getModuleCount()
    const size = 26, pad = 4, cell = size / n
    const h = size + 2 * pad
    ensure(h + 4)
    doc.setFillColor(...rgb(BRAND.rowAlt)).setDrawColor(...TEAL).setLineWidth(0.5).roundedRect(M, y, W, h, 2, 2, 'FD')
    doc.setFillColor(255, 255, 255).rect(M + pad - 1, y + pad - 1, size + 2, size + 2, 'F')
    doc.setFillColor(...NAVY)
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) doc.rect(M + pad + c * cell, y + pad + r * cell, cell + 0.02, cell + 0.02, 'F')
    }
    const tx = M + pad + size + 6, tw = W - (tx - M) - pad
    doc.setFont('helvetica', 'bold').setFontSize(12).setTextColor(...NAVY).text('Ver este proyecto a detalle en línea', tx, y + pad + 5)
    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...INK)
    const lines = doc.splitTextToSize(t('Escanea el código o abre el link y entra con tu cuenta de Google: explora cada nodo en '
      + 'el mapa, su enlace, su perfil de elevación y la cobertura 4G, y prueba otra altura o entorno.'), tw) as string[]
    doc.text(lines, tx, y + pad + 11)
    doc.setFont('helvetica', 'bold').setFontSize(8.5).setTextColor(...TEAL)
    doc.textWithLink(url, tx, y + pad + 12 + lines.length * 4 + 2, { url })
    y += h + 5
  }

  // ── summary: header, figures, the whole project on the map, one table per kind of node ──
  const LOGO_W = 40
  doc.setFillColor(...NAVY).rect(0, 0, 210, 34, 'F')
  doc.setFillColor(...TEAL).rect(0, 34, 210, 1.4, 'F')
  doc.addImage(logo, 'PNG', M, (34 - LOGO_W * LOGO_RATIO) / 2, LOGO_W, LOGO_W * LOGO_RATIO)
  const tx = M + LOGO_W + 8
  doc.setDrawColor(...TEAL).setLineWidth(0.4).line(tx - 4, 9, tx - 4, 25)
  doc.setFont('helvetica', 'bold').setFontSize(18).setTextColor(255, 255, 255)
  doc.text(doc.splitTextToSize(t(d.project.name.trim() || 'Proyecto Verea'), 210 - tx - M)[0] as string, tx, 16)
  doc.setFont('helvetica', 'normal').setFontSize(9.5).setTextColor(159, 176, 195)
  doc.text(t(`Reporte de red · ${d.generatedAt.toLocaleString('es-MX')}`), tx, 24)
  y = 42
  if (d.project.description.trim()) paragraph(d.project.description, 10, INK)
  if (d.mapImg) {
    image(d.mapImg, (d.mapSize[1] + 88) / (d.mapSize[0] + 32), 140)
    y -= 2
    legend(d.legend)
  }
  if (d.shareUrl) onlineBox(d.shareUrl)
  stacked(summaryTables(d))
  paragraph(settingsLine(d), 8.5)
  for (const tb of [gatewayTable(d), loraTable(d), cellTable(d)]) {
    if (!tb) continue
    heading(tb.title, 12)
    table(tb.head, tb.rows, [], tb.colors)
  }
  doc.setFont('helvetica', 'bold').setFontSize(8).setTextColor(...MUTED)
  ensure(12)
  doc.text('Fuentes', M, y + 3)
  y += 4
  for (const src of SOURCES) paragraph(src, 7)

  // ── page numbers ──
  const pages = doc.getNumberOfPages()
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i)
    doc.setDrawColor(...rgb('#dce3eb')).setLineWidth(0.2).line(M, pageH - 11, 210 - M, pageH - 11)
    doc.addImage(mark, 'PNG', M, pageH - 9.6, 4.6, 4.6)
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...MUTED)
    doc.text(t(`Verea · ${d.project.name.trim() || 'Proyecto'}`), M + 6, pageH - 6.4)
    doc.text(t(`página ${i} de ${pages}`), 210 - M, pageH - 6.4, { align: 'right' })
  }
  return doc.output('blob')
}
