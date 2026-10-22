import { useCallback, useEffect, useMemo, useReducer, useState } from 'react'
import { api, ApiError } from './api'
import DevicePanel from './DevicePanel'
import MapView, { type MapMode } from './MapView'
import { emptyProject, isCellular, PROJECT_VERSION, reduce, rename, selected, type Action } from './project'
import Sidebar from './Sidebar'
import type { Catalog, CellStatus, LinkResult, Project, Selection } from './types'

const STORAGE_KEY = 'verea.project'     // local copy until projects live in the cloud (phase 3)
const RECALC_DELAY_MS = 400

function loadLocal(): Project | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Project) : null
  } catch {
    return null
  }
}

function saveLocal(p: Project) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
  } catch {
    /* private mode or full: the project still works in memory */
  }
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export default function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    api.catalog().then(setCatalog).catch((e) =>
      setError(e instanceof ApiError ? `${e.status}: ${e.message}` : 'Cannot reach the Verea server'))
  }, [])
  if (error) return <div className="p-6 text-red-600">⚠ {error}</div>
  if (!catalog) return <div className="p-6">Loading…</div>
  return <Workspace catalog={catalog} />
}

function Workspace({ catalog }: { catalog: Catalog }) {
  const [project, dispatchRaw] = useReducer(reduce, null, () => loadLocal() ?? emptyProject(catalog.defaults))
  const [selection, setSelection] = useState<Selection>(null)
  const [mode, setMode] = useState<MapMode>('select')
  const [addModel, setAddModel] = useState('')
  const [showCoverage, setShowCoverage] = useState(false)
  const [focus, setFocus] = useState<{ lat: number; lon: number; zoom?: number; key: number } | null>(null)
  const [links, setLinks] = useState<Record<string, LinkResult>>({})
  const [cells, setCells] = useState<Record<string, CellStatus>>({})
  const [status, setStatus] = useState('')
  const dispatch = useCallback((a: Action) => dispatchRaw(a), [])

  useEffect(() => saveLocal(project), [project])

  const cellular = useMemo(
    () => new Set(project.nodes.filter((n) => isCellular(catalog, n)).map((n) => n.name)),
    [project.nodes, catalog])

  // ── LoRa links: recalculated shortly after any change that affects them ──
  const loraNodes = useMemo(() => project.nodes.filter((n) => !cellular.has(n.name)), [project.nodes, cellular])
  const { cell_operator, ...rf } = project.settings
  const linkInput = useDebounced(JSON.stringify([project.gateways, loraNodes, rf]), RECALC_DELAY_MS)
  useEffect(() => {
    const [gateways, nodes, settings] = JSON.parse(linkInput)
    if (!nodes.length) {
      setLinks({})
      return
    }
    const ctrl = new AbortController()
    setStatus('Calculating links…')
    api.links(gateways, nodes, settings, ctrl.signal)
      .then((r) => {
        setLinks(r.results)
        setStatus(`Links up to date · terrain: ${r.elevation}`)
      })
      .catch((e) => { if (e.name !== 'AbortError') setStatus(`⚠ Link calculation failed: ${e.message}`) })
    return () => ctrl.abort()
  }, [linkInput])

  // ── 4G sensors ──
  const cellInput = useDebounced(JSON.stringify([cell_operator ?? null,
    project.nodes.filter((n) => cellular.has(n.name)).map((n) => ({ name: n.name, lat: n.lat, lon: n.lon }))]),
  RECALC_DELAY_MS)
  useEffect(() => {
    const [operator, points] = JSON.parse(cellInput)
    if (!operator || !points.length) {
      setCells({})
      return
    }
    const ctrl = new AbortController()
    api.cellStatus(operator, points, ctrl.signal)
      .then((r) => setCells(Object.fromEntries(r.points.map((c) => [c.name ?? '', c]))))
      .catch((e) => { if (e.name !== 'AbortError') setStatus(`⚠ 4G check failed: ${e.message}`) })
    return () => ctrl.abort()
  }, [cellInput])

  // Esc leaves the add mode
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMode('select') }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const select = (s: Selection, fly = false) => {
    setSelection(s)
    const d = selected(project, s)
    if (fly && d) setFocus({ lat: d.lat, lon: d.lon, key: Date.now() })
  }

  const add = (lat: number, lon: number) => {
    if (mode === 'addGateway') {
      const next = reduce(project, { type: 'addGateway', lat, lon, catalog })
      dispatch({ type: 'load', project: next })
      setSelection({ kind: 'gateway', name: next.gateways[next.gateways.length - 1].name })
    } else if (mode === 'addNode') {
      const next = reduce(project, { type: 'addNode', lat, lon, model: addModel, catalog })
      dispatch({ type: 'load', project: next })
      setSelection({ kind: 'node', name: next.nodes[next.nodes.length - 1].name })
    }
    setMode('select')
  }

  const importFile = async (file: File) => {
    try {
      const raw = JSON.parse(await file.text())
      const p = await api.normalize(raw)
      dispatch({ type: 'load', project: { ...p, version: PROJECT_VERSION, settings: { ...catalog.defaults, ...p.settings } } })
      setSelection(null)
      const first = p.gateways[0] ?? p.nodes[0]
      if (first) setFocus({ lat: first.lat, lon: first.lon, zoom: 14, key: Date.now() })
      setStatus(`Opened ${file.name}`)
    } catch (e) {
      setStatus(`⚠ Could not open ${file.name}: ${e instanceof Error ? e.message : e}`)
    }
  }

  const exportFile = () => {
    const blob = new Blob([JSON.stringify({ ...project, saved_at: new Date().toISOString() }, null, 1)],
      { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${(project.name.trim() || 'verea_project').replace(/[^\w-]+/g, '_').slice(0, 60)}.verea.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const dev = selected(project, selection)
  return (
    <div className="app">
      <Sidebar catalog={catalog} project={project} selection={selection} links={links} cells={cells}
        mode={mode} addModel={addModel} showCoverage={showCoverage} status={status}
        onMode={(m, model) => { setMode(m); if (model) setAddModel(model) }}
        onSettings={(patch) => dispatch({ type: 'settings', patch })}
        onMeta={(name) => dispatch({ type: 'meta', name })}
        onSelect={select} onShowCoverage={setShowCoverage}
        onImport={importFile} onExport={exportFile}
        onNew={() => {
          if (!confirm('Start a new empty project? Save the current one to a file first if you need it.')) return
          dispatch({ type: 'load', project: emptyProject(catalog.defaults) })
          setSelection(null)
        }} />
      <main className="map-area">
        <MapView project={project} selection={selection} links={links} cells={cells} cellular={cellular}
          mode={mode} showCoverage={showCoverage} focus={focus}
          onSelect={(s) => setSelection(s)}
          onMove={(kind, name, lat, lon) => dispatch({ type: 'move', kind, name, lat, lon })}
          onAdd={add} />
        {mode !== 'select' && (
          <div className="mode-banner">Click the map to place the {mode === 'addGateway' ? 'gateway' : 'node'} · Esc to cancel</div>
        )}
      </main>
      {dev && selection && (
        <DevicePanel key={`${selection.kind}:${selection.name}`} catalog={catalog} project={project}
          kind={selection.kind} device={dev} link={links[dev.name]} cell={cells[dev.name]}
          onRename={(next) => {
            dispatch({ type: 'load', project: rename(project, selection.kind, dev.name, next) })
            setSelection({ kind: selection.kind, name: next.trim() })
          }}
          onPatch={(patch) => dispatch(selection.kind === 'gateway'
            ? { type: 'updateGateway', name: dev.name, patch }
            : { type: 'updateNode', name: dev.name, patch })}
          onRemove={() => { dispatch({ type: 'remove', kind: selection.kind, name: dev.name }); setSelection(null) }}
          onClose={() => setSelection(null)} />
      )}
    </div>
  )
}
