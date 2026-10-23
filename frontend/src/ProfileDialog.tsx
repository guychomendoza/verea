import { useEffect, useState } from 'react'
import * as cloud from './cloud'

interface Props {
  me: cloud.Me
  onSaved: (me: cloud.Me) => void
  onSignOut: () => void
  onClose: () => void
}

const ROLE: Record<cloud.Role, string> = { admin: 'Administrador', member: 'Editor del equipo', viewer: 'Lector' }

/** Your profile: name, optional phone and company; viewers may delete their account. */
export default function ProfileDialog({ me, onSaved, onSignOut, onClose }: Props) {
  const [form, setForm] = useState({ full_name: me.full_name, phone: me.phone, company: me.company })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setMsg('')
    try {
      const patch = { full_name: form.full_name.trim(), phone: form.phone.trim(), company: form.company.trim() }
      await cloud.updateMe(me.id, patch)
      onSaved({ ...me, ...patch })
      setMsg('Guardado')
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!confirm('¿Eliminar tu cuenta? Se borran tu perfil, tus archivos compartidos y tus cambios. No se puede deshacer.')) return
    try {
      await cloud.deleteMyAccount()
      onSignOut()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
  }

  const field = (key: keyof typeof form, label: string, max: number, type = 'text', autoComplete = 'off') => (
    <label className="field"><span>{label}</span>
      <input type={type} value={form[key]} maxLength={max} autoComplete={autoComplete}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
    </label>
  )

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog" role="dialog" aria-label="Mi perfil" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">👤 Mi perfil</h2>
          <button type="button" className="btn-ghost" onClick={onClose} aria-label="Cerrar">✕</button>
        </div>
        <p className="hint">{me.email} · {ROLE[me.role]}</p>
        {field('full_name', 'Nombre', 120, 'text', 'name')}
        {field('phone', 'Teléfono (opcional)', 40, 'tel', 'tel')}
        {field('company', 'Empresa (opcional)', 120, 'text', 'organization')}
        <p className="hint">
          Tus datos solo los ve el equipo de Verea que te compartió proyectos. Consulta el{' '}
          <a href="/privacidad.html" target="_blank" rel="noopener" className="underline">aviso de privacidad</a>.
        </p>
        {msg && <p className="hint" role="status">{msg}</p>}
        <div className="flex gap-2 justify-between flex-wrap">
          <div className="flex gap-2">
            <button type="button" className="btn" onClick={onSignOut}>Cerrar sesión</button>
            {me.role === 'viewer' && <button type="button" className="btn-danger" onClick={remove}>Eliminar mi cuenta</button>}
          </div>
          <button className="btn btn-active" type="submit" disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</button>
        </div>
      </form>
    </div>
  )
}
