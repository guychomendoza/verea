import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import type { Session } from '@supabase/supabase-js'
import { api, ApiError, setToken } from './api'
import * as cloud from './cloud'
import { COLORS } from './colors'
import DevicePanel from './DevicePanel'
import { Login, Notice, SetPassword } from './Login'
import ProjectsDialog from './ProjectsDialog'
import { downloadBlob, mapToPng, safeName, type LegendItem } from './exportImage'
import MapView, { type MapMode } from './MapView'
import { emptyProject, isCellular, PROJECT_VERSION, reduce, rename, selected, type Action } from './project'
import SearchBox from './SearchBox'
import Sidebar from './Sidebar'
import type { Catalog, CellStatus, LinkResult, Project, Selection } from './types'

const STORAGE_KEY = 'verea.project'     // local mode (no Supabase configured)
const LAST_PROJECT_KEY = 'verea.lastProject'
const RECALC_DELAY_MS = 400
const SAVE_DELAY_MS = 1500

function loadLocal(): Project | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Project) : null
  } catch {
    return null
  }
}

function store(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* private mode or full: the project still works in memory */
  }
}

function recall(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
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
  if (!cloud.cloudEnabled) {
    if (error) return <div className="p-6 text-red-600">⚠ {error}</div>
    if (!catalog) return <div className="p-6">Loading…</div>
    return <Workspace catalog={catalog} />
  }
  return <CloudGate catalog={catalog} error={error} onSession={() => {
    setError('')
    api.catalog().then(setCatalog).catch((e) => setError(e instanceof ApiError ? `${e.status}: ${e.message}` : 'Cannot reach the Verea server'))
  }} />
}

/** Login, password setup and membership check before the workspace (cloud mode). */
function CloudGate({ catalog, error, onSession }: { catalog: Catalog | null; error: string; onSession: () => void }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [me, setMe] = useState<cloud.Me | null | undefined>(undefined)
  const [mustSetPassword, setMustSetPassword] = useState(cloud.arrivedToSetPassword)

  useEffect(() => {
    const sb = cloud.supabase!
    sb.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = sb.auth.onAuthStateChange((event, s) => {
      if (event === 'PASSWORD_RECOVERY') setMustSetPassword(true)
      setSession(s)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  // The API takes the same session token
  const token = session?.access_token ?? null
  useEffect(() => {
    setToken(token)
    if (token) onSession()
  }, [token]) // eslint-disable-line react-hooks/exhaustive-deps

  const uid = session?.user.id
  useEffect(() => {
    setMe(undefined)
    if (session) cloud.me(session).then(setMe).catch(() => setMe(null))
  }, [uid]) // eslint-disable-line react-hooks/exhaustive-deps

  const signOut = () => { cloud.supabase!.auth.signOut(); store(LAST_PROJECT_KEY, null) }

  if (session === undefined) return <div className="p-6">Loading…</div>
  if (!session) return <Login />
  if (mustSetPassword) return <SetPassword email={session.user.email ?? ''} onDone={() => setMustSetPassword(false)} />
  if (me === undefined) return <div className="p-6">Loading…</div>
  if (me === null) {
    return (
      <Notice title="This account is not active">
        <p className="hint">Ask your team admin to (re)activate {session.user.email}.</p>
        <button className="btn" onClick={signOut}>Sign out</button>
      </Notice>
    )
  }
  if (error) return <div className="p-6 text-red-600">⚠ {error}</div>
  if (!catalog) return <div className="p-6">Loading…</div>
  return <Workspace catalog={catalog} user={{ me, signOut }} />
}

interface CloudDoc {
  id: string
  updated_at: string
  owner_id: string
}

type SaveState = 'saved' | 'saving' | 'pending' | 'conflict' | 'error'

function Workspace({ catalog, user }: { catalog: Catalog; user?: { me: cloud.Me; signOut: () => void } }) {
  const cloudMode = !!user
  const [project, dispatchRaw] = useReducer(reduce, null, () =>
    (cloudMode ? null : loadLocal()) ?? emptyProject(catalog.defaults))
  const [selection, setSelection] = useState<Selection>(null)
  const [mode, setMode] = useState<MapMode>('select')
  const [addModel, setAddModel] = useState('')
  const [showCoverage, setShowCoverage] = useState(false)
  const [showLabels, setShowLabels] = useState(true)
  const [pin, setPin] = useState<{ lat: number; lon: number } | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const [focus, setFocus] = useState<{ lat: number; lon: number; zoom?: number; key: number } | null>(null)
  const [links, setLinks] = useState<Record<string, LinkResult>>({})
  const [cells, setCells] = useState<Record<string, CellStatus>>({})
  const [status, setStatus] = useState('')
  const dispatch = useCallback((a: Action) => dispatchRaw(a), [])

  // ── persistence: browser (local mode) or cloud with optimistic locking ──
  const [doc, setDoc] = useState<CloudDoc | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [saveError, setSaveError] = useState('')
  const [showProjects, setShowProjects] = useState(false)
  const savedRef = useRef<Project | null>(null)       // the project as last loaded / saved

  useEffect(() => { if (!cloudMode) store(STORAGE_KEY, JSON.stringify(project)) }, [project, cloudMode])

  const openDoc = useCallback((p: Project, d: CloudDoc) => {
    savedRef.current = p
    dispatch({ type: 'load', project: p })
    setDoc(d)
    setSaveState('saved')
    setSelection(null)
    store(LAST_PROJECT_KEY, d.id)
    const first = p.gateways[0] ?? p.nodes[0]
    if (first) setFocus({ lat: first.lat, lon: first.lon, zoom: 14, key: Date.now() })
  }, [dispatch])

  const openCloud = useCallback(async (id: string) => {
    const r = await cloud.loadProject(id)
    const p = { ...r.project, settings: { ...catalog.defaults, ...r.project.settings } }
    openDoc(p, { id, updated_at: r.updated_at, owner_id: r.owner_id })
  }, [catalog, openDoc])

  const createCloud = useCallback(async (p: Project) => {
    const r = await cloud.createProject(p)
    openDoc(p, r)
  }, [openDoc])

  // First open: the last project, else the most recent, else a new one
  useEffect(() => {
    if (!cloudMode) return
    (async () => {
      const last = recall(LAST_PROJECT_KEY)
      try {
        if (last) return await openCloud(last)
      } catch { /* deleted or not reachable: fall through */ }
      const rows = await cloud.listProjects()
      if (rows.length) await openCloud(rows[0].id)
      else await createCloud(emptyProject(catalog.defaults))
    })().catch((e) => { setSaveState('error'); setSaveError(e.message) })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Autosave shortly after the last change
  useEffect(() => {
    if (!cloudMode || !doc || project === savedRef.current || saveState === 'conflict') return
    setSaveState('pending')
    const t = setTimeout(async () => {
      setSaveState('saving')
      try {
        const updated = await cloud.saveProject(doc.id, project, doc.updated_at)
        if (updated === null) {
          setSaveState('conflict')
          return
        }
        savedRef.current = project
        setDoc({ ...doc, updated_at: updated })
        setSaveState('saved')
      } catch (e) {
        setSaveState('error')
        setSaveError(e instanceof Error ? e.message : String(e))
      }
    }, SAVE_DELAY_MS)
    return () => clearTimeout(t)
  }, [project, doc, cloudMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // Warn before leaving with changes not yet in the cloud
  useEffect(() => {
    const unsaved = cloudMode && saveState !== 'saved'
    const onLeave = (e: BeforeUnloadEvent) => { if (unsaved) e.preventDefault() }
    window.addEventListener('beforeunload', onLeave)
    return () => window.removeEventListener('beforeunload', onLeave)
  }, [cloudMode, saveState])

  const saveText = !cloudMode ? '' : {
    saved: '☁ Saved', saving: '☁ Saving…', pending: '☁ Unsaved changes…',
    conflict: '⚠ Not saved: changed by someone else', error: `⚠ Not saved: ${saveError}`,
  }[saveState]

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
      const n = await api.normalize(raw)
      const p: Project = { ...n, version: PROJECT_VERSION, settings: { ...catalog.defaults, ...n.settings } }
      if (cloudMode) {
        await createCloud(p)             // an imported file becomes a new cloud project
      } else {
        dispatch({ type: 'load', project: p })
        setSelection(null)
        const first = p.gateways[0] ?? p.nodes[0]
        if (first) setFocus({ lat: first.lat, lon: first.lon, zoom: 14, key: Date.now() })
      }
      setStatus(`Opened ${file.name}`)
    } catch (e) {
      setStatus(`⚠ Could not open ${file.name}: ${e instanceof Error ? e.message : e}`)
    }
  }

  const exportMap = async () => {
    const map = mapRef.current
    if (!map) return
    const legend: LegendItem[] = []
    if (project.gateways.length) legend.push({ color: COLORS.gateway, label: 'Gateway' })
    if (Object.keys(links).length) {
      legend.push({ color: COLORS.viable, label: 'Viable link', line: true },
        { color: COLORS.marginal, label: 'Marginal', line: true },
        { color: COLORS.fail, label: 'Not viable', line: true })
    }
    if (showCoverage) {
      legend.push({ color: COLORS.cellOk, label: '4G guaranteed' },
        { color: COLORS.cellEdge, label: '4G uncertain (near a gap)' },
        { color: COLORS.cellNone, label: 'No 4G declared' })
    }
    const center = map.getCenter()
    try {
      const blob = await mapToPng(map.getCanvas(), {
        title: project.name.trim() || 'Verea project',
        subtitle: `${new Date().toLocaleString()} · centre ${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}`,
        legend,
        attribution: 'Imagery and labels © Esri' + (showCoverage ? ' · 4G coverage: CRT / datos.gob.mx (CC BY 4.0)' : ''),
      })
      downloadBlob(blob, `${safeName(project.name)}_map.png`)
    } catch (e) {
      setStatus(`⚠ Could not create the map image: ${e instanceof Error ? e.message : e}`)
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
        mode={mode} addModel={addModel} showCoverage={showCoverage}
        status={[saveText, status].filter(Boolean).join(' · ')}
        user={user ? { name: user.me.full_name || user.me.email, onSignOut: user.signOut,
          onProjects: () => setShowProjects(true) } : undefined}
        onMode={(m, model) => { setMode(m); if (model) setAddModel(model) }}
        onSettings={(patch) => dispatch({ type: 'settings', patch })}
        onMeta={(name) => dispatch({ type: 'meta', name })}
        onSelect={select} onShowCoverage={setShowCoverage}
        showLabels={showLabels} onShowLabels={setShowLabels}
        onImport={importFile} onExport={exportFile}
        onNew={() => {
          if (cloudMode) {
            createCloud(emptyProject(catalog.defaults)).catch((e) => setStatus(`⚠ ${e.message}`))
            return
          }
          if (!confirm('Start a new empty project? Save the current one to a file first if you need it.')) return
          dispatch({ type: 'load', project: emptyProject(catalog.defaults) })
          setSelection(null)
        }} />
      <main className="map-area">
        <MapView project={project} selection={selection} links={links} cells={cells} cellular={cellular}
          mode={mode} showCoverage={showCoverage} showLabels={showLabels} pin={pin} focus={focus}
          onReady={(m) => { mapRef.current = m }}
          onSelect={(s) => setSelection(s)}
          onMove={(kind, name, lat, lon) => dispatch({ type: 'move', kind, name, lat, lon })}
          onAdd={add} />
        <div className="map-tools">
          <SearchBox onPick={(pl) => {
            setPin({ lat: pl.lat, lon: pl.lon })
            setFocus({ lat: pl.lat, lon: pl.lon, zoom: pl.kind === 'coordinates' ? 16 : 14, key: Date.now() })
          }} />
          <button className="btn map-btn" onClick={exportMap} title="Download the map as a PNG image">📷 Map image</button>
        </div>
        {saveState === 'conflict' && doc && (
          <div className="conflict-banner" role="alert">
            Someone else saved this project after you opened it. Your latest changes are not saved.
            <div className="flex gap-2 mt-2">
              <button className="btn" onClick={() => openCloud(doc.id)}>Load their version</button>
              <button className="btn btn-active" onClick={() =>
                createCloud({ ...project, name: `${project.name || 'Untitled'} (my copy)` })}>
                Save mine as a copy
              </button>
            </div>
          </div>
        )}
        {mode !== 'select' && (
          <div className="mode-banner">Click the map to place the {mode === 'addGateway' ? 'gateway' : 'node'} · Esc to cancel</div>
        )}
      </main>
      {showProjects && user && (
        <ProjectsDialog me={user.me} currentId={doc?.id ?? null}
          onOpen={(id) => { setShowProjects(false); openCloud(id).catch((e) => setStatus(`⚠ ${e.message}`)) }}
          onDeleted={(id) => {
            if (id === doc?.id) {
              setDoc(null)
              store(LAST_PROJECT_KEY, null)
              createCloud(emptyProject(catalog.defaults)).catch((e) => setStatus(`⚠ ${e.message}`))
            }
          }}
          onClose={() => setShowProjects(false)} />
      )}
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
