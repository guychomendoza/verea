/** An on / off switch (role="switch"), with its state written beside it. */
export function Switch({ on, onChange, labelledBy, label, disabled, onText = 'Activado', offText = 'Desactivado' }: {
  on: boolean; onChange: (on: boolean) => void; labelledBy?: string; label?: string; disabled?: boolean; onText?: string; offText?: string
}) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-labelledby={labelledBy} aria-label={label} disabled={disabled}
      className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>
      <span className="switch-track"><span className="switch-thumb" /></span>
      <span className="switch-text">{on ? onText : offText}</span>
    </button>
  )
}
