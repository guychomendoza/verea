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
      setMsg(error ? error.message : 'If that email belongs to the team, a link to set a new password is on its way.')
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) setMsg(error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message)
    }
    setBusy(false)
  }

  return (
    <Card title={forgot ? 'Reset your password' : 'Sign in to your team workspace'}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="field"><span>Email</span>
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {!forgot && (
          <label className="field"><span>Password</span>
            <input type="password" autoComplete="current-password" required value={password}
              onChange={(e) => setPassword(e.target.value)} />
          </label>
        )}
        <button className="btn btn-active" type="submit" disabled={busy}>
          {busy ? '…' : forgot ? 'Send reset link' : 'Sign in'}
        </button>
        {msg && <p className="hint" role="alert">{msg}</p>}
        <button type="button" className="btn-ghost text-sm underline self-start"
          onClick={() => { setForgot(!forgot); setMsg('') }}>
          {forgot ? 'Back to sign in' : 'Forgot your password?'}
        </button>
        <p className="hint">Accounts are by invitation. Ask your team admin for access.</p>
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
    if (password.length < 10) return setMsg('Use at least 10 characters.')
    if (password !== repeat) return setMsg('The passwords do not match.')
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
    <Card title={`Choose a password for ${email}`}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="field"><span>New password (10+ characters)</span>
          <input type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label className="field"><span>Repeat it</span>
          <input type="password" autoComplete="new-password" required value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        </label>
        <button className="btn btn-active" type="submit" disabled={busy}>{busy ? '…' : 'Save password'}</button>
        {msg && <p className="hint" role="alert">{msg}</p>}
      </form>
    </Card>
  )
}

export function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return <Card title={title}>{children}</Card>
}
