// "Importar parcelas": KML / KMZ / XLSX / CSV → reviewed rows → sensors (and plots) in the project.
import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl, { type GeoJSONSource } from 'maplibre-gl'
import { COLORS } from '../colors'
import { registerDeviceIcons } from '../deviceIcons'
import { MAP_LOCALE, buildStyle, ensurePmtiles } from '../mapStyle'
import type { Catalog, Project } from '../types'
import { applyImport, type ImportSummary } from './apply'
import { readFile, type ReadResult } from './readers'
import { ROLE_LABELS, detectRoles, nodeName, rowsFromFeatures, rowsFromTable, valid, type ImportRow, type Naming, type Role } from './rules'

interface Props {
  catalog: Catalog
  project: Project
  onApply: (next: Project, summary: ImportSummary) => void
  onClose: () => void
}

const NAMING_LABELS: Record<Naming, string> = { folio: 'Folio', folio_owner: 'Folio + titular', owner: 'Titular' }

export default function ImportDialog(p: Props) {
  const [file, setFile] = useState<{ name: string; data: ReadResult } | null>(null)
  const [error, setError] = useState('')
  const [reading, setReading] = useState(false)
  const [roles, setRoles] = useState<Role[]>([])
  const [edits, setEdits] = useState<Record<string, Partial<ImportRow>>>({})
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [onlyIssues, setOnlyIssues] = useState(false)
  const models = Object.entries(p.catalog.node_profiles)
  const [model, setModel] = useState(models.find(([k]) => k === 'dragino_se0x_cs')?.[0] ?? models[0]?.[0] ?? '')
  const [naming, setNaming] = useState<Naming>('folio')
  const [movePositions, setMovePositions] = useState(false)
  const [focusKey, setFocusKey] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') p.onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [p])

  const open = async (f: File) => {
    setReading(true)
    setError('')
    try {
      const data = await readFile(f)
      setFile({ name: f.name, data })
      setRoles(data.kind === 'table' ? detectRoles(data.table) : [])
      setEdits({})
      setExcluded(new Set())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setReading(false)
    }
  }

  const base = useMemo((): { rows: ImportRow[]; ignored: number } => {
    if (!file) return { rows: [], ignored: 0 }
    return file.data.kind === 'features' ? rowsFromFeatures(file.data.features) : { rows: rowsFromTable(file.data.table, roles), ignored: 0 }
  }, [file, roles])
  const rows = useMemo(() => base.rows.map((r) => ({ ...r, ...edits[r.key] })), [base, edits])
  const existing = useMemo(() => new Set(p.project.nodes.map((n) => n.name)), [p.project.nodes])
  const chosen = rows.filter((r) => !excluded.has(r.key) && valid(r))
  const shown = onlyIssues ? rows.filter((r) => r.issues.length || !valid(r)) : rows
  const counts = {
    ok: rows.filter((r) => valid(r) && !r.issues.length).length,
    issues: rows.filter((r) => r.issues.length).length,
    fixed: rows.filter((r) => r.notes.some((n) => /corregida|fecha/.test(n))).length,
    plots: rows.filter((r) => r.plot).length,
    updates: chosen.filter((r) => existing.has(nodeName(r, naming))).length,
  }

  const apply = () => {
    const [next, summary] = applyImport(p.project, p.catalog, chosen, { model, naming, movePositions })
    p.onApply(next, summary)
  }

  return (
    <div className="dialog-backdrop">
      <div className="dialog import-dialog" role="dialog" aria-label="Importar parcelas">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Importar parcelas y sensores</h2>
          <button className="btn-ghost" onClick={p.onClose} aria-label="Cerrar">✕</button>
        </div>
        <p className="hint">
          KML o KMZ (Google Earth: pines y polígonos de parcelas), Excel (.xlsx) o CSV. El archivo se lee en tu
          navegador; no se sube a ningún lado. Cada pin o parcela será un sensor; revisa las filas marcadas con ⚠.
        </p>
        <label className="btn self-start">
          {reading ? 'Leyendo…' : file ? `Cambiar archivo (${file.name})` : 'Elegir archivo…'}
          <input type="file" hidden accept=".kml,.kmz,.xlsx,.csv,.tsv,.txt" aria-label="Archivo a importar"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) open(f); e.target.value = '' }} />
        </label>
        {error && <p className="error" role="alert">⚠ {error}</p>}

        {file?.data.kind === 'table' && (
          <details open={!roles.includes('folio') || !(roles.includes('latlon') || (roles.includes('lat') && roles.includes('lon')))}>
            <summary className="text-sm font-semibold">Columnas del archivo ({file.data.table.headers.length})</summary>
            <div className="import-roles">
              {file.data.table.headers.map((h, i) => (
                <label key={i} className="field">
                  <span title={h}>{h || `Columna ${i + 1}`}</span>
                  <select value={roles[i] ?? 'ignore'} aria-label={`Uso de la columna ${h}`}
                    onChange={(e) => setRoles(roles.map((r, j) => (j === i ? (e.target.value as Role) : r)))}>
                    {(Object.keys(ROLE_LABELS) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                  </select>
                </label>
              ))}
            </div>
          </details>
        )}

        {file && (
          <>
            <p className="text-sm" role="status">
              <b>{rows.length}</b> filas · ✓ {counts.ok} listas · ⚠ {counts.issues} por revisar · {counts.fixed} reparadas
              {counts.plots ? ` · ${counts.plots} parcelas` : ''}{base.ignored ? ` · ${base.ignored} elementos sin punto ni polígono ignorados` : ''}
            </p>
            <div className="import-body">
              <PreviewMap rows={rows} excluded={excluded} focusKey={focusKey} />
              <div className="import-table">
                <label className="flex items-center gap-2 text-sm mb-1">
                  <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} />
                  Solo las filas por revisar
                </label>
                <table>
                  <thead>
                    <tr><th></th><th>Nodo</th><th>Folio</th><th>Titular</th><th>Superficie</th><th>Detalles</th></tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => {
                      const ok = valid(r)
                      const name = nodeName(r, naming)
                      return (
                        <tr key={r.key} className={r.issues.length ? 'warn' : ''} onClick={() => setFocusKey(r.key)}>
                          <td>
                            <input type="checkbox" checked={ok && !excluded.has(r.key)} disabled={!ok}
                              aria-label={`Incluir ${name}`}
                              onChange={(e) => {
                                const s = new Set(excluded)
                                if (e.target.checked) s.delete(r.key); else s.add(r.key)
                                setExcluded(s)
                              }} />
                          </td>
                          <td>
                            {r.issues.length ? '⚠' : '✓'} {name}
                            {existing.has(name) && <span className="hint"> · actualiza</span>}
                          </td>
                          <td><input value={r.folio ?? ''} aria-label={`Folio de ${name}`}
                            onChange={(e) => setEdits({ ...edits, [r.key]: { ...edits[r.key], folio: e.target.value.trim() || undefined } })} /></td>
                          <td><input value={r.owner ?? ''} aria-label={`Titular de ${name}`}
                            onChange={(e) => setEdits({ ...edits, [r.key]: { ...edits[r.key], owner: e.target.value || undefined } })} /></td>
                          <td>{r.area_ha != null ? `${r.area_ha.toFixed(2)} ha` : '—'}</td>
                          <td className="import-details">
                            {r.issues.map((x, i) => <div key={`i${i}`} className="issue">⚠ {x}</div>)}
                            {r.notes.map((x, i) => <div key={`n${i}`} className="hint">ℹ {x}</div>)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="import-options">
              <label className="field"><span>Modelo de sensor</span>
                <select value={model} onChange={(e) => setModel(e.target.value)}>
                  {models.map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
              </label>
              <label className="field"><span>Nombre de cada nodo</span>
                <select value={naming} onChange={(e) => setNaming(e.target.value as Naming)}>
                  {(Object.keys(NAMING_LABELS) as Naming[]).map((k) => <option key={k} value={k}>{NAMING_LABELS[k]}</option>)}
                </select>
              </label>
              {counts.updates > 0 && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={movePositions} onChange={(e) => setMovePositions(e.target.checked)} />
                  Mover también los {counts.updates} nodos que ya existen a la ubicación del archivo
                </label>
              )}
            </div>
          </>
        )}
        <div className="flex gap-2 justify-end">
          <button className="btn" onClick={p.onClose}>Cancelar</button>
          <button className="btn btn-active" disabled={!chosen.length || !model} onClick={apply}>
            {!chosen.length ? 'Agregar' : counts.updates ? `Agregar ${chosen.length - counts.updates} y actualizar ${counts.updates}` : `Agregar ${chosen.length} al proyecto`}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Small satellite map with the rows (green ready, amber to check, grey left out) and plots. */
function PreviewMap({ rows, excluded, focusKey }: { rows: ImportRow[]; excluded: Set<string>; focusKey: string | null }) {
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const ready = useRef(false)
  const fitted = useRef('')

  const data = () => ({
    devices: {
      type: 'FeatureCollection' as const,
      features: rows.filter(valid).map((r) => ({
        type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [r.lon, r.lat] },
        properties: {
          kind: 'node', icon: 'icon-cellular', label: r.folio ?? r.owner ?? '', selected: r.key === focusKey, focus: false, dim: false,
          color: excluded.has(r.key) ? COLORS.none : r.issues.length ? COLORS.marginal : COLORS.viable,
        },
      })),
    },
    plots: {
      type: 'FeatureCollection' as const,
      features: rows.filter((r) => r.plot).map((r) => ({
        type: 'Feature' as const, geometry: r.plot!.geometry, properties: { id: r.plot!.id, focus: r.key === focusKey, dim: false },
      })),
    },
  })

  const update = () => {
    const m = map.current
    if (!m || !ready.current) return
    const d = data()
    ;(m.getSource('devices') as GeoJSONSource).setData(d.devices)
    ;(m.getSource('plots') as GeoJSONSource).setData(d.plots)
    const sig = rows.map((r) => r.key).join()
    const pts = rows.filter(valid)
    if (pts.length && fitted.current !== sig) {
      fitted.current = sig
      const lons = pts.map((r) => r.lon), lats = pts.map((r) => r.lat)
      m.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 30, maxZoom: 16, duration: 0 })
    }
    const f = rows.find((r) => r.key === focusKey)
    if (f && valid(f)) m.flyTo({ center: [f.lon, f.lat], zoom: Math.max(m.getZoom(), 15) })
  }

  useEffect(() => {
    ensurePmtiles()
    const m = new maplibregl.Map({ container: el.current!, style: buildStyle(), locale: MAP_LOCALE, attributionControl: { compact: true } })
    registerDeviceIcons(m)
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.current = m
    m.on('load', () => { ready.current = true; update() })
    return () => m.remove()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(update, [rows, excluded, focusKey])

  return <div ref={el} className="import-map" style={{ position: 'relative' }} data-testid="import-map" />
}
