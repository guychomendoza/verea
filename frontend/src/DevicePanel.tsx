import { useEffect, useState } from 'react'
import { db, distance, num } from './geo'
import { isCellular, nameError } from './project'
import type { Catalog, CellStatus, Gateway, LinkResult, NodeDevice, Project } from './types'

interface Props {
  catalog: Catalog
  project: Project
  kind: 'gateway' | 'node'
  device: Gateway | NodeDevice
  link?: LinkResult
  cell?: CellStatus
  served: number                       // nodes whose best link is this gateway
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

/** Text input that commits on blur / Enter. */
function TextField({ label, value, maxLength, onCommit }: {
  label: string; value: string; maxLength: number; onCommit: (v: string) => void
}) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <label className="field">
      <span>{label}</span>
      <input value={text} maxLength={maxLength} onChange={(e) => setText(e.target.value)}
        onBlur={() => text.trim() !== value && onCommit(text.trim())}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
    </label>
  )
}

/** Number that may be left empty (undefined). */
function OptionalNumber({ label, value, onCommit }: {
  label: string; value?: number; onCommit: (v: number | undefined) => void
}) {
  const [text, setText] = useState(value?.toString() ?? '')
  useEffect(() => setText(value?.toString() ?? ''), [value])
  const commit = () => {
    const v = text.trim() === '' ? undefined : Number(text)
    if (v !== undefined && (!Number.isFinite(v) || v < 0)) return setText(value?.toString() ?? '')
    if (v !== value) onCommit(v)
  }
  return (
    <label className="field">
      <span>{label}</span>
      <input type="number" inputMode="decimal" step={0.01} min={0} value={text}
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
  useEffect(() => setName(p.device.name), [p.device.name])
  const err = nameError(p.project, p.device.name, name)
  const node = p.kind === 'node' ? (p.device as NodeDevice) : null
  const gw = p.kind === 'gateway' ? (p.device as Gateway) : null
  const cellular = node ? isCellular(p.catalog, node) : false
  const profiles = p.kind === 'gateway' ? p.catalog.gateway_profiles : p.catalog.node_profiles
  const prof = profiles[p.device.model]
  const best = p.link?.link

  const changeModel = (model: string) => {
    const pr = profiles[model]
    p.onPatch({
      model, height: pr.height, tx_power: pr.tx_power, gain: pr.gain, cable_loss: pr.cable_loss,
      ...(node ? { type: pr.type, sf: pr.sf } : {}),
    })
  }

  return (
    <aside className="panel side-panel" aria-label="Dispositivo">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{gw ? '📡 Gateway' : cellular ? '📶 Sensor 4G' : '📱 Nodo'}</h2>
        <button className="btn-ghost" onClick={p.onClose} aria-label="Cerrar">✕</button>
      </div>

      <label className="field">
        <span>Nombre</span>
        <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)}
          onBlur={() => (err ? setName(p.device.name) : name !== p.device.name && p.onRename(name))}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        {err && name !== p.device.name && <em className="error">{err}</em>}
      </label>

      <label className="field">
        <span>Modelo</span>
        <select value={p.device.model} onChange={(e) => changeModel(e.target.value)}>
          {Object.entries(profiles).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        {prof && <small className="hint">{prof.source}{prof.estimated.length ? ` Valores estimados: ${prof.estimated.join(', ')}.` : ''}</small>}
      </label>

      {node && (
        <>
          <TextField label="Titular" value={node.owner ?? ''} maxLength={80}
            onCommit={(v) => p.onPatch({ owner: v || undefined })} />
          <OptionalNumber label="Superficie (ha)" value={node.area_ha}
            onCommit={(v) => p.onPatch({ area_ha: v })} />
        </>
      )}

      {/* ── result ── */}
      {node && !cellular && (
        <section className="result">
          {best ? (
            <>
              <div className={`verdict ${best.viable ? 'ok' : best.margin_db > -5 ? 'warn' : 'bad'}`}>
                {best.viable ? '✅ Enlace viable' : '❌ Enlace no viable'} con {best.gateway}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Metric label="Margen" value={db(best.margin_db)} />
                <Metric label="RSSI" value={`${num(best.rssi_dbm, 0)} dBm`} />
                <Metric label="Distancia" value={distance(best.distance_m)} />
              </div>
              {best.reasons.length > 0 && <ul className="hint list-disc pl-4">{best.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
              <small className="hint">El Perfil de Elevación de este enlace está en el panel inferior.</small>
            </>
          ) : (
            <div className="verdict warn">⚠ {p.link?.error ?? 'Calculando…'}</div>
          )}
        </section>
      )}
      {cellular && (
        <section className="result">
          {p.cell ? (
            <>
              <div className={`verdict ${p.cell.state === 'ok' ? 'ok' : p.cell.state === 'none' ? 'bad' : 'warn'}`}>{p.cell.text}</div>
              <div className="grid grid-cols-2 gap-2">
                <Metric label="Cubierto alrededor (300 m)" value={`${Math.round((p.cell.nearby_share ?? 0) * 100)}%`} />
                {p.cell.covered
                  ? <Metric label="Señal declarada" value={p.cell.level_dbm != null ? `${p.cell.level_dbm} dBm` : '—'} />
                  : <Metric label="Cobertura más cercana" value={p.cell.nearest_m != null ? distance(p.cell.nearest_m) : '> 20 km'} />}
              </div>
            </>
          ) : (
            <div className="hint">{p.project.settings.cell_operator ? 'Revisando cobertura 4G…' : 'Elige un operador 4G en los ajustes.'}</div>
          )}
          <small className="hint">Envía datos por la red celular (NB-IoT / LTE-M), no por un gateway LoRaWAN.</small>
        </section>
      )}
      {gw && <p className="hint">{p.served ? `Mejor gateway para ${p.served} nodo${p.served === 1 ? '' : 's'}.` : 'Todavía no es el mejor gateway de ningún nodo.'}</p>}

      {/* ── properties ── */}
      <div className="grid grid-cols-2 gap-2">
        <NumberField label="Latitud" value={p.device.lat} step={0.0001} min={-90} max={90} onCommit={(v) => p.onPatch({ lat: v })} />
        <NumberField label="Longitud" value={p.device.lon} step={0.0001} min={-180} max={180} onCommit={(v) => p.onPatch({ lon: v })} />
        {!cellular && <>
          <NumberField label="Altura sobre el suelo (m)" value={p.device.height} min={0.5} max={gw ? 60 : 30} onCommit={(v) => p.onPatch({ height: v })} />
          <NumberField label="Potencia TX (dBm)" value={p.device.tx_power} step={1} min={-10} max={gw ? 36 : 30} onCommit={(v) => p.onPatch({ tx_power: v })} />
          <NumberField label="Ganancia de antena (dBi)" value={p.device.gain} min={-10} max={20} onCommit={(v) => p.onPatch({ gain: v })} />
          <NumberField label="Pérdida en cable (dB)" value={p.device.cable_loss} min={0} max={20} onCommit={(v) => p.onPatch({ cable_loss: v })} />
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
            <span>Entorno</span>
            <select value={node.environment ?? p.project.settings.environment} onChange={(e) => p.onPatch({ environment: e.target.value })}>
              {Object.entries(p.catalog.environments).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </label>
        </div>
      )}
      {gw && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={gw.online} onChange={(e) => p.onPatch({ online: e.target.checked })} />
          En línea (se usa para los enlaces)
        </label>
      )}

      <button className="btn-danger mt-2" onClick={() => confirm(`¿Eliminar ${p.device.name}?`) && p.onRemove()}>
        Eliminar {p.device.name}
      </button>
    </aside>
  )
}
