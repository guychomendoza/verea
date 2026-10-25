// "Sugerir gateways 4G": where 4G gateways would serve the LoRa nodes, from the terrain (high
// points of the local DEM, link budget along each elevation profile) and the operator's 4G.
import { useEffect, useRef, useState } from 'react'
import maplibregl, { type GeoJSONSource } from 'maplibre-gl'
import { api, type GatewaySuggestion } from './api'
import { COLORS } from './colors'
import { registerDeviceIcons } from './deviceIcons'
import { MAP_LOCALE, buildStyle, ensurePmtiles } from './mapStyle'
import type { Catalog, LinkResult, NodeDevice, Project } from './types'
import { Alert, CloseButton } from './icons'

interface Props {
  catalog: Catalog
  project: Project
  links: Record<string, LinkResult>
  cellular: Set<string>
  onApply: (points: { lat: number; lon: number }[], model: string, height: number) => void
  onClose: () => void
}

const CELL_TEXT: Record<string, string> = { ok: '4G garantizado', edge: '4G incierto' }

export default function SuggestGatewaysDialog(p: Props) {
  const models = Object.entries(p.catalog.gateway_profiles).filter(([, v]) => v.backhaul === '4g')
  const [model, setModel] = useState(models[0]?.[0] ?? '')
  const [height, setHeight] = useState(6)
  const [maxGw, setMaxGw] = useState(5)
  const [target, setTarget] = useState<'unserved' | 'all'>('unserved')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<GatewaySuggestion | null>(null)
  const [chosen, setChosen] = useState<Set<number>>(new Set())

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') p.onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [p])

  const operator = p.project.settings.cell_operator || p.catalog.cell_operators[0]     // as the rest of the app
  const lora = p.project.nodes.filter((n) => !p.cellular.has(n.name))
  const targets = target === 'all' ? lora : lora.filter((n) => !p.links[n.name]?.link?.viable)

  const run = async () => {
    setBusy(true)
    setError('')
    setResult(null)
    try {
      const prof = p.catalog.gateway_profiles[model]
      const r = await api.suggestGateways({
        nodes: targets, settings: p.project.settings, operator,
        gateway: { name: 'propuesto', lat: 0, lon: 0, model, height, tx_power: prof.tx_power, gain: prof.gain,
          cable_loss: prof.cable_loss, online: true, backhaul: '4g' },
        max_gateways: maxGw, max_link_km: 8,
      })
      setResult(r)
      setChosen(new Set(r.proposals.map((_, i) => i)))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop">
      <div className="dialog import-dialog" role="dialog" aria-label="Sugerir gateways 4G">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Sugerir gateways 4G</h2>
          <CloseButton onClick={p.onClose} />
        </div>
        <p className="hint">
          Busca en los puntos altos del terreno cercanos a los nodos LoRa, descarta los que no tienen 4G del operador
          (el gateway necesita internet) y calcula el enlace con cada nodo a lo largo de su perfil de elevación (el
          mismo cálculo de la app). Elige los que dan servicio a más nodos. Solo para gateways con <b>4G propio</b>: uno
          con WiFi o Ethernet necesita corriente y red, así que su lugar se decide a mano.
        </p>
        {!models.length ? <p className="error">No hay modelos de gateway con 4G en el catálogo.</p> : (
          <div className="import-options">
            <label className="field"><span>Gateway 4G</span>
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {models.map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </label>
            <label className="field"><span>Altura del mástil (m)</span>
              <input type="number" min={1} max={30} step={0.5} value={height} onChange={(e) => setHeight(Number(e.target.value) || 6)} />
            </label>
            <label className="field"><span>Máximo de gateways</span>
              <input type="number" min={1} max={20} value={maxGw} onChange={(e) => setMaxGw(Math.min(20, Math.max(1, Number(e.target.value) || 1)))} />
            </label>
            <label className="field"><span>Nodos a cubrir</span>
              <select value={target} onChange={(e) => setTarget(e.target.value as 'unserved' | 'all')}>
                <option value="unserved">LoRa sin enlace viable ({lora.filter((n) => !p.links[n.name]?.link?.viable).length})</option>
                <option value="all">Todos los LoRa ({lora.length})</option>
              </select>
            </label>
            <button className="btn btn-active" onClick={run} disabled={busy || !targets.length || !model}>
              {busy ? 'Calculando…' : 'Buscar ubicaciones'}
            </button>
          </div>
        )}
        {!operator && <Alert tone="warn">El servidor no tiene datos de cobertura 4G: no se revisa si hay 4G en los puntos propuestos.</Alert>}
        {error && <Alert>{error}</Alert>}
        {result && (
          <>
            <p className="text-sm" role="status">
              {result.proposals.length} gateways propuestos · cubren{' '}
              {result.proposals.reduce((s, x) => s + x.nodes.length, 0)} de {targets.length} nodos
              {result.unreachable.length ? ` · ${result.unreachable.length} sin alcance desde ningún punto con 4G` : ''}
              {result.over_limit.length ? ` · ${result.over_limit.length} necesitarían más gateways` : ''}
            </p>
            <div className="import-body">
              <SuggestMap nodes={targets} result={result} chosen={chosen} />
              <div className="import-table">
                <table>
                  <thead><tr><th></th><th>Propuesta</th><th>Nodos</th><th>Margen mínimo</th><th>4G</th><th>Altitud</th></tr></thead>
                  <tbody>
                    {result.proposals.map((g, i) => (
                      <tr key={i}>
                        <td><input type="checkbox" checked={chosen.has(i)} aria-label={`Agregar propuesta ${i + 1}`}
                          onChange={(e) => {
                            const s = new Set(chosen)
                            if (e.target.checked) s.add(i); else s.delete(i)
                            setChosen(s)
                          }} /></td>
                        <td>GW propuesto {i + 1}<div className="hint">{g.lat.toFixed(5)}, {g.lon.toFixed(5)}</div></td>
                        <td title={g.nodes.map((n) => `${n.name}: ${n.margin_db} dB`).join('\n')}>{g.nodes.length}
                          <div className="hint">{g.nodes.slice(0, 4).map((n) => n.name).join(', ')}{g.nodes.length > 4 ? '…' : ''}</div></td>
                        <td>{g.min_margin_db.toFixed(1)} dB</td>
                        <td>{g.cell_state ? CELL_TEXT[g.cell_state] ?? g.cell_state : '—'}</td>
                        <td>{Math.round(g.elevation_m)} m</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {result.unreachable.length > 0 && (
                  <p className="hint">Sin alcance: {result.unreachable.join(', ')}. Revisa si conviene un gateway con WiFi/Ethernet
                    cerca o mover esos sensores.</p>
                )}
              </div>
            </div>
          </>
        )}
        <div className="flex gap-2 justify-end">
          <button className="btn" onClick={p.onClose}>Cancelar</button>
          <button className="btn btn-active" disabled={!result || !chosen.size}
            onClick={() => p.onApply(result!.proposals.filter((_, i) => chosen.has(i)).map((g) => ({ lat: g.lat, lon: g.lon })), model, height)}>
            Agregar {chosen.size} gateways
          </button>
        </div>
      </div>
    </div>
  )
}

/** The proposals (gateway symbols) with lines to the nodes each one serves. */
function SuggestMap({ nodes, result, chosen }: { nodes: NodeDevice[]; result: GatewaySuggestion; chosen: Set<number> }) {
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const ready = useRef(false)

  const update = () => {
    const m = map.current
    if (!m || !ready.current) return
    const byName = new Map(nodes.map((n) => [n.name, n]))
    const served = new Set(result.proposals.flatMap((g, i) => (chosen.has(i) ? g.nodes.map((n) => n.name) : [])))
    const devices: GeoJSON.Feature[] = [
      ...nodes.map((n) => ({ type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [n.lon, n.lat] },
        properties: { kind: 'node', icon: 'icon-lora', label: '', color: served.has(n.name) ? COLORS.viable : COLORS.fail, focus: false, dim: false } })),
      ...result.proposals.map((g, i) => ({ type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [g.lon, g.lat] },
        properties: { kind: 'gateway', icon: 'icon-gateway', label: `Propuesto ${i + 1}\n${g.nodes.length} nodos`,
          color: chosen.has(i) ? COLORS.gateway : COLORS.none, focus: chosen.has(i), dim: !chosen.has(i) } })),
    ]
    const links: GeoJSON.Feature[] = result.proposals.flatMap((g, i) => (chosen.has(i) ? g.nodes : []).map((n) => {
      const nd = byName.get(n.name)!
      return { type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: [[g.lon, g.lat], [nd.lon, nd.lat]] },
        properties: { color: n.margin_db >= 0 ? COLORS.viable : COLORS.fail, focus: false, dim: false } }
    }))
    ;(m.getSource('devices') as GeoJSONSource).setData({ type: 'FeatureCollection', features: devices })
    ;(m.getSource('links') as GeoJSONSource).setData({ type: 'FeatureCollection', features: links })
    const pts = [...nodes.map((n) => [n.lon, n.lat]), ...result.proposals.map((g) => [g.lon, g.lat])]
    if (pts.length) {
      const lons = pts.map((q) => q[0]), lats = pts.map((q) => q[1])
      m.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 40, maxZoom: 15, duration: 0 })
    }
  }

  useEffect(() => {
    ensurePmtiles()
    const m = new maplibregl.Map({ container: el.current!, style: buildStyle(), locale: MAP_LOCALE, attributionControl: { compact: true } })
    registerDeviceIcons(m)
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.current = m
    m.on('load', () => { ready.current = true; update() })
    return () => m.remove()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(update, [result, chosen])
  return <div ref={el} className="import-map" style={{ position: 'relative' }} data-testid="suggest-map" />
}
