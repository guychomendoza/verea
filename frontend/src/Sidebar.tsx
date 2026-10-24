import { useEffect, useMemo, useRef, useState } from 'react'
import type { MapMode } from './MapView'
import { COLORS } from './colors'
import { cellColor, cellShort } from './mapStyle'
import { KIND_LABELS, type DeviceKind } from './deviceIcons'
import { DeviceIcon, Logo } from './Logo'
import { Icon, type IconName } from './icons'
import { db } from './geo'
import { STATE_GROUPS, nodeState } from './nodeStatus'
import { isCellular, isStation } from './project'
import { SHORTCUT_HELP } from './shortcuts'
import type { SaveState } from './autosave'
import type { Catalog, CellStatus, LinkResult, NodeDevice, Project, Selection, Settings } from './types'

interface Props {
  catalog: Catalog
  project: Project
  selection: Selection
  links: Record<string, LinkResult>
  cells: Record<string, CellStatus>
  mode: MapMode
  addModel: string
  showCoverage: boolean
  showLabels: boolean
  status: string
  user?: { onProjects?: () => void; onShare?: () => void }
  save?: { state: SaveState; savedAt: Date | null; autosave: boolean; onSave: () => void }   // team cloud projects
  edit?: { on: boolean; onChange: (on: boolean) => void }     // Ver / Editar (not for viewers)
  onConfig: () => void                 // Configuración: account and appearance
  // Viewer mode: the project is read-only except heights / environments, which are the viewer's own
  viewer?: { changes: number; onRestore: () => void; onFiles: () => void }
  onMode: (m: MapMode, model?: string) => void
  onSettings: (patch: Partial<Settings>) => void
  onMeta: (meta: { name?: string; description?: string }) => void
  onSelect: (s: Selection, focus?: boolean) => void
  onShowLabels: (v: boolean) => void
  onImport: (file: File) => void
  onExport: () => void
  onNew: () => void
  onReport: () => void
  onImportPlots: () => void
  onSuggest: () => void
  onBulk: (preset?: { groups: string[]; model?: string }) => void
  onBulkEnvironment: (names: string[], environment: string) => void
  ranges: { any: boolean; loading: boolean; onAll: () => void; onHide: () => void }
  history: { canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void }
}

const MODEL_LABELS: Record<string, string> = { itm: 'Longley-Rice (ITM)', simple: 'Simple (espacio libre + difracción)' }
const SECTIONS_KEY = 'verea.sections'
const byName = (a: NodeDevice, b: NodeDevice) => a.name.localeCompare(b.name, 'es', { numeric: true, sensitivity: 'base' })

function dot(color: string) {
  return <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
}

function savedSections(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? '{}')
  } catch {
    return {}
  }
}

/** A part of the panel that folds; whether it is open is remembered in this browser. */
function Section({ id, title, icon, count, defaultOpen = true, nested = false, actions, children }: {
  id: string; title: string; icon?: React.ReactNode; count?: number | string; defaultOpen?: boolean; nested?: boolean
  actions?: React.ReactNode; children: React.ReactNode
}) {
  const [open, setOpen] = useState(() => savedSections()[id] ?? defaultOpen)
  const toggle = () => {
    setOpen(!open)
    try {
      localStorage.setItem(SECTIONS_KEY, JSON.stringify({ ...savedSections(), [id]: !open }))
    } catch { /* private mode: not remembered */ }
  }
  return (
    <section className={`side-section ${nested ? 'nested' : ''}`}>
      <div className="section-head">
        <button type="button" className="section-toggle" aria-expanded={open} onClick={toggle}>
          <Icon name="chevron" size={14} className="chev" />
          {icon}
          <h3>{title}</h3>
          {count !== undefined && <span className="section-count">{count}</span>}
        </button>
        {open && actions}
      </div>
      {/* kept mounted so it can fold smoothly; hidden from keyboard and screen readers while closed */}
      <div className={`fold ${open ? 'open' : ''}`} aria-hidden={!open} inert={!open}>
        <div className="fold-inner"><div className="section-body">{children}</div></div>
      </div>
    </section>
  )
}

/** "Archivo": the project file actions, out of the way of the everyday ones. */
type MenuItem = [label: string, run: () => void, title: string, icon: IconName]

function FileMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [open])
  return (
    <div className="menu" ref={ref}>
      <button className="btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        Archivo <Icon name="chevron" size={14} className={`menu-chev ${open ? 'open' : ''}`} />
      </button>
      {open && (
        <div className="menu-list" role="menu">
          {items.map(([label, run, title, icon]) => (
            <button key={label} role="menuitem" title={title} onClick={() => { setOpen(false); run() }}>
              <Icon name={icon} /> {label}</button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Sidebar(p: Props) {
  const file = useRef<HTMLInputElement>(null)
  const [describing, setDescribing] = useState(false)
  const ro = !!p.viewer || (!!p.edit && !p.edit.on)      // nothing editable (a viewer, or Ver)
  const s = p.project.settings
  const lora = Object.entries(p.catalog.node_profiles).filter(([, v]) => v.link !== 'cellular')
  const cellModels = Object.entries(p.catalog.node_profiles).filter(([, v]) => v.link === 'cellular')

  const nodeColor = (name: string, cellular: boolean) => {
    if (cellular) return cellColor(p.cells[name])
    const l = p.links[name]?.link
    return !l ? COLORS.none : l.viable ? COLORS.viable : l.margin_db > -5 ? COLORS.marginal : COLORS.fail
  }

  // ── node list: filters, then one group per technology, each alphabetical ──
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('')
  const kindOf = (n: NodeDevice): DeviceKind => (isCellular(p.catalog, n) ? 'cellular' : isStation(p.catalog, n) ? 'station' : 'lora')
  const stateOf = useMemo(() => new Map(p.project.nodes.map((n) =>
    [n.name, nodeState(n, isCellular(p.catalog, n), p.links, p.cells)])), [p.project.nodes, p.catalog, p.links, p.cells])
  const inGroup = (name: string, key: string) => STATE_GROUPS.find((g) => g.key === key)!.states.includes(stateOf.get(name)!)
  const groupCount = (key: string) => p.project.nodes.filter((n) => inGroup(n.name, key)).length
  const q = query.trim().toLowerCase()
  const shown = p.project.nodes.filter((n) => (!filter || inGroup(n.name, filter))
    && (!q || `${n.name} ${n.owner ?? ''}`.toLowerCase().includes(q)))
  const groups = (['lora', 'cellular', 'station'] as DeviceKind[]).map((kind) => ({
    kind, all: p.project.nodes.filter((n) => kindOf(n) === kind).length,
    nodes: shown.filter((n) => kindOf(n) === kind).sort(byName),
  })).filter((g) => g.all > 0)
  const noCell = groupCount('cell-none')

  // Environment of every LoRa node at once (crop stage); '' when they differ
  const loraNodes = p.project.nodes.filter((n) => !isCellular(p.catalog, n))
  const envs = new Set(loraNodes.map((n) => n.environment ?? s.environment))
  const commonEnv = envs.size === 1 ? [...envs][0] : ''

  const fileItems: MenuItem[] = p.viewer ? [] : ([
    ['Nuevo', p.onNew, 'Un proyecto vacío', 'file-plus'],
    [p.user ? 'Importar archivo…' : 'Abrir…', () => file.current?.click(), 'Un proyecto .verea.json', 'upload'],
    ['Guardar archivo', p.onExport, 'Descargar el proyecto como .verea.json', 'download'],
    ['Importar parcelas…', p.onImportPlots, 'KML, KMZ, Excel o CSV con pines y parcelas', 'layers'],
  ] as MenuItem[]).filter(([label]) => !ro || label !== 'Importar parcelas…')

  const history = (
    <span className="history-btns">
      <button className="icon-btn" onClick={p.history.onUndo} disabled={!p.history.canUndo} title="Deshacer (Ctrl+Z)" aria-label="Deshacer">
        <Icon name="undo" /></button>
      <button className="icon-btn" onClick={p.history.onRedo} disabled={!p.history.canRedo} title="Rehacer (Ctrl+Y)" aria-label="Rehacer">
        <Icon name="redo" /></button>
    </span>
  )

  return (
    <aside className="panel side-panel" aria-label="Proyecto">
      <div className="brand-bar">
        <Logo width={104} />
        {p.edit && <EditToggle {...p.edit} />}
        <button className={`icon-btn ${p.edit ? '' : 'ml-auto'}`} onClick={p.onConfig} title="Configuración: cuenta y apariencia"
          aria-label="Configuración"><Icon name="settings" size={17} /></button>
      </div>

      {/* ── the project: name, description, what it has ── */}
      <div className="project-card">
        <div className="project-head">
          {ro ? (
            <h2 className="project-title">{p.project.name || 'Proyecto sin nombre'}</h2>
          ) : (
            <input className="project-name" placeholder="Proyecto sin nombre" value={p.project.name}
              maxLength={80} onChange={(e) => p.onMeta({ name: e.target.value })} aria-label="Nombre del proyecto" />
          )}
          {p.user?.onProjects && (
            <button className="icon-btn" onClick={p.user.onProjects} title="Abrir otro proyecto del equipo" aria-label="Proyectos…">
              <Icon name="folder" /></button>
          )}
        </div>
        {ro ? (
          p.project.description && <p className="project-description-text whitespace-pre-line">{p.project.description}</p>
        ) : (p.project.description || describing) ? (
          <textarea className="project-description" rows={2} maxLength={2000} placeholder="Descripción (aparece en el reporte)"
            value={p.project.description} autoFocus={describing && !p.project.description}
            onChange={(e) => p.onMeta({ description: e.target.value })}
            onBlur={() => setDescribing(false)} aria-label="Descripción del proyecto" />
        ) : (
          <button className="link-btn self-start" onClick={() => setDescribing(true)}>
            <Icon name="plus" size={13} /> Agregar descripción</button>
        )}
        <div className="project-stats" aria-label="Contenido del proyecto">
          <span><DeviceIcon kind="gateway" color="#3da3bc" size={15} /> <b>{p.project.gateways.length}</b> {p.project.gateways.length === 1 ? 'gateway' : 'gateways'}</span>
          <span><DeviceIcon kind="lora" color="#3da3bc" size={15} /> <b>{loraNodes.length}</b> LoRa</span>
          <span><DeviceIcon kind="cellular" color="#3da3bc" size={15} /> <b>{p.project.nodes.length - loraNodes.length}</b> 4G</span>
        </div>
        {p.viewer && (
          <div className="viewer-banner" role="note">
            <Icon name="eye" /><span><b>Modo lector.</b> Puedes probar otra altura o entorno en los nodos; se guarda solo para ti.</span>
            {p.viewer.changes > 0 && (
              <button className="btn-ghost underline" onClick={p.viewer.onRestore}>
                Restaurar valores originales ({p.viewer.changes})</button>
            )}
          </div>
        )}
      </div>

      {/* ── actions: save, file, share, report, undo ── */}
      <div className="action-bar">
        {p.save && <div className="save-row"><SaveButton {...p.save} />{history}</div>}
        <div className="action-row">
          {p.viewer && <button className="btn" onClick={p.viewer.onFiles}><Icon name="arrow-left" /> Mis archivos</button>}
          {fileItems.length > 0 && <FileMenu items={fileItems} />}
          {p.user?.onShare && <button className="btn" onClick={p.user.onShare} title="Link para ver el proyecto en modo lector">
            <Icon name="link" /> Compartir</button>}
          <button className="btn" onClick={p.onReport} title="Reporte PDF del proyecto"><Icon name="report" /> Reporte</button>
          {!p.save && history}
        </div>
        <input ref={file} type="file" accept=".json,application/json" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) p.onImport(f); e.target.value = '' }} />
      </div>
      <StatusLine text={p.status} />

      {/* ── add devices / tools ── */}
      {!ro && (
        <Section id="add" title="Agregar al mapa" icon={<SectionIcon name="plus" />}>
          <div className="flex flex-wrap gap-1.5">
            <button className={`btn ${p.mode === 'addGateway' ? 'btn-active' : ''}`} title="G"
              onClick={() => p.onMode(p.mode === 'addGateway' ? 'select' : 'addGateway')}><Icon name="plus" size={14} /> Gateway</button>
            <select className="btn" value={p.mode === 'addNode' ? p.addModel : ''}
              onChange={(e) => p.onMode(e.target.value ? 'addNode' : 'select', e.target.value)}
              aria-label="Agregar nodo">
              <option value="">+ Nodo…</option>
              <optgroup label="LoRaWAN">
                {lora.map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </optgroup>
              <optgroup label="4G">
                {cellModels.map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </optgroup>
            </select>
            {loraNodes.length > 0 && (
              <button className="btn" onClick={p.onSuggest} title="Ubicaciones para gateways con 4G propio, según el relieve">
                Sugerir gateways 4G…</button>
            )}
          </div>
          {(p.mode === 'addGateway' || p.mode === 'addNode') && <p className="hint">Haz clic en el mapa para colocarlo. Esc para cancelar.</p>}
        </Section>
      )}

      {/* ── gateways ── */}
      <Section id="gateways" title="Gateways" icon={<SectionIcon name="gateway" />} count={p.project.gateways.length}
        actions={p.project.gateways.length > 0 && (
          <button className="btn-ghost underline text-xs" disabled={p.ranges.loading}
            onClick={p.ranges.any ? p.ranges.onHide : p.ranges.onAll}>
            {p.ranges.loading ? 'Calculando…' : p.ranges.any ? 'Ocultar alcance' : 'Alcance de todos'}
          </button>
        )}>
        {p.project.gateways.length === 0 && <p className="hint">Sin gateways todavía.</p>}
        <ul className="device-list">
          {[...p.project.gateways].sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true })).map((g) => (
            <li key={g.name}>
              <button className={p.selection?.name === g.name ? 'selected' : ''}
                onClick={() => p.onSelect({ kind: 'gateway', name: g.name }, true)}>
                <DeviceIcon kind="gateway" color={g.online ? COLORS.gateway : COLORS.none} /> {g.name}
                <span className="hint ml-auto">{g.online ? (g.backhaul === '4g' ? '4G' : 'WiFi/Ethernet') : 'fuera de línea'}</span>
              </button>
            </li>
          ))}
        </ul>
      </Section>

      {/* ── sensors, by technology ── */}
      <Section id="nodes" title="Sensores" icon={<SectionIcon name="sensors" />}
        count={shown.length === p.project.nodes.length ? p.project.nodes.length : `${shown.length} de ${p.project.nodes.length}`}
        actions={p.project.nodes.length > 0 && !ro && (
          <button className="btn-ghost underline text-xs" onClick={() => p.onBulk()}>Cambiar modelo…</button>
        )}>
        {p.project.nodes.length === 0 && <p className="hint">Sin sensores todavía.</p>}
        {loraNodes.length > 1 && (
          <label className="field env-all">
            <span>Entorno de todos los nodos LoRa (etapa del cultivo)</span>
            <select value={commonEnv} aria-label="Entorno de todos los nodos LoRa"
              onChange={(e) => e.target.value && p.onBulkEnvironment(loraNodes.map((n) => n.name), e.target.value)}>
              {!commonEnv && <option value="">Varios entornos…</option>}
              {Object.entries(p.catalog.environments).map(([k, v]) => (
                <option key={k} value={k}>{v.label} (+{v.clutter_loss_db} dB)</option>
              ))}
            </select>
          </label>
        )}
        {p.project.nodes.length > 3 && (
          <>
            <input type="search" placeholder="Buscar nodo, titular o folio" value={query} aria-label="Buscar nodo"
              onChange={(e) => setQuery(e.target.value)} />
            <div className="node-filters" role="group" aria-label="Filtrar por estado">
              {[{ key: '', label: 'Todos' }, ...STATE_GROUPS.filter((g) => groupCount(g.key))].map((g) => (
                <button key={g.key} className={`chip ${filter === g.key ? 'active' : ''}`} aria-pressed={filter === g.key}
                  onClick={() => setFilter(g.key)}>{g.label}{g.key ? ` (${groupCount(g.key)})` : ''}</button>
              ))}
            </div>
          </>
        )}
        <div role="region" aria-label="Lista de sensores">
          {groups.map((g) => g.nodes.length > 0 && (
            <Section key={g.kind} id={`nodes-${g.kind}`} nested title={GROUP_TITLES[g.kind]}
              icon={<DeviceIcon kind={g.kind} color="#3da3bc" size={15} />}
              count={g.nodes.length === g.all ? g.all : `${g.nodes.length} de ${g.all}`}>
              <ul className="device-list">
                {g.nodes.map((n) => {
                  const cell = g.kind === 'cellular'
                  const l = p.links[n.name]?.link
                  return (
                    <li key={n.name}>
                      <button className={p.selection?.name === n.name ? 'selected' : ''} title={n.owner}
                        onClick={() => p.onSelect({ kind: 'node', name: n.name }, true)}>
                        <DeviceIcon kind={g.kind} color={nodeColor(n.name, cell)} /> {n.name}
                        <span className="hint ml-auto">
                          {cell ? cellShort(p.cells[n.name]) : l ? db(l.margin_db) : ''}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </Section>
          ))}
          {p.project.nodes.length > 0 && shown.length === 0 && <p className="hint">Ningún sensor coincide con el filtro.</p>}
        </div>
      </Section>

      {/* ── 4G ── */}
      <Section id="cell" title="Cobertura 4G" icon={<SectionIcon name="signal" />}>
        {p.catalog.cell_operators.length ? (
          <>
            <label className="field"><span>Operador</span>
              <select value={s.cell_operator ?? ''} disabled={ro} onChange={(e) => p.onSettings({ cell_operator: e.target.value || undefined })}>
                <option value="">—</option>
                {p.catalog.cell_operators.map((o) => <option key={o}>{o}</option>)}
              </select>
            </label>
            {noCell > 0 && !ro && (
              <button className="btn" onClick={() => p.onBulk({ groups: ['cell-none'], model: 'dragino_se0x_lb' })}>
                Cambiar los {noCell} sensores sin 4G a LoRa…
              </button>
            )}
            <ul className="color-key">
              <li>{dot(COLORS.cellOk)} Garantizada</li>
              <li>{dot(COLORS.cellEdge)} Incierta: cerca del borde (125–250 m según el terreno)</li>
              <li>{dot(COLORS.cellPossible)} Posible solo para sensores LTE-M / NB-IoT (100–300 m fuera)</li>
              <li>{dot(COLORS.cellNone)} Sin cobertura</li>
            </ul>
            <p className="hint">Muéstrala en el mapa con el botón «Cobertura 4G» (abajo a la derecha).</p>
          </>
        ) : <p className="hint">El servidor no tiene datos de cobertura.</p>}
      </Section>

      {/* ── radio settings ── */}
      <Section id="radio" title="Ajustes de radio" icon={<SectionIcon name="sliders" />} defaultOpen={false}>
        <fieldset disabled={ro} className="contents">
          <label className="field"><span>Frecuencia (MHz)</span>
            <select value={s.freq_mhz} onChange={(e) => p.onSettings({ freq_mhz: Number(e.target.value) })}>
              {p.catalog.freq_mhz.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </label>
          <label className="field"><span>Margen de seguridad: {s.safety_margin} dB</span>
            <input type="range" min={0} max={25} step={0.5} value={s.safety_margin}
              onChange={(e) => p.onSettings({ safety_margin: Number(e.target.value) })} />
            <small className="hint">Reserva para desvanecimientos, lluvia, follaje y lo que el mapa no ve. El margen del enlace es lo que sobra por encima.</small>
          </label>
          <label className="field"><span>Entorno por defecto (nodos nuevos)</span>
            <select value={s.environment} onChange={(e) => p.onSettings({ environment: e.target.value })}>
              {Object.entries(p.catalog.environments).map(([k, v]) => (
                <option key={k} value={k}>{v.label} (+{v.clutter_loss_db} dB)</option>
              ))}
            </select>
          </label>
          <label className="field"><span>Modelo de propagación</span>
            <select value={s.propagation_model} onChange={(e) => p.onSettings({ propagation_model: e.target.value })}>
              {p.catalog.propagation_models.map((m) => <option key={m} value={m}>{MODEL_LABELS[m] ?? m}</option>)}
            </select>
          </label>
        </fieldset>
      </Section>

      {/* ── map ── */}
      <Section id="map" title="Mapa y simbología" icon={<SectionIcon name="map" />} defaultOpen={false}>
        <div className="symbology" aria-label="Simbología">
          {(['gateway', 'lora', 'cellular', 'station'] as DeviceKind[]).map((k) => (
            <span key={k}><DeviceIcon kind={k} color="#5a6b80" /> {KIND_LABELS[k]}</span>
          ))}
        </div>
        <p className="hint">
          Color = estado: {dot(COLORS.viable)} viable · {dot(COLORS.marginal)} marginal · {dot(COLORS.fail)} no viable ·{' '}
          {dot(COLORS.none)} sin resultado
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={p.showLabels} onChange={(e) => p.onShowLabels(e.target.checked)} />
          Nombres de lugares, carreteras y límites
        </label>
      </Section>

      {!p.viewer && (
        <Section id="shortcuts" title="Atajos de teclado" icon={<SectionIcon name="keyboard" />} defaultOpen={false}>
          <dl className="shortcuts">
            {SHORTCUT_HELP.map(([k, v]) => (<div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>))}
          </dl>
        </Section>
      )}
    </aside>
  )
}

const SectionIcon = ({ name }: { name: IconName }) => <Icon name={name} size={15} />

const GROUP_TITLES: Record<DeviceKind, string> = {
  gateway: 'Gateways', lora: 'Sensores LoRa', cellular: 'Sensores 4G', station: 'Estaciones meteorológicas',
}

/** Guardar (team cloud projects) with the save state beside it. */
function SaveButton({ state, savedAt, autosave, onSave }: NonNullable<Props['save']>) {
  const time = savedAt?.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
  const text = {
    saved: time ? `Guardado ${time}` : 'Guardado',
    saving: 'Guardando…',
    pending: autosave ? 'Se guardará en unos segundos' : 'Cambios sin guardar',
    conflict: 'Sin guardar: hay otra versión',
    error: 'No se pudo guardar',
  }[state]
  return (
    <span className="save-box">
      <button className={`btn ${state === 'pending' || state === 'error' ? 'btn-active' : ''}`} onClick={onSave}
        disabled={state === 'saved' || state === 'saving' || state === 'conflict'} title="Guardar el proyecto (Ctrl+S)">
        <Icon name="save" /> Guardar
      </button>
      <span className={`save-state ${state}`} aria-live="polite">{text}</span>
    </span>
  )
}

/** The status line; parts that start with ⚠ (errors) show as alerts. */
function StatusLine({ text }: { text: string }) {
  const parts = text.split(' · ').filter(Boolean)
  return (
    <p className="status-line" role="status">
      {parts.map((t, i) => t.startsWith('⚠')
        ? <span key={i} className="status-error"><Icon name="alert" size={13} /> {t.replace(/^⚠\s*/, '')}</span>
        : <span key={i}>{t}</span>)}
    </p>
  )
}

/** Ver / Editar: in Ver the map and the panels cannot change anything (no accidental drags). */
function EditToggle({ on, onChange }: NonNullable<Props['edit']>) {
  return (
    <div className="segmented edit-toggle ml-auto" role="radiogroup" aria-label="Modo">
      <button role="radio" aria-checked={!on} className={on ? '' : 'active'} onClick={() => onChange(false)}
        title="Solo ver: nada se mueve por accidente"><Icon name="eye" size={14} /> Ver</button>
      <button role="radio" aria-checked={on} className={on ? 'active' : ''} onClick={() => onChange(true)}
        title="Mover, agregar y cambiar"><Icon name="pencil" size={14} /> Editar</button>
    </div>
  )
}
