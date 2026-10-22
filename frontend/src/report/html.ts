// Interactive HTML report: one self-contained file (data embedded), map and elevation
// profiles navigable in any browser; MapLibre and Plotly load from a CDN when it is opened.
import { COLORS } from '../colors'
import { PLOTLY_CONFIG, PLOTLY_LOCALE } from '../profilePlot'
import type { ReportData } from './collect'
import { GLOSSARY, SOURCES, nodeFacts, overviewTable, settingsLine, summary } from './content'

const MAPLIBRE = 'https://unpkg.com/maplibre-gl@5.24.0/dist'
const PLOTLY = 'https://cdn.jsdelivr.net/npm/plotly.js-dist-min@2.35.2/plotly.min.js'

function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function tableHtml(head: string[], rows: string[][]): string {
  return `<div class="tbl"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>`
    + `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
}

export function buildHtml(d: ReportData): string {
  const title = d.project.name.trim() || 'Proyecto Verea'
  const nodeColor = (name: string) => {
    if (d.cellular.has(name)) {
      const s = d.cells[name]?.state
      return !s ? COLORS.none : s === 'ok' ? COLORS.cellOk : s === 'none' ? COLORS.cellNone : COLORS.cellEdge
    }
    const l = d.links[name]?.link
    return !l ? COLORS.none : l.viable ? COLORS.viable : l.margin_db > -5 ? COLORS.marginal : COLORS.fail
  }
  const data = {
    devices: [
      ...d.project.gateways.map((g) => ({ kind: 'gateway', name: g.name, lat: g.lat, lon: g.lon, color: COLORS.gateway })),
      ...d.project.nodes.map((n) => ({ kind: 'node', name: n.name, lat: n.lat, lon: n.lon, color: nodeColor(n.name) })),
    ],
    links: d.nodes.filter((s) => s.gateway).map((s) => ({
      from: [s.gateway!.lon, s.gateway!.lat], to: [s.node.lon, s.node.lat], color: nodeColor(s.node.name),
    })),
    sections: d.nodes.map((s, i) => ({ id: `p${i}`, figure: s.figure, coords: s.detail?.profile.coordinates }))
      .filter((s) => s.figure),
    locale: PLOTLY_LOCALE,
    config: { ...PLOTLY_CONFIG, responsive: true },
  }
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  const verdict = (name: string, cellular: boolean) => {
    if (cellular) {
      const c = d.cells[name]
      return [c ? c.short : 'Sin revisar', !c ? 'muted' : c.state === 'ok' ? 'ok' : c.state === 'none' ? 'bad' : 'warn']
    }
    const r = d.links[name]
    const l = r?.link
    return [l ? (l.viable ? 'Enlace viable' : 'Enlace no viable') : (r?.error ?? 'Sin resultado'),
      !l ? 'muted' : l.viable ? 'ok' : l.margin_db > -5 ? 'warn' : 'bad']
  }
  const cards = d.nodes.map((s, i) => {
    const l = s.cellular ? null : d.links[s.node.name]?.link
    const [text, cls] = verdict(s.node.name, s.cellular)
    return `<section class="card">
  <h3>${esc(s.node.name)} <small>${esc(s.cellular ? 'Sensor 4G' : l ? `Nodo LoRa · enlace con ${l.gateway}` : 'Nodo LoRa')}</small></h3>
  <p class="verdict ${cls}">${esc(text)}</p>
  <img class="snap" alt="${esc(s.node.name)} en el mapa" src="${s.mapJpg}">
  ${s.figure ? `<div class="chart" id="p${i}"></div>` : ''}
  ${tableHtml(['Dato', 'Valor'], nodeFacts(d, s))}
  ${l && !l.viable && l.reasons.length ? `<p class="muted"><b>Por qué no es viable:</b> ${l.reasons.map(esc).join(' · ')}</p>` : ''}
</section>`
  }).join('\n')
  const ov = overviewTable(d)

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Reporte Verea</title>
<link rel="stylesheet" href="${MAPLIBRE}/maplibre-gl.css">
<style>
  :root { --ink:#1d2433; --muted:#5b6475; --line:#e3e6eb; }
  body { margin:0; font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; color:var(--ink); background:#f6f7f9; }
  header { background:#0e1117; color:#e9ecef; padding:22px 24px; }
  header h1 { margin:0 0 4px; font-size:24px; } header p { margin:0; color:#adb5bd; }
  main { max-width:1150px; margin:0 auto; padding:16px 16px 48px; }
  h2 { font-size:18px; border-bottom:1px solid var(--line); padding-bottom:6px; margin:28px 0 10px; }
  h3 { font-size:16px; margin:0 0 8px; } h3 span { font-size:12px; padding:2px 8px; border-radius:99px; color:#fff; }
  .verdict { display:inline-block; margin:0 0 10px; padding:3px 10px; border-radius:99px; color:#fff; font-weight:600; font-size:13px; }
  .ok { background:#06a77d; } .warn { background:#c98a00; } .bad { background:#d64161; } .muted.verdict { background:#6c757d; }
  h3 small { font-weight:400; color:var(--muted); font-size:13px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:10px; padding:16px; margin:18px 0; }
  .snap { width:100%; border-radius:8px; display:block; margin-bottom:10px; }
  #map { height:520px; border-radius:10px; overflow:hidden; border:1px solid var(--line); }
  .tbl { overflow-x:auto; } table { border-collapse:collapse; width:100%; background:#fff; font-size:13px; }
  th { background:#0e1117; color:#e9ecef; text-align:left; } th, td { padding:6px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
  .chart { height:460px; border-radius:8px; overflow:hidden; }
  .cols { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:16px; margin-top:10px; }
  dt { font-weight:600; margin-top:8px; } dd { margin:0; color:var(--muted); }
  .muted { color:var(--muted); font-size:12px; }
  @media (max-width:760px) { .cols { grid-template-columns:1fr; } #map { height:380px; } .chart { height:380px; } }
  @media print { #map, .chart { break-inside:avoid; } }
</style>
</head>
<body>
<header><h1>${esc(title)}</h1><p>Reporte de red · ${esc(d.generatedAt.toLocaleString('es-MX'))}${d.author ? ` · ${esc(d.author)}` : ''}</p></header>
<main>
${d.project.description.trim() ? `<p>${esc(d.project.description)}</p>` : ''}
<h2>Resumen</h2>${tableHtml(['Concepto', 'Valor'], summary(d))}
<p class="muted">${esc(settingsLine(d))}</p>
<h2>Mapa</h2><div id="map"></div>
<p class="muted">Pasa el mouse sobre un Perfil de Elevación para ver el punto en este mapa.</p>
<h2>${esc(ov.title)}</h2>${tableHtml(ov.head, ov.rows)}
${d.nodes.length ? '<h2>Nodos</h2>' : ''}
${cards}
<h2>Glosario</h2><dl>${GLOSSARY.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
<h2>Fuentes y atribuciones</h2>${SOURCES.map((s) => `<p class="muted">${esc(s)}</p>`).join('')}
</main>
<script id="verea-data" type="application/json">${json}</script>
<script src="${MAPLIBRE}/maplibre-gl.js"></script>
<script src="${PLOTLY}"></script>
<script>
const D = JSON.parse(document.getElementById('verea-data').textContent);
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const map = new maplibregl.Map({
  container: 'map', attributionControl: { compact: true },
  locale: { 'NavigationControl.ZoomIn': 'Acercar', 'NavigationControl.ZoomOut': 'Alejar',
    'NavigationControl.ResetBearing': 'Arrastra para girar el mapa; clic para volver al norte',
    'AttributionControl.ToggleAttribution': 'Mostrar u ocultar atribuciones', 'Map.Title': 'Mapa' },
  style: { version: 8, glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      imagery: { type: 'raster', tiles: [ESRI + '/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 18, attribution: 'Imágenes © Esri' },
      places: { type: 'raster', tiles: [ESRI + '/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'], tileSize: 256 },
      devices: { type: 'geojson', data: { type: 'FeatureCollection', features: D.devices.map(d => ({ type: 'Feature',
        geometry: { type: 'Point', coordinates: [d.lon, d.lat] }, properties: d })) } },
      links: { type: 'geojson', data: { type: 'FeatureCollection', features: D.links.map(l => ({ type: 'Feature',
        geometry: { type: 'LineString', coordinates: [l.from, l.to] }, properties: l })) } },
      cursor: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    },
    layers: [
      { id: 'imagery', type: 'raster', source: 'imagery' },
      { id: 'places', type: 'raster', source: 'places' },
      { id: 'links', type: 'line', source: 'links', paint: { 'line-color': ['get', 'color'], 'line-width': 3 } },
      { id: 'devices', type: 'circle', source: 'devices', paint: { 'circle-radius': ['match', ['get', 'kind'], 'gateway', 9, 7],
        'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } },
      { id: 'labels', type: 'symbol', source: 'devices', layout: { 'text-field': ['get', 'name'], 'text-font': ['Open Sans Semibold'],
        'text-size': 12, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-optional': true },
        paint: { 'text-color': '#fff', 'text-halo-color': '#000', 'text-halo-width': 1.5 } },
      { id: 'cursor', type: 'circle', source: 'cursor', paint: { 'circle-radius': 7, 'circle-color': '#ffd166',
        'circle-stroke-color': '#000', 'circle-stroke-width': 2 } },
    ] },
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
if (D.devices.length) {
  const b = new maplibregl.LngLatBounds();
  D.devices.forEach(d => b.extend([d.lon, d.lat]));
  map.fitBounds(b, { padding: 60, maxZoom: 16, duration: 0 });
}
Plotly.register(D.locale);
for (const s of D.sections) {
  const el = document.getElementById(s.id);
  Plotly.newPlot(el, s.figure.data, s.figure.layout, D.config);
  el.on('plotly_hover', ev => {
    const c = s.coords[ev.points[0].pointIndex];
    map.getSource('cursor').setData({ type: 'FeatureCollection', features: [{ type: 'Feature',
      geometry: { type: 'Point', coordinates: [c[1], c[0]] }, properties: {} }] });
  });
}
</script>
</body>
</html>
`
}
