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
  DELIVERY, EXPECTED, OBSERVED, agrees, comparedToMap, deliveryOf, dequeue, enqueue, newClientId, queued, testsCsv, withFieldTests,
  type Delivery, type FieldTest, type Observed,
} from './fieldTests'
import { RulerBox } from './ruler'
import { downloadBlob } from './exportImage'
import type { Catalog, CellStatus, Project } from './types'
import { askConfirm } from './confirm'

type Here = { lat: number; lon: number; accuracy: number }
type Draft = Here & { predicted: CellStatus | null; checking: boolean; observed: Observed | null
  delivered: boolean | null; rssi: string; notes: string }

const PREDICTED_LABEL: Record<CellStatus['state'], string> = {
  ok: 'garantizada', edge: 'incierta', differentiated: 'solo diferenciada', possible: 'posible', none: 'sin cobertura',
}
const DELIVERIES: Delivery[] = ['yes', 'no', 'unknown']
const isToday = (t: FieldTest) => new Date(t.taken_at).toDateString() === new Date().toDateString()

/** The border of a test's dot on the map (mapStyle.ts 'field-tests'): did the reading reach the server. */
function TestDot({ t, size = 18 }: { t: Pick<FieldTest, 'observed' | 'delivered'>; size?: number }) {
  const d = deliveryOf(t as FieldTest)
  return (
    <span className={`test-dot ${d}`} style={{ background: OBSERVED[t.observed].color, width: size, height: size }} aria-hidden="true">
      {d === 'no' && <Icon name="x" size={Math.round(size * 0.6)} />}
    </span>
  )
}

export default function FieldMode({ catalog, projectId, me: account, onExit }: {
  catalog: Catalog; projectId: string | null; me: cloud.Me; onExit: (projectId: string | null) => void
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
  const [focus] = useState<Focus | null>(null)
  const [picked, setPicked] = useState<FieldTest | null>(null)     // a test's dot clicked: its card
  const [mode, setMode] = useState<MapMode>('select')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [cells, setCells] = useState<Record<string, CellStatus>>({})
  const [showCoverage, setShowCoverage] = useState(true)
  const [ruler, setRuler] = useState<[number, number][]>([])
  // dots shown: by «¿llegó el dato?» (the chips) and, from a cell of the summary, by the signal too
  const [filter, setFilter] = useState<{ delivery: Delivery | null; observed: Observed | null }>({ delivery: null, observed: null })
  const [summary, setSummary] = useState<'today' | 'all' | null>(null)
  const syncingRef = useRef(false)

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
    if (!q.length || !navigator.onLine || syncingRef.current) return      // one upload at a time
    syncingRef.current = true
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
      setError('')
      await refresh()
    } catch {
      // a dropped connection is normal in the field: the tests wait on the phone and the next try uploads them
      setError('Sin conexión estable: las pruebas se quedan en el teléfono y se suben solas en cuanto haya señal.')
    } finally {
      syncingRef.current = false
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

  // a test of mine (or any, for an admin) can be deleted; one not uploaded yet just leaves the queue
  const canDelete = (t: FieldTest) => !t.author_id || t.author_id === account.id || account.role === 'admin'
  const remove = async (t: FieldTest) => {
    if (!await askConfirm('¿Borrar esta prueba de campo? No se puede deshacer.', { ok: 'Borrar prueba', danger: true })) return
    try {
      if (pending.some((x) => x.client_id === t.client_id)) dequeue([t.client_id])
      else await cloud.deleteFieldTest(t.client_id)
      setPending(queued())
      setPicked(null)
      await refresh()
    } catch (e) {
      setError(`No se pudo borrar la prueba: ${e instanceof Error ? e.message : e}`)
    }
  }

  const shown = useMemo(() => [...pending, ...tests.filter((t) => !pending.some((p) => p.client_id === t.client_id))], [pending, tests])
  const today = shown.filter(isToday)
  const visible = shown.filter((t) => (!filter.delivery || deliveryOf(t) === filter.delivery) && (!filter.observed || t.observed === filter.observed))
  const downloadCsv = () => {
    const names = new Map((rows ?? []).map((r) => [r.id, r.name]))
    downloadBlob(new Blob([testsCsv(shown, (id) => (id && names.get(id)) || '')], { type: 'text/csv;charset=utf-8' }),
      `pruebas_campo_4g_${new Date().toISOString().slice(0, 10)}.csv`)
  }
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
          mode={mode} showCoverage={showCoverage} showLabels pin={null} focus={focus} cursor={null} profilePins={[]} ruler={ruler}
          onSelect={() => {}} onMove={() => {}} onAdd={(lat, lon) => start({ lat, lon, accuracy: 0 })}
          onRulerPoint={(lat, lon) => setRuler((r) => [...r, [lat, lon]])} onRulerDone={() => setMode('select')}
          onToggleRuler={() => {
            if (mode === 'ruler') setMode('select')
            else { setRuler([]); setDraft(null); setPicked(null); setMode('ruler') }
          }}
          coverageAvailable={catalog.cell_operators.length > 0} onToggleCoverage={() => setShowCoverage((v) => !v)}
          readOnly fieldTests={shown} testPoints={visible} autoLocate
          onLocate={(here) => { setMe(here); setGeoError('') }} onLocateError={setGeoError}
          onFieldTest={(id) => { setDraft(null); setPicked(shown.find((t) => t.client_id === id) ?? null) }} />
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

      <RulerBox points={ruler} active={mode === 'ruler'} onDone={() => setMode('select')}
        onClear={() => { setRuler([]); setMode('select') }} />
      {!draft && !picked && !summary && mode !== 'ruler' && (
        <div className="field-actions">
          {geoError && <p className="field-geo">{geoError}</p>}
          {mode === 'pick' ? (
            <div className="mode-banner field-pick" role="status">
              <span>Toca el mapa donde hiciste la prueba</span>
              <button onClick={() => setMode('select')}>Cancelar</button>
            </div>
          ) : (
            <>
              {shown.length > 0 && (
                <div className="field-filter" role="group" aria-label="Mostrar pruebas">
                  {([null, ...DELIVERIES] as (Delivery | null)[]).map((d) => (
                    <button key={d ?? 'all'} className={`chip ${filter.delivery === d && !filter.observed ? 'active' : ''}`} aria-pressed={filter.delivery === d && !filter.observed}
                      onClick={() => setFilter({ delivery: d, observed: null })}>
                      {d ? DELIVERY[d] : 'Todas'} <b>{d ? shown.filter((t) => deliveryOf(t) === d).length : shown.length}</b></button>
                  ))}
                  {filter.observed && (
                    <button className="chip active" onClick={() => setFilter({ delivery: null, observed: null })} title="Quitar el filtro">
                      {OBSERVED[filter.observed].label}{filter.delivery ? ` · ${DELIVERY[filter.delivery]}` : ''} <b>{visible.length}</b> <Icon name="x" size={12} /></button>
                  )}
                </div>
              )}
              <button className="field-today" onClick={() => setSummary(today.length ? 'today' : 'all')} disabled={!shown.length}
                title="Resumen de las pruebas">
                {today.length ? `Hoy: ${today.length} prueba${today.length === 1 ? '' : 's'} · ${todayAgree} coinciden con el mapa` : 'Sin pruebas hoy'}
                {shown.length > 0 && <Icon name="chevron-up" size={14} />}</button>
              <div className="field-buttons">
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
                : <p className="agree no"><Icon name="alert" size={16} /> No coincide: el mapa la da como {PREDICTED_LABEL[draft.predicted.state]}
                    (se esperaría {OBSERVED[EXPECTED[draft.predicted.state]].label.toLowerCase()}) y aquí la señal es{' '}
                    {comparedToMap(draft.predicted.state, draft.observed)} de lo que dice. Esta prueba lo corrige aquí.</p>
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
      {summary && (
        <section className="field-sheet" role="dialog" aria-label="Resumen de pruebas">
          <div className="phone-sheet-bar">
            <div className="phone-sheet-title"><b>Resumen de pruebas</b></div>
            <CloseButton onClick={() => setSummary(null)} label="Cerrar el resumen" />
          </div>
          <div className="field-sheet-body">
            <div className="segmented edit-toggle" role="radiogroup" aria-label="Pruebas">
              {([['today', 'Hoy'], ['all', 'Todas']] as const).map(([k, l]) => (
                <button key={k} role="radio" aria-checked={summary === k} className={summary === k ? 'active' : ''} onClick={() => setSummary(k)}>{l}</button>
              ))}
            </div>
            <p className="hint">Toca una casilla para ver solo esas pruebas en el mapa.</p>
            {(() => {
              const set = summary === 'today' ? today : shown
              const count = (o: Observed | null, d: Delivery | null) =>
                set.filter((t) => (!o || t.observed === o) && (!d || deliveryOf(t) === d)).length
              const pick = (o: Observed | null, d: Delivery | null) => { setFilter({ observed: o, delivery: d }); setSummary(null) }
              return (
                <table className="field-summary">
                  <thead><tr><th>Señal reportada</th>{DELIVERIES.map((d) => <th key={d}>{DELIVERY[d]}</th>)}<th>Total</th></tr></thead>
                  <tbody>
                    {(Object.keys(OBSERVED) as Observed[]).map((o) => (
                      <tr key={o}>
                        <th><TestDot t={{ observed: o, delivered: true }} size={12} /> {OBSERVED[o].label}</th>
                        {DELIVERIES.map((d) => <td key={d}><button onClick={() => pick(o, d)} disabled={!count(o, d)}>{count(o, d)}</button></td>)}
                        <td><button onClick={() => pick(o, null)} disabled={!count(o, null)}><b>{count(o, null)}</b></button></td>
                      </tr>
                    ))}
                    <tr><th>Total</th>
                      {DELIVERIES.map((d) => <td key={d}><button onClick={() => pick(null, d)} disabled={!count(null, d)}><b>{count(null, d)}</b></button></td>)}
                      <td><b>{set.length}</b></td></tr>
                  </tbody>
                </table>
              )
            })()}
            <div className="field-legend">
              <span><TestDot t={{ observed: 'stable', delivered: true }} size={14} /> Relleno: la señal que reportaste</span>
              <span><TestDot t={{ observed: 'intermittent', delivered: true }} size={14} /> Borde blanco: el dato llegó</span>
              <span><TestDot t={{ observed: 'intermittent', delivered: false }} size={14} /> Borde rojo con ✕: no llegó</span>
              <span><TestDot t={{ observed: 'intermittent', delivered: null }} size={14} /> Borde gris delgado: no se sabe</span>
            </div>
            <p className="hint">Las pruebas son de todo el equipo y corrigen la cobertura en todos los proyectos. El CSV las junta
              todas para calibrar el mapa más adelante.</p>
            <button className="btn self-center" onClick={downloadCsv}><Icon name="download" /> Descargar pruebas (CSV)</button>
          </div>
        </section>
      )}
      {picked && (
        <section className="field-sheet field-test-card" role="dialog" aria-label="Prueba de campo">
          <div className="phone-sheet-bar">
            <div className="phone-sheet-title">
              <TestDot t={picked} />
              <div className="device-head-text"><b>{OBSERVED[picked.observed].label}</b>
                <span>{new Date(picked.taken_at).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' })}
                  {picked.author_id === account.id || !picked.author_id ? ' · tuya' : ''}
                  {pending.some((x) => x.client_id === picked.client_id) ? ' · por subir' : ''}</span></div>
            </div>
            <CloseButton onClick={() => setPicked(null)} label="Cerrar la prueba" />
          </div>
          <div className="field-sheet-body">
            <p className="hint">{OBSERVED[picked.observed].hint}.
              {picked.predicted ? ` El mapa la daba como ${PREDICTED_LABEL[picked.predicted]}: ${agrees(picked.predicted, picked.observed) ? 'coincide' : `no coincide (señal ${comparedToMap(picked.predicted, picked.observed)})`}.` : ''}
              {picked.delivered === true ? ' El dato llegó al servidor.' : picked.delivered === false ? ' El dato no llegó al servidor.' : ''}
              {picked.rssi_dbm != null ? ` RSSI ${picked.rssi_dbm} dBm.` : ''}</p>
            {picked.notes && <p className="test-notes">{picked.notes}</p>}
            {canDelete(picked) && (
              <button className="btn-danger self-center" onClick={() => remove(picked)}><Icon name="x" /> Borrar esta prueba</button>
            )}
          </div>
        </section>
      )}
      {error && <div className="field-error"><Alert>{error}</Alert><CloseButton onClick={() => setError('')} /></div>}
    </div>
  )
}
