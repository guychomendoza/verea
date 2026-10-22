import { useEffect, useState } from 'react'
import { api } from './api'
import ProfileChart from './ProfileChart'
import { isCellular, nameError } from './project'
import type { Catalog, CellStatus, Gateway, LinkDetail, LinkResult, NodeDevice, Project } from './types'

interface Props {
  catalog: Catalog
  project: Project
  kind: 'gateway' | 'node'
  device: Gateway | NodeDevice
  link?: LinkResult
  cell?: CellStatus
  onRename: (next: string) => void
  onPatch: (patch: Partial<Gateway & NodeDevice>) => void
  onRemove: () => void
  onClose: () => void
}

/** Number input that commits on blur / Enter, so typing does not trigger a recalculation per key. */
function NumberField({ label, value, step = 0.5, min, max, onCommit }: {
  label: string; value?: number; step?: number; min?: number; max?: number; onCommit: (v: number) => void
}) {
  const [text, setText] = useState(value?.toString() ?? '')
  useEffect(() => setText(value?.toString() ?? ''), [value])
  const commit = () => {
    const v = Number(text)
    if (text.trim() === '' || !Number.isFinite(v) || (min !== undefined && v < min) || (max !== undefined && v > max)) {
      setText(value?.toString() ?? '')
      return
    }
    if (v !== value) onCommit(v)
  }
  return (
    <label className="field">
      <span>{label}</span>
      <input type="number" inputMode="decimal" step={step} min={min} max={max} value={text}
        onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
    </label>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  )
}

export default function DevicePanel(p: Props) {
  const [name, setName] = useState(p.device.name)
  const [detail, setDetail] = useState<LinkDetail | null>(null)
  useEffect(() => setName(p.device.name), [p.device.name])
  const err = nameError(p.project, p.device.name, name)
  const node = p.kind === 'node' ? (p.device as NodeDevice) : null
  const gw = p.kind === 'gateway' ? (p.device as Gateway) : null
  const cellular = node ? isCellular(p.catalog, node) : false
  const profiles = p.kind === 'gateway' ? p.catalog.gateway_profiles : p.catalog.node_profiles
  const prof = profiles[p.device.model]

  // Terrain profile of the node's best link
  const best = p.link?.link
  const bestGw = best ? p.project.gateways.find((g) => g.name === best.gateway) : undefined
  useEffect(() => {
    setDetail(null)
    if (!node || !bestGw) return
    const ctrl = new AbortController()
    api.link(bestGw, node, p.project.settings, ctrl.signal).then(setDetail).catch(() => {})
    return () => ctrl.abort()
  }, [node, bestGw, p.project.settings])

  const changeModel = (model: string) => {
    const pr = profiles[model]
    p.onPatch({
      model, height: pr.height, tx_power: pr.tx_power, gain: pr.gain, cable_loss: pr.cable_loss,
      ...(node ? { type: pr.type, sf: pr.sf } : {}),
    })
  }

  return (
    <aside className="panel right-panel" aria-label="Device">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{gw ? '📡 Gateway' : cellular ? '📶 4G sensor' : '📱 Node'}</h2>
        <button className="btn-ghost" onClick={p.onClose} aria-label="Close">✕</button>
      </div>

      <label className="field">
        <span>Name</span>
        <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)}
          onBlur={() => (err ? setName(p.device.name) : name !== p.device.name && p.onRename(name))}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        {err && name !== p.device.name && <em className="error">{err}</em>}
      </label>

      <label className="field">
        <span>Model</span>
        <select value={p.device.model} onChange={(e) => changeModel(e.target.value)}>
          {Object.entries(profiles).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        {prof && <small className="hint">{prof.source}{prof.estimated.length ? ` Estimated: ${prof.estimated.join(', ')}.` : ''}</small>}
      </label>

      {/* ── result ── */}
      {node && !cellular && (
        <section className="result">
          {best ? (
            <>
              <div className={`verdict ${best.viable ? 'ok' : best.margin_db > -5 ? 'warn' : 'bad'}`}>
                {best.viable ? '✅ Viable' : '❌ Not viable'} via {best.gateway}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Metric label="Link margin" value={`${best.margin_db.toFixed(1)} dB`} />
                <Metric label="RSSI" value={`${best.rssi_dbm.toFixed(0)} dBm`} />
                <Metric label="Distance" value={`${(best.distance_m / 1000).toFixed(2)} km`} />
              </div>
              {best.reasons.length > 0 && <ul className="hint list-disc pl-4">{best.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
              {detail ? <ProfileChart profile={detail.profile} /> : <div className="hint">Loading terrain…</div>}
            </>
          ) : (
            <div className="verdict warn">⚠ {p.link?.error ?? 'Calculating…'}</div>
          )}
        </section>
      )}
      {cellular && (
        <section className="result">
          {p.cell ? (
            <>
              <div className={`verdict ${p.cell.state === 'ok' ? 'ok' : p.cell.state === 'none' ? 'bad' : 'warn'}`}>{p.cell.text}</div>
              <div className="grid grid-cols-2 gap-2">
                <Metric label="Covered around (300 m)" value={`${Math.round((p.cell.nearby_share ?? 0) * 100)}%`} />
                {p.cell.covered
                  ? <Metric label="Declared signal" value={p.cell.level_dbm != null ? `${p.cell.level_dbm} dBm` : '—'} />
                  : <Metric label="Nearest coverage" value={p.cell.nearest_m != null ? `${Math.round(p.cell.nearest_m).toLocaleString()} m` : '> 20 km'} />}
              </div>
            </>
          ) : (
            <div className="hint">{p.project.settings.cell_operator ? 'Checking 4G coverage…' : 'Choose a 4G operator in the settings.'}</div>
          )}
          <small className="hint">Sends data over the cell network (NB-IoT / LTE-M), not through a LoRaWAN gateway.</small>
        </section>
      )}

      {/* ── properties ── */}
      <div className="grid grid-cols-2 gap-2">
        <NumberField label="Latitude" value={p.device.lat} step={0.0001} min={-90} max={90} onCommit={(v) => p.onPatch({ lat: v })} />
        <NumberField label="Longitude" value={p.device.lon} step={0.0001} min={-180} max={180} onCommit={(v) => p.onPatch({ lon: v })} />
        {!cellular && <>
          <NumberField label="Height AGL (m)" value={p.device.height} min={0.5} max={gw ? 60 : 30} onCommit={(v) => p.onPatch({ height: v })} />
          <NumberField label="TX power (dBm)" value={p.device.tx_power} step={1} min={-10} max={gw ? 36 : 30} onCommit={(v) => p.onPatch({ tx_power: v })} />
          <NumberField label="Antenna gain (dBi)" value={p.device.gain} min={-10} max={20} onCommit={(v) => p.onPatch({ gain: v })} />
          <NumberField label="Cable loss (dB)" value={p.device.cable_loss} min={0} max={20} onCommit={(v) => p.onPatch({ cable_loss: v })} />
        </>}
      </div>
      {node && !cellular && (
        <div className="grid grid-cols-2 gap-2">
          <label className="field">
            <span>Spreading factor</span>
            <select value={node.sf} onChange={(e) => p.onPatch({ sf: Number(e.target.value) })}>
              {p.catalog.spreading_factors.map((sf) => <option key={sf} value={sf}>SF{sf}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Environment</span>
            <select value={node.environment ?? p.project.settings.environment} onChange={(e) => p.onPatch({ environment: e.target.value })}>
              {Object.keys(p.catalog.environments).map((k) => <option key={k}>{k}</option>)}
            </select>
          </label>
        </div>
      )}
      {gw && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={gw.online} onChange={(e) => p.onPatch({ online: e.target.checked })} />
          Online (used for links)
        </label>
      )}

      <button className="btn-danger mt-2" onClick={() => confirm(`Delete ${p.device.name}?`) && p.onRemove()}>
        Delete {p.device.name}
      </button>
    </aside>
  )
}
