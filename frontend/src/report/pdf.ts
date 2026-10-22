// PDF report (A4) built in the browser with jsPDF; loaded only when a report is made.
import type { ReportData } from './collect'
import { GLOSSARY, SOURCES, budgetRows, summary, tables } from './content'

const M = 14                       // page margin (mm)
const W = 210 - 2 * M
const INK: [number, number, number] = [29, 36, 51]
const MUTED: [number, number, number] = [91, 100, 117]
const ACCENT: [number, number, number] = [17, 138, 178]

/** jsPDF's built-in fonts only cover Latin-1 (Spanish is fine): replace the rest. */
function t(s: string): string {
  return s
    .replace(/→/g, '->').replace(/[−–—]/g, '-').replace(/≈/g, '~').replace(/✓/g, 'OK')
    .replace(/\s+/g, ' ').replace(/[^ -\xff]/g, '').trim()
}

export async function buildPdf(d: ReportData): Promise<Blob> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true })
  const pageH = doc.internal.pageSize.getHeight()
  let y = M

  const ensure = (h: number) => {
    if (y + h > pageH - M) {
      doc.addPage()
      y = M
    }
  }
  const heading = (text: string, size = 13) => {
    ensure(14)
    doc.setFont('helvetica', 'bold').setFontSize(size).setTextColor(...INK)
    doc.text(t(text), M, y + 5)
    y += 9
  }
  const paragraph = (text: string, size = 9.5, color = MUTED) => {
    doc.setFont('helvetica', 'normal').setFontSize(size).setTextColor(...color)
    const lines = doc.splitTextToSize(t(text), W) as string[]
    ensure(lines.length * size * 0.42 + 2)
    doc.text(lines, M, y + 4)
    y += lines.length * size * 0.42 + 3
  }
  const table = (head: string[], rows: string[][], opts: { widths?: number[] } = {}) => {
    autoTable(doc, {
      startY: y, head: [head.map(t)], body: rows.map((r) => r.map(t)), margin: { left: M, right: M },
      styles: { fontSize: 8, cellPadding: 1.6, textColor: INK, lineColor: [220, 224, 230], lineWidth: 0.1 },
      headStyles: { fillColor: [14, 17, 23], textColor: [233, 236, 239], fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [246, 247, 249] },
      columnStyles: Object.fromEntries((opts.widths ?? []).map((w, i) => [i, { cellWidth: w }])),
    })
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6
  }
  const image = (dataUrl: string, ratio: number, maxH = 150) => {
    const w = Math.min(W, maxH / ratio)
    const h = w * ratio
    ensure(h + 2)
    doc.addImage(dataUrl, 'JPEG', M + (W - w) / 2, y, w, h, undefined, 'FAST')
    y += h + 5
  }

  // ── cover ──
  doc.setFillColor(14, 17, 23).rect(0, 0, 210, 34, 'F')
  doc.setFont('helvetica', 'bold').setFontSize(20).setTextColor(233, 236, 239)
  doc.text(t(d.project.name.trim() || 'Proyecto Verea'), M, 17)
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(173, 181, 189)
  doc.text(t(`Reporte de red · ${d.generatedAt.toLocaleString('es-MX')}${d.author ? ` · ${d.author}` : ''}`), M, 26)
  y = 42
  if (d.project.description.trim()) paragraph(d.project.description, 10, INK)
  heading('Resumen')
  table(['Concepto', 'Valor'], summary(d), { widths: [90, W - 90] })

  if (d.mapPng) {
    heading('Mapa')
    image(d.mapPng, (d.mapSize[1] + 90) / (d.mapSize[0] + 32), 175)
  }
  for (const tb of tables(d)) {
    heading(tb.title)
    table(tb.head, tb.rows)
  }

  // ── one section per link ──
  for (const s of d.sections) {
    doc.addPage()
    y = M
    const l = d.links[s.node.name]?.link
    heading(`Enlace ${s.gateway.name} -> ${s.node.name}`)
    doc.setFont('helvetica', 'bold').setFontSize(10)
    doc.setTextColor(...(l?.viable ? [6, 167, 125] as [number, number, number] : [214, 65, 97] as [number, number, number]))
    doc.text(t(l?.viable ? 'Enlace viable' : 'Enlace no viable'), M, y + 3)
    y += 7
    image(s.png, 520 / 1000)
    table(['Presupuesto del enlace', 'Valor'], budgetRows(s.detail.budget), { widths: [90, W - 90] })
    if (s.detail.summary.reasons.length) {
      doc.setFont('helvetica', 'bold').setFontSize(9.5).setTextColor(...INK)
      ensure(8)
      doc.text('Observaciones', M, y + 3)
      y += 6
      for (const r of s.detail.summary.reasons) paragraph(`- ${r}`, 9)
    }
    paragraph(`Elevación: ${s.detail.profile.elevation_source}.`, 8)
  }

  // ── glossary and sources ──
  doc.addPage()
  y = M
  heading('Glosario')
  for (const [term, text] of GLOSSARY) {
    doc.setFont('helvetica', 'bold').setFontSize(9.5).setTextColor(...ACCENT)
    ensure(10)
    doc.text(t(term), M, y + 4)
    y += 5
    paragraph(text, 9, INK)
  }
  heading('Fuentes y atribuciones', 11)
  for (const s of SOURCES) paragraph(s, 8.5)

  // ── page numbers ──
  const pages = doc.getNumberOfPages()
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i)
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...MUTED)
    doc.text(t(`Verea · ${d.project.name.trim() || 'Proyecto'} · página ${i} de ${pages}`), M, pageH - 7)
  }
  return doc.output('blob')
}
