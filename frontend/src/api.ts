import type {
  Catalog, CellStatus, Gateway, LinkDetail, LinkResult, NodeDevice, Place, Project, Settings,
} from './types'

const BASE = import.meta.env.VITE_API_URL ?? ''

// Session token for the API (set by the login, phase 3)
let token: string | null = null
export function setToken(t: string | null) {
  token = t
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const j = await res.json()
      detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, detail)
  }
  return res.json() as Promise<T>
}

export const api = {
  catalog: () => call<Catalog>('/api/catalog'),
  links: (gateways: Gateway[], nodes: NodeDevice[], settings: Settings, signal?: AbortSignal) =>
    call<{ results: Record<string, LinkResult>; elevation: string }>(
      '/api/links', { gateways, nodes, settings }, signal),
  link: (gateway: Gateway, node: NodeDevice, settings: Settings, signal?: AbortSignal) =>
    call<LinkDetail>('/api/link', { gateway, node, settings }, signal),
  cellStatus: (operator: string, points: { name: string; lat: number; lon: number }[],
    signal?: AbortSignal) =>
    call<{ points: CellStatus[]; sources: string[] }>('/api/cell-status', { operator, points }, signal),
  geocode: (q: string, signal?: AbortSignal) =>
    call<{ results: Place[] }>(`/api/geocode?q=${encodeURIComponent(q)}`, undefined, signal),
  normalize: (project: unknown) => call<Omit<Project, 'version'>>('/api/project/normalize', { project }),
}
