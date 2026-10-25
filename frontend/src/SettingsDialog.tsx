import { useEffect, useState } from 'react'
import type * as cloud from './cloud'
import { CloseButton, Icon, type IconName } from './icons'
import { applyTheme, savedTheme, type Theme } from './theme'
import { isTeam } from './cloud'
import { setAutosave, useAutosave } from './autosave'
import { askConfirm } from './confirm'

type Tab = 'account' | 'appearance' | 'saving' | 'admin'

interface Props {
  // Cloud mode: the signed-in account (local mode has no account: appearance only)
  account?: {
    me: cloud.Me
    onSave: (patch: { full_name: string; phone: string; company: string }) => Promise<void>
    onDelete: () => Promise<void>
    onSignOut: () => void
    onUsers?: () => void              // admins
  }
  onClose: () => void
}

const ROLE: Record<cloud.Role, string> = { admin: 'Administrador', member: 'Editor del equipo', viewer: 'Lector' }
const THEMES: [Theme, string, IconName][] = [['auto', 'Automático', 'monitor'], ['light', 'Claro', 'sun'], ['dark', 'Oscuro', 'moon']]

/** Configuración: the account (profile, sign out), the appearance and, for admins, the users. */
export default function SettingsDialog({ account, onClose }: Props) {
  const tabs: [Tab, string, IconName][] = [
    ...(account ? [['account', 'Cuenta', 'user'] as [Tab, string, IconName]] : []),
    ['appearance', 'Apariencia', 'palette'],
    ...(account && isTeam(account.me) ? [['saving', 'Guardado', 'save'] as [Tab, string, IconName]] : []),
    ...(account?.onUsers ? [['admin', 'Administración', 'users'] as [Tab, string, IconName]] : []),
  ]
  const [tab, setTab] = useState<Tab>(tabs[0][0])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog settings" role="dialog" aria-label="Configuración" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold flex items-center gap-2"><Icon name="settings" size={18} /> Configuración</h2>
          <CloseButton onClick={onClose} />
        </div>
        <div className="settings-body">
          <nav className="settings-tabs" role="tablist" aria-label="Secciones de la configuración">
            {tabs.map(([key, label, icon]) => (
              <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''}
                onClick={() => setTab(key)}><Icon name={icon} /> {label}</button>
            ))}
          </nav>
          <div className="settings-panel" role="tabpanel" aria-label={tabs.find((t) => t[0] === tab)?.[1]}>
            {tab === 'account' && account && <AccountTab {...account} />}
            {tab === 'appearance' && <AppearanceTab />}
            {tab === 'saving' && <SavingTab />}
            {tab === 'admin' && account?.onUsers && (
              <>
                <p className="hint">
                  Quien entra con Google queda como <b>lector</b>: solo ve los proyectos que le comparten. Para que alguien del
                  equipo edite, pídele que entre una vez y cámbialo a <b>Editor</b>.
                </p>
                <button className="btn self-start flex items-center gap-2" onClick={account.onUsers}>
                  <Icon name="users" /> Usuarios y roles…</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function AccountTab({ me, onSave, onDelete, onSignOut }: NonNullable<Props['account']>) {
  const [form, setForm] = useState({ full_name: me.full_name, phone: me.phone, company: me.company })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setMsg('')
    try {
      await onSave({ full_name: form.full_name.trim(), phone: form.phone.trim(), company: form.company.trim() })
      setMsg('Guardado')
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!await askConfirm('¿Eliminar tu cuenta? Se borran tu perfil, tus archivos compartidos y tus cambios. No se puede deshacer.', { ok: 'Eliminar mi cuenta', danger: true })) return
    try {
      await onDelete()
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
    <form className="flex flex-col gap-3" onSubmit={save}>
      <div className="account-card">
        <span className="avatar" aria-hidden="true">{(me.full_name || me.email).slice(0, 1).toUpperCase()}</span>
        <div className="min-w-0">
          <div className="font-medium truncate">{me.full_name || me.email}</div>
          <div className="hint truncate">{me.email} · {ROLE[me.role]}</div>
        </div>
      </div>
      {field('full_name', 'Nombre', 120, 'text', 'name')}
      {field('phone', 'Teléfono (opcional)', 40, 'tel', 'tel')}
      {field('company', 'Empresa (opcional)', 120, 'text', 'organization')}
      <p className="hint">
        Tus datos solo los ve el equipo de Verea. Consulta el{' '}
        <a href="/privacidad.html" target="_blank" rel="noopener" className="underline">aviso de privacidad</a>.
      </p>
      {msg && <p className="hint" role="status">{msg}</p>}
      <div className="flex gap-2 justify-between flex-wrap">
        <button type="button" className="btn-danger flex items-center gap-2" onClick={onSignOut}><Icon name="logout" /> Cerrar sesión</button>
        <button className="btn btn-active" type="submit" disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</button>
      </div>
      {me.role === 'viewer' && (
        <button type="button" className="btn-ghost text-xs underline self-start text-[var(--bad)]" onClick={remove}>
          Eliminar mi cuenta</button>
      )}
    </form>
  )
}

function AppearanceTab() {
  const [theme, setTheme] = useState<Theme>(savedTheme)
  return (
    <div className="flex flex-col gap-3">
      <div className="field"><span>Tema</span>
        <div className="segmented" role="radiogroup" aria-label="Tema">
          {THEMES.map(([key, label, icon]) => (
            <button key={key} role="radio" aria-checked={theme === key} className={theme === key ? 'active' : ''}
              onClick={() => { applyTheme(key); setTheme(key) }}><Icon name={icon} /> {label}</button>
          ))}
        </div>
        <small className="hint">Automático sigue la configuración de tu sistema. Se recuerda en este navegador.</small>
      </div>
    </div>
  )
}

function SavingTab() {
  const autosave = useAutosave()
  return (
    <div className="flex flex-col gap-3">
      <div className="setting-row">
        <div>
          <b id="autosave-label">Autoguardado</b>
          <small className="hint block">Guarda el proyecto en la nube unos segundos después de cada cambio. Desactivado, los
            cambios se guardan solo con el botón Guardar o Ctrl+S.</small>
        </div>
        <Switch on={autosave} onChange={setAutosave} labelledBy="autosave-label" />
      </div>
      <small className="hint">Sin guardar, tus cambios quedan como borrador en este navegador: si cierras la pestaña,
        Verea te ofrece recuperarlos la próxima vez. Esta preferencia se recuerda en este navegador.</small>
    </div>
  )
}

/** An on / off switch (role="switch"), with its state written beside it. */
function Switch({ on, onChange, labelledBy }: { on: boolean; onChange: (on: boolean) => void; labelledBy: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-labelledby={labelledBy} className={`switch ${on ? 'on' : ''}`}
      onClick={() => onChange(!on)}>
      <span className="switch-track"><span className="switch-thumb" /></span>
      <span className="switch-text">{on ? 'Activado' : 'Desactivado'}</span>
    </button>
  )
}
