import { useId, useState } from 'react'
import { supabase } from './cloud'
import { pendingShare } from './share'
import { Logo, ThemeButton } from './Logo'
import { Icon } from './icons'
import LoginArt from './LoginArt'
import { returnUrl } from './route'

const FEATURES = [
  'Enlaces LoRaWAN sobre el relieve real',
  'Cobertura 4G declarada por los operadores',
  'Reportes PDF y proyectos compartidos con el equipo',
]

/** Split screen: the illustration with what Verea does, and the card. */
function Card({ title, heading, children }: { title: string; heading?: string; children: React.ReactNode }) {
  return (
    <div className="login-wrap">
      <section className="login-art" aria-label="Verea">
        <LoginArt />
        <div className="login-art-text">
          <p className="login-art-title">Verea</p>
          <p className="login-art-sub">Planeación de redes IoT para el campo</p>
          <ul>{FEATURES.map((f) => <li key={f}><Icon name="check" size={15} /> {f}</li>)}</ul>
        </div>
      </section>
      <main className="login-side">
        <ThemeButton className="login-theme" />
        <div className="login-card">
          <div className="flex justify-center"><Logo width={150} /></div>
          {heading ? (
            <div className="login-head">
              <h1>{heading}</h1>
              <p>{title}</p>
            </div>
          ) : <div className="login-head"><h1>{title}</h1></div>}
          {children}
        </div>
        <p className="login-foot">© {new Date().getFullYear()} Verea</p>
      </main>
    </div>
  )
}

/** Password input with a button to show what was typed. */
function PasswordField({ label, value, onChange, autoComplete }: {
  label: string; value: string; onChange: (v: string) => void; autoComplete: string
}) {
  const [visible, setVisible] = useState(false)
  const id = useId()
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="password-field">
        <input id={id} type={visible ? 'text' : 'password'} autoComplete={autoComplete} required value={value}
          autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="btn-ghost" aria-pressed={visible}
          aria-label={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
          title={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
          onClick={() => setVisible(!visible)}>
          <Icon name={visible ? 'eye-off' : 'eye'} />
        </button>
      </div>
    </div>
  )
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  )
}

/**
 * Google sign-in (anyone: a new account is a viewer, it sees the projects shared with it) and
 * the team's email + password login with its password reset.
 */
export function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [forgot, setForgot] = useState(false)
  const [withEmail, setWithEmail] = useState(false)
  const shared = pendingShare() !== null

  const google = async () => {
    if (!supabase) return
    setBusy(true)
    const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: returnUrl() } })
    if (error) {
      setMsg(error.message.includes('provider is not enabled') ? 'El acceso con Google todavía no está activado.' : error.message)
      setBusy(false)
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!supabase) return
    setBusy(true)
    setMsg('')
    if (forgot) {
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: returnUrl() })
      setMsg(error ? error.message : 'Si ese correo tiene cuenta con contraseña, te llegará un enlace para crear una nueva.')
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) setMsg(error.message === 'Invalid login credentials' ? 'Correo o contraseña incorrectos.' : error.message)
    }
    setBusy(false)
  }

  return (
    <Card heading={forgot ? 'Restablecer contraseña' : 'Bienvenido'}
      title={forgot ? 'Te enviaremos un enlace para crear una nueva.' : shared ? 'Te compartieron un proyecto: entra para verlo'
        : 'Inicia sesión para ver y planear tus redes'}>
      {!forgot && (
        <div className="flex flex-col gap-3">
          <button type="button" className="btn btn-google" onClick={google} disabled={busy}>
            <GoogleMark /> Continuar con Google
          </button>
          <p className="hint">
            Con tu cuenta de Google ves los proyectos que te compartan, en modo lector. Al entrar aceptas el{' '}
            <a href="/privacidad.html" target="_blank" rel="noopener" className="underline">aviso de privacidad</a>.
          </p>
          {!withEmail && msg && <p className="hint" role="alert">{msg}</p>}
          {!withEmail && (
            <>
              <div className="login-divider"><span>o</span></div>
              <button type="button" className="btn btn-email" onClick={() => { setWithEmail(true); setMsg('') }}>
                <Icon name="user" /> Soy del equipo: entrar con correo
              </button>
            </>
          )}
        </div>
      )}
      {(withEmail || forgot) && <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="field"><span>Correo</span>
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {!forgot && (
          <PasswordField label="Contraseña" autoComplete="current-password" value={password} onChange={setPassword} />
        )}
        <button className="btn btn-active btn-lg" type="submit" disabled={busy}>
          {busy ? '…' : forgot ? 'Enviar enlace' : 'Iniciar sesión'}
        </button>
        {msg && <p className="hint" role="alert">{msg}</p>}
        <button type="button" className="btn-ghost text-sm underline self-start"
          onClick={() => { setForgot(!forgot); setMsg('') }}>
          {forgot ? 'Volver a iniciar sesión' : '¿Olvidaste tu contraseña?'}
        </button>
        <p className="hint">Las cuentas del equipo son por invitación de un administrador.</p>
      </form>}
    </Card>
  )
}

/** After an invitation or reset link: choose the password for the account. */
export function SetPassword({ email, onDone }: { email: string; onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!supabase) return
    if (password.length < 10) return setMsg('Usa al menos 10 caracteres.')
    if (password !== repeat) return setMsg('Las contraseñas no coinciden.')
    setBusy(true)
    const { error } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (error) setMsg(error.message)
    else {
      history.replaceState(null, '', window.location.pathname)
      onDone()
    }
  }

  return (
    <Card title={`Elige una contraseña para ${email}`}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <PasswordField label="Nueva contraseña (10+ caracteres)" autoComplete="new-password" value={password} onChange={setPassword} />
        <PasswordField label="Repítela" autoComplete="new-password" value={repeat} onChange={setRepeat} />
        <button className="btn btn-active btn-lg" type="submit" disabled={busy}>{busy ? '…' : 'Guardar contraseña'}</button>
        {msg && <p className="hint" role="alert">{msg}</p>}
      </form>
    </Card>
  )
}

export function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return <Card title={title}>{children}</Card>
}
