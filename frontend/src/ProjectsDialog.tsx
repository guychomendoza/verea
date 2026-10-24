import { useEffect, useState } from 'react'
import * as cloud from './cloud'
import { CloseButton } from './icons'

interface Props {
  me: cloud.Me
  currentId: string | null
  onOpen: (id: string) => void
  onDeleted: (id: string) => void
  onClose: () => void
}

function who(p: { full_name: string; email: string } | null): string {
  return p ? p.full_name || p.email : '—'
}

/** The team's projects: open one, or delete your own (admins: any). */
export default function ProjectsDialog({ me, currentId, onOpen, onDeleted, onClose }: Props) {
  const [rows, setRows] = useState<cloud.ProjectRow[] | null>(null)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')

  const load = () => cloud.listProjects().then(setRows).catch((e) => setError(e.message))
  useEffect(() => { load() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const remove = async (r: cloud.ProjectRow) => {
    if (!confirm(`¿Eliminar "${r.name || 'Sin nombre'}" para todo el equipo? No se puede deshacer.`)) return
    try {
      if (await cloud.deleteProject(r.id)) {
        onDeleted(r.id)
        load()
      } else {
        setError('Solo su dueño o un administrador puede eliminar este proyecto.')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const shown = (rows ?? []).filter((r) => r.name.toLowerCase().includes(filter.toLowerCase()))
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" role="dialog" aria-label="Proyectos del equipo" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Proyectos del equipo</h2>
          <CloseButton onClick={onClose} />
        </div>
        <input type="search" placeholder="Filtrar por nombre" value={filter} onChange={(e) => setFilter(e.target.value)}
          aria-label="Filtrar proyectos" />
        {error && <p className="error">{error}</p>}
        {rows === null ? <p className="hint">Cargando…</p> : (
          <ul className="project-list">
            {shown.length === 0 && <li className="hint">No hay proyectos</li>}
            {shown.map((r) => (
              <li key={r.id} className={r.id === currentId ? 'current' : ''}>
                <button className="grow text-left" onClick={() => onOpen(r.id)}>
                  <div className="font-medium">{r.name || 'Proyecto sin nombre'}{r.id === currentId ? ' · abierto' : ''}</div>
                  <div className="hint">
                    {new Date(r.updated_at).toLocaleString('es-MX')} por {who(r.editor)} · dueño: {who(r.owner)}
                  </div>
                </button>
                {(r.owner_id === me.id || me.role === 'admin') && (
                  <button className="btn-danger text-xs" onClick={() => remove(r)} aria-label={`Eliminar ${r.name}`}>Eliminar</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
