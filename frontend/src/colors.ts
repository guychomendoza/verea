// Map colours and data locations shared by the map and the panels.

export const COVERAGE_URL = import.meta.env.VITE_COVERAGE_URL ?? '/coverage/telcel_4g_2026q2.pmtiles'
export const DEFAULT_CENTER: [number, number] = [-102.3494, 21.9614]   // Aguascalientes region

export const COLORS = {
  viable: '#06d6a0', marginal: '#ffd166', fail: '#ef476f', none: '#6c757d',
  gateway: '#3da3bc', cellOk: '#2a9d8f', cellEdge: '#ffe066', cellPossible: '#f77f00', cellNone: '#e63946',
}
