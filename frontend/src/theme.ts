// Light / dark / automatic (follows the system) theme, remembered in this browser.
export type Theme = 'auto' | 'light' | 'dark'
const KEY = 'verea.theme'
export const NEXT: Record<Theme, Theme> = { auto: 'light', light: 'dark', dark: 'auto' }
export const THEME_LABELS: Record<Theme, [string, string]> = {   // [short, long]
  auto: ['Automático', 'Tema automático (como el sistema)'], light: ['Claro', 'Tema claro'], dark: ['Oscuro', 'Tema oscuro'],
}

export function savedTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY)
    return t === 'light' || t === 'dark' ? t : 'auto'
  } catch {
    return 'auto'
  }
}

export function applyTheme(t: Theme) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.dataset.theme = t
  try { localStorage.setItem(KEY, t) } catch { /* private mode: not remembered */ }
}

