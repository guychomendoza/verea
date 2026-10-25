// "Cargando": the logo's signal waves lighting up one after another, instead of a bare text.
// LoadingScreen fills the page (opening the app or a project); Spinner sits inside a dialog.
// index.html shows the same animation (plain HTML + CSS) before the app's script has loaded.

function Waves({ size }: { size: number }) {
  return (
    <svg className="loading-waves" width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <circle className="w0" cx="24" cy="38" r="4" />
      <path className="w1" d="M16.5 30.5a10.6 10.6 0 0 1 15 0" />
      <path className="w2" d="M11 25a18.4 18.4 0 0 1 26 0" />
      <path className="w3" d="M5.5 19.5a26.2 26.2 0 0 1 37 0" />
    </svg>
  )
}

export function LoadingScreen({ text = 'Cargando…' }: { text?: string }) {
  return (
    <div className="loading-screen" role="status" aria-live="polite">
      <Waves size={64} />
      <p>{text}</p>
    </div>
  )
}

export function Spinner({ text = 'Cargando…' }: { text?: string }) {
  return (
    <p className="loading-inline" role="status" aria-live="polite"><Waves size={22} /> {text}</p>
  )
}
