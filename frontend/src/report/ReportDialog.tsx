import { useEffect, useRef, useState } from 'react'
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
  const ctrl = useRef<AbortController | null>(null)
  // Closing while a report is being made cancels it
  const close = () => {
    ctrl.current?.abort()
    p.onClose()
  }
  useEffect(() => () => ctrl.current?.abort(), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      ctrl.current?.abort()
      p.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [p])

  const lora = p.project.nodes.filter((n) => !p.cellular.has(n.name))
  const withLink = lora.filter((n) => p.links[n.name]?.link).length
  // 4G states still on their way: a report now would list those sensors as unchecked
  const cellPending = !!p.project.settings.cell_operator
    && p.project.nodes.some((n) => p.cellular.has(n.name) && !p.cells[n.name])

  const generate = async () => {
    const c = new AbortController()
    ctrl.current = c
    setBusy(true)
    setError('')
    setDone([])
    const files: string[] = []
    const fileBase = (d: Date) => `${safeName(p.project.name || 'proyecto_verea')}_reporte_${d.toISOString().slice(0, 16).replace(/[-:T]/g, '')}`
    try {
      const data = await collectReport({
        project: p.project, catalog: p.catalog, details: html, signal: c.signal, links: p.links,
        cells: p.cells, cellular: p.cellular, stations: p.stations, legend: p.legend, showCoverage: p.showCoverage,
        onProgress: (text, fraction) => setProgress({ text, fraction }),
        // The PDF only needs the general map: download it right away, the HTML follows
        onSummary: async (summary) => {
          if (!pdf) return
          const { buildPdf } = await import('./pdf')
          const blob = await buildPdf(summary)
          if (c.signal.aborted) return
          downloadBlob(blob, `${fileBase(summary.generatedAt)}.pdf`)
          files.push(`${fileBase(summary.generatedAt)}.pdf`)
          setDone([...files])
        },
      })
      const base = fileBase(data.generatedAt)
      if (html && !c.signal.aborted) {
        const { buildHtml } = await import('./html')
        downloadBlob(new Blob([buildHtml(data)], { type: 'text/html;charset=utf-8' }), `${base}.html`)
        files.push(`${base}.html`)
      }
      setDone([...files])
      setProgress({ text: 'Listo', fraction: 1 })
    } catch (e) {
      if (c.signal.aborted) setProgress(null)
      else setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (ctrl.current === c) ctrl.current = null
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onClick={() => !busy && close()}>
      <div className="dialog" role="dialog" aria-label="Reporte" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">📄 Reporte de la red</h2>
          <button className="btn-ghost" onClick={close} aria-label="Cerrar">✕</button>
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
        {done.length > 0 && <p className="hint">Descargado: {done.join(', ')}{busy ? ' · el HTML sigue generándose…' : ''}</p>}
        {cellPending && !busy && <p className="hint" role="status">Calculando la cobertura 4G de los sensores… el reporte se habilita al terminar.</p>}
        {error && <p className="error" role="alert">⚠ {error}</p>}
        <div className="flex gap-2 justify-end">
          {busy
            ? <button className="btn btn-danger" onClick={() => ctrl.current?.abort()}>Cancelar</button>
            : <button className="btn" onClick={close}>Cerrar</button>}
          <button className="btn btn-active" onClick={generate} disabled={busy || cellPending || (!pdf && !html)}>
            {busy ? 'Generando…' : 'Generar y descargar'}
          </button>
        </div>
      </div>
    </div>
  )
}
