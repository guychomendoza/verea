// Light / dark / automatic (follows the system) theme, remembered in this browser.
export type Theme = 'auto' | 'light' | 'dark'
const KEY = 'verea.theme'

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

