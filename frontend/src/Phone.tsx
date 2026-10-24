// Phones: the map stays free; the project panel and a device's detail open full screen on demand,
// and a picked device shows as a small card at the bottom, each with its ✕.
import { useEffect } from 'react'
import type { DeviceKind } from './deviceIcons'
import { DeviceIcon, Logo } from './Logo'
import { CloseButton, Icon } from './icons'

/** A full-screen layer over the map (the project panel, a device's detail). */
export function PhoneOverlay({ label, onClose, brand = false, children }: {
  label: string; onClose: () => void; brand?: boolean; children: React.ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="phone-overlay" role="dialog" aria-label={label}>
      {brand && (
        <div className="phone-overlay-bar">
          <CloseButton onClick={onClose} label="Cerrar el panel" />
          <Logo width={92} />
          <span className="w-10" />
        </div>
      )}
      <div className="phone-overlay-body">{children}</div>
    </div>
  )
}

/** The picked device, small, at the bottom of the map: name, state, «Ver detalle» and ✕. */
export function DeviceCard({ kind, name, summary, color, onDetail, onClose }: {
  kind: DeviceKind; name: string; summary: string; color: string; onDetail: () => void; onClose: () => void
}) {
  return (
    <section className="device-card" aria-label={`Seleccionado: ${name}`}>
      <DeviceIcon kind={kind} color={color} size={30} />
      <div className="device-card-text">
        <b>{name}</b>
        <span>{summary}</span>
      </div>
      <button className="btn btn-active" onClick={onDetail}>Ver detalle</button>
      <CloseButton onClick={onClose} label="Quitar la selección" />
    </section>
  )
}

/** Opens the project panel (top left of the map). */
export function PanelButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button className="phone-panel-btn" onClick={onClick} aria-label="Abrir el panel del proyecto">
      <Icon name="menu" size={18} /><span>{name || 'Proyecto'}</span>
    </button>
  )
}
