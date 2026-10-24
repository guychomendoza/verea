// Addresses: /p/<id> is a team project (so it can be bookmarked, reloaded or sent to a teammate),
// /v/<token> a shared link (share.ts), / everything else. No router library: the History API.
const PROJECT = /^\/p\/([0-9a-f-]{36})\/?$/i

export function projectFromPath(path = window.location.pathname): string | null {
  return PROJECT.exec(path)?.[1] ?? null
}

/** Show a project's address: a new history entry when switching, the same one on first open. */
export function showProject(id: string | null, replace = false) {
  const path = id ? `/p/${id}` : '/'
  if (window.location.pathname === path) return
  if (replace || window.location.pathname === '/') history.replaceState(null, '', path + window.location.search)
  else history.pushState(null, '', path + window.location.search)
}

/** Google sign-in comes back with the session in the hash; once read, an empty "#" is left. */
export function cleanAuthHash() {
  if (window.location.href.endsWith('#')) history.replaceState(null, '', window.location.pathname + window.location.search)
}

/** Where Google sends the visitor back: the same address (a project stays open). */
export const returnUrl = () => window.location.origin + window.location.pathname
