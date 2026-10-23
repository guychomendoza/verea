// Shared links: https://<app>/v/<token>. The token is kept in the browser while the visitor
// signs in (Google leaves the page), then exchanged for access to the project.
const PENDING_KEY = 'verea.pendingShare'
const TOKEN = /^[0-9a-f]{32}$/

export function tokenFromPath(path: string): string | null {
  const m = /^\/v\/([^/?#]+)\/?$/.exec(path)
  return m && TOKEN.test(m[1]) ? m[1] : null
}

/** On load: a link's token is remembered and the address goes back to the app's root. */
export function rememberShareFromUrl(): void {
  const token = tokenFromPath(window.location.pathname)
  if (!token) return
  try {
    localStorage.setItem(PENDING_KEY, token)
  } catch { /* private mode: the link has to be opened again after signing in */ }
  history.replaceState(null, '', '/' + window.location.hash)
}

export function pendingShare(): string | null {
  try {
    const t = localStorage.getItem(PENDING_KEY)
    return t && TOKEN.test(t) ? t : null
  } catch {
    return null
  }
}

export function clearPendingShare(): void {
  try {
    localStorage.removeItem(PENDING_KEY)
  } catch { /* nothing kept */ }
}

export const shareUrl = (token: string) => `${window.location.origin}/v/${token}`
