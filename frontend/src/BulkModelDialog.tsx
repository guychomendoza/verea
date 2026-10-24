// Change the model of many sensors at once (e.g. the 4G ones without coverage → a LoRa model).
import { useEffect, useMemo, useState } from 'react'
import { STATE_GROUPS, nodeState } from './nodeStatus'
import type { Catalog, CellStatus, LinkResult, Project } from './types'
import { CloseButton } from './icons'

interface Props {
  catalog: Catalog
  project: Project
  links: Record<string, LinkResult>
  cells: Record<string, CellStatus>
  cellular: Set<string>
  preset?: { groups: string[]; model?: string }
  onApply: (names: string[], model: string) => void
  onClose: () => void
}

export default function BulkModelDialog(p: Props) {
  const [groups, setGroups] = useState<Set<string>>(new Set(p.preset?.groups ?? []))
  const [fromModel, setFromModel] = useState('')
  const models = Object.entries(p.catalog.node_profiles)
  const [model, setModel] = useState(p.preset?.model ?? models.find(([k]) => k === 'dragino_se0x_lb')?.[0] ?? models[0][0])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') p.onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [p])

  const stateOf = useMemo(() => new Map(p.project.nodes.map((n) =>
    [n.name, nodeState(n, p.cellular.has(n.name), p.links, p.cells)])), [p.project.nodes, p.cellular, p.links, p.cells])
  const count = (key: string) => p.project.nodes.filter((n) =>
    STATE_GROUPS.find((g) => g.key === key)!.states.includes(stateOf.get(n.name)!)).length
  const chosen = p.project.nodes.filter((n) => {
    const st = stateOf.get(n.name)!
    const inGroup = !groups.size || STATE_GROUPS.some((g) => groups.has(g.key) && g.states.includes(st))
    return inGroup && (!fromModel || n.model === fromModel) && n.model !== model
  })
  const label = (k: string) => p.catalog.node_profiles[k]?.label ?? k

  return (
    <div className="dialog-backdrop" onClick={p.onClose}>
      <div className="dialog" role="dialog" aria-label="Cambiar modelo de sensores" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Cambiar modelo de sensores</h2>
          <CloseButton onClick={p.onClose} />
        </div>
        <p className="hint">Se conservan nombre, ubicación, titular, superficie y parcela; potencia, altura, ganancia y SF
          pasan a los del modelo nuevo. Se puede deshacer con Ctrl+Z.</p>
        <fieldset className="bulk-groups">
          <legend className="text-sm font-semibold">Sensores con estado</legend>
          {STATE_GROUPS.filter((g) => count(g.key)).map((g) => (
            <label key={g.key} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={groups.has(g.key)} onChange={(e) => {
                const s = new Set(groups)
                if (e.target.checked) s.add(g.key); else s.delete(g.key)
                setGroups(s)
              }} />
              {g.label} ({count(g.key)})
            </label>
          ))}
          {!groups.size && <p className="hint">Sin estado marcado: se toman todos los sensores.</p>}
        </fieldset>
        <label className="field"><span>Modelo actual</span>
          <select value={fromModel} onChange={(e) => setFromModel(e.target.value)}>
            <option value="">Cualquiera</option>
            {[...new Set(p.project.nodes.map((n) => n.model))].map((k) => <option key={k} value={k}>{label(k)}</option>)}
          </select>
        </label>
        <label className="field"><span>Cambiar a</span>
          <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Modelo nuevo">
            {models.map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
        <div className="bulk-list" aria-label="Sensores que cambian">
          {chosen.map((n) => <div key={n.name}>{n.name}{n.owner ? ` · ${n.owner}` : ''} <span className="hint">({label(n.model)})</span></div>)}
          {!chosen.length && <p className="hint">Ningún sensor cumple el filtro.</p>}
        </div>
        <div className="flex gap-2 justify-end">
          <button className="btn" onClick={p.onClose}>Cancelar</button>
          <button className="btn btn-active" disabled={!chosen.length} onClick={() => p.onApply(chosen.map((n) => n.name), model)}>
            {`Cambiar ${chosen.length} a ${label(model)}`}
          </button>
        </div>
      </div>
    </div>
  )
}
