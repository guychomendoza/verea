import { useEffect, useState } from 'react'
import * as cloud from './cloud'
import { api } from './api'
import { Alert, CloseButton, Icon } from './icons'
import { Spinner } from './Loading'
import { askConfirm } from './confirm'

interface Props {
  me: cloud.Me
  onClose: () => void
}

const ROLES: [cloud.Role, string][] = [['viewer', 'Lector'], ['member', 'Editor'], ['admin', 'Administrador']]

/** Admins: every account, its role (viewer → editor gives edit access) and whether it is active. */
export default function UsersDialog({ me, onClose }: Props) {
  const [rows, setRows] = useState<cloud.Account[] | null>(null)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const load = () => cloud.listAccounts().then(setRows).catch((e) => setError(e.message))
  useEffect(() => { load() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const change = async (a: cloud.Account, patch: { role?: cloud.Role; active?: boolean }) => {
    if (patch.role && patch.role !== 'viewer' && a.role === 'viewer'
      && !await askConfirm(`¿Dar acceso de ${patch.role === 'admin' ? 'administrador' : 'editor'} a ${a.email}? Podrá ver y editar todos los proyectos del equipo.`, { ok: 'Dar acceso' })) return
    setError('')
    try {
      await cloud.setAccount(a.id, patch)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const remove = async (a: cloud.Account) => {
    if (!await askConfirm(`¿Eliminar la cuenta de ${a.full_name || a.email}? Sus proyectos y pruebas de campo pasan a ti; ya no podrá entrar. No se puede deshacer.`,
      { ok: 'Eliminar cuenta', danger: true })) return
    setError('')
    try {
      await cloud.adminDeleteAccount(a.id)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const q = filter.toLowerCase()
  const shown = (rows ?? []).filter((a) => [a.email, a.full_name, a.company].some((v) => v.toLowerCase().includes(q)))
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" role="dialog" aria-label="Usuarios" onClick={(e) => e.stopPropagation()} style={{ width: 'min(820px, 100%)' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold flex items-center gap-2"><Icon name="users" size={18} /> Usuarios</h2>
          <CloseButton onClick={onClose} />
        </div>
        <p className="hint">
          Crea cuentas con correo y una contraseña temporal (la persona la cambia al entrar), o cambia el rol de quien
          entró con Google: quien entra con Google queda como <b>lector</b> hasta que le des otro rol aquí.
        </p>
        <NewUser onCreated={load} />
        <input type="search" placeholder="Buscar por correo, nombre o empresa" value={filter} onChange={(e) => setFilter(e.target.value)}
          aria-label="Buscar usuarios" />
        {error && <Alert>{error}</Alert>}
        {rows === null ? <Spinner /> : (
          <table className="account-table">
            <thead><tr><th>Cuenta</th><th>Empresa · teléfono</th><th>Rol</th><th>Activa</th><th>Alta</th><th><span className="sr-only">Eliminar</span></th></tr></thead>
            <tbody>
              {shown.map((a) => (
                <tr key={a.id}>
                  <td>{a.full_name || '—'}<div className="hint">{a.email}</div></td>
                  <td>{[a.company, a.phone].filter(Boolean).join(' · ') || '—'}</td>
                  <td>
                    <select value={a.role} disabled={a.id === me.id} aria-label={`Rol de ${a.email}`}
                      onChange={(e) => change(a, { role: e.target.value as cloud.Role })}>
                      {ROLES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </td>
                  <td><input type="checkbox" checked={a.active} disabled={a.id === me.id} aria-label={`Cuenta activa ${a.email}`}
                    onChange={(e) => change(a, { active: e.target.checked })} /></td>
                  <td>{new Date(a.created_at).toLocaleDateString('es-MX')}</td>
                  <td>{a.id !== me.id && (
                    <button className="icon-btn danger-icon" onClick={() => remove(a)} aria-label={`Eliminar ${a.email}`} title="Eliminar la cuenta">
                      <Icon name="trash" /></button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

/** A random temporary password the admin passes on (12 characters, no look-alike letters). */
function temporaryPassword(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from(crypto.getRandomValues(new Uint32Array(12)), (n) => chars[n % chars.length]).join('')
}

/** «Crear usuario»: email, name, role and a temporary password (shown once, to pass on). */
function NewUser({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ email: '', full_name: '', role: 'member', password: temporaryPassword() })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  if (!open) {
    return <button className="btn self-start" onClick={() => { setOpen(true); setMsg(null) }}><Icon name="plus" /> Crear usuario</button>
  }
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    try {
      await api.createUser(form)
      setMsg({ ok: true, text: `Cuenta creada. Pásale a ${form.email} su contraseña temporal: ${form.password} (la cambiará al entrar).` })
      setForm({ email: '', full_name: '', role: 'member', password: temporaryPassword() })
      onCreated()
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="new-user" onSubmit={submit} aria-label="Crear usuario">
      <div className="new-user-grid">
        <label className="field"><span>Correo</span>
          <input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
        <label className="field"><span>Nombre</span>
          <input value={form.full_name} maxLength={120} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></label>
        <label className="field"><span>Rol</span>
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {ROLES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></label>
        <label className="field"><span>Contraseña temporal</span>
          <input value={form.password} minLength={10} required onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
      </div>
      <div className="flex gap-2 justify-end">
        <button type="button" className="btn" onClick={() => setOpen(false)}>Cancelar</button>
        <button className="btn btn-active" disabled={busy}>{busy ? 'Creando…' : 'Crear cuenta'}</button>
      </div>
      {msg && (msg.ok ? <p className="ok-line" role="status">{msg.text}</p> : <Alert>{msg.text}</Alert>)}
    </form>
  )
}
