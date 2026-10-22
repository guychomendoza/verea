import { useState } from 'react'
import { logoSvg, LOGO_RATIO } from './brand'
import { deviceIconSvg, type DeviceKind } from './deviceIcons'
import { NEXT, THEME_LABELS, applyTheme, savedTheme, type Theme } from './theme'

const SVG = logoSvg('currentColor', undefined, ' role="img" aria-label="Verea"')

/** The logo; letters follow the theme (navy on light, white on dark), waves stay teal. */
export function Logo({ width }: { width: number }) {
  return <span className="logo" style={{ width, height: width * LOGO_RATIO }} dangerouslySetInnerHTML={{ __html: SVG }} />
}

/** Device symbol (circle in the status colour + glyph of its type), as on the map. */
export function DeviceIcon({ kind, color, size = 18 }: { kind: DeviceKind; color: string; size?: number }) {
  return <span className="device-icon" dangerouslySetInnerHTML={{ __html: deviceIconSvg(kind, color, size) }} />
}

/** Cycles automatic → light → dark. */
export function ThemeButton({ className = '' }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>(savedTheme)
  const [icon, label] = THEME_LABELS[theme]
  return (
    <button type="button" className={`theme-btn ${className}`} title={`${label}. Clic para cambiar`}
      aria-label={`${label}. Cambiar tema`}
      onClick={() => { const t = NEXT[theme]; applyTheme(t); setTheme(t) }}>{icon}</button>
  )
}
