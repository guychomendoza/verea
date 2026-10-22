// Same shapes as the project JSON of core/project.py, so .verea.json files load as they are.

export interface Gateway {
  name: string
  lat: number
  lon: number
  model: string
  height?: number
  tx_power?: number
  gain?: number
  cable_loss?: number
  online: boolean
}

export interface NodeDevice {
  name: string
  lat: number
  lon: number
  model: string
  type?: string
  sf?: number
  height?: number
  tx_power?: number
  gain?: number
  cable_loss?: number
  environment?: string
}

export interface Settings {
  freq_mhz: number
  propagation_model: string
  diffraction_method: string
  safety_margin: number
  environment: string
  cell_operator?: string
}

export interface Project {
  version: number
  name: string
  description: string
  gateways: Gateway[]
  nodes: NodeDevice[]
  name_counters: Record<string, number>
  settings: Settings
}

export interface LinkSummary {
  gateway: string
  viable: boolean
  margin_db: number
  rssi_dbm: number
  snr_db: number
  distance_m: number
  model: string
  reasons: string[]
}

export interface LinkResult {
  link: LinkSummary | null
  error: string | null
}

export interface Profile {
  distances_m: number[]
  elevations_m: number[]
  coordinates: [number, number][]
  los_m: number[]
  fresnel_radius_m: number[]
  clearance_pct: number[]
  worst_point_idx: number
  elevation_source: string
}

export interface LinkDetail {
  summary: LinkSummary
  budget: Record<string, number | string | boolean | string[]>
  profile: Profile
}

export type CellState = 'ok' | 'edge' | 'differentiated' | 'none'

export interface CellStatus {
  name: string | null
  state: CellState
  text: string
  short: string
  covered?: boolean
  level_dbm?: number | null
  nearby_share?: number
  nearest_m?: number | null
  edge_m?: number | null
  margin_m?: number | null
}

export interface DeviceProfile {
  label: string
  type?: string
  link?: string
  tx_power: number
  gain: number
  cable_loss: number
  height: number
  sf?: number
  source: string
  estimated: string[]
}

export interface Catalog {
  gateway_profiles: Record<string, DeviceProfile>
  node_profiles: Record<string, DeviceProfile>
  environments: Record<string, { clutter_loss_db: number; description: string }>
  freq_mhz: number[]
  propagation_models: string[]
  diffraction_methods: string[]
  spreading_factors: number[]
  cell_operators: string[]
  defaults: Settings
}

export type Selection = { kind: 'gateway' | 'node'; name: string } | null

export interface Place {
  name: string
  lat: number
  lon: number
  kind: string
}
