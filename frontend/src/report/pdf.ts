// PDF report (A4) built in the browser with jsPDF; loaded only when a report is made.
// Visual first: the general map and a one-page card per node (its link on the map, its
// elevation profile and only the figures that matter).
import { PROFILE_SIZE, type ReportData } from './collect'
import { GLOSSARY, SOURCES, nodeFacts, overviewTable, settingsLine, summary } from './content'
import { SNAPSHOT_SIZE } from './snapshots'

const M = 14                       // page margin (mm)
const W = 210 - 2 * M
const INK: [number, number, number] = [29, 36, 51]
const MUTED: [number, number, number] = [91, 100, 117]
const ACCENT: [number, number, number] = [17, 138, 178]
const OK: [number, number, number] = [6, 167, 125]
const WARN: [number, number, number] = [201, 138, 0]
const BAD: [number, number, number] = [214, 65, 97]

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
    if (y + h > pageH - M - 6) {
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
  const table = (head: string[] | null, rows: string[][], widths: number[] = []) => {
    autoTable(doc, {
      startY: y, head: head ? [head.map(t)] : undefined, body: rows.map((r) => r.map(t)), margin: { left: M, right: M },
      styles: { fontSize: 8.5, cellPadding: 1.6, textColor: INK, lineColor: [220, 224, 230], lineWidth: 0.1 },
      headStyles: { fillColor: [14, 17, 23], textColor: [233, 236, 239], fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [246, 247, 249] },
      columnStyles: Object.fromEntries(widths.map((w, i) => [i, { cellWidth: w, ...(i === 0 && !head ? { fontStyle: 'bold' } : {}) }])),
    })
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 5
  }
  const image = (dataUrl: string, ratio: number, maxH: number) => {
    const w = Math.min(W, maxH / ratio)
    const h = w * ratio
    ensure(h + 2)
    doc.addImage(dataUrl, 'JPEG', M + (W - w) / 2, y, w, h, undefined, 'FAST')
    y += h + 4
  }
  const verdict = (text: string, color: [number, number, number]) => {
    doc.setFillColor(...color).roundedRect(M, y, 3, 6, 0.8, 0.8, 'F')
    doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...color)
    doc.text(t(text), M + 5, y + 4.6)
    y += 9
  }

  // ── cover: summary, general map, connectivity table ──
  doc.setFillColor(14, 17, 23).rect(0, 0, 210, 32, 'F')
  doc.setFont('helvetica', 'bold').setFontSize(20).setTextColor(233, 236, 239)
  doc.text(t(d.project.name.trim() || 'Proyecto Verea'), M, 16)
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(173, 181, 189)
  doc.text(t(`Reporte de red · ${d.generatedAt.toLocaleString('es-MX')}${d.author ? ` · ${d.author}` : ''}`), M, 25)
  y = 40
  if (d.project.description.trim()) paragraph(d.project.description, 10, INK)
  table(null, summary(d), [80, W - 80])
  paragraph(settingsLine(d), 8.5)
  if (d.mapImg) image(d.mapImg, (d.mapSize[1] + 92) / (d.mapSize[0] + 32), 150)
  const ov = overviewTable(d)
  heading(ov.title, 12)
  table(ov.head, ov.rows)

  // ── one card per node ──
  for (const s of d.nodes) {
    doc.addPage()
    y = M
    const l = s.cellular ? null : d.links[s.node.name]?.link
    heading(s.node.name, 16)
    doc.setFont('helvetica', 'normal').setFontSize(9.5).setTextColor(...MUTED)
    doc.text(t(s.cellular ? 'Sensor 4G' : l ? `Nodo LoRa · enlace con ${l.gateway}` : 'Nodo LoRa'), M, y)
    y += 5
    if (s.cellular) {
      const c = d.cells[s.node.name]
      verdict(c ? c.short : 'Sin revisar', !c ? MUTED : c.state === 'ok' ? OK : c.state === 'none' ? BAD : WARN)
    } else {
      verdict(l ? (l.viable ? 'Enlace viable' : 'Enlace no viable') : (d.links[s.node.name]?.error ?? 'Sin resultado'),
        !l ? MUTED : l.viable ? OK : l.margin_db > -5 ? WARN : BAD)
    }
    // Reasons of a failed link take room: smaller images keep the card on one page
    const why = l && !l.viable ? l.reasons : []
    image(s.mapJpg, SNAPSHOT_SIZE[1] / SNAPSHOT_SIZE[0], s.profileJpg ? (why.length ? 88 : 105) : 150)
    if (s.profileJpg) image(s.profileJpg, PROFILE_SIZE[1] / PROFILE_SIZE[0], why.length ? 68 : 82)
    table(null, nodeFacts(d, s), [52, W - 52])
    if (why.length) {
      doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(...INK)
      ensure(7)
      doc.text('Por qué no es viable', M, y + 3)
      y += 5
      for (const r of why) paragraph(`- ${r}`, 8)
    }
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
