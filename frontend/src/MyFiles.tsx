import { useEffect, useState } from 'react'
import * as cloud from './cloud'
import { Alert, Icon } from './icons'
import { Logo } from './Logo'
import { Spinner } from './Loading'

interface Props {
  me: cloud.Me
  notice: string
  onOpen: (id: string) => void
  onSettings: () => void
}

/** A viewer's files: the projects whose link they opened. */
export default function MyFiles({ me, notice, onOpen, onSettings }: Props) {
  const [rows, setRows] = useState<cloud.ViewerFile[] | null>(null)
  const [error, setError] = useState('')
  const load = () => cloud.myFiles().then(setRows).catch((e) => setError(e.message))
  useEffect(() => { load() }, [])

  const leave = async (f: cloud.ViewerFile) => {
    if (!confirm(`¿Quitar "${f.name || 'Sin nombre'}" de tus archivos? Para volver a verlo necesitarás el link otra vez.`)) return
    try {
      await cloud.leaveProject(f.project_id, me.id)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="files-wrap">
      <div className="files">
        <div className="files-head">
          <Logo width={150} />
          <div className="flex items-center gap-2">
            <span className="hint truncate">{me.full_name || me.email}</span>
            <button className="icon-btn" onClick={onSettings} title="Configuración: cuenta y apariencia" aria-label="Configuración">
              <Icon name="settings" size={18} /></button>
          </div>
        </div>
        <h1 className="text-lg font-semibold">Mis archivos</h1>
        <p className="hint">Los proyectos que te compartieron. Ábrelos para explorar cada nodo, su enlace y su perfil de elevación.</p>
        {notice && <Alert tone="warn">{notice}</Alert>}
        {error && <Alert>{error}</Alert>}
        {rows === null ? <Spinner /> : rows.length === 0 ? (
          <p className="hint">Todavía no tienes proyectos. Cuando alguien te comparta un link de Verea, ábrelo y aparecerá aquí.</p>
        ) : (
          <div className="file-grid">
            {rows.map((f) => (
              <div key={f.project_id} className="file-card" role="button" tabIndex={0} aria-label={`Abrir ${f.name}`}
                onClick={() => onOpen(f.project_id)} onKeyDown={(e) => e.key === 'Enter' && onOpen(f.project_id)}>
                <div className="font-medium">{f.name || 'Proyecto sin nombre'}</div>
                <div className="hint">Actualizado {new Date(f.updated_at).toLocaleDateString('es-MX')}</div>
                <div className="hint">Lo abriste {new Date(f.last_opened).toLocaleString('es-MX')}</div>
                <button className="btn-ghost text-xs underline self-start" aria-label={`Quitar ${f.name}`}
                  onClick={(e) => { e.stopPropagation(); leave(f) }}>Quitar de mis archivos</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
