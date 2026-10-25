import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from 'react-resizable-panels'
import type { Session } from '@supabase/supabase-js'
import { api, ApiError, setToken } from './api'
import * as cloud from './cloud'
import DevicePanel from './DevicePanel'
import { downloadBlob, mapToPng, safeName, type LegendItem } from './exportImage'
import { db, distance, haversine } from './geo'
import { COLORS } from './colors'
import { cellColor, cellShort, linkColor } from './mapStyle'
import { mapLegend as buildLegend } from './legend'
import { Login, Notice, SetPassword } from './Login'
import MapView, { type Focus, type MapMode } from './MapView'
import ProfilePanel from './ProfilePanel'
import { profileTitle } from './profilePlot'
import { emptyProject, isCellular, isStation, PROJECT_VERSION, reduce, rename, selected, reduceHistory, type HistoryAction } from './project'
import MyFiles from './MyFiles'
import SettingsDialog from './SettingsDialog'
import ProjectsDialog from './ProjectsDialog'
import ShareDialog from './ShareDialog'
import UsersDialog from './UsersDialog'
import { clearPendingShare, pendingShare, shareUrl } from './share'
import { applyOverrides, changeCount, overridesOf, viewerAllows, type Overrides } from './viewer'
import BulkModelDialog from './BulkModelDialog'
import { networkCounts } from './counts'
import NetworkCounter from './NetworkCounter'
import SuggestGatewaysDialog from './SuggestGatewaysDialog'
import ImportDialog from './import/ImportDialog'
import ReportDialog from './report/ReportDialog'
import SearchBox from './SearchBox'
import { shortcutFor } from './shortcuts'
import { clearDraft, loadDraft, saveDraft, useAutosave, type Draft, type SaveState } from './autosave'
import { cleanAuthHash, fieldFromPath, projectFromPath, showProject } from './route'
import FieldMode from './FieldMode'
import { queued, withFieldTests, type FieldTest } from './fieldTests'
import Sidebar from './Sidebar'
import { DeviceHead, PanelButton, PhoneSheet, ProjectHead } from './Phone'
import { CellResult } from './DevicePanel'
import type { Catalog, CellStatus, Gateway, LinkDetail, LinkResult, NodeDevice, Project, Radial, Selection } from './types'
import { Alert, Icon } from './icons'
import { LoadingScreen } from './Loading'

const STORAGE_KEY = 'verea.project'     // local mode (no Supabase configured)
const LAST_PROJECT_KEY = 'verea.lastProject'
const VIEWER_FILE_KEY = 'verea.viewerFile'
const EDIT_KEY = 'verea.editing'          // Ver / Editar, remembered per browser
const OVERRIDES_DELAY_MS = 1000
const RECALC_DELAY_MS = 400
const SAVE_DELAY_MS = 1500                 // autosave (opt-in) after the last change
const DRAFT_DELAY_MS = 800                 // browser draft of unsaved edits
const SHORTCUT_NODE_MODEL = 'dragino_lse01'
const NARROW_PX = 900
const TOUCH = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches

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

/**
 * Border between panels: drag it to resize; near it, an arrow appears to close the panel on
 * that side (or, once closed, to open it again).
 */
function Edge({ axis, side, collapsed, name, onToggle }: {
  axis: 'x' | 'y'; side: 'left' | 'right' | 'bottom'; collapsed: boolean; name: string; onToggle: () => void
}) {
  const arrow = { left: collapsed ? '›' : '‹', right: collapsed ? '‹' : '›', bottom: collapsed ? '⌃' : '⌄' }[side]
  const text = collapsed ? `Abrir ${name}` : `Cerrar ${name}`
  return (
    <PanelResizeHandle className={`resize-handle resize-${axis} edge-${side}`}>
      <button type="button" className="edge-toggle" title={text} aria-label={text} aria-expanded={!collapsed}
        onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onToggle() }}>
        {arrow}
      </button>
    </PanelResizeHandle>
  )
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW_PX)
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < NARROW_PX)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return narrow
}

const apiError = (e: unknown) => (e instanceof ApiError ? `${e.status}: ${e.message}` : 'No se puede conectar con el servidor de Verea')

export default function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [error, setError] = useState('')
  // Cloud mode asks only once logged in (CloudGate): a request without the session token
  // would answer 401, and could arrive after the good one and leave the error on screen
  useEffect(() => {
    if (!cloud.cloudEnabled) api.catalog().then(setCatalog).catch((e) => setError(apiError(e)))
  }, [])
  if (!cloud.cloudEnabled) {
    if (error) return <div className="p-6"><Alert>{error}</Alert></div>
    if (!catalog) return <LoadingScreen />
    return <Workspace catalog={catalog} />
  }
  return <CloudGate catalog={catalog} error={error} onSession={() => {
    setError('')
    api.catalog().then((c) => { setCatalog(c); setError('') }).catch((e) => setError(apiError(e)))
  }} />
}

/**
 * Login, password setup, the shared link being opened, then the team's workspace or, for a
 * viewer, their files and the project they open (cloud mode).
 */
function CloudGate({ catalog, error, onSession }: { catalog: Catalog | null; error: string; onSession: () => void }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [me, setMe] = useState<cloud.Me | null | undefined>(undefined)
  const [mustSetPassword, setMustSetPassword] = useState(cloud.arrivedToSetPassword)
  const [claiming, setClaiming] = useState(() => pendingShare() !== null)
  const [notice, setNotice] = useState('')
  const [file, setFile] = useState<string | null>(() => recall(VIEWER_FILE_KEY))
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [usersOpen, setUsersOpen] = useState(false)

  useEffect(() => {
    const sb = cloud.supabase!
    sb.auth.getSession().then(({ data }) => { setSession(data.session); cleanAuthHash() })
    const { data } = sb.auth.onAuthStateChange((event, s) => {
      if (event === 'PASSWORD_RECOVERY') setMustSetPassword(true)
      setSession(s)
      cleanAuthHash()
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

  // A shared link opened before signing in: its project opens now
  useEffect(() => {
    const share = pendingShare()
    if (!me || !me.active || !share) return
    cloud.claimShare(share)
      .then((id) => {
        if (cloud.isTeam(me)) store(LAST_PROJECT_KEY, id)
        else openFile(id)
      })
      .catch((e) => setNotice(/revocado|no existe/.test(e.message) ? 'Ese link ya no es válido: pide uno nuevo a quien te lo compartió.' : e.message))
      .finally(() => { clearPendingShare(); setClaiming(false) })
  }, [me?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const openFile = (id: string | null) => {
    store(VIEWER_FILE_KEY, id)
    setFile(id)
  }
  const signOut = () => {
    cloud.supabase!.auth.signOut()
    store(LAST_PROJECT_KEY, null)
    store(VIEWER_FILE_KEY, null)
    setSettingsOpen(false)
  }

  if (session === undefined) return <LoadingScreen />
  if (!session) return <Login />
  // an invitation / reset link, or an account an admin created with a temporary password
  if (mustSetPassword || session.user.user_metadata?.must_change_password) {
    return <SetPassword email={session.user.email ?? ''} onDone={() => setMustSetPassword(false)} />
  }
  if (me === undefined) return <LoadingScreen />
  if (me === null || !me.active) {
    return (
      <Notice title="Esta cuenta no está activa">
        <p className="hint">Pide al administrador de Verea que (re)active {session.user.email}.</p>
        <button className="btn" onClick={signOut}>Cerrar sesión</button>
      </Notice>
    )
  }
  if (claiming) return <LoadingScreen text="Abriendo el proyecto compartido…" />
  const dialogs = (
    <>
      {settingsOpen && (
        <SettingsDialog onClose={() => setSettingsOpen(false)} account={{
          me, onSignOut: signOut,
          onSave: async (patch) => { await cloud.updateMe(me.id, patch); setMe({ ...me, ...patch }) },
          onDelete: async () => { await cloud.deleteMyAccount(); signOut() },
          onUsers: me.role === 'admin' ? () => { setSettingsOpen(false); setUsersOpen(true) } : undefined,
        }} />
      )}
      {usersOpen && <UsersDialog me={me} onClose={() => setUsersOpen(false)} />}
    </>
  )
  const user = { me, signOut, onSettings: () => setSettingsOpen(true) }
  let content: React.ReactNode
  if (!cloud.isTeam(me) && !file) {
    content = <MyFiles me={me} notice={notice} onOpen={openFile} onSettings={user.onSettings} />
  } else if (error) {
    content = <div className="p-6"><Alert>{error}</Alert></div>
  } else if (!catalog) {
    content = <LoadingScreen />
  } else if (!cloud.isTeam(me)) {
    content = <ViewerLoader key={file} id={file!} catalog={catalog} user={user}
      onFiles={(msg) => { setNotice(msg ?? ''); openFile(null) }} />
  } else if (fieldFromPath()) {
    // the team's 4G field tests; leaving goes back to the editor on that project
    content = <FieldMode catalog={catalog} projectId={fieldFromPath()!.project} me={me}
      onExit={(id) => window.location.assign(id ? `/p/${id}` : '/')} />
  } else {
    content = <Workspace catalog={catalog} user={user} />
  }
  return <>{content}{dialogs}</>
}

type User = { me: cloud.Me; signOut: () => void; onSettings: () => void }

/** A viewer's project: loaded with their own changes, then the read-only workspace. */
function ViewerLoader({ id, catalog, user, onFiles }: { id: string; catalog: Catalog; user: User; onFiles: (msg?: string) => void }) {
  const [doc, setDoc] = useState<ViewerDoc | null>(null)
  useEffect(() => {
    cloud.viewerProject(id)
      .then((r) => setDoc({ id, token: r.token, overrides: r.overrides ?? {},
        base: { ...r.data, name: r.name, settings: { ...catalog.defaults, ...r.data.settings } } }))
      .catch(() => onFiles('Ya no tienes acceso a ese proyecto.'))
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!doc) return <LoadingScreen text="Abriendo el proyecto…" />
  return <Workspace catalog={catalog} user={user} viewer={{ ...doc, onFiles: () => onFiles() }} />
}

interface ViewerDoc {
  id: string
  base: Project                        // the team's project, as shared
  overrides: Overrides                 // the viewer's own changes on it
  token: string | null                 // the link they came by (for the PDF)
}

interface CloudDoc {
  id: string
  updated_at: string
  owner_id: string
}

function Workspace({ catalog, user, viewer }: {
  catalog: Catalog; user?: User; viewer?: ViewerDoc & { onFiles: () => void }
}) {
  const cloudMode = !!user
  const teamCloud = cloudMode && !viewer          // the team's projects table (viewers keep only their changes)
  const narrow = useNarrow()
  const [phonePanel, setPhonePanel] = useState(false)          // phones: the project panel, full screen
  const [phoneDetail, setPhoneDetail] = useState(false)        // phones: the picked device's detail
  const envKeys = Object.keys(catalog.environments)
  const [history, dispatchRaw] = useReducer(reduceHistory, null, () =>
    ({ present: viewer ? applyOverrides(viewer.base, viewer.overrides, envKeys)
      : (cloudMode ? null : loadLocal()) ?? emptyProject(catalog.defaults), past: [], future: [] }))
  const project = history.present
  const [selection, setSelection] = useState<Selection>(null)
  useEffect(() => { if (!selection) setPhoneDetail(false) }, [selection])
  const [mode, setMode] = useState<MapMode>('select')
  const [addModel, setAddModel] = useState('')
  const [showCoverage, setShowCoverage] = useState(false)
  const [showLabels, setShowLabels] = useState(true)
  const [pin, setPin] = useState<{ lat: number; lon: number } | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const [focus, setFocus] = useState<Focus | null>(null)
  /** Fit the view to every device of a project (on open and after an import). */
  const showAll = useCallback((p: Project) => {
    const pts = [...p.gateways, ...p.nodes]
    if (!pts.length) return
    const lons = pts.map((d) => d.lon), lats = pts.map((d) => d.lat)
    setFocus({ lat: lats[0], lon: lons[0], key: Date.now(),
      bounds: [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]] })
  }, [])
  const [links, setLinks] = useState<Record<string, LinkResult>>({})
  const [rawCells, setCells] = useState<Record<string, CellStatus>>({})   // as the map predicts them
  const [fieldTests, setFieldTests] = useState<FieldTest[]>([])           // the team's 4G field tests
  const [status, setStatus] = useState('')
  const [ruler, setRuler] = useState<[number, number][]>([])
  const [showReport, setShowReport] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [suggest, setSuggest] = useState(false)
  const [bulk, setBulk] = useState<{ groups: string[]; model?: string } | null>(null)
  // Gateway range on the map: radials per gateway, kept while the gateway and settings stay the same
  const [ranges, setRanges] = useState<Record<string, { radials: Radial[]; sig: string }>>({})
  const [rangeLoading, setRangeLoading] = useState<Set<string>>(new Set())
  // Ver / Editar: in Ver nothing can be moved or changed by accident (phones start in Ver)
  const [editing, setEditingRaw] = useState(() => { const v = recall(EDIT_KEY); return v ? v === '1' : window.innerWidth >= NARROW_PX })
  const locked = !viewer && !editing
  const setEditing = (on: boolean) => {
    store(EDIT_KEY, on ? '1' : '0')
    setEditingRaw(on)
    if (!on) setMode('select')
  }
  // A viewer may only change heights / environments; in Ver only another project may be opened
  const dispatch = useCallback((a: HistoryAction) => {
    if (viewer ? viewerAllows(a) : editing || a.type === 'open') dispatchRaw(a)
  }, [viewer, editing])
  const [showShare, setShowShare] = useState(false)
  const [localSettings, setLocalSettings] = useState(false)     // local mode: appearance only

  // ── persistence: browser (local mode) or cloud with optimistic locking ──
  const [doc, setDoc] = useState<CloudDoc | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [saveError, setSaveError] = useState('')
  const [showProjects, setShowProjects] = useState(false)
  const savedRef = useRef<Project | null>(null)       // the project as last loaded / saved
  const savingRef = useRef(false)
  const autosave = useAutosave()
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  const [recover, setRecover] = useState<Draft | null>(null)       // unsaved edits from an earlier session
  const [leaving, setLeaving] = useState<{ next: () => void; cancel?: () => void } | null>(null)   // "unsaved changes" dialog

  useEffect(() => { if (!cloudMode) store(STORAGE_KEY, JSON.stringify(project)) }, [project, cloudMode])

  const openDoc = useCallback((p: Project, d: CloudDoc) => {
    savedRef.current = p
    dispatch({ type: 'open', project: p })
    setDoc(d)
    setSaveState('saved')
    setSavedAt(new Date(d.updated_at))
    setRecover(null)
    setSelection(null)
    store(LAST_PROJECT_KEY, d.id)
    showProject(d.id)
    showAll(p)
  }, [dispatch, showAll])

  const openCloud = useCallback(async (id: string) => {
    const r = await cloud.loadProject(id)
    const p = { ...r.project, settings: { ...catalog.defaults, ...r.project.settings } }
    openDoc(p, { id, updated_at: r.updated_at, owner_id: r.owner_id })
    const draft = loadDraft(id)
    if (draft && JSON.stringify(draft.project) !== JSON.stringify(p)) setRecover(draft)
    else if (draft) clearDraft(id)
  }, [catalog, openDoc])

  const createCloud = useCallback(async (p: Project) => {
    const r = await cloud.createProject(p)
    openDoc(p, r)
  }, [openDoc])

  // First open: the last project, else the most recent, else a new one (once: React's
  // development mode runs effects twice, which would create two empty projects)
  const startedRef = useRef(false)
  useEffect(() => { if (viewer) showAll(project) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!teamCloud || startedRef.current) return
    startedRef.current = true
    ;(async () => {
      const last = projectFromPath() ?? recall(LAST_PROJECT_KEY)     // the address first (/p/<id>)
      try {
        if (last) return await openCloud(last)
      } catch { /* deleted or not reachable: fall through */ }
      const rows = await cloud.listProjects()
      if (rows.length) await openCloud(rows[0].id)
      else await createCloud(emptyProject(catalog.defaults))
    })().catch((e) => { setSaveState('error'); setSaveError(e.message) })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /** Save the current project to the cloud now (Guardar, Ctrl+S, autosave); true when it is saved. */
  const projectRef = useRef(project)
  projectRef.current = project
  const docRef = useRef(doc)
  docRef.current = doc
  const saveNow = useCallback(async (): Promise<boolean> => {
    const d = docRef.current
    const p = projectRef.current
    if (!d || savingRef.current) return false
    if (p === savedRef.current) return true
    savingRef.current = true
    setSaveState('saving')
    try {
      const updated = await cloud.saveProject(d.id, p, d.updated_at)
      if (updated === null) {
        setSaveState('conflict')
        return false
      }
      savedRef.current = p
      setDoc({ ...d, updated_at: updated })
      setSavedAt(new Date())
      if (projectRef.current === p) clearDraft(d.id)
      setSaveState(projectRef.current === p ? 'saved' : 'pending')
      return true
    } catch (e) {
      setSaveState('error')
      setSaveError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      savingRef.current = false
    }
  }, [])

  // After a change: autosave (if turned on) or keep a draft in this browser until Guardar
  useEffect(() => {
    if (!teamCloud || !doc || project === savedRef.current || saveState === 'conflict') return
    setSaveState('pending')
    const t = autosave
      ? setTimeout(saveNow, SAVE_DELAY_MS)
      : setTimeout(() => saveDraft(doc.id, project, doc.updated_at), DRAFT_DELAY_MS)
    return () => clearTimeout(t)
  }, [project, doc, teamCloud, autosave]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Run `next` (open / create another project) after asking about unsaved changes. */
  const unsaved = teamCloud && (saveState === 'pending' || saveState === 'saving' || saveState === 'error')
  const guard = (next: () => void, cancel?: () => void) => { if (unsaved) setLeaving({ next, cancel }); else next() }

  // Back / forward between project addresses opens that project (asking first if unsaved)
  const guardRef = useRef(guard)
  guardRef.current = guard
  useEffect(() => {
    if (!teamCloud) return
    const onPop = () => {
      const id = projectFromPath()
      const current = docRef.current?.id
      if (!id || id === current) return
      const back = () => { if (current) showProject(current, true) }
      guardRef.current(() => { openCloud(id).catch((e) => { setStatus(`⚠ ${e.message}`); back() }) }, back)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [teamCloud, openCloud])

  // Viewer: their changes (what differs from the shared project) are saved shortly after
  const overrides = useMemo(() => (viewer ? overridesOf(viewer.base, project) : {}), [viewer, project])
  const overridesJson = JSON.stringify(overrides)
  const savedOverrides = useRef(viewer ? JSON.stringify(overridesOf(viewer.base, project)) : '')
  useEffect(() => {
    if (!viewer || !user || overridesJson === savedOverrides.current) return
    setSaveState('pending')
    const t = setTimeout(() => {
      setSaveState('saving')
      cloud.saveOverrides(viewer.id, user.me.id, JSON.parse(overridesJson))
        .then(() => { savedOverrides.current = overridesJson; setSaveState('saved') })
        .catch((e) => { setSaveState('error'); setSaveError(e.message) })
    }, OVERRIDES_DELAY_MS)
    return () => clearTimeout(t)
  }, [overridesJson]) // eslint-disable-line react-hooks/exhaustive-deps

  // Warn before leaving with changes not yet in the cloud
  useEffect(() => {
    const unsaved = cloudMode && saveState !== 'saved'
    const onLeave = (e: BeforeUnloadEvent) => { if (unsaved) e.preventDefault() }
    window.addEventListener('beforeunload', onLeave)
    return () => window.removeEventListener('beforeunload', onLeave)
  }, [cloudMode, saveState])

  const saveText = !cloudMode ? '' : viewer ? {
    saved: '', saving: 'Guardando tus cambios…', pending: 'Guardando tus cambios…',
    conflict: '', error: `⚠ Tus cambios no se guardaron: ${saveError}`,
  }[saveState] : {   // team projects: the Guardar button shows the state; problems also go here
    saved: '', saving: '', pending: '',
    conflict: '⚠ Sin guardar: alguien más lo modificó', error: `⚠ Sin guardar: ${saveError}`,
  }[saveState]

  const cellular = useMemo(
    () => new Set(project.nodes.filter((n) => isCellular(catalog, n)).map((n) => n.name)),
    [project.nodes, catalog])
  const stations = useMemo(
    () => new Set(project.nodes.filter((n) => isStation(catalog, n)).map((n) => n.name)),
    [project.nodes, catalog])
  // 4G states with the field tests applied: a sensor near a test shows what was measured
  useEffect(() => { if (teamCloud) cloud.listFieldTests().then((t) => setFieldTests([...queued(), ...t])).catch(() => {}) }, [teamCloud])
  const cells = useMemo(() => withFieldTests(rawCells, project.nodes, cellular, fieldTests),
    [rawCells, project.nodes, cellular, fieldTests])

  // ── LoRa links: recalculated shortly after any change that affects them ──
  // Radio fields only: editing the owner or the area does not recalculate the links
  const loraNodes = useMemo(() => project.nodes.filter((n) => !cellular.has(n.name))
    .map(({ owner, area_ha, ...radio }) => (void owner, void area_ha, radio)), [project.nodes, cellular])
  const { cell_operator, ...rf } = project.settings
  const linkInput = useDebounced(JSON.stringify([project.gateways, loraNodes, rf]), RECALC_DELAY_MS)
  useEffect(() => {
    const [gateways, nodes, settings] = JSON.parse(linkInput)
    if (!nodes.length) {
      setLinks({})
      return
    }
    const ctrl = new AbortController()
    setStatus('Calculando enlaces…')
    api.links(gateways, nodes, settings, ctrl.signal)
      .then((r) => {
        setLinks(r.results)
        // the terrain source only when it is not the local DEM (a fallback worth noticing)
        setStatus(/local/.test(r.elevation) ? 'Enlaces al día' : `Enlaces al día · terreno: ${r.elevation}`)
      })
      .catch((e) => { if (e.name !== 'AbortError') setStatus(`⚠ Falló el cálculo de enlaces: ${e.message}`) })
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
      .catch((e) => { if (e.name !== 'AbortError') setStatus(`⚠ Falló la revisión 4G: ${e.message}`) })
    return () => ctrl.abort()
  }, [cellInput])

  // ── elevation profile of the selected node's best link ──
  const dev = selected(project, selection)
  const selNode = selection?.kind === 'node' && dev && !cellular.has(dev.name) ? (dev as NodeDevice) : null
  const best = selNode ? links[selNode.name]?.link : undefined
  const bestGw = best ? project.gateways.find((g) => g.name === best.gateway) : undefined
  const [detail, setDetail] = useState<LinkDetail | null>(null)
  const [pins, setPins] = useState<number[]>([])
  const [cursorIdx, setCursorIdx] = useState<number | null>(null)
  const detailKey = selNode && bestGw ? JSON.stringify([bestGw, selNode, rf]) : ''
  useEffect(() => {
    setDetail(null)
    setPins([])
    setCursorIdx(null)
    if (!detailKey) return
    const [g, n, settings] = JSON.parse(detailKey)
    const ctrl = new AbortController()
    api.link(g, n, settings, ctrl.signal).then(setDetail).catch(() => {})
    return () => ctrl.abort()
  }, [detailKey])
  const profileStatus = !selNode
    ? 'Selecciona un nodo LoRa (en el mapa o en la lista) para ver el perfil de elevación de su enlace.'
    : !bestGw ? (links[selNode.name]?.error ?? 'Calculando el enlace…') : 'Cargando el terreno…'
  const title = detail && selNode && best
    ? profileTitle(detail.profile, { gateway: best.gateway, node: selNode.name, sf: selNode.sf, freqMhz: project.settings.freq_mhz })
    : ''
  const coordAt = (i: number) => detail?.profile.coordinates[i] as [number, number] | undefined

  // ── panels ──
  const leftRef = useRef<ImperativePanelHandle>(null)
  const profileRef = useRef<ImperativePanelHandle>(null)
  const rightRef = useRef<ImperativePanelHandle>(null)
  const [collapsed, setCollapsed] = useState({ left: false, profile: false, right: false })
  const toggle = (which: 'left' | 'profile' | 'right') => {
    const ref = { left: leftRef, profile: profileRef, right: rightRef }[which].current
    if (!ref) return
    if (ref.isCollapsed()) ref.expand()
    else ref.collapse()
  }

  const select = (s: Selection, fly = false) => {
    setSelection(s)
    if (narrow) setPhonePanel(false)        // phones: back to the map, where the device's card shows
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
    if (narrow) setPhonePanel(false)        // phones: the new device's sheet replaces the panel
  }

  // Test sensor for the range: the LoRa model most used in the project (SE0X-LB if none), SF10
  const rangeModel = useMemo(() => {
    const counts = new Map<string, number>()
    for (const n of project.nodes) if (!cellular.has(n.name)) counts.set(n.model, (counts.get(n.model) ?? 0) + 1)
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'dragino_se0x_lb'
  }, [project.nodes, cellular])
  const rangeSig = (g: Gateway) => JSON.stringify([g.lat, g.lon, g.height, g.tx_power, g.gain, g.cable_loss, g.model, rf, rangeModel])
  // A range drawn for a gateway that has since moved or changed is dropped
  useEffect(() => {
    setRanges((r) => {
      const keep = Object.fromEntries(Object.entries(r).filter(([name, v]) => {
        const g = project.gateways.find((x) => x.name === name)
        return g && rangeSig(g) === v.sig
      }))
      return Object.keys(keep).length === Object.keys(r).length ? r : keep
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.gateways, rf, rangeModel])
  const showRange = async (names: string[]) => {
    const todo = project.gateways.filter((g) => names.includes(g.name))
    setRangeLoading((s) => new Set([...s, ...todo.map((g) => g.name)]))
    setStatus(`Calculando el alcance de ${todo.length === 1 ? todo[0].name : `${todo.length} gateways`}…`)
    try {
      await Promise.all(todo.map(async (g) => {
        const r = await api.coverage(g, project.settings, { node_model: rangeModel, sf: 10, radius_km: 10, radials: 24 })
        setRanges((x) => ({ ...x, [g.name]: { radials: r.radials, sig: rangeSig(g) } }))
      }))
      setStatus(`Alcance con un sensor ${catalog.node_profiles[rangeModel]?.label ?? rangeModel} a SF10: verde = enlace viable`)
    } catch (e) {
      setStatus(apiError(e))
    } finally {
      setRangeLoading((s) => new Set([...s].filter((n) => !names.includes(n))))
    }
  }
  const hideRange = (names: string[]) => setRanges((r) => Object.fromEntries(Object.entries(r).filter(([n]) => !names.includes(n))))

  const undoRedo = (a: 'undo' | 'redo') => {
    if (!(a === 'undo' ? history.past : history.future).length) return
    dispatch({ type: a })
    setStatus(a === 'undo' ? 'Deshecho' : 'Rehecho')
  }

  // ── keyboard shortcuts ──
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {})
  keyHandler.current = (e: KeyboardEvent) => {
    const action = shortcutFor(e)
    if (!action || showReport || showProjects || showImport || bulk || suggest || showShare || localSettings || leaving) return
    if ((viewer || locked) && (action === 'addGateway' || action === 'addNode')) return
    if (action === 'save' || action === 'undo' || action === 'redo' || (action === 'addGateway' && (e.ctrlKey || e.metaKey))) e.preventDefault()
    switch (action) {
      case 'addGateway':
        setMode('addGateway')
        break
      case 'addNode':
        setAddModel(SHORTCUT_NODE_MODEL)
        setMode('addNode')
        break
      case 'ruler':
        if (mode === 'ruler') setMode('select')
        else { setRuler([]); setMode('ruler') }
        break
      case 'cancel':
        setMode('select')
        break
      case 'undo':
      case 'redo':
        undoRedo(action)
        break
      case 'save':
        if (viewer) setStatus('Tus cambios se guardan solos')
        else if (cloudMode) {
          if (saveState === 'saved') setStatus('Todo está guardado')
          else saveNow()
        } else {
          store(STORAGE_KEY, JSON.stringify(project))
          setStatus('Guardado en este navegador')
        }
        break
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current(e)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const importFile = async (file: File) => {
    try {
      const raw = JSON.parse(await file.text())
      const n = await api.normalize(raw)
      const p: Project = { ...n, version: PROJECT_VERSION, settings: { ...catalog.defaults, ...n.settings } }
      if (cloudMode) {
        guard(() => {                    // an imported file becomes a new cloud project
          createCloud(p).then(() => setStatus(`Abierto: ${file.name}`)).catch((e) => setStatus(`⚠ ${e.message}`))
        })
        return
      } else {
        dispatch({ type: 'open', project: p })
        setSelection(null)
        showAll(p)
      }
      setStatus(`Abierto: ${file.name}`)
    } catch (e) {
      setStatus(`⚠ No se pudo abrir ${file.name}: ${e instanceof Error ? e.message : e}`)
    }
  }

  const mapLegend = (): LegendItem[] => buildLegend({ project, links, cells, cellular, stations,
    ranges: Object.fromEntries(Object.entries(ranges).map(([k, v]) => [k, v.radials])) }, showCoverage)

  const exportMap = async () => {
    const map = mapRef.current
    if (!map) return
    const center = map.getCenter()
    try {
      const blob = await mapToPng(map.getCanvas(), {
        title: project.name.trim() || 'Proyecto Verea',
        subtitle: `${new Date().toLocaleString('es-MX')} · centro ${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}`,
        legend: mapLegend(),
        attribution: 'Imágenes y nombres © Esri' + (showCoverage ? ' · Cobertura 4G: CRT / datos.gob.mx (CC BY 4.0)' : ''),
      })
      downloadBlob(blob, `${safeName(project.name)}_mapa.png`)
    } catch (e) {
      setStatus(`⚠ No se pudo crear la imagen del mapa: ${e instanceof Error ? e.message : e}`)
    }
  }

  const exportFile = () => {
    const blob = new Blob([JSON.stringify({ ...project, saved_at: new Date().toISOString() }, null, 1)],
      { type: 'application/json' })
    downloadBlob(blob, `${safeName(project.name || 'proyecto_verea')}.verea.json`)
  }

  // Cloud: nothing is editable until the project is open, so no edit is lost to the load
  if (teamCloud && !doc) {
    return saveState === 'error'
      ? <Notice title="No se pudieron abrir tus proyectos"><p className="hint">{saveError}</p>
          <button className="btn" onClick={() => window.location.reload()}>Reintentar</button></Notice>
      : <LoadingScreen text="Abriendo el proyecto…" />
  }

  const rulerTotal = ruler.slice(1).reduce((sum, pt, i) => sum + haversine(ruler[i], pt), 0)
  const served = selection?.kind === 'gateway'
    ? Object.values(links).filter((r) => r.link?.gateway === selection.name).length : 0

  const sidebar = (
    <Sidebar catalog={catalog} project={project} selection={selection} links={links} cells={cells}
      mode={mode} addModel={addModel} showCoverage={showCoverage}
      status={[saveText, status].filter(Boolean).join(' · ')}
      user={user && !viewer ? { onProjects: () => setShowProjects(true), onShare: doc ? () => setShowShare(true) : undefined } : undefined}
      save={teamCloud ? { state: saveState, savedAt, autosave, onSave: () => { saveNow() } } : undefined}
      edit={viewer ? undefined : { on: editing, onChange: setEditing }}
      onFieldMode={teamCloud && doc ? () => guard(() => window.location.assign(`/campo/${doc.id}`)) : undefined}
      onConfig={user ? user.onSettings : () => setLocalSettings(true)}
      viewer={viewer ? { changes: changeCount(overrides), onFiles: viewer.onFiles,
        onRestore: () => { dispatch({ type: 'open', project: viewer.base }); setStatus('Valores originales restaurados') } } : undefined}
      onMode={(m, model) => {
        if (m === 'ruler' && mode !== 'ruler') setRuler([])
        setMode(m)
        if (model) setAddModel(model)
      }}
      onSettings={(patch) => dispatch({ type: 'settings', patch })}
      onMeta={(meta) => dispatch({ type: 'meta', ...meta })}
      onSelect={select}
      showLabels={showLabels} onShowLabels={setShowLabels}
      onImport={importFile} onExport={exportFile} onReport={() => setShowReport(true)} onImportPlots={() => setShowImport(true)} onBulk={(preset) => setBulk(preset ?? { groups: [] })}
      onBulkEnvironment={(names, environment) => {
        dispatch({ type: 'bulkEnvironment', names, environment })
        setStatus(`${names.length} nodos LoRa en «${catalog.environments[environment]?.label ?? environment}» (Ctrl+Z para deshacer)`)
      }} onSuggest={() => setSuggest(true)}
      ranges={{ any: Object.keys(ranges).length > 0, loading: rangeLoading.size > 0,
        onAll: () => showRange(project.gateways.filter((g) => g.online).map((g) => g.name)),
        onHide: () => setRanges({}) }}
      history={{ canUndo: history.past.length > 0, canRedo: history.future.length > 0,
        onUndo: () => undoRedo('undo'), onRedo: () => undoRedo('redo') }}
      onNew={() => {
        if (cloudMode) {
          guard(() => createCloud(emptyProject(catalog.defaults)).catch((e) => setStatus(`⚠ ${e.message}`)))
          return
        }
        if (!confirm('¿Empezar un proyecto vacío? Guarda antes el actual en un archivo si lo necesitas.')) return
        dispatch({ type: 'open', project: emptyProject(catalog.defaults) })
        setSelection(null)
      }} />
  )

  const mapArea = (
    <main className="map-area">
      <MapView project={project} selection={selection} links={links} cells={cells} cellular={cellular} stations={stations}
        ranges={Object.fromEntries(Object.entries(ranges).map(([k, v]) => [k, v.radials]))}
        mode={mode} showCoverage={showCoverage} showLabels={showLabels} pin={pin} focus={focus}
        cursor={cursorIdx !== null ? coordAt(cursorIdx) ?? null : null}
        profilePins={pins.map((i) => coordAt(i)).filter((c): c is [number, number] => !!c)}
        ruler={ruler}
        onReady={(m) => { mapRef.current = m }} readOnly={!!viewer || locked} fieldTests={fieldTests}
        onSelect={(s) => setSelection(s)}
        onMove={(kind, name, lat, lon) => dispatch({ type: 'move', kind, name, lat, lon })}
        onAdd={add}
        onRulerPoint={(lat, lon) => setRuler((r) => [...r, [lat, lon]])}
        onRulerDone={() => setMode('select')}
        coverageAvailable={catalog.cell_operators.length > 0} onToggleCoverage={() => setShowCoverage((v) => !v)}
        onToggleRuler={() => {
          if (mode === 'ruler') setMode('select')
          else { setRuler([]); setMode('ruler') }
        }} />
      <div className="map-tools">
        <SearchBox onPick={(pl) => {
          setPin({ lat: pl.lat, lon: pl.lon })
          setFocus({ lat: pl.lat, lon: pl.lon, zoom: pl.kind === 'coordinates' ? 16 : 14, key: Date.now() })
        }} />
        <button className="btn map-btn" onClick={exportMap} title="Descargar el mapa como imagen PNG"><Icon name="camera" /><span className="btn-label">Imagen del mapa</span></button>
      </div>
      <NetworkCounter counts={networkCounts(project, catalog, links, cells, cellular)} folded={narrow} />
      {(mode === 'ruler' || ruler.length > 0) && (
        <div className="ruler-box" role="region" aria-label="Regla">
          <strong className="inline-flex items-center gap-1"><Icon name="ruler" size={14} /> Regla</strong>{' '}
          {ruler.length < 2 ? <span>Haz clic en el mapa para medir</span> : (
            <span>Total <b data-testid="ruler-total">{distance(rulerTotal)}</b> · {ruler.length - 1} tramo{ruler.length > 2 ? 's' : ''}</span>
          )}
          <span className="hint"> {mode === 'ruler' ? '· doble clic o Esc para terminar' : ''}</span>
          <button className="btn-ghost underline ml-2" onClick={() => { setRuler([]); setMode('select') }}>Borrar</button>
        </div>
      )}
      {saveState === 'conflict' && doc && (
        <div className="conflict-banner" role="alert">
          Alguien más guardó este proyecto después de que lo abriste. Tus últimos cambios no están guardados.
          <div className="flex gap-2 mt-2">
            <button className="btn" onClick={() => { clearDraft(doc.id); openCloud(doc.id) }}>Cargar su versión</button>
            <button className="btn btn-active" onClick={() =>
              createCloud({ ...project, name: `${project.name || 'Sin nombre'} (mi copia)` })}>
              Guardar la mía como copia
            </button>
          </div>
        </div>
      )}
      {recover && doc && (
        <div className="conflict-banner" role="alert">
          Tienes cambios sin guardar de la última vez ({new Date(recover.at).toLocaleString('es-MX',
            { dateStyle: 'medium', timeStyle: 'short' })}).
          {recover.base !== doc.updated_at && ' Ojo: alguien guardó el proyecto después; si los recuperas y guardas, reemplazarás su versión.'}
          <div className="flex gap-2 mt-2">
            <button className="btn" onClick={() => { clearDraft(doc.id); setRecover(null) }}>Descartar</button>
            <button className="btn btn-active" onClick={() => {
              dispatch({ type: 'open', project: recover.project })
              setRecover(null)
              setStatus('Cambios recuperados: falta guardarlos')
            }}>Recuperar</button>
          </div>
        </div>
      )}
      {(mode === 'addGateway' || mode === 'addNode') && (
        <div className="mode-banner" role="status">
          <span>{TOUCH ? 'Toca' : 'Haz clic en'} el mapa para colocar el {mode === 'addGateway' ? 'gateway' : 'sensor'}</span>
          <button onClick={() => setMode('select')}>Cancelar</button>
        </div>
      )}
    </main>
  )

  const profile = (
    <ProfilePanel profile={detail?.profile ?? null} title={title} status={profileStatus}
      pins={pins} onPins={setPins} onHover={setCursorIdx} />
  )

  const devicePanel = dev && selection ? (
    <DevicePanel key={`${selection.kind}:${selection.name}`} catalog={catalog} project={project}
      kind={selection.kind} device={dev} link={links[dev.name]} cell={cells[dev.name]} served={served} viewer={!!viewer} locked={locked}
      range={selection.kind === 'gateway' ? {
        shown: !!ranges[dev.name], loading: rangeLoading.has(dev.name),
        onToggle: () => (ranges[dev.name] ? hideRange([dev.name]) : showRange([dev.name])),
      } : undefined}
      onRename={(next) => {
        dispatch({ type: 'load', project: rename(project, selection.kind, dev.name, next) })
        setSelection({ kind: selection.kind, name: next.trim() })
      }}
      onPatch={(patch) => dispatch(selection.kind === 'gateway'
        ? { type: 'updateGateway', name: dev.name, patch }
        : { type: 'updateNode', name: dev.name, patch })}
      onRemove={() => { dispatch({ type: 'remove', kind: selection.kind, name: dev.name }); setSelection(null) }}
      onClose={() => setSelection(null)} />
  ) : null

  const dialogs = (
    <>
      {showProjects && user && (
        <ProjectsDialog me={user.me} currentId={doc?.id ?? null}
          onOpen={(id) => { setShowProjects(false); guard(() => openCloud(id).catch((e) => setStatus(`⚠ ${e.message}`))) }}
          onDeleted={(id) => {
            if (id === doc?.id) {
              setDoc(null)
              store(LAST_PROJECT_KEY, null)
              createCloud(emptyProject(catalog.defaults)).catch((e) => setStatus(`⚠ ${e.message}`))
            }
          }}
          onClose={() => setShowProjects(false)} />
      )}
      {showShare && doc && (
        <ShareDialog projectId={doc.id} projectName={project.name} onClose={() => setShowShare(false)} />
      )}
      {leaving && doc && (
        <div className="dialog-backdrop" onClick={() => { leaving.cancel?.(); setLeaving(null) }}>
          <div className="dialog" role="alertdialog" aria-label="Cambios sin guardar" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-semibold">Cambios sin guardar</h2>
            <p className="hint">«{project.name || 'Proyecto sin nombre'}» tiene cambios que no se han guardado.</p>
            <div className="flex gap-2 justify-end">
              <button className="btn" onClick={() => { leaving.cancel?.(); setLeaving(null) }}>Cancelar</button>
              <button className="btn" onClick={() => { const next = leaving.next; clearDraft(doc.id); setLeaving(null); next() }}>
                Descartar cambios</button>
              <button className="btn btn-active" autoFocus onClick={async () => {
                const next = leaving.next
                if (await saveNow()) { setLeaving(null); next() }
              }}>Guardar</button>
            </div>
          </div>
        </div>
      )}
      {localSettings && <SettingsDialog onClose={() => setLocalSettings(false)} />}
      {suggest && (
        <SuggestGatewaysDialog catalog={catalog} project={project} links={links} cellular={cellular}
          onClose={() => setSuggest(false)}
          onApply={(points, model, height) => {
            dispatch({ type: 'addGateways', points, model, height, catalog })
            setSuggest(false)
            setStatus(`${points.length} gateways 4G agregados: muévelos si hace falta (Ctrl+Z para deshacer)`)
          }} />
      )}
      {bulk && (
        <BulkModelDialog catalog={catalog} project={project} links={links} cells={cells} cellular={cellular} preset={bulk}
          onClose={() => setBulk(null)}
          onApply={(names, model) => {
            dispatch({ type: 'bulkModel', names, model, catalog })
            setBulk(null)
            setStatus(`${names.length} sensores cambiados a ${catalog.node_profiles[model]?.label ?? model} (Ctrl+Z para deshacer)`)
          }} />
      )}
      {showImport && (
        <ImportDialog catalog={catalog} project={project} onClose={() => setShowImport(false)}
          onApply={(next, s) => {
            dispatch({ type: 'load', project: next })
            setShowImport(false)
            setSelection(null)
            showAll(next)
            setStatus(`Importado: ${s.added} nodos nuevos, ${s.updated} actualizados${s.plots ? `, ${s.plots} parcelas` : ''}`)
          }} />
      )}
      {showReport && (
        <ReportDialog catalog={catalog} project={project} links={links} cells={cells} cellular={cellular} stations={stations}
          legend={mapLegend()} showCoverage={showCoverage} onClose={() => setShowReport(false)}
          share={viewer ? (viewer.token ? { team: false, get: async () => shareUrl(viewer.token!) } : undefined)
            : teamCloud && doc ? { team: true, get: async (showOwners) => shareUrl((await cloud.activeShare(doc.id, showOwners)).token) }
              : undefined}
          onDone={(files) => { setShowReport(false); setStatus(`Reporte descargado: ${files.join(', ')}`) }} />
      )}
    </>
  )

  if (narrow) {
    // Phones: the map stays free; the panel and a device's detail open full screen on demand
    const kind = !dev ? 'lora' : selection?.kind === 'gateway' ? 'gateway' : cellular.has(dev.name) ? 'cellular'
      : stations.has(dev.name) ? 'station' : 'lora'
    const link = dev ? links[dev.name]?.link : undefined
    const summary = !dev ? '' : selection?.kind === 'gateway' ? `${served} nodo${served === 1 ? '' : 's'} atendido${served === 1 ? '' : 's'}`
      : cellular.has(dev.name) ? cellShort(cells[dev.name])
      : link ? `${link.viable ? 'Viable' : 'No viable'} · ${db(link.margin_db)} · ${distance(link.distance_m)}` : 'Calculando enlace…'
    const color = !dev ? '' : selection?.kind === 'gateway' ? ((dev as Gateway).online ? COLORS.gateway : COLORS.none)
      : cellular.has(dev.name) ? cellColor(cells[dev.name]) : linkColor(links[dev.name])
    const head = dev ? <DeviceHead kind={kind} name={dev.name} summary={summary} color={color} /> : null
    return (
      <div className={`app-phone ${phonePanel || dev ? 'sheet-open' : ''} ${phonePanel ? 'panel-open' : ''}`}>
        <div className="phone-map">{mapArea}</div>
        {!phonePanel && <PanelButton name={project.name} onClick={() => setPhonePanel(true)} />}
        {phonePanel ? (
          <PhoneSheet label="Panel del proyecto" head={<ProjectHead />} onClose={() => setPhonePanel(false)}>{sidebar}</PhoneSheet>
        ) : dev && selection && (
          phoneDetail ? (
            <PhoneSheet label="Detalle del dispositivo" onClose={() => setPhoneDetail(false)}>
              <button className="link-btn back-link" onClick={() => setPhoneDetail(false)}><Icon name="arrow-left" size={14} /> Resumen</button>
              {devicePanel}
            </PhoneSheet>
          ) : (
            // essentials first: a LoRa node's profile, a 4G sensor's coverage; the rest behind «Ver más detalles»
            <PhoneSheet label="Dispositivo seleccionado" head={head} onClose={() => setSelection(null)}>
              <div className="device-summary">
                {selNode && <div className="phone-profile">{profile}</div>}
                {kind === 'cellular' && <CellResult cell={cells[dev.name]} operator={project.settings.cell_operator} />}
                <button className="btn" onClick={() => setPhoneDetail(true)}>Ver más detalles</button>
              </div>
            </PhoneSheet>
          )
        )}
        {dialogs}
      </div>
    )
  }

  return (
    <div className="app">
      <PanelGroup direction="horizontal" autoSaveId="verea-layout-h">
        <Panel id="left" order={1} ref={leftRef} defaultSize={24} minSize={16} collapsible collapsedSize={0}
          onCollapse={() => setCollapsed((c) => ({ ...c, left: true }))}
          onExpand={() => setCollapsed((c) => ({ ...c, left: false }))}>
          {sidebar}
        </Panel>
        <Edge axis="x" side="left" collapsed={collapsed.left} name="Proyecto" onToggle={() => toggle('left')} />
        <Panel id="center" order={2} minSize={30}>
          <PanelGroup direction="vertical" autoSaveId="verea-layout-v">
            <Panel id="map" order={1} minSize={25}>{mapArea}</Panel>
            <Edge axis="y" side="bottom" collapsed={collapsed.profile} name="Perfil de Elevación" onToggle={() => toggle('profile')} />
            <Panel id="profile" order={2} ref={profileRef} defaultSize={34} minSize={14} collapsible collapsedSize={0}
              onCollapse={() => setCollapsed((c) => ({ ...c, profile: true }))}
              onExpand={() => setCollapsed((c) => ({ ...c, profile: false }))}>
              {profile}
            </Panel>
          </PanelGroup>
        </Panel>
        {devicePanel && (
          <>
            <Edge axis="x" side="right" collapsed={collapsed.right} name="Detalles" onToggle={() => toggle('right')} />
            <Panel id="right" order={3} ref={rightRef} defaultSize={24} minSize={16} collapsible collapsedSize={0}
              onCollapse={() => setCollapsed((c) => ({ ...c, right: true }))}
              onExpand={() => setCollapsed((c) => ({ ...c, right: false }))}>
              {devicePanel}
            </Panel>
          </>
        )}
      </PanelGroup>
      {dialogs}
    </div>
  )
}
