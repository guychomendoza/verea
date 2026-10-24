// Phones: the map always keeps the upper half. The project panel and a picked device open in a
// half-height sheet at the bottom, each with its ✕; a device shows its essentials first (the
// elevation profile of a LoRa node, the coverage of a 4G sensor) and «Ver más detalles» below.
import { useEffect } from 'react'
import type { DeviceKind } from './deviceIcons'
import { DeviceIcon, Logo } from './Logo'
import { CloseButton, Icon } from './icons'

/** The half-height sheet; `head` is its title row (logo or the device), or nothing. */
export function PhoneSheet({ label, onClose, head, children }: {
  label: string; onClose: () => void; head?: React.ReactNode; children: React.ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <section className="phone-sheet" role="dialog" aria-label={label}>
      {head !== undefined && (
        <div className="phone-sheet-bar">
          <div className="phone-sheet-title">{head}</div>
          <CloseButton onClick={onClose} label={`Cerrar ${label.toLowerCase()}`} />
        </div>
      )}
      <div className="phone-sheet-body">{children}</div>
    </section>
  )
}

export const ProjectHead = () => <Logo width={92} />

/** The device in the sheet's title row: its map symbol, name and state. */
export function DeviceHead({ kind, name, summary, color }: { kind: DeviceKind; name: string; summary: string; color: string }) {
  return (
    <>
      <DeviceIcon kind={kind} color={color} size={28} />
      <div className="device-head-text"><b>{name}</b><span>{summary}</span></div>
    </>
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
