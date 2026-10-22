import { useEffect, useRef } from 'react'
import maplibregl, { type GeoJSONSource, type MapMouseEvent, type MapTouchEvent } from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import 'maplibre-gl/dist/maplibre-gl.css'
import { COLORS, COVERAGE_URL, DEFAULT_CENTER } from './colors'
import { db, distance, haversine } from './geo'
import type { CellStatus, LinkResult, Project, Selection } from './types'

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services'
const ESRI_IMAGERY = `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`
// Transparent reference layers: roads, then places and boundaries
const ESRI_ROADS = `${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`
const ESRI_PLACES = `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`
const GLYPHS = 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf'
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
let protocolAdded = false

export type MapMode = 'select' | 'addGateway' | 'addNode' | 'ruler'
type LatLon = [number, number]

interface Props {
  project: Project
  selection: Selection
  links: Record<string, LinkResult>
  cells: Record<string, CellStatus>
  cellular: Set<string>
  mode: MapMode
  showCoverage: boolean
  showLabels: boolean
  pin: { lat: number; lon: number } | null
  focus: { lat: number; lon: number; zoom?: number; key: number } | null
  cursor: LatLon | null                 // point hovered in the elevation profile
  profilePins: LatLon[]                 // points marked in the elevation profile
  ruler: LatLon[]
  onSelect: (s: Selection) => void
  onMove: (kind: 'gateway' | 'node', name: string, lat: number, lon: number) => void
  onAdd: (lat: number, lon: number) => void
  onRulerPoint: (lat: number, lon: number) => void
  onRulerDone: () => void
  onReady?: (map: maplibregl.Map) => void
}

function linkColor(r?: LinkResult): string {
  const l = r?.link
  if (!l) return COLORS.none
  return l.viable ? COLORS.viable : l.margin_db > -5 ? COLORS.marginal : COLORS.fail
}

function cellColor(c?: CellStatus): string {
  if (!c) return COLORS.none
  return c.state === 'ok' ? COLORS.cellOk : c.state === 'none' ? COLORS.cellNone : COLORS.cellEdge
}

/** Second label line: distance and margin of LoRa nodes, 4G state, nodes served by a gateway. */
function subLabel(p: Props, kind: 'gateway' | 'node', name: string): string {
  if (kind === 'gateway') {
    const n = Object.values(p.links).filter((r) => r.link?.gateway === name).length
    return n ? `${n} nodo${n === 1 ? '' : 's'}` : ''
  }
  if (p.cellular.has(name)) return p.cells[name]?.short ?? '4G'
  const l = p.links[name]?.link
  return l ? `${distance(l.distance_m)} · ${db(l.margin_db)}` : ''
}

function devicesGeoJSON(p: Props): GeoJSON.FeatureCollection {
  const sel = p.selection
  const label = (kind: 'gateway' | 'node', name: string) => {
    const sub = subLabel(p, kind, name)
    return sub ? `${name}\n${sub}` : name
  }
  return {
    type: 'FeatureCollection',
    features: [
      ...p.project.gateways.map((g) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [g.lon, g.lat] },
        properties: {
          kind: 'gateway', name: g.name, label: label('gateway', g.name),
          color: g.online ? COLORS.gateway : COLORS.none,
          selected: sel?.kind === 'gateway' && sel.name === g.name,
        },
      })),
      ...p.project.nodes.map((n) => {
        const cell = p.cellular.has(n.name)
        return {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [n.lon, n.lat] },
          properties: {
            kind: 'node', name: n.name, cellular: cell, label: label('node', n.name),
            color: cell ? cellColor(p.cells[n.name]) : linkColor(p.links[n.name]),
            selected: sel?.kind === 'node' && sel.name === n.name,
          },
        }
      }),
    ],
  }
}

function linksGeoJSON(p: Props): GeoJSON.FeatureCollection {
  const gws = new Map(p.project.gateways.map((g) => [g.name, g]))
  const features: GeoJSON.Feature[] = []
  for (const n of p.project.nodes) {
    const r = p.links[n.name]
    const gw = r?.link ? gws.get(r.link.gateway) : undefined
    if (!gw) continue
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[gw.lon, gw.lat], [n.lon, n.lat]] },
      properties: { color: linkColor(r) },
    })
  }
  return { type: 'FeatureCollection', features }
}

function pointsGeoJSON(points: LatLon[], numbered = false): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: points.map((pt, i) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [pt[1], pt[0]] },
      properties: { n: numbered ? String(i + 1) : '' },
    })),
  }
}

/** Ruler line, its points, and a label with the length of each segment at its middle. */
function rulerGeoJSON(points: LatLon[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = points.map((pt) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [pt[1], pt[0]] }, properties: { kind: 'vertex' },
  }))
  if (points.length > 1) {
    features.push({
      type: 'Feature', properties: { kind: 'line' },
      geometry: { type: 'LineString', coordinates: points.map((pt) => [pt[1], pt[0]]) },
    })
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]
      const b = points[i]
      features.push({
        type: 'Feature', properties: { kind: 'segment', text: distance(haversine(a, b)) },
        geometry: { type: 'Point', coordinates: [(a[1] + b[1]) / 2, (a[0] + b[0]) / 2] },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

function applyProps(map: maplibregl.Map, props: Props, dragging: boolean) {
  if (!dragging) {
    ;(map.getSource('devices') as GeoJSONSource).setData(devicesGeoJSON(props))
    ;(map.getSource('links') as GeoJSONSource).setData(linksGeoJSON(props))
  }
  ;(map.getSource('ruler') as GeoJSONSource).setData(rulerGeoJSON(props.ruler))
  ;(map.getSource('profile-pins') as GeoJSONSource).setData(pointsGeoJSON(props.profilePins, true))
  ;(map.getSource('cursor') as GeoJSONSource).setData(pointsGeoJSON(props.cursor ? [props.cursor] : []))
  map.setLayoutProperty('coverage', 'visibility', props.showCoverage ? 'visible' : 'none')
  for (const id of ['roads', 'places']) {
    map.setLayoutProperty(id, 'visibility', props.showLabels ? 'visible' : 'none')
  }
}

export default function MapView(props: Props) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const propsRef = useRef(props)
  propsRef.current = props
  const drag = useRef<{ kind: 'gateway' | 'node'; name: string; moved: boolean } | null>(null)
  // The click that follows a press on a device must not deselect it: opening the side panel
  // narrows the map between mousedown and click, so the click no longer lands on the device.
  const pressedDevice = useRef(false)
  const loaded = useRef(false)

  // Create the map once
  useEffect(() => {
    if (!protocolAdded) {
      maplibregl.addProtocol('pmtiles', new Protocol().tile)
      protocolAdded = true
    }
    const first = propsRef.current.project.gateways[0] ?? propsRef.current.project.nodes[0]
    const map = new maplibregl.Map({
      container: container.current!,
      center: first ? [first.lon, first.lat] : DEFAULT_CENTER,
      zoom: first ? 14 : 12,
      maxZoom: 19,
      attributionControl: { compact: true },
      doubleClickZoom: false,               // double click ends a ruler measurement
      locale: {
        'NavigationControl.ZoomIn': 'Acercar', 'NavigationControl.ZoomOut': 'Alejar',
        'NavigationControl.ResetBearing': 'Arrastra para girar el mapa; clic para volver al norte',
        'AttributionControl.ToggleAttribution': 'Mostrar u ocultar atribuciones',
        'AttributionControl.MapFeedback': 'Comentarios sobre el mapa',
        'Map.Title': 'Mapa', 'ScaleControl.Meters': 'm', 'ScaleControl.Kilometers': 'km',
        'Marker.Title': 'Marcador', 'Popup.Close': 'Cerrar',
      },
      canvasContextAttributes: { preserveDrawingBuffer: true },   // map image download
      style: {
        version: 8,
        glyphs: GLYPHS,
        sources: {
          imagery: {
            type: 'raster', tiles: [ESRI_IMAGERY], tileSize: 256, maxzoom: 18,
            attribution: 'Imágenes © Esri',
          },
          roads: { type: 'raster', tiles: [ESRI_ROADS], tileSize: 256, maxzoom: 19 },
          places: {
            type: 'raster', tiles: [ESRI_PLACES], tileSize: 256, maxzoom: 19,
            attribution: 'Nombres © Esri',
          },
          coverage: {
            type: 'raster', url: `pmtiles://${new URL(COVERAGE_URL, window.location.href).href}`,
            tileSize: 256,
            attribution: 'Cobertura 4G: CRT / datos.gob.mx (CC BY 4.0)',
          },
          devices: { type: 'geojson', data: EMPTY },
          links: { type: 'geojson', data: EMPTY },
          ruler: { type: 'geojson', data: EMPTY },
          'profile-pins': { type: 'geojson', data: EMPTY },
          cursor: { type: 'geojson', data: EMPTY },
        },
        layers: [
          { id: 'imagery', type: 'raster', source: 'imagery' },
          {
            id: 'coverage', type: 'raster', source: 'coverage',
            layout: { visibility: 'none' }, paint: { 'raster-resampling': 'nearest' },
          },
          { id: 'roads', type: 'raster', source: 'roads' },
          { id: 'places', type: 'raster', source: 'places' },
          {
            id: 'links', type: 'line', source: 'links',
            paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 0.85 },
          },
          {
            id: 'device-halo', type: 'circle', source: 'devices',
            filter: ['==', ['get', 'selected'], true],
            paint: { 'circle-radius': 15, 'circle-color': '#ffffff', 'circle-opacity': 0.9 },
          },
          {
            id: 'devices', type: 'circle', source: 'devices',
            paint: {
              'circle-radius': ['match', ['get', 'kind'], 'gateway', 10, 8],
              'circle-color': ['get', 'color'],
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2,
            },
          },
          {
            id: 'labels', type: 'symbol', source: 'devices',
            layout: {
              'text-field': ['get', 'label'],
              'text-font': ['Open Sans Semibold'],
              'text-size': 12,
              'text-line-height': 1.25,
              'text-offset': [0, 1.3],
              'text-anchor': 'top',
              'text-optional': true,       // hide a label rather than overlap it
            },
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
      },
    })
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right')
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left')
    mapRef.current = map
    propsRef.current.onReady?.(map)
    if (import.meta.env.DEV) (window as unknown as { __vereaMap: maplibregl.Map }).__vereaMap = map

    const featureAt = (e: MapMouseEvent | MapTouchEvent) =>
      map.queryRenderedFeatures(e.point, { layers: ['devices'] })[0]

    const startDrag = (e: MapMouseEvent | MapTouchEvent) => {
      const f = featureAt(e)
      if (!f || propsRef.current.mode !== 'select') return
      if ('points' in e && e.points.length !== 1) return
      e.preventDefault()
      pressedDevice.current = true
      const { kind, name } = f.properties as { kind: 'gateway' | 'node'; name: string }
      drag.current = { kind, name, moved: false }
      propsRef.current.onSelect({ kind, name })
      map.getCanvas().style.cursor = 'grabbing'
    }
    const moveDrag = (e: MapMouseEvent | MapTouchEvent) => {
      const d = drag.current
      if (!d) {
        map.getCanvas().style.cursor = propsRef.current.mode !== 'select' ? 'crosshair'
          : featureAt(e) ? 'grab' : ''
        return
      }
      d.moved = true
      const src = map.getSource('devices') as GeoJSONSource
      const data = devicesGeoJSON(propsRef.current)
      for (const f of data.features) {
        if (f.properties?.kind === d.kind && f.properties?.name === d.name) {
          (f.geometry as GeoJSON.Point).coordinates = [e.lngLat.lng, e.lngLat.lat]
        }
      }
      src.setData(data)
    }
    const endDrag = (e: MapMouseEvent | MapTouchEvent) => {
      const d = drag.current
      if (!d) return
      drag.current = null
      map.getCanvas().style.cursor = ''
      if (d.moved) propsRef.current.onMove(d.kind, d.name, e.lngLat.lat, e.lngLat.lng)
    }
    map.on('mousedown', 'devices', startDrag)
    map.on('touchstart', 'devices', startDrag)
    map.on('mousemove', moveDrag)
    map.on('touchmove', moveDrag)
    map.on('mouseup', endDrag)
    map.on('touchend', endDrag)
    map.on('click', (e) => {
      const p = propsRef.current
      const pressed = pressedDevice.current
      pressedDevice.current = false
      if (p.mode === 'ruler') p.onRulerPoint(e.lngLat.lat, e.lngLat.lng)
      else if (p.mode !== 'select') p.onAdd(e.lngLat.lat, e.lngLat.lng)
      else if (!pressed && !featureAt(e)) p.onSelect(null)
    })
    map.on('dblclick', () => { if (propsRef.current.mode === 'ruler') propsRef.current.onRulerDone() })
    // Once loaded, always draw the latest props (isStyleLoaded() can be false for a moment
    // later on, and a 'load' listener added then would never fire)
    map.on('load', () => {
      loaded.current = true
      applyProps(map, propsRef.current, !!drag.current)
    })
    return () => map.remove()
  }, [])

  // Data and visibility follow the props
  useEffect(() => {
    const map = mapRef.current
    if (map && loaded.current) applyProps(map, props, !!drag.current)
  }, [props])

  useEffect(() => {
    const f = props.focus
    const map = mapRef.current
    if (!f || !map) return
    // Next frame: a panel opened in the same render may have narrowed the map
    const id = requestAnimationFrame(() => {
      map.resize()
      map.flyTo({ center: [f.lon, f.lat], zoom: f.zoom ?? map.getZoom() })
    })
    return () => cancelAnimationFrame(id)
  }, [props.focus])

  // Marker of the last place searched
  const pinRef = useRef<maplibregl.Marker | null>(null)
  useEffect(() => {
    const map = mapRef.current
    pinRef.current?.remove()
    pinRef.current = null
    if (map && props.pin) {
      pinRef.current = new maplibregl.Marker({ color: '#ef476f' }).setLngLat([props.pin.lon, props.pin.lat]).addTo(map)
    }
  }, [props.pin])

  // Inline style: maplibre-gl.css sets .maplibregl-map { position: relative }
  return <div ref={container} style={{ position: 'absolute', inset: 0 }} data-testid="map" />
}
