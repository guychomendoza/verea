import { useEffect, useState } from 'react'
import * as cloud from './cloud'
import { shareUrl } from './share'

interface Props {
  projectId: string
  projectName: string
  onClose: () => void
}

const when = (s: string) => new Date(s).toLocaleString('es-MX')

/** Links to the project for people outside the team, and who opened them. */
export default function ShareDialog({ projectId, projectName, onClose }: Props) {
  const [shares, setShares] = useState<cloud.Share[] | null>(null)
  const [access, setAccess] = useState<cloud.Access[]>([])
  const [showOwners, setShowOwners] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')

  const load = () => Promise.all([cloud.listShares(projectId), cloud.listAccess(projectId)])
    .then(([s, a]) => { setShares(s); setAccess(a) })
    .catch((e) => setError(e.message))
  useEffect(() => { load() }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = (f: () => Promise<unknown>) => async () => {
    setError('')
    try {
      await f()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const copy = async (token: string) => {
    try {
      await navigator.clipboard.writeText(shareUrl(token))
      setCopied(token)
    } catch {
      setError('No se pudo copiar: selecciona el link y cópialo a mano.')
    }
  }

  const live = (shares ?? []).filter((s) => !s.revoked_at)
  const label = (id: string | null) => {
    const s = (shares ?? []).find((x) => x.id === id)
    return !s ? '—' : `${s.show_owner_info ? 'con titulares' : 'sin titulares'}${s.revoked_at ? ' (revocado)' : ''}`
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" role="dialog" aria-label="Compartir" onClick={(e) => e.stopPropagation()} style={{ width: 'min(720px, 100%)' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">🔗 Compartir "{projectName || 'Sin nombre'}"</h2>
          <button className="btn-ghost" onClick={onClose} aria-label="Cerrar">✕</button>
        </div>
        <p className="hint">
          Quien abra el link entra con su cuenta de Google como <b>lector</b>: explora el mapa, cada nodo y su perfil de
          elevación, y puede probar otra altura o entorno solo para él. No puede editar el proyecto. El link también va en
          el PDF.
        </p>
        {error && <p className="error" role="alert">⚠ {error}</p>}
        {shares === null ? <p className="hint">Cargando…</p> : (
          <>
            {live.map((s) => (
              <div key={s.id} className="flex flex-col gap-1">
                <div className="share-link">
                  <input readOnly value={shareUrl(s.token)} aria-label="Link para compartir" onFocus={(e) => e.target.select()} />
                  <button className="btn" onClick={() => copy(s.token)}>{copied === s.token ? '✓ Copiado' : 'Copiar'}</button>
                  <button className="btn-danger text-xs" onClick={run(() => cloud.revokeShare(s.id))}>Revocar</button>
                </div>
                <span className="hint">{s.show_owner_info ? 'Muestra titulares, hectáreas y parcelas' : 'Sin titulares, hectáreas ni parcelas'} · creado {when(s.created_at)}</span>
              </div>
            ))}
            <div className="flex items-center gap-3 flex-wrap">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={showOwners} onChange={(e) => setShowOwners(e.target.checked)} />
                Mostrar titulares, hectáreas y parcelas
              </label>
              <button className="btn btn-active" onClick={run(() => cloud.createShare(projectId, showOwners))}>
                {live.length ? 'Crear otro link' : 'Crear link'}
              </button>
            </div>
            <p className="hint">Revocar un link evita que entren personas nuevas; quien ya entró conserva el acceso hasta que se lo quites abajo.</p>
            <h3>Quién tiene acceso ({access.length})</h3>
            {access.length === 0 ? <p className="hint">Nadie ha abierto todavía un link de este proyecto.</p> : (
              <table className="account-table">
                <thead><tr><th>Persona</th><th>Empresa · teléfono</th><th>Link</th><th>Último acceso</th><th></th></tr></thead>
                <tbody>
                  {access.map((a) => (
                    <tr key={a.user_id}>
                      <td>{a.who?.full_name || '—'}<div className="hint">{a.who?.email}</div></td>
                      <td>{[a.who?.company, a.who?.phone].filter(Boolean).join(' · ') || '—'}</td>
                      <td>{label(a.share_id)}</td>
                      <td>{when(a.last_opened)}</td>
                      <td><button className="btn-danger text-xs" aria-label={`Quitar acceso a ${a.who?.email}`}
                        onClick={run(() => cloud.removeAccess(projectId, a.user_id))}>Quitar acceso</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  )
}
