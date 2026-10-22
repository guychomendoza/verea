// Accounts and cloud projects (Supabase). Without VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
// the app runs in local mode: no login, the project lives in the browser.
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'
import type { Project } from './types'

const URL_ = import.meta.env.VITE_SUPABASE_URL as string | undefined
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

// An invitation or password-reset link lands with "type=invite|recovery" in the URL hash;
// read it before the client consumes the hash, to ask for a new password.
export const arrivedToSetPassword = /type=(invite|recovery)/.test(window.location.hash)

export const supabase: SupabaseClient | null = URL_ && KEY
  ? createClient(URL_, KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null

export const cloudEnabled = supabase !== null

export interface ProjectRow {
  id: string
  name: string
  updated_at: string
  owner_id: string
  owner: { full_name: string; email: string } | null
  editor: { full_name: string; email: string } | null
}

export interface Me {
  id: string
  email: string
  full_name: string
  role: 'admin' | 'member'
}

function db(): SupabaseClient {
  if (!supabase) throw new Error('Cloud storage is not configured')
  return supabase
}

function check<T>(r: { data: T; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message)
  return r.data
}

export async function me(session: Session): Promise<Me | null> {
  const r = await db().from('profiles').select('id, email, full_name, role').eq('id', session.user.id).maybeSingle()
  return check(r) as Me | null
}

export async function listProjects(): Promise<ProjectRow[]> {
  const r = await db().from('projects')
    .select('id, name, updated_at, owner_id, owner:profiles!projects_owner_id_fkey(full_name, email), '
      + 'editor:profiles!projects_updated_by_fkey(full_name, email)')
    .order('updated_at', { ascending: false })
  return check(r) as unknown as ProjectRow[]
}

export async function loadProject(id: string): Promise<{ project: Project; updated_at: string; owner_id: string }> {
  const r = await db().from('projects').select('data, updated_at, owner_id').eq('id', id).single()
  const row = check(r) as { data: Project; updated_at: string; owner_id: string }
  return { project: row.data, updated_at: row.updated_at, owner_id: row.owner_id }
}

export async function createProject(project: Project): Promise<{ id: string; updated_at: string; owner_id: string }> {
  const r = await db().from('projects').insert({ name: project.name, data: project })
    .select('id, updated_at, owner_id').single()
  return check(r) as { id: string; updated_at: string; owner_id: string }
}

/**
 * Save over the version that was loaded (`knownUpdatedAt`). Returns the new updated_at,
 * or null when someone else saved in between (nothing is overwritten).
 */
export async function saveProject(id: string, project: Project, knownUpdatedAt: string): Promise<string | null> {
  const r = await db().from('projects').update({ name: project.name, data: project })
    .eq('id', id).eq('updated_at', knownUpdatedAt).select('updated_at')
  const rows = check(r) as { updated_at: string }[]
  return rows.length ? rows[0].updated_at : null
}

export async function deleteProject(id: string): Promise<boolean> {
  const r = await db().from('projects').delete().eq('id', id).select('id')
  return (check(r) as unknown[]).length > 0
}
