import { useState } from 'react'
import { supabase } from './cloud'

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="text-2xl font-semibold">📡 Verea</div>
        <h1 className="text-base text-[var(--muted)]">{title}</h1>
        {children}
      </div>
    </div>
  )
}

/** Email + password login, and the password-reset request. No sign-up: accounts are invite-only. */
export function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [forgot, setForgot] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!supabase) return
    setBusy(true)
    setMsg('')
    if (forgot) {
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin })
      setMsg(error ? error.message : 'Si ese correo pertenece al equipo, te llegará un enlace para crear una nueva contraseña.')
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) setMsg(error.message === 'Invalid login credentials' ? 'Correo o contraseña incorrectos.' : error.message)
    }
    setBusy(false)
  }

  return (
    <Card title={forgot ? 'Restablecer tu contraseña' : 'Inicia sesión en el espacio de tu equipo'}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="field"><span>Correo</span>
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {!forgot && (
          <label className="field"><span>Contraseña</span>
            <input type="password" autoComplete="current-password" required value={password}
              onChange={(e) => setPassword(e.target.value)} />
          </label>
        )}
        <button className="btn btn-active" type="submit" disabled={busy}>
          {busy ? '…' : forgot ? 'Enviar enlace' : 'Iniciar sesión'}
        </button>
        {msg && <p className="hint" role="alert">{msg}</p>}
        <button type="button" className="btn-ghost text-sm underline self-start"
          onClick={() => { setForgot(!forgot); setMsg('') }}>
          {forgot ? 'Volver a iniciar sesión' : '¿Olvidaste tu contraseña?'}
        </button>
        <p className="hint">Las cuentas son por invitación. Pide acceso al administrador de tu equipo.</p>
      </form>
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
        <label className="field"><span>Nueva contraseña (10+ caracteres)</span>
          <input type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label className="field"><span>Repítela</span>
          <input type="password" autoComplete="new-password" required value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        </label>
        <button className="btn btn-active" type="submit" disabled={busy}>{busy ? '…' : 'Guardar contraseña'}</button>
        {msg && <p className="hint" role="alert">{msg}</p>}
      </form>
    </Card>
  )
}

export function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return <Card title={title}>{children}</Card>
}
