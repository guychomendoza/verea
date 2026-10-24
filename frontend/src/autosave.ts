// Cloud projects are saved with the Guardar button (or Ctrl+S); autosave is an opt-in preference
// (Configuración → Guardado), off by default. Unsaved edits are also kept as a draft in this
// browser, so a closed tab or a crash does not lose them: the draft is offered back on reopen.
import { useSyncExternalStore } from 'react'
import type { Project } from './types'

export type SaveState = 'saved' | 'saving' | 'pending' | 'conflict' | 'error'

const AUTOSAVE_KEY = 'verea.autosave'
const DRAFT_PREFIX = 'verea.draft.'
const EVENT = 'verea:autosave'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* private mode or full: the preference / draft lives only in memory */
  }
}

export function autosaveOn(): boolean {
  return read(AUTOSAVE_KEY) === '1'
}

export function setAutosave(on: boolean) {
  write(AUTOSAVE_KEY, on ? '1' : null)
  window.dispatchEvent(new Event(EVENT))
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb)
  window.addEventListener('storage', cb)          // another tab changed it
  return () => {
    window.removeEventListener(EVENT, cb)
    window.removeEventListener('storage', cb)
  }
}

/** The autosave preference, updated live when it changes. */
export function useAutosave(): boolean {
  return useSyncExternalStore(subscribe, autosaveOn)
}

/** Unsaved edits of a cloud project; `base` is the version (updated_at) they started from. */
export interface Draft { project: Project; base: string; at: string }

export function saveDraft(id: string, project: Project, base: string) {
  write(DRAFT_PREFIX + id, JSON.stringify({ project, base, at: new Date().toISOString() }))
}

export function loadDraft(id: string): Draft | null {
  try {
    const raw = read(DRAFT_PREFIX + id)
    return raw ? (JSON.parse(raw) as Draft) : null
  } catch {
    return null
  }
}

export function clearDraft(id: string) {
  write(DRAFT_PREFIX + id, null)
}
