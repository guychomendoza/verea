import { useRef } from 'react'
import type { MapMode } from './MapView'
import { COLORS } from './colors'
import { KIND_LABELS, type DeviceKind } from './deviceIcons'
import { DeviceIcon, Logo } from './Logo'
import { db } from './geo'
import { isCellular, isStation } from './project'
import { SHORTCUT_HELP } from './shortcuts'
import type { Catalog, CellStatus, LinkResult, Project, Selection, Settings } from './types'

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
  user?: { name: string; onSignOut: () => void; onProjects: () => void }
  onMode: (m: MapMode, model?: string) => void
  onSettings: (patch: Partial<Settings>) => void
  onMeta: (meta: { name?: string; description?: string }) => void
  onSelect: (s: Selection, focus?: boolean) => void
  onShowCoverage: (v: boolean) => void
  onShowLabels: (v: boolean) => void
  onImport: (file: File) => void
  onExport: () => void
  onNew: () => void
  onReport: () => void
}

const MODEL_LABELS: Record<string, string> = { itm: 'Longley-Rice (ITM)', simple: 'Simple (espacio libre + difracción)' }

function dot(color: string) {
  return <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
}

export default function Sidebar(p: Props) {
  const file = useRef<HTMLInputElement>(null)
  const s = p.project.settings
  const lora = Object.entries(p.catalog.node_profiles).filter(([, v]) => v.link !== 'cellular')
  const cellModels = Object.entries(p.catalog.node_profiles).filter(([, v]) => v.link === 'cellular')

  const nodeColor = (name: string, cellular: boolean) => {
    if (cellular) {
      const c = p.cells[name]
      return !c ? COLORS.none : c.state === 'ok' ? COLORS.cellOk : c.state === 'none' ? COLORS.cellNone : COLORS.cellEdge
    }
    const l = p.links[name]?.link
    return !l ? COLORS.none : l.viable ? COLORS.viable : l.margin_db > -5 ? COLORS.marginal : COLORS.fail
  }

  return (
    <aside className="panel side-panel" aria-label="Proyecto">
      <div className="brand-bar">
        <Logo width={112} />
        {p.user && (
          <div className="flex flex-col items-end text-xs min-w-0">
            <span className="truncate max-w-full" title={p.user.name}>{p.user.name}</span>
            <button className="btn-ghost underline" onClick={p.user.onSignOut}>Cerrar sesión</button>
          </div>
        )}
      </div>
      <input className="font-semibold" placeholder="Proyecto sin nombre" value={p.project.name}
        maxLength={80} onChange={(e) => p.onMeta({ name: e.target.value })} aria-label="Nombre del proyecto" />
      <textarea className="project-description" rows={2} maxLength={2000} placeholder="Descripción (aparece en el reporte)"
        value={p.project.description} onChange={(e) => p.onMeta({ description: e.target.value })}
        aria-label="Descripción del proyecto" />
      <div className="flex flex-wrap gap-1.5">
        {p.user && <button className="btn" onClick={p.user.onProjects}>Proyectos…</button>}
        <button className="btn" onClick={p.onNew}>Nuevo</button>
        <button className="btn" onClick={() => file.current?.click()}>{p.user ? 'Importar archivo…' : 'Abrir…'}</button>
        <button className="btn" onClick={p.onExport}>Guardar archivo</button>
        <button className="btn btn-active" onClick={p.onReport}>📄 Reporte</button>
        <input ref={file} type="file" accept=".json,application/json" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) p.onImport(f); e.target.value = '' }} />
      </div>
      <p className="hint" role="status">{p.status}</p>

      {/* ── add devices / tools ── */}
      <section>
        <h3>Agregar al mapa</h3>
        <div className="flex flex-wrap gap-1.5">
          <button className={`btn ${p.mode === 'addGateway' ? 'btn-active' : ''}`} title="G"
            onClick={() => p.onMode(p.mode === 'addGateway' ? 'select' : 'addGateway')}>+ Gateway</button>
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
        </div>
        {(p.mode === 'addGateway' || p.mode === 'addNode') && <p className="hint">Haz clic en el mapa para colocarlo. Esc para cancelar.</p>}
      </section>

      {/* ── devices ── */}
      <section>
        <h3>Gateways ({p.project.gateways.length})</h3>
        <ul className="device-list">
          {p.project.gateways.map((g) => (
            <li key={g.name}>
              <button className={p.selection?.name === g.name ? 'selected' : ''}
                onClick={() => p.onSelect({ kind: 'gateway', name: g.name }, true)}>
                <DeviceIcon kind="gateway" color={g.online ? COLORS.gateway : COLORS.none} /> {g.name}
                {!g.online && <span className="hint">fuera de línea</span>}
              </button>
            </li>
          ))}
        </ul>
        <h3>Nodos ({p.project.nodes.length})</h3>
        <ul className="device-list">
          {p.project.nodes.map((n) => {
            const cell = isCellular(p.catalog, n)
            const kind: DeviceKind = cell ? 'cellular' : isStation(p.catalog, n) ? 'station' : 'lora'
            const l = p.links[n.name]?.link
            return (
              <li key={n.name}>
                <button className={p.selection?.name === n.name ? 'selected' : ''} title={n.owner}
                  onClick={() => p.onSelect({ kind: 'node', name: n.name }, true)}>
                  <DeviceIcon kind={kind} color={nodeColor(n.name, cell)} /> {n.name}
                  <span className="hint ml-auto">
                    {cell ? (p.cells[n.name]?.short ?? '4G') : l ? db(l.margin_db) : ''}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </section>

      {/* ── settings ── */}
      <section>
        <h3>Radio</h3>
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
      </section>

      <section>
        <h3>Mapa</h3>
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
      </section>

      <section>
        <h3>Cobertura 4G</h3>
        {p.catalog.cell_operators.length ? (
          <>
            <label className="field"><span>Operador</span>
              <select value={s.cell_operator ?? ''} onChange={(e) => p.onSettings({ cell_operator: e.target.value || undefined })}>
                <option value="">—</option>
                {p.catalog.cell_operators.map((o) => <option key={o}>{o}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={p.showCoverage} onChange={(e) => p.onShowCoverage(e.target.checked)} />
              Mostrar en el mapa
            </label>
            {p.showCoverage && (
              <p className="hint">
                {dot('#2a9d8f')} garantizada · {dot('#e9c46a')} cerca de una zona sin señal (250–500 m según el terreno) · {dot('#e63946')} sin cobertura declarada
              </p>
            )}
          </>
        ) : <p className="hint">El servidor no tiene datos de cobertura.</p>}
      </section>

      <section>
        <h3>Atajos de teclado</h3>
        <dl className="shortcuts">
          {SHORTCUT_HELP.map(([k, v]) => (<div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>))}
        </dl>
      </section>
    </aside>
  )
}
