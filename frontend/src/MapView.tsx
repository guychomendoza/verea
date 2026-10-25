import { useEffect, useRef } from 'react'
import maplibregl, { type GeoJSONSource, type MapMouseEvent, type MapTouchEvent } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { COLORS, DEFAULT_CENTER } from './colors'
import { distance, haversine } from './geo'
import { registerDeviceIcons } from './deviceIcons'
import { MAP_LOCALE, buildStyle, devicesGeoJSON, ensurePmtiles, linksGeoJSON, plotsGeoJSON, rangeGeoJSON } from './mapStyle'
import type { CellStatus, LinkResult, Project, Radial, Selection } from './types'
import { NEAR_M, OBSERVED, type FieldTest } from './fieldTests'

/** Where to move the view: a point (and zoom), or a box to fit (every device of a project). */
export interface Focus { lat: number; lon: number; zoom?: number; bounds?: [[number, number], [number, number]]; key: number }

export type MapMode = 'select' | 'addGateway' | 'addNode' | 'ruler' | 'pick'   // pick: a point for a field test
type LatLon = [number, number]

interface Props {
  project: Project
  selection: Selection
  links: Record<string, LinkResult>
  cells: Record<string, CellStatus>
  cellular: Set<string>
  stations: Set<string>
  ranges?: Record<string, Radial[]>
  mode: MapMode
  showCoverage: boolean
  showLabels: boolean
  pin: { lat: number; lon: number } | null
  focus: Focus | null
  cursor: LatLon | null                 // point hovered in the elevation profile
  profilePins: LatLon[]                 // points marked in the elevation profile
  ruler: LatLon[]
  onSelect: (s: Selection) => void
  onMove: (kind: 'gateway' | 'node', name: string, lat: number, lon: number) => void
  onAdd: (lat: number, lon: number) => void
  onRulerPoint: (lat: number, lon: number) => void
  onRulerDone: () => void
  onToggleRuler: () => void
  coverageAvailable: boolean            // the server has 4G coverage data
  onToggleCoverage: () => void
  onReady?: (map: maplibregl.Map) => void
  readOnly?: boolean                    // viewer: devices are selected, never dragged
  fieldTests?: FieldTest[]              // 4G field tests, drawn as coloured points
  onFieldTest?: (clientId: string) => void   // a field test's dot was clicked
  // «Mi ubicación» (MapLibre's control, beside the zoom): autoLocate starts it at once (field mode);
  // onLocate gets every position, onLocateError a message (permission denied…)
  autoLocate?: boolean
  onLocate?: (here: { lat: number; lon: number; accuracy: number }) => void
  onLocateError?: (message: string) => void
}

/** Map button for the ruler, under the zoom buttons. */
class RulerControl implements maplibregl.IControl {
  private el = document.createElement('div')
  private btn = document.createElement('button')
  constructor(onClick: () => void) {
    this.el.className = 'maplibregl-ctrl maplibregl-ctrl-group'
    this.btn.type = 'button'
    this.btn.className = 'verea-ruler-btn'
    this.btn.title = 'Regla (R): medir distancias'
    this.btn.setAttribute('aria-label', 'Regla: medir distancias')
    this.btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" '
      + 'd="M3 15.6 15.6 3 21 8.4 8.4 21zm2.1 0 3.3 3.3L18.9 8.4l-3.3-3.3-1.2 1.2 1.6 1.6-.9.9-1.6-1.6-1.2 1.2 '
      + '2.4 2.4-.9.9-2.4-2.4-1.2 1.2 1.6 1.6-.9.9-1.6-1.6-1.2 1.2 2.4 2.4-.9.9-2.4-2.4z"/></svg>'
    this.btn.onclick = onClick
    this.el.appendChild(this.btn)
  }
  setActive(on: boolean) {
    this.btn.classList.toggle('active', on)
    this.btn.setAttribute('aria-pressed', String(on))
  }
  onAdd() { return this.el }
  onRemove() { this.el.remove() }
}

/** 4G coverage on/off, bottom right beside the attribution, with its legend while shown. */
class CoverageControl implements maplibregl.IControl {
  private el = document.createElement('div')
  private btn = document.createElement('button')
  private legend = document.createElement('div')
  constructor(onClick: () => void) {
    this.el.className = 'maplibregl-ctrl verea-coverage-ctrl'
    this.btn.type = 'button'
    this.btn.className = 'verea-coverage-btn'
    this.btn.title = 'Mostrar u ocultar la cobertura 4G declarada'
    this.btn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" '
      + 'stroke-width="2.4" stroke-linecap="round"><path d="M5 20v-3M9.7 20v-6.5M14.3 20v-10M19 20V6.5"/></svg>'
      + '<span>Cobertura 4G</span>'
    this.btn.onclick = onClick
    this.legend.className = 'verea-coverage-legend'
    this.legend.innerHTML = ([[COLORS.cellOk, 'Garantizada'], [COLORS.cellEdge, 'Incierta'],
      [COLORS.cellPossible, 'Posible (LTE-M)'], [COLORS.cellNone, 'Sin cobertura']] as const)
      .map(([c, t]) => `<span><i style="background:${c}"></i>${t}</span>`).join('')
    this.el.append(this.legend, this.btn)
  }
  set(on: boolean, available: boolean) {
    this.el.hidden = !available
    this.btn.classList.toggle('active', on)
    this.btn.setAttribute('aria-pressed', String(on))
    this.legend.hidden = !on
  }
  onAdd() { return this.el }
  onRemove() { this.el.remove() }
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

function metresToPixels(m: number, lat: number) {
  const r0 = m / (156543.03 * Math.cos((lat * Math.PI) / 180))        // metres per pixel at zoom 0
  return { r0, r22: r0 * 2 ** 22 }
}

/** Field tests: one point each, coloured by what the sensor got. */
function fieldGeoJSON(tests: FieldTest[] = []): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: tests.map((t) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
      // r0 / r22: NEAR_M in pixels at zoom 0 and 22 (the area it repaints on the coverage map)
      properties: { color: OBSERVED[t.observed].color, id: t.client_id, ...metresToPixels(NEAR_M, t.lat) } })),
  }
}

function applyProps(map: maplibregl.Map, props: Props, dragging: boolean) {
  if (!dragging) {
    ;(map.getSource('devices') as GeoJSONSource).setData(devicesGeoJSON(props))
    ;(map.getSource('links') as GeoJSONSource).setData(linksGeoJSON(props))
    ;(map.getSource('plots') as GeoJSONSource).setData(plotsGeoJSON(props))
    ;(map.getSource('range') as GeoJSONSource).setData(rangeGeoJSON(props))
  }
  ;(map.getSource('ruler') as GeoJSONSource).setData(rulerGeoJSON(props.ruler))
  ;(map.getSource('profile-pins') as GeoJSONSource).setData(pointsGeoJSON(props.profilePins, true))
  ;(map.getSource('cursor') as GeoJSONSource).setData(pointsGeoJSON(props.cursor ? [props.cursor] : []))
  ;(map.getSource('field-tests') as GeoJSONSource).setData(fieldGeoJSON(props.fieldTests))
  map.setLayoutProperty('coverage', 'visibility', props.showCoverage ? 'visible' : 'none')
  map.setLayoutProperty('field-areas', 'visibility', props.showCoverage ? 'visible' : 'none')   // tests repaint the coverage
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
  const rulerCtl = useRef<RulerControl | null>(null)
  const coverageCtl = useRef<CoverageControl | null>(null)

  // Create the map once
  useEffect(() => {
    ensurePmtiles()
    const first = propsRef.current.project.gateways[0] ?? propsRef.current.project.nodes[0]
    const map = new maplibregl.Map({
      container: container.current!,
      center: first ? [first.lon, first.lat] : DEFAULT_CENTER,
      zoom: first ? 14 : 12,
      maxZoom: 19,
      attributionControl: { compact: true },
      doubleClickZoom: false,               // double click ends a ruler measurement
      locale: MAP_LOCALE,
      canvasContextAttributes: { preserveDrawingBuffer: true },   // map image download
      style: buildStyle(),
    })
    registerDeviceIcons(map)
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right')
    const ruler = new RulerControl(() => propsRef.current.onToggleRuler())
    map.addControl(ruler, 'top-right')
    rulerCtl.current = ruler
    // «Mi ubicación»: the blue dot and its accuracy circle, following the phone; also in the editor
    // (the map doubles as a field map for installations)
    const locate = new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
      trackUserLocation: true, showAccuracyCircle: true, fitBoundsOptions: { maxZoom: 16 },
    })
    map.addControl(locate, 'top-right')
    locate.on('geolocate', (e: GeolocationPosition) =>
      propsRef.current.onLocate?.({ lat: e.coords.latitude, lon: e.coords.longitude, accuracy: e.coords.accuracy }))
    locate.on('error', (e: GeolocationPositionError) => propsRef.current.onLocateError?.(e.code === 1
      ? 'Permite el acceso a tu ubicación para verla en el mapa.' : 'No se pudo obtener tu ubicación.'))
    if (propsRef.current.autoLocate) map.once('load', () => locate.trigger())
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left')
    const coverage = new CoverageControl(() => propsRef.current.onToggleCoverage())
    map.addControl(coverage, 'bottom-right')
    coverageCtl.current = coverage
    mapRef.current = map
    propsRef.current.onReady?.(map)
    // tests: the dev server, or a production build made with VITE_E2E=1 (CSP check)
    if (import.meta.env.DEV || import.meta.env.VITE_E2E) (window as unknown as { __vereaMap: maplibregl.Map }).__vereaMap = map

    const featureAt = (e: MapMouseEvent | MapTouchEvent) =>
      map.queryRenderedFeatures(e.point, { layers: ['devices'] })[0]

    const startDrag = (e: MapMouseEvent | MapTouchEvent) => {
      const f = featureAt(e)
      if (!f || propsRef.current.mode !== 'select') return
      if ('points' in e && e.points.length !== 1) return
      if (propsRef.current.readOnly) return       // the click selects it
      e.preventDefault()
      pressedDevice.current = true
      const { kind, name } = f.properties as { kind: 'gateway' | 'node'; name: string }
      drag.current = { kind, name, moved: false }
      propsRef.current.onSelect({ kind, name })
      map.getCanvas().style.cursor = 'grabbing'
    }
    const moveDrag = (e: MapMouseEvent | MapTouchEvent) => {
      // A press whose release happened off the map (e.g. over the panel that the selection
      // opened) must not keep dragging: no button held means the drag is over
      if (drag.current && 'buttons' in e.originalEvent && (e.originalEvent as MouseEvent).buttons === 0) {
        drag.current = null
        devicesDirty()
      }
      const d = drag.current
      if (!d) {
        map.getCanvas().style.cursor = propsRef.current.mode !== 'select' ? 'crosshair'
          : featureAt(e) ? (propsRef.current.readOnly ? 'pointer' : 'grab') : ''
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
    // Released outside the map: drop the drag (the node goes back to its place)
    const cancelDrag = () => {
      if (!drag.current) return
      drag.current = null
      map.getCanvas().style.cursor = ''
      devicesDirty()
    }
    const devicesDirty = () => (map.getSource('devices') as GeoJSONSource | undefined)?.setData(devicesGeoJSON(propsRef.current))
    const onWindowUp = (ev: MouseEvent) => { if (!map.getCanvas().contains(ev.target as Node)) cancelDrag() }
    window.addEventListener('mouseup', onWindowUp)
    map.on('touchend', endDrag)
    map.on('click', (e) => {
      const p = propsRef.current
      const pressed = pressedDevice.current
      pressedDevice.current = false
      if (p.mode === 'ruler') p.onRulerPoint(e.lngLat.lat, e.lngLat.lng)
      else if (p.mode !== 'select') p.onAdd(e.lngLat.lat, e.lngLat.lng)
      else if (!pressed) {
        const t = p.onFieldTest && map.queryRenderedFeatures(e.point, { layers: ['field-tests'] })[0]
        if (t) { p.onFieldTest!(t.properties.id as string); return }
        const f = featureAt(e)
        if (!f) p.onSelect(null)
        else if (p.readOnly) {
          const { kind, name } = f.properties as { kind: 'gateway' | 'node'; name: string }
          p.onSelect({ kind, name })
        }
      }
    })
    map.on('dblclick', () => { if (propsRef.current.mode === 'ruler') propsRef.current.onRulerDone() })
    // Once loaded, always draw the latest props (isStyleLoaded() can be false for a moment
    // later on, and a 'load' listener added then would never fire)
    map.on('load', () => {
      loaded.current = true
      applyProps(map, propsRef.current, !!drag.current)
    })
    // The map may be created before its panel has its final size (or the panel changes later)
    const resizer = new ResizeObserver(() => map.resize())
    resizer.observe(container.current!)
    return () => {
      resizer.disconnect()
      window.removeEventListener('mouseup', onWindowUp)
      map.remove()
    }
  }, [])

  // Data and visibility follow the props
  useEffect(() => {
    const map = mapRef.current
    if (map && loaded.current) applyProps(map, props, !!drag.current)
    rulerCtl.current?.setActive(props.mode === 'ruler')
    coverageCtl.current?.set(props.showCoverage, props.coverageAvailable)
  }, [props])

  useEffect(() => {
    const f = props.focus
    const map = mapRef.current
    if (!f || !map) return
    // Next frame: a panel opened in the same render may have narrowed the map
    const id = requestAnimationFrame(() => {
      map.resize()
      if (f.bounds) map.fitBounds(f.bounds, { padding: 60, maxZoom: 16, duration: 600 })
      else map.flyTo({ center: [f.lon, f.lat], zoom: f.zoom ?? map.getZoom() })
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
