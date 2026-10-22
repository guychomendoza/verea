import { useRef } from 'react'
import type { MapMode } from './MapView'
import { COLORS } from './colors'
import { isCellular } from './project'
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
  onMeta: (name: string) => void
  onSelect: (s: Selection, focus?: boolean) => void
  onShowCoverage: (v: boolean) => void
  onShowLabels: (v: boolean) => void
  onImport: (file: File) => void
  onExport: () => void
  onNew: () => void
}

const MODEL_LABELS: Record<string, string> = { itm: 'Longley-Rice (ITM)', simple: 'Simple (FSPL + diffraction)' }

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
    <aside className="panel left-panel" aria-label="Project">
      {p.user && (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="truncate" title={p.user.name}>👤 {p.user.name}</span>
          <button className="btn-ghost underline" onClick={p.user.onSignOut}>Sign out</button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <input className="grow font-semibold" placeholder="Untitled project" value={p.project.name}
          maxLength={80} onChange={(e) => p.onMeta(e.target.value)} aria-label="Project name" />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {p.user && <button className="btn" onClick={p.user.onProjects}>Projects…</button>}
        <button className="btn" onClick={p.onNew}>New</button>
        <button className="btn" onClick={() => file.current?.click()}>{p.user ? 'Import file…' : 'Open…'}</button>
        <button className="btn" onClick={p.onExport}>Save file</button>
        <input ref={file} type="file" accept=".json,application/json" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) p.onImport(f); e.target.value = '' }} />
      </div>
      <p className="hint" role="status">{p.status}</p>

      {/* ── add devices ── */}
      <section>
        <h3>Add to the map</h3>
        <div className="flex flex-wrap gap-1.5">
          <button className={`btn ${p.mode === 'addGateway' ? 'btn-active' : ''}`}
            onClick={() => p.onMode(p.mode === 'addGateway' ? 'select' : 'addGateway')}>+ Gateway</button>
          <select className="btn" value={p.mode === 'addNode' ? p.addModel : ''}
            onChange={(e) => p.onMode(e.target.value ? 'addNode' : 'select', e.target.value)}
            aria-label="Add node">
            <option value="">+ Node…</option>
            <optgroup label="LoRaWAN">
              {lora.map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </optgroup>
            <optgroup label="4G">
              {cellModels.map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </optgroup>
          </select>
        </div>
        {p.mode !== 'select' && <p className="hint">Click the map to place it. Esc to cancel.</p>}
      </section>

      {/* ── devices ── */}
      <section>
        <h3>Gateways ({p.project.gateways.length})</h3>
        <ul className="device-list">
          {p.project.gateways.map((g) => (
            <li key={g.name}>
              <button className={p.selection?.name === g.name ? 'selected' : ''}
                onClick={() => p.onSelect({ kind: 'gateway', name: g.name }, true)}>
                {dot(g.online ? COLORS.gateway : COLORS.none)} {g.name}
                {!g.online && <span className="hint">offline</span>}
              </button>
            </li>
          ))}
        </ul>
        <h3>Nodes ({p.project.nodes.length})</h3>
        <ul className="device-list">
          {p.project.nodes.map((n) => {
            const cell = isCellular(p.catalog, n)
            const l = p.links[n.name]?.link
            return (
              <li key={n.name}>
                <button className={p.selection?.name === n.name ? 'selected' : ''}
                  onClick={() => p.onSelect({ kind: 'node', name: n.name }, true)}>
                  {dot(nodeColor(n.name, cell))} {n.name}
                  <span className="hint ml-auto">
                    {cell ? (p.cells[n.name]?.short ?? '4G') : l ? `${l.margin_db.toFixed(1)} dB` : ''}
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
        <label className="field"><span>Frequency (MHz)</span>
          <select value={s.freq_mhz} onChange={(e) => p.onSettings({ freq_mhz: Number(e.target.value) })}>
            {p.catalog.freq_mhz.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
        <label className="field"><span>Safety margin: {s.safety_margin} dB</span>
          <input type="range" min={0} max={25} step={0.5} value={s.safety_margin}
            onChange={(e) => p.onSettings({ safety_margin: Number(e.target.value) })} />
          <small className="hint">Reserve for fading, rain, foliage and things not in the map. Link margin is what is left over it.</small>
        </label>
        <label className="field"><span>Default environment (new nodes)</span>
          <select value={s.environment} onChange={(e) => p.onSettings({ environment: e.target.value })}>
            {Object.entries(p.catalog.environments).map(([k, v]) => (
              <option key={k} value={k}>{k} (+{v.clutter_loss_db} dB)</option>
            ))}
          </select>
        </label>
        <label className="field"><span>Propagation model</span>
          <select value={s.propagation_model} onChange={(e) => p.onSettings({ propagation_model: e.target.value })}>
            {p.catalog.propagation_models.map((m) => <option key={m} value={m}>{MODEL_LABELS[m] ?? m}</option>)}
          </select>
        </label>
      </section>

      <section>
        <h3>Map</h3>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={p.showLabels} onChange={(e) => p.onShowLabels(e.target.checked)} />
          Place names, roads and boundaries
        </label>
      </section>

      <section>
        <h3>4G coverage</h3>
        {p.catalog.cell_operators.length ? (
          <>
            <label className="field"><span>Operator</span>
              <select value={s.cell_operator ?? ''} onChange={(e) => p.onSettings({ cell_operator: e.target.value || undefined })}>
                <option value="">—</option>
                {p.catalog.cell_operators.map((o) => <option key={o}>{o}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={p.showCoverage} onChange={(e) => p.onShowCoverage(e.target.checked)} />
              Show on map
            </label>
            {p.showCoverage && (
              <p className="hint">
                {dot('#2a9d8f')} guaranteed · {dot('#e9c46a')} near an area without signal (250–500 m by terrain) · {dot('#e63946')} none declared
              </p>
            )}
          </>
        ) : <p className="hint">No coverage data on the server.</p>}
      </section>
    </aside>
  )
}
