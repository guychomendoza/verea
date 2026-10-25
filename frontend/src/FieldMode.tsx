// «Pruebas de campo 4G» (/campo, docs/modo-campo.md): go with a sensor to where the coverage map
// says possible or none, and record what really happens. Phone first; works without signal (the
// tests wait on the phone and upload by themselves when there is connection).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as cloud from './cloud'
import { api } from './api'
import MapView, { type Focus, type MapMode } from './MapView'
import { CellResult } from './DevicePanel'
import { Alert, CloseButton, Icon } from './icons'
import { LoadingScreen, Spinner } from './Loading'
import { isCellular, isStation } from './project'
import {
  OBSERVED, agrees, dequeue, enqueue, newClientId, queued, withFieldTests, type FieldTest, type Observed,
} from './fieldTests'
import type { Catalog, CellStatus, Project } from './types'

type Here = { lat: number; lon: number; accuracy: number }
type Draft = Here & { predicted: CellStatus | null; checking: boolean; observed: Observed | null
  delivered: boolean | null; rssi: string; notes: string }

export default function FieldMode({ catalog, projectId, onExit }: {
  catalog: Catalog; projectId: string | null; onExit: (projectId: string | null) => void
}) {
  const [rows, setRows] = useState<cloud.ProjectRow[] | null>(null)
  const [project, setProject] = useState<{ id: string; data: Project } | null>(null)
  const [choosing, setChoosing] = useState(!projectId)
  const [tests, setTests] = useState<FieldTest[]>([])
  const [pending, setPending] = useState<FieldTest[]>(queued)
  const [online, setOnline] = useState(navigator.onLine)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState('')
  const [me, setMe] = useState<Here | null>(null)
  const [geoError, setGeoError] = useState('')
  const [focus, setFocus] = useState<Focus | null>(null)
  const [mode, setMode] = useState<MapMode>('select')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [cells, setCells] = useState<Record<string, CellStatus>>({})
  const [showCoverage, setShowCoverage] = useState(true)
  const centred = useRef(false)

  const operator = project?.data.settings.cell_operator || catalog.cell_operators[0] || 'Telcel'

  // ── projects ──
  useEffect(() => { cloud.listProjects().then(setRows).catch((e) => setError(e.message)) }, [])
  const open = useCallback(async (id: string) => {
    setChoosing(false)
    const r = await cloud.loadProject(id)
    setProject({ id, data: { ...r.project, settings: { ...catalog.defaults, ...r.project.settings } } })
    history.replaceState(null, '', `/campo/${id}`)
  }, [catalog])
  useEffect(() => { if (projectId) open(projectId).catch((e) => { setError(e.message); setChoosing(true) }) }, [projectId, open])

  // the project's 4G sensors as the map predicts them (for context on the map)
  const cellular = useMemo(() => new Set((project?.data.nodes ?? []).filter((n) => isCellular(catalog, n)).map((n) => n.name)), [project, catalog])
  const stations = useMemo(() => new Set((project?.data.nodes ?? []).filter((n) => isStation(catalog, n)).map((n) => n.name)), [project, catalog])
  useEffect(() => {
    if (!project || !online) return
    const pts = project.data.nodes.filter((n) => cellular.has(n.name)).map((n) => ({ name: n.name, lat: n.lat, lon: n.lon }))
    if (!pts.length) return
    api.cellStatus(operator, pts).then((r) => setCells(Object.fromEntries(r.points.map((p) => [p.name, p])))).catch(() => {})
  }, [project, online, operator, cellular])

  // ── tests: the team's, plus the ones still on this phone ──
  const refresh = useCallback(() => cloud.listFieldTests().then(setTests).catch(() => {}), [])
  useEffect(() => { refresh() }, [refresh])
  const sync = useCallback(async () => {
    const q = queued()
    setPending(q)
    if (!q.length || !navigator.onLine) return
    setSyncing(true)
    try {
      // tests recorded without signal: ask the map now what it predicted there
      for (const t of q.filter((x) => !x.predicted)) {
        const r = await api.cellStatus(t.operator, [{ name: 'p', lat: t.lat, lon: t.lon }])
        t.predicted = r.points[0]?.state ?? null
      }
      await cloud.uploadFieldTests(q)
      dequeue(q.map((t) => t.client_id))
      setPending(queued())
      await refresh()
    } catch (e) {
      setError(`No se pudieron subir las pruebas (se quedan en el teléfono): ${e instanceof Error ? e.message : e}`)
    } finally {
      setSyncing(false)
    }
  }, [refresh])
  useEffect(() => {
    const up = () => { setOnline(true); sync() }
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    const t = setInterval(sync, 30000)
    sync()
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); clearInterval(t) }
  }, [sync])

  // ── where I am ──
  useEffect(() => {
    if (!navigator.geolocation) { setGeoError('Este navegador no da la ubicación.'); return }
    const id = navigator.geolocation.watchPosition(
      (p) => {
        const here = { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }
        setMe(here)
        setGeoError('')
        if (!centred.current) { centred.current = true; setFocus({ ...here, zoom: 16, key: Date.now() }) }
      },
      (e) => setGeoError(e.code === e.PERMISSION_DENIED ? 'Permite el acceso a tu ubicación para registrar pruebas donde estás.'
        : 'Buscando tu ubicación…'),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 })
    return () => navigator.geolocation.clearWatch(id)
  }, [])

  // ── recording ──
  const start = (at: Here) => {
    setMode('select')
    setDraft({ ...at, predicted: null, checking: navigator.onLine, observed: null, delivered: null, rssi: '', notes: '' })
    if (!navigator.onLine) return
    api.cellStatus(operator, [{ name: 'p', lat: at.lat, lon: at.lon }])
      .then((r) => setDraft((d) => (d && d.lat === at.lat && d.lon === at.lon ? { ...d, predicted: r.points[0] ?? null, checking: false } : d)))
      .catch(() => setDraft((d) => (d ? { ...d, checking: false } : d)))
  }
  const save = () => {
    if (!draft?.observed) return
    const rssi = Number(draft.rssi)
    enqueue({
      client_id: newClientId(), project_id: project?.id ?? null, taken_at: new Date().toISOString(),
      lat: draft.lat, lon: draft.lon, accuracy_m: draft.accuracy || null, operator,
      predicted: draft.predicted?.state ?? null, observed: draft.observed, delivered: draft.delivered,
      rssi_dbm: draft.rssi.trim() && Number.isFinite(rssi) ? rssi : null, notes: draft.notes.trim(),
    })
    setDraft(null)
    sync()
  }

  const shown = useMemo(() => [...pending, ...tests.filter((t) => !pending.some((p) => p.client_id === t.client_id))], [pending, tests])
  const today = shown.filter((t) => new Date(t.taken_at).toDateString() === new Date().toDateString())
  const todayAgree = today.filter((t) => agrees(t.predicted, t.observed)).length
  const shownCells = useMemo(() => withFieldTests(cells, project?.data.nodes ?? [], cellular, shown), [cells, project, cellular, shown])

  if (choosing) {
    return (
      <div className="field-choose">
        <div className="field-choose-card">
          <h1><Icon name="signal" size={20} /> Pruebas de campo 4G</h1>
          <p className="hint">Elige el proyecto de la zona que vas a recorrer. Sus sensores y la cobertura 4G se ven en el mapa.</p>
          {error && <Alert>{error}</Alert>}
          {rows === null ? <Spinner /> : (
            <ul className="project-list">
              {rows.map((r) => (
                <li key={r.id}><button className="flex-1 text-left" onClick={() => open(r.id).catch((e) => setError(e.message))}>
                  <b>{r.name || 'Sin nombre'}</b></button></li>
              ))}
            </ul>
          )}
          <button className="btn self-center" onClick={() => onExit(projectId)}><Icon name="arrow-left" /> Volver al editor</button>
        </div>
      </div>
    )
  }
  if (!project) return <LoadingScreen text="Abriendo el proyecto…" />

  return (
    <div className="field-mode">
      <div className="field-map">
        <MapView project={project.data} selection={null} links={{}} cells={shownCells} cellular={cellular} stations={stations}
          mode={mode} showCoverage={showCoverage} showLabels pin={null} focus={focus} cursor={null} profilePins={[]} ruler={[]}
          onSelect={() => {}} onMove={() => {}} onAdd={(lat, lon) => start({ lat, lon, accuracy: 0 })}
          onRulerPoint={() => {}} onRulerDone={() => {}} onToggleRuler={() => {}}
          coverageAvailable={catalog.cell_operators.length > 0} onToggleCoverage={() => setShowCoverage((v) => !v)}
          readOnly fieldTests={shown} me={me} />
      </div>

      <header className="field-bar">
        <button className="icon-btn" onClick={() => onExit(project.id)} aria-label="Volver al editor" title="Volver al editor"><Icon name="arrow-left" /></button>
        <button className="field-title" onClick={() => setChoosing(true)} title="Cambiar de proyecto">
          <span>Pruebas de campo</span><b>{project.data.name || 'Proyecto'}</b>
        </button>
        <span className={`field-sync ${online ? '' : 'offline'}`} role="status">
          {syncing ? 'Subiendo…' : pending.length ? `${pending.length} por subir${online ? '' : ' · sin conexión'}` : online ? 'Al día' : 'Sin conexión'}
        </span>
      </header>

      {!draft && (
        <div className="field-actions">
          {geoError && <p className="field-geo">{geoError}</p>}
          {mode === 'pick' ? (
            <div className="mode-banner field-pick" role="status">
              <span>Toca el mapa donde hiciste la prueba</span>
              <button onClick={() => setMode('select')}>Cancelar</button>
            </div>
          ) : (
            <>
              <p className="field-today">{today.length ? `Hoy: ${today.length} prueba${today.length === 1 ? '' : 's'} · ${todayAgree} coinciden con el mapa` : 'Sin pruebas hoy'}</p>
              <div className="field-buttons">
                <button className="btn" onClick={() => me && setFocus({ ...me, zoom: 16, key: Date.now() })} disabled={!me}
                  aria-label="Centrar en mi ubicación" title="Centrar en mi ubicación"><Icon name="locate" /></button>
                <button className="btn btn-active field-record" onClick={() => me && start(me)} disabled={!me}>
                  <Icon name="plus" /> Registrar prueba aquí</button>
                <button className="btn" onClick={() => setMode('pick')} aria-label="Elegir el punto en el mapa" title="Elegir el punto en el mapa">
                  <Icon name="map" /></button>
              </div>
            </>
          )}
        </div>
      )}

      {draft && (
        <section className="field-sheet" role="dialog" aria-label="Registrar prueba">
          <div className="phone-sheet-bar">
            <div className="phone-sheet-title"><b>Nueva prueba</b></div>
            <CloseButton onClick={() => setDraft(null)} label="Cancelar la prueba" />
          </div>
          <div className="field-sheet-body">
            <p className="hint text-center">{draft.lat.toFixed(5)}, {draft.lon.toFixed(5)}{draft.accuracy ? ` · precisión ±${Math.round(draft.accuracy)} m` : ''}</p>
            <h3>Lo que dice el mapa</h3>
            {draft.checking ? <Spinner text="Consultando el mapa de cobertura…" />
              : draft.predicted ? <CellResult cell={draft.predicted} operator={operator} />
              : <p className="hint">Sin conexión: el mapa se consulta al subir la prueba.</p>}
            <h3>¿Qué pasó con el sensor aquí?</h3>
            <div className="observed-buttons" role="radiogroup" aria-label="Lo que pasó">
              {(Object.keys(OBSERVED) as Observed[]).map((k) => (
                <button key={k} role="radio" aria-checked={draft.observed === k} className={`observed ${draft.observed === k ? 'active' : ''}`}
                  style={{ '--obs': OBSERVED[k].color } as React.CSSProperties} onClick={() => setDraft({ ...draft, observed: k })}>
                  <i /><b>{OBSERVED[k].label}</b><span>{OBSERVED[k].hint}</span>
                </button>
              ))}
            </div>
            {draft.observed && draft.predicted && (
              agrees(draft.predicted.state, draft.observed)
                ? <p className="agree yes"><Icon name="check-circle" size={16} /> Coincide con el mapa</p>
                : <p className="agree no"><Icon name="alert" size={16} /> No coincide con el mapa: esta prueba lo corrige aquí</p>
            )}
            <div className="field-extra">
              <div className="field"><span>¿Llegó el dato al servidor?</span>
                <div className="segmented" role="radiogroup" aria-label="¿Llegó el dato al servidor?">
                  {([[true, 'Sí'], [false, 'No'], [null, 'No sé']] as [boolean | null, string][]).map(([v, l]) => (
                    <button key={l} role="radio" aria-checked={draft.delivered === v} className={draft.delivered === v ? 'active' : ''}
                      onClick={() => setDraft({ ...draft, delivered: v })}>{l}</button>
                  ))}
                </div>
              </div>
              <label className="field"><span>RSSI / RSRP del sensor (dBm, opcional)</span>
                <input inputMode="decimal" value={draft.rssi} placeholder="-95" onChange={(e) => setDraft({ ...draft, rssi: e.target.value })} /></label>
              <label className="field"><span>Notas (opcional)</span>
                <textarea rows={2} maxLength={1000} value={draft.notes} placeholder="Cultivo alto, junto a la bomba…"
                  onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></label>
            </div>
            <div className="flex gap-2 justify-center">
              <button className="btn" onClick={() => setDraft(null)}>Cancelar</button>
              <button className="btn btn-active" onClick={save} disabled={!draft.observed}>Guardar prueba</button>
            </div>
          </div>
        </section>
      )}
      {error && <div className="field-error"><Alert>{error}</Alert><CloseButton onClick={() => setError('')} /></div>}
    </div>
  )
}
