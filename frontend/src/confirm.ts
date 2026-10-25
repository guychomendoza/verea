// Confirmations in Verea's own style instead of the browser's confirm(): `await askConfirm(...)`
// opens a small dialog (ConfirmHost.tsx, mounted once in main.tsx) and resolves true or false.

export interface Ask { message: string; ok: string; danger: boolean; resolve: (yes: boolean) => void }

let current: Ask | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function askConfirm(message: string, opts: { ok?: string; danger?: boolean } = {}): Promise<boolean> {
  current?.resolve(false)
  return new Promise((resolve) => {
    current = { message, ok: opts.ok ?? 'Aceptar', danger: opts.danger ?? false, resolve }
    emit()
  })
}

export function answer(yes: boolean) {
  const a = current
  current = null
  emit()
  a?.resolve(yes)
}

export const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } }
export const pending = () => current
