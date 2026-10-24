import { useEffect, useState } from 'react'
import * as cloud from './cloud'
import { Alert, CloseButton, Icon } from './icons'

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
      && !confirm(`¿Dar acceso de ${patch.role === 'admin' ? 'administrador' : 'editor'} a ${a.email}? Podrá ver y editar todos los proyectos del equipo.`)) return
    setError('')
    try {
      await cloud.setAccount(a.id, patch)
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
          Quien entra con Google queda como <b>lector</b> (solo ve los links que le comparten). Para que alguien del equipo
          edite, pídele que entre una vez y cámbialo aquí a <b>Editor</b>.
        </p>
        <input type="search" placeholder="Buscar por correo, nombre o empresa" value={filter} onChange={(e) => setFilter(e.target.value)}
          aria-label="Buscar usuarios" />
        {error && <Alert>{error}</Alert>}
        {rows === null ? <p className="hint">Cargando…</p> : (
          <table className="account-table">
            <thead><tr><th>Cuenta</th><th>Empresa · teléfono</th><th>Rol</th><th>Activa</th><th>Alta</th></tr></thead>
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
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
