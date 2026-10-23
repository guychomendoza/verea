// Accounts and cloud projects (Supabase). Without VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
// the app runs in local mode: no login, the project lives in the browser.
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'
import type { Project } from './types'
import type { Overrides } from './viewer'

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

export type Role = 'admin' | 'member' | 'viewer'

export interface Me {
  id: string
  email: string
  full_name: string
  phone: string
  company: string
  role: Role
  active: boolean
}

/** Admins and members: the team, who edit. Viewers only open shared links. */
export const isTeam = (m: Me) => m.role === 'admin' || m.role === 'member'

function db(): SupabaseClient {
  if (!supabase) throw new Error('El almacenamiento en la nube no está configurado')
  return supabase
}

function check<T>(r: { data: T; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message)
  return r.data
}

export async function me(session: Session): Promise<Me | null> {
  const r = await db().from('profiles').select('id, email, full_name, phone, company, role, active').eq('id', session.user.id).maybeSingle()
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

export async function updateMe(id: string, patch: { full_name: string; phone: string; company: string }): Promise<void> {
  check(await db().from('profiles').update(patch).eq('id', id).select('id'))
}

export async function deleteMyAccount(): Promise<void> {
  check(await db().rpc('delete_my_account'))
}

// ── team: accounts (admins change roles) ──
export interface Account { id: string; email: string; full_name: string; phone: string; company: string; role: Role; active: boolean; created_at: string }

export async function listAccounts(): Promise<Account[]> {
  const r = await db().from('profiles').select('id, email, full_name, phone, company, role, active, created_at')
    .order('created_at', { ascending: false })
  return check(r) as Account[]
}

export async function setAccount(id: string, patch: { role?: Role; active?: boolean }): Promise<void> {
  const rows = check(await db().from('profiles').update(patch).eq('id', id).select('id')) as unknown[]
  if (!rows.length) throw new Error('Solo un administrador puede cambiar esta cuenta')
}

// ── shared links ──
export interface Share { id: string; token: string; show_owner_info: boolean; created_at: string; revoked_at: string | null }
export interface Access {
  user_id: string
  first_opened: string
  last_opened: string
  share_id: string | null
  who: { full_name: string; email: string; phone: string; company: string } | null
}

export async function listShares(projectId: string): Promise<Share[]> {
  const r = await db().from('project_shares').select('id, token, show_owner_info, created_at, revoked_at')
    .eq('project_id', projectId).order('created_at', { ascending: false })
  return check(r) as Share[]
}

export async function createShare(projectId: string, showOwnerInfo: boolean): Promise<Share> {
  const r = await db().from('project_shares').insert({ project_id: projectId, show_owner_info: showOwnerInfo })
    .select('id, token, show_owner_info, created_at, revoked_at').single()
  return check(r) as Share
}

export async function revokeShare(id: string): Promise<void> {
  check(await db().from('project_shares').update({ revoked_at: new Date().toISOString() }).eq('id', id).select('id'))
}

/** The project's newest active link that shows (or hides) owner info, made when there is none. */
export async function activeShare(projectId: string, showOwnerInfo: boolean): Promise<Share> {
  const live = (await listShares(projectId)).find((s) => !s.revoked_at && s.show_owner_info === showOwnerInfo)
  return live ?? createShare(projectId, showOwnerInfo)
}

export async function listAccess(projectId: string): Promise<Access[]> {
  const r = await db().from('project_viewers')
    .select('user_id, first_opened, last_opened, share_id, who:profiles!project_viewers_user_id_fkey(full_name, email, phone, company)')
    .eq('project_id', projectId).order('last_opened', { ascending: false })
  return check(r) as unknown as Access[]
}

export async function removeAccess(projectId: string, userId: string): Promise<void> {
  check(await db().from('project_viewers').delete().eq('project_id', projectId).eq('user_id', userId).select('user_id'))
}

// ── viewers ──
export interface ViewerFile { project_id: string; name: string; updated_at: string; last_opened: string }
export interface ViewerProject {
  name: string
  updated_at: string
  data: Project
  overrides: Overrides
  token: string | null                 // the link they came by, while it is active
  show_owner_info: boolean
}

/** Open a shared link: the project's id (viewers get access to it). */
export async function claimShare(token: string): Promise<string> {
  const r = await db().rpc('claim_share', { share_token: token })
  return check(r) as string
}

export async function myFiles(): Promise<ViewerFile[]> {
  return check(await db().rpc('my_files')) as ViewerFile[]
}

export async function viewerProject(id: string): Promise<ViewerProject> {
  return check(await db().rpc('viewer_project', { pid: id })) as ViewerProject
}

export async function saveOverrides(projectId: string, userId: string, overrides: Overrides): Promise<void> {
  check(await db().from('project_viewers').update({ overrides }).eq('project_id', projectId).eq('user_id', userId)
    .select('user_id'))
}

/** A viewer takes a project off their files (the link brings it back while it is active). */
export async function leaveProject(projectId: string, userId: string): Promise<void> {
  await removeAccess(projectId, userId)
}
