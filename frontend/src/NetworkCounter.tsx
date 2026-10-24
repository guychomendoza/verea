// Small counter on the map: devices of each kind and how many links / 4G states of each colour.
import { useState } from 'react'
import type { NetworkCounts } from './counts'
import { DeviceIcon } from './Logo'
import { Icon } from './icons'

const KEY = 'verea.counterOpen'

export default function NetworkCounter({ counts }: { counts: NetworkCounts }) {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(KEY) !== '0' } catch { return true } })
  const toggle = () => {
    setOpen(!open)
    try { localStorage.setItem(KEY, open ? '0' : '1') } catch { /* not remembered */ }
  }
  const { gateways: g, lora, cell } = counts
  if (!g.total && !lora.total && !cell.total) return null
  const dots = (states: { label: string; color: string; n: number }[]) => states.filter((s) => s.n).map((s) => (
    <span key={s.label} className="counter-state" title={s.label}><i style={{ background: s.color }} />{s.n}</span>
  ))
  return (
    <div className="network-counter" role="region" aria-label="Resumen de la red">
      <button className="counter-head" onClick={toggle} aria-expanded={open} title={open ? 'Ocultar resumen' : 'Mostrar resumen'}>
        Red: {g.total} GW · {lora.total + cell.total} {lora.total + cell.total === 1 ? 'sensor' : 'sensores'} <Icon name="chevron" size={13} className={`counter-chev ${open ? '' : 'closed'}`} />
      </button>
      {open && (
        <div className="counter-rows">
          {g.total > 0 && (
            <div className="counter-row" title={g.models.map(([m, n]) => `${n} × ${m}`).join('\n')}>
              <DeviceIcon kind="gateway" color="#3da3bc" size={15} /><b>{g.total}</b> {g.total === 1 ? 'gateway' : 'gateways'}
              <span className="hint">{g.cellular ? `${g.cellular} con 4G` : ''}{g.cellular && g.wired ? ' · ' : ''}{g.wired ? `${g.wired} WiFi/Ethernet` : ''}</span>
            </div>
          )}
          {lora.total > 0 && (
            <div className="counter-row" title={lora.models.map(([m, n]) => `${n} × ${m}`).join('\n')}>
              <DeviceIcon kind="lora" color="#5a6b80" size={15} /><b>{lora.total}</b> LoRa {dots(lora.states)}
            </div>
          )}
          {cell.total > 0 && (
            <div className="counter-row" title={cell.models.map(([m, n]) => `${n} × ${m}`).join('\n')}>
              <DeviceIcon kind="cellular" color="#5a6b80" size={15} /><b>{cell.total}</b> 4G {dots(cell.states)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
