import { useEffect, useSyncExternalStore } from 'react'
import { answer, pending, subscribe } from './confirm'

/** The dialog behind askConfirm (confirm.ts). */
export function ConfirmHost() {
  const ask = useSyncExternalStore(subscribe, pending)
  useEffect(() => {
    if (!ask) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') answer(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ask])
  if (!ask) return null
  return (
    <div className="dialog-backdrop confirm-backdrop" onClick={() => answer(false)}>
      <div className="dialog confirm-dialog" role="alertdialog" aria-label="Confirmar" onClick={(e) => e.stopPropagation()}>
        <p className="confirm-message">{ask.message}</p>
        <div className="flex gap-2 justify-end">
          <button className="btn" onClick={() => answer(false)}>Cancelar</button>
          <button className={ask.danger ? 'btn-danger btn-danger-solid' : 'btn btn-active'} autoFocus onClick={() => answer(true)}>{ask.ok}</button>
        </div>
      </div>
    </div>
  )
}
