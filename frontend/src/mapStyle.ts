// Map style and device/link data, shared by the main map (MapView) and the report snapshots
// (report/snapshots.ts), so both look the same. A highlight (one gateway + one node) enlarges and
// rings those two and their link, and dims everything else: used for each node's report image.
import maplibregl from 'maplibre-gl'
import type { StyleSpecification } from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import { BRAND } from './brand'
import { COLORS, COVERAGE_URL } from './colors'
import { iconImageId, type DeviceKind } from './deviceIcons'
import { db, distance } from './geo'
import type { CellStatus, LinkResult, Project, Selection } from './types'

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services'
const ESRI_IMAGERY = `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`
// Transparent reference layers: roads, then places and boundaries
const ESRI_ROADS = `${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`
const ESRI_PLACES = `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`
const GLYPHS = 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf'
export const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

export const MAP_LOCALE = {
  'NavigationControl.ZoomIn': 'Acercar', 'NavigationControl.ZoomOut': 'Alejar',
  'NavigationControl.ResetBearing': 'Arrastra para girar el mapa; clic para volver al norte',
  'AttributionControl.ToggleAttribution': 'Mostrar u ocultar atribuciones',
  'AttributionControl.MapFeedback': 'Comentarios sobre el mapa',
  'Map.Title': 'Mapa', 'ScaleControl.Meters': 'm', 'ScaleControl.Kilometers': 'km',
  'Marker.Title': 'Marcador', 'Popup.Close': 'Cerrar',
}

let protocolAdded = false
/** PMTiles (the 4G coverage) are read by the browser through this protocol. */
export function ensurePmtiles() {
  if (!protocolAdded) {
    maplibregl.addProtocol('pmtiles', new Protocol().tile)
    protocolAdded = true
  }
}

export interface MapData {
  project: Project
  links: Record<string, LinkResult>
  cells: Record<string, CellStatus>
  cellular: Set<string>
  stations: Set<string>                           // weather stations (own symbol)
  selection?: Selection
  highlight?: { gateway?: string; node: string }  // report: one link (or one 4G sensor)
}

export function linkColor(r?: LinkResult): string {
  const l = r?.link
  if (!l) return COLORS.none
  return l.viable ? COLORS.viable : l.margin_db > -5 ? COLORS.marginal : COLORS.fail
}

export function cellColor(c?: CellStatus): string {
  if (!c) return COLORS.none
  return c.state === 'ok' ? COLORS.cellOk : c.state === 'none' ? COLORS.cellNone
    : c.state === 'possible' ? COLORS.cellPossible : COLORS.cellEdge
}

/** Second label line: distance and margin of LoRa nodes, 4G state, nodes served by a gateway. */
function subLabel(d: MapData, kind: 'gateway' | 'node', name: string): string {
  if (kind === 'gateway') {
    const n = Object.values(d.links).filter((r) => r.link?.gateway === name).length
    return n ? `${n} nodo${n === 1 ? '' : 's'}` : ''
  }
  if (d.cellular.has(name)) return d.cells[name]?.short ?? '4G'
  const l = d.links[name]?.link
  return l ? `${distance(l.distance_m)} · ${db(l.margin_db)}` : ''
}

export function nodeKindOf(d: Pick<MapData, 'cellular' | 'stations'>, name: string): DeviceKind {
  return d.cellular.has(name) ? 'cellular' : d.stations.has(name) ? 'station' : 'lora'
}

export function devicesGeoJSON(d: MapData): GeoJSON.FeatureCollection {
  const sel = d.selection
  const f = d.highlight
  const label = (kind: 'gateway' | 'node', name: string) => {
    const sub = subLabel(d, kind, name)
    return sub ? `${name}\n${sub}` : name
  }
  const focusOf = (kind: 'gateway' | 'node', name: string) =>
    !!f && (kind === 'gateway' ? f.gateway === name : f.node === name)
  return {
    type: 'FeatureCollection',
    features: [
      ...d.project.gateways.map((g) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [g.lon, g.lat] },
        properties: {
          kind: 'gateway', name: g.name, label: label('gateway', g.name), icon: iconImageId('gateway'),
          color: g.online ? COLORS.gateway : COLORS.none,
          selected: sel?.kind === 'gateway' && sel.name === g.name,
          focus: focusOf('gateway', g.name), dim: !!f && !focusOf('gateway', g.name),
        },
      })),
      ...d.project.nodes.map((n) => {
        const cell = d.cellular.has(n.name)
        return {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [n.lon, n.lat] },
          properties: {
            kind: 'node', name: n.name, cellular: cell, label: label('node', n.name),
            icon: iconImageId(nodeKindOf(d, n.name)),
            color: cell ? cellColor(d.cells[n.name]) : linkColor(d.links[n.name]),
            selected: sel?.kind === 'node' && sel.name === n.name,
            focus: focusOf('node', n.name), dim: !!f && !focusOf('node', n.name),
          },
        }
      }),
    ],
  }
}

/** Plots (parcelas); in a report card, the node's own plot is highlighted. */
export function plotsGeoJSON(d: MapData): GeoJSON.FeatureCollection {
  const node = d.highlight ? d.project.nodes.find((n) => n.name === d.highlight!.node) : undefined
  return {
    type: 'FeatureCollection',
    features: (d.project.plots ?? []).map((pl) => ({
      type: 'Feature', geometry: pl.geometry,
      properties: { id: pl.id, focus: !!node?.plot && node.plot === pl.id, dim: !!d.highlight && node?.plot !== pl.id },
    })),
  }
}

export function linksGeoJSON(d: MapData): GeoJSON.FeatureCollection {
  const gws = new Map(d.project.gateways.map((g) => [g.name, g]))
  const features: GeoJSON.Feature[] = []
  for (const n of d.project.nodes) {
    const r = d.links[n.name]
    const gw = r?.link ? gws.get(r.link.gateway) : undefined
    if (!gw) continue
    const focus = !!d.highlight && d.highlight.node === n.name
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[gw.lon, gw.lat], [n.lon, n.lat]] },
      properties: { color: linkColor(r), focus, dim: !!d.highlight && !focus },
    })
  }
  return { type: 'FeatureCollection', features }
}

const isFocus = ['==', ['get', 'focus'], true] as const
const isDim = ['==', ['get', 'dim'], true] as const

/** The whole map style: imagery, 4G coverage, labels, links, devices and the tool layers. */
export function buildStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      imagery: { type: 'raster', tiles: [ESRI_IMAGERY], tileSize: 256, maxzoom: 18, attribution: 'Imágenes © Esri' },
      roads: { type: 'raster', tiles: [ESRI_ROADS], tileSize: 256, maxzoom: 19 },
      places: { type: 'raster', tiles: [ESRI_PLACES], tileSize: 256, maxzoom: 19, attribution: 'Nombres © Esri' },
      coverage: {
        type: 'raster', url: `pmtiles://${new URL(COVERAGE_URL, window.location.href).href}`, tileSize: 256,
        attribution: 'Cobertura 4G: CRT / datos.gob.mx (CC BY 4.0)',
      },
      plots: { type: 'geojson', data: EMPTY },
      devices: { type: 'geojson', data: EMPTY },
      links: { type: 'geojson', data: EMPTY },
      ruler: { type: 'geojson', data: EMPTY },
      'profile-pins': { type: 'geojson', data: EMPTY },
      cursor: { type: 'geojson', data: EMPTY },
    },
    layers: [
      { id: 'imagery', type: 'raster', source: 'imagery' },
      { id: 'coverage', type: 'raster', source: 'coverage', layout: { visibility: 'none' }, paint: { 'raster-resampling': 'nearest' } },
      { id: 'roads', type: 'raster', source: 'roads' },
      { id: 'places', type: 'raster', source: 'places' },
      {
        id: 'plots-fill', type: 'fill', source: 'plots',
        paint: { 'fill-color': ['case', isFocus, BRAND.teal, '#ffffff'], 'fill-opacity': ['case', isFocus, 0.22, isDim, 0.04, 0.1] } as never,
      },
      {
        id: 'plots-line', type: 'line', source: 'plots',
        paint: {
          'line-color': ['case', isFocus, BRAND.tealLight, '#ffffff'],
          'line-width': ['case', isFocus, 3, 1.4],
          'line-opacity': ['case', isDim, 0.35, 0.9],
        } as never,
      },
      {
        id: 'links-casing', type: 'line', source: 'links', filter: isFocus as never,
        layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 9 },
      },
      {
        id: 'links', type: 'line', source: 'links', layout: { 'line-cap': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['case', isFocus, 5, 3],
          'line-opacity': ['case', isDim, 0.3, 0.85],
        } as never,
      },
      {
        id: 'device-halo', type: 'circle', source: 'devices',
        filter: ['any', ['==', ['get', 'selected'], true], isFocus] as never,
        paint: { 'circle-radius': ['case', isFocus, 21, 17], 'circle-color': '#ffffff', 'circle-opacity': 0.95 } as never,
      },
      {
        id: 'devices', type: 'circle', source: 'devices',
        paint: {
          'circle-radius': ['case', isFocus, 15, ['match', ['get', 'kind'], 'gateway', 13, 11]],
          'circle-color': ['get', 'color'],
          'circle-opacity': ['case', isDim, 0.35, 1],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
          'circle-stroke-opacity': ['case', isDim, 0.35, 1],
        } as never,
      },
      {
        // white glyph of the device type inside its circle (images from deviceIcons.ts)
        id: 'device-icons', type: 'symbol', source: 'devices',
        layout: {
          'icon-image': ['get', 'icon'],
          'icon-size': ['case', isFocus, 0.9, ['match', ['get', 'kind'], 'gateway', 0.8, 0.68]],
          'icon-allow-overlap': true, 'icon-ignore-placement': true,
        } as never,
        paint: { 'icon-opacity': ['case', isDim, 0.35, 1] } as never,
      },
      {
        id: 'labels', type: 'symbol', source: 'devices', filter: ['!', isDim] as never,
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Open Sans Semibold'],
          'text-size': ['case', isFocus, 14, 12],
          'text-line-height': 1.25,
          'text-offset': ['case', isFocus, ['literal', [0, 2.1]], ['literal', [0, 1.6]]],
          'text-anchor': 'top',
          'text-optional': true,           // hide a label rather than overlap it
        } as never,
        paint: { 'text-color': '#ffffff', 'text-halo-color': '#000000', 'text-halo-width': 1.5 },
      },
      {
        id: 'ruler-line', type: 'line', source: 'ruler', filter: ['==', ['get', 'kind'], 'line'],
        paint: { 'line-color': '#ffd166', 'line-width': 2.5, 'line-dasharray': [2, 1.5] },
      },
      {
        id: 'ruler-vertex', type: 'circle', source: 'ruler', filter: ['==', ['get', 'kind'], 'vertex'],
        paint: { 'circle-radius': 4.5, 'circle-color': '#ffd166', 'circle-stroke-color': '#000', 'circle-stroke-width': 1 },
      },
      {
        id: 'ruler-text', type: 'symbol', source: 'ruler', filter: ['==', ['get', 'kind'], 'segment'],
        layout: { 'text-field': ['get', 'text'], 'text-font': ['Open Sans Semibold'], 'text-size': 12, 'text-allow-overlap': true },
        paint: { 'text-color': '#ffd166', 'text-halo-color': '#000000', 'text-halo-width': 1.8 },
      },
      {
        id: 'profile-pins', type: 'circle', source: 'profile-pins',
        paint: { 'circle-radius': 9, 'circle-color': '#ef476f', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
      },
      {
        id: 'profile-pin-numbers', type: 'symbol', source: 'profile-pins',
        layout: { 'text-field': ['get', 'n'], 'text-font': ['Open Sans Semibold'], 'text-size': 11, 'text-allow-overlap': true },
        paint: { 'text-color': '#ffffff' },
      },
      {
        id: 'cursor', type: 'circle', source: 'cursor',
        paint: { 'circle-radius': 7, 'circle-color': '#ffd166', 'circle-stroke-color': '#000', 'circle-stroke-width': 2 },
      },
    ],
  }
}
