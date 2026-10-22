// Keyboard shortcuts. Letters alone act only outside text fields (Ctrl+N cannot be used:
// Chrome and Edge keep it for "new window").

export type Shortcut = 'addGateway' | 'addNode' | 'ruler' | 'cancel' | 'save'

export const SHORTCUT_HELP: [string, string][] = [
  ['G', 'Agregar gateway (también Ctrl+G)'],
  ['N', 'Agregar sensor (Dragino LSE01)'],
  ['R', 'Regla: medir distancias'],
  ['Ctrl+S', 'Guardar ahora'],
  ['Esc', 'Cancelar / terminar'],
]

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable
}

export function shortcutFor(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'target'>): Shortcut | null {
  const key = e.key.toLowerCase()
  const mod = e.ctrlKey || e.metaKey
  if (mod && !e.altKey && key === 's') return 'save'
  if (mod && !e.altKey && key === 'g') return 'addGateway'
  if (key === 'escape') return 'cancel'
  if (mod || e.altKey || typing(e.target)) return null
  if (key === 'g') return 'addGateway'
  if (key === 'n') return 'addNode'
  if (key === 'r') return 'ruler'
  return null
}
