import { useEffect, useState } from 'react'
import { downloadBlob, safeName, type LegendItem } from '../exportImage'
import type { Catalog, CellStatus, LinkResult, Project } from '../types'
import { collectReport } from './collect'

interface Props {
  catalog: Catalog
  project: Project
  links: Record<string, LinkResult>
  cells: Record<string, CellStatus>
  cellular: Set<string>
  stations: Set<string>
  legend: LegendItem[]
  showCoverage: boolean
  onClose: () => void
}

/** Choose PDF and/or interactive HTML, build them in the browser and download them. */
export default function ReportDialog(p: Props) {
  const [pdf, setPdf] = useState(true)
  const [html, setHtml] = useState(true)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ text: string; fraction: number } | null>(null)
  const [error, setError] = useState('')
  const [done, setDone] = useState<string[]>([])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) p.onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, p])

  const lora = p.project.nodes.filter((n) => !p.cellular.has(n.name))
  const withLink = lora.filter((n) => p.links[n.name]?.link).length
  // 4G states still on their way: a report now would list those sensors as unchecked
  const cellPending = !!p.project.settings.cell_operator
    && p.project.nodes.some((n) => p.cellular.has(n.name) && !p.cells[n.name])

  const generate = async () => {
    setBusy(true)
    setError('')
    setDone([])
    try {
      const data = await collectReport({
        project: p.project, catalog: p.catalog, details: html, links: p.links,
        cells: p.cells, cellular: p.cellular, stations: p.stations, legend: p.legend, showCoverage: p.showCoverage,
        onProgress: (text, fraction) => setProgress({ text, fraction }),
      })
      const stamp = data.generatedAt.toISOString().slice(0, 16).replace(/[-:T]/g, '')
      const base = `${safeName(p.project.name || 'proyecto_verea')}_reporte_${stamp}`
      const files: string[] = []
      if (pdf) {
        const { buildPdf } = await import('./pdf')
        downloadBlob(await buildPdf(data), `${base}.pdf`)
        files.push(`${base}.pdf`)
      }
      if (html) {
        const { buildHtml } = await import('./html')
        downloadBlob(new Blob([buildHtml(data)], { type: 'text/html;charset=utf-8' }), `${base}.html`)
        files.push(`${base}.html`)
      }
      setDone(files)
      setProgress({ text: 'Listo', fraction: 1 })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onClick={() => !busy && p.onClose()}>
      <div className="dialog" role="dialog" aria-label="Reporte" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">📄 Reporte de la red</h2>
          <button className="btn-ghost" onClick={p.onClose} disabled={busy} aria-label="Cerrar">✕</button>
        </div>
        <p className="hint">
          {p.project.gateways.length} gateways · {lora.length} nodos LoRa ({withLink} con enlace) ·{' '}
          {p.project.nodes.length - lora.length} sensores 4G. El PDF es un resumen: el mapa del proyecto y las tablas
          de nodos LoRa y 4G. El HTML trae además la ficha de cada nodo (su enlace en el mapa, el Perfil de
          Elevación y sus datos).
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={pdf} onChange={(e) => setPdf(e.target.checked)} disabled={busy} />
          PDF: resumen con mapa y tablas (para enviar o imprimir)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={html} onChange={(e) => setHtml(e.target.checked)} disabled={busy} />
          HTML interactivo: detalle de cada nodo (se abre en cualquier navegador)
        </label>
        {progress && (
          <div>
            <div className="progress"><div style={{ width: `${Math.round(progress.fraction * 100)}%` }} /></div>
            <p className="hint" role="status">{progress.text}</p>
          </div>
        )}
        {done.length > 0 && <p className="hint">Descargado: {done.join(', ')}</p>}
        {cellPending && !busy && <p className="hint" role="status">Calculando la cobertura 4G de los sensores… el reporte se habilita al terminar.</p>}
        {error && <p className="error" role="alert">⚠ {error}</p>}
        <div className="flex gap-2 justify-end">
          <button className="btn" onClick={p.onClose} disabled={busy}>Cerrar</button>
          <button className="btn btn-active" onClick={generate} disabled={busy || cellPending || (!pdf && !html)}>
            {busy ? 'Generando…' : 'Generar y descargar'}
          </button>
        </div>
      </div>
    </div>
  )
}
