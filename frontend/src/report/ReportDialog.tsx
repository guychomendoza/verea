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
  // Cloud projects: the link printed in the PDF (the team chooses whether it shows owners)
  share?: { get: (showOwners: boolean) => Promise<string>; team: boolean }
  onClose: () => void
  onDone: (files: string[]) => void      // the PDF was downloaded: the dialog closes
}

/** Build the PDF in the browser and download it. */
export default function ReportDialog(p: Props) {
  const [withLink, setWithLink] = useState(true)
  const [showOwners, setShowOwners] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ text: string; fraction: number } | null>(null)
  const [error, setError] = useState('')
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
  const withLinkCount = lora.filter((n) => p.links[n.name]?.link).length
  // 4G states still on their way: a report now would list those sensors as unchecked
  const cellPending = !!p.project.settings.cell_operator
    && p.project.nodes.some((n) => p.cellular.has(n.name) && !p.cells[n.name])

  const generate = async () => {
    const c = new AbortController()
    ctrl.current = c
    setBusy(true)
    setError('')
    try {
      setProgress({ text: 'Preparando el link…', fraction: 0.02 })
      const shareUrl = p.share && withLink ? await p.share.get(showOwners) : null
      const data = await collectReport({
        project: p.project, catalog: p.catalog, signal: c.signal, links: p.links, shareUrl,
        cells: p.cells, cellular: p.cellular, stations: p.stations, legend: p.legend, showCoverage: p.showCoverage,
        onProgress: (text, fraction) => setProgress({ text, fraction }),
      })
      const { buildPdf } = await import('./pdf')
      const blob = await buildPdf(data)
      if (c.signal.aborted) return
      const name = `${safeName(p.project.name || 'proyecto_verea')}_reporte_${data.generatedAt.toISOString().slice(0, 16).replace(/[-:T]/g, '')}.pdf`
      downloadBlob(blob, name)
      setProgress({ text: 'Listo', fraction: 1 })
      p.onDone([name])
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
          {p.project.gateways.length} gateways · {lora.length} nodos LoRa ({withLinkCount} con enlace) ·{' '}
          {p.project.nodes.length - lora.length} sensores 4G. El PDF es un resumen: el mapa del proyecto y las tablas
          de gateways, nodos LoRa y sensores 4G.
        </p>
        {p.share && (
          <>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={withLink} onChange={(e) => setWithLink(e.target.checked)} disabled={busy} />
              Incluir «Ver este proyecto a detalle en verea.app» (link y código QR)
            </label>
            {p.share.team && withLink && (
              <label className="flex items-center gap-2 text-sm pl-6">
                <input type="checkbox" checked={showOwners} onChange={(e) => setShowOwners(e.target.checked)} disabled={busy} />
                El link muestra titulares, hectáreas y parcelas
              </label>
            )}
            {withLink && (
              <p className="hint">Quien abra el link entra con su cuenta de Google en modo lector: explora cada nodo, su enlace y su
                perfil de elevación, sin poder editar el proyecto.</p>
            )}
          </>
        )}
        {progress && (
          <div>
            <div className="progress"><div style={{ width: `${Math.round(progress.fraction * 100)}%` }} /></div>
            <p className="hint" role="status">{progress.text}</p>
          </div>
        )}
        {cellPending && !busy && <p className="hint" role="status">Calculando la cobertura 4G de los sensores… el reporte se habilita al terminar.</p>}
        {error && <p className="error" role="alert">⚠ {error}</p>}
        <div className="flex gap-2 justify-end">
          {busy
            ? <button className="btn btn-danger" onClick={() => ctrl.current?.abort()}>Cancelar</button>
            : <button className="btn" onClick={close}>Cerrar</button>}
          <button className="btn btn-active" onClick={generate} disabled={busy || cellPending}>
            {busy ? 'Generando…' : 'Generar PDF'}
          </button>
        </div>
      </div>
    </div>
  )
}
