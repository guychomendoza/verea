// Google sign-in with Google's own button (Google Identity Services): Google hands the ID token to
// this page and Supabase verifies it (signInWithIdToken), so Google's screens name verea.app instead
// of the Supabase project's address. Needs VITE_GOOGLE_CLIENT_ID (the same OAuth client Supabase
// uses) and this site among the client's "Authorized JavaScript origins" in Google Cloud.
const GIS_SRC = 'https://accounts.google.com/gsi/client'
export const GOOGLE_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? ''

interface Gis {
  accounts: { id: {
    initialize: (o: Record<string, unknown>) => void
    renderButton: (el: HTMLElement, o: Record<string, unknown>) => void
  } }
}

let loading: Promise<Gis> | null = null
function loadGis(): Promise<Gis> {
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = GIS_SRC
    s.async = true
    s.onload = () => resolve((window as unknown as { google: Gis }).google)
    s.onerror = () => { loading = null; reject(new Error('No se pudo cargar el inicio de sesión de Google')) }
    document.head.appendChild(s)
  })
  return loading
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

// One initialisation per page (Google warns otherwise); the latest button's handler gets the token
const NONCE = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
let handler: (idToken: string, nonce: string) => void = () => {}
let initialised: Promise<void> | null = null

/** Google's button in `el`; `onToken(idToken, nonce)` gets the raw nonce Supabase must check. */
export async function renderGoogleButton(el: HTMLElement, dark: boolean,
  onToken: (idToken: string, nonce: string) => void): Promise<void> {
  const gis = await loadGis()
  handler = onToken
  initialised ??= sha256Hex(NONCE).then((hashed) => gis.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    nonce: hashed,                          // Google signs the hash; Supabase compares it with the raw nonce
    callback: (r: { credential: string }) => handler(r.credential, NONCE),
    ux_mode: 'popup',
    use_fedcm_for_button: true,
  }))
  await initialised
  gis.accounts.id.renderButton(el, {
    type: 'standard', theme: dark ? 'filled_black' : 'outline', size: 'large', shape: 'pill',
    text: 'continue_with', logo_alignment: 'center', width: Math.min(el.clientWidth || 340, 400), locale: 'es',
  })
}
