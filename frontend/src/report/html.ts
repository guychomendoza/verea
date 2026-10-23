// Interactive HTML report: one self-contained file (data embedded), map and elevation
// profiles navigable in any browser; MapLibre and Plotly load from a CDN when it is opened.
import { BRAND, logoSvg } from '../brand'
import { COLORS, COVERAGE_URL } from '../colors'
import { deviceIconSvg, glyphPngs, iconImageId } from '../deviceIcons'
import type { LegendItem } from '../legend'
import { cellColor, cellShort, nodeKindOf } from '../mapStyle'
import { PLOTLY_CONFIG, PLOTLY_LOCALE } from '../profilePlot'
import type { ReportData } from './collect'
import { GLOSSARY, SOURCES, byOwner, cellTable, gatewayTable, loraTable, nodeFacts, nodeTitle, settingsLine, summaryTables, type Table } from './content'

const MAPLIBRE = 'https://unpkg.com/maplibre-gl@5.24.0/dist'
const PLOTLY = 'https://cdn.jsdelivr.net/npm/plotly.js-dist-min@2.35.2/plotly.min.js'
const PMTILES = 'https://unpkg.com/pmtiles@4.5.0/dist/pmtiles.js'

function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function tableHtml(head: string[], rows: string[][], colors: string[] = [], dotCol = head.length - 1): string {
  const cell = (c: string, i: number, r: number) => (colors[r] && i === dotCol
    ? `<td><i class="dt" style="background:${colors[r]}"></i> ${esc(c)}</td>` : `<td>${esc(c)}</td>`)
  return `<div class="tbl"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>`
    + `<tbody>${rows.map((r, ri) => `<tr>${r.map((c, i) => cell(c, i, ri)).join('')}</tr>`).join('')}</tbody></table></div>`
}

const statusTable = (tb: Table | null) => (tb ? `<h2>${esc(tb.title)}</h2>${tableHtml(tb.head, tb.rows, tb.colors)}` : '')

/** Symbology under a map: device symbols, line samples, dots and group titles. */
function legendHtml(items: LegendItem[]): string {
  if (!items.length) return ''
  return `<div class="symbology">${items.map((it) => {
    if (it.heading) return `<b>${esc(it.label)}</b>`
    const sample = it.icon ? deviceIconSvg(it.icon, it.color, 18)
      : it.line ? `<i class="ln" style="background:${it.color}"></i>` : `<i class="dt" style="background:${it.color}"></i>`
    return `<span>${sample}${esc(it.label)}</span>`
  }).join('')}</div>`
}

export function buildHtml(d: ReportData): string {
  const title = d.project.name.trim() || 'Proyecto Verea'
  const nodeColor = (name: string) => {
    if (d.cellular.has(name)) return cellColor(d.cells[name])
    const l = d.links[name]?.link
    return !l ? COLORS.none : l.viable ? COLORS.viable : l.margin_db > -5 ? COLORS.marginal : COLORS.fail
  }
  const data = {
    devices: [
      ...d.project.gateways.map((g) => ({ kind: 'gateway', name: g.name, lat: g.lat, lon: g.lon,
        color: g.online ? COLORS.gateway : COLORS.none, icon: iconImageId('gateway') })),
      ...d.project.nodes.map((n) => ({ kind: 'node', name: n.name, lat: n.lat, lon: n.lon, color: nodeColor(n.name),
        icon: iconImageId(nodeKindOf(d, n.name)) })),
    ],
    links: d.nodes.filter((s) => s.gateway).map((s) => ({
      from: [s.gateway!.lon, s.gateway!.lat], to: [s.node.lon, s.node.lat], color: nodeColor(s.node.name),
    })),
    sections: d.nodes.map((s, i) => ({ id: `p${i}`, figure: s.figure, coords: s.detail?.profile.coordinates }))
      .filter((s) => s.figure),
    plots: (d.project.plots ?? []).map((pl) => ({ type: 'Feature', geometry: pl.geometry, properties: { id: pl.id } })),
    icons: glyphPngs(),
    // 4G layer, read from the same server as the app (it must be reachable when the file is opened)
    coverage: { url: new URL(COVERAGE_URL, window.location.href).href, shown: d.showCoverage,
      legend: [[COLORS.cellOk, 'Garantizada'], [COLORS.cellEdge, 'Incierta'], [COLORS.cellPossible, 'Posible (LTE-M)'],
        [COLORS.cellNone, 'Sin cobertura']] },
    locale: PLOTLY_LOCALE,
    config: { ...PLOTLY_CONFIG, responsive: true },
  }
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  const verdict = (name: string, cellular: boolean) => {
    if (cellular) {
      const c = d.cells[name]
      return [c ? cellShort(c) : 'Sin revisar', !c ? 'muted' : c.state === 'ok' ? 'ok' : c.state === 'none' ? 'bad' : 'warn']
    }
    const r = d.links[name]
    const l = r?.link
    return [l ? (l.viable ? 'Enlace viable' : 'Enlace no viable') : (r?.error ?? 'Sin resultado'),
      !l ? 'muted' : l.viable ? 'ok' : l.margin_db > -5 ? 'warn' : 'bad']
  }
  // LoRa nodes first, then the 4G sensors, each in alphabetical order (as the tables)
  const order = new Map([...d.project.nodes].sort((a, b) => Number(d.cellular.has(a.name)) - Number(d.cellular.has(b.name)) || byOwner(a, b)).map((n, i) => [n.name, i]))
  const cards = d.nodes.map((s, i) => [s, i] as const).sort(([a], [b]) => order.get(a.node.name)! - order.get(b.node.name)!).map(([s, i]) => {
    const l = s.cellular ? null : d.links[s.node.name]?.link
    const [text, cls] = verdict(s.node.name, s.cellular)
    return `<section class="card">
  <h3>${esc(nodeTitle(s.node))} <small>${esc(s.cellular ? 'Sensor 4G' : l ? `Nodo LoRa · enlace con ${l.gateway}` : 'Nodo LoRa')}</small></h3>
  <p class="verdict ${cls}">${esc(text)}</p>
  <img class="snap" alt="${esc(s.node.name)} en el mapa" src="${s.mapJpg}">
  ${legendHtml(s.legend)}
  ${s.figure ? `<div class="chart" id="p${i}"></div>` : ''}
  ${tableHtml(['Dato', 'Valor'], nodeFacts(d, s))}
  ${l && !l.viable && l.reasons.length ? `<p class="muted"><b>Por qué no es viable:</b> ${l.reasons.map(esc).join(' · ')}</p>` : ''}
</section>`
  }).join('\n')

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Reporte Verea</title>
<link rel="stylesheet" href="${MAPLIBRE}/maplibre-gl.css">
<style>
  :root { --ink:#162a40; --muted:#5a6b80; --line:#dce3eb; --navy:${BRAND.navy}; --teal:${BRAND.teal}; }
  body { margin:0; font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; color:var(--ink); background:#f4f7fa; }
  header { background:var(--navy); color:#e6edf4; padding:20px 24px; border-bottom:4px solid var(--teal);
    display:flex; align-items:center; gap:24px; flex-wrap:wrap; }
  header .logo { width:150px; flex-shrink:0; } header .logo svg { display:block; width:100%; height:auto; }
  header h1 { margin:0 0 4px; font-size:24px; } header p { margin:0; color:#9fb0c3; }
  h2 { color:var(--navy); }
  .maplibregl-ctrl-bottom-right { display:flex; align-items:flex-end; gap:6px; }
  .cov-ctrl { display:flex; flex-direction:column; align-items:flex-end; gap:4px; }
  .cov-btn { padding:4px 10px; border-radius:999px; border:0; background:#fff; color:#162a40; cursor:pointer;
    font:600 12px/1.2 system-ui,sans-serif; box-shadow:0 0 0 2px rgb(0 0 0 / .1); }
  .cov-btn.active { background:var(--navy); color:#fff; }
  .cov-legend { display:flex; flex-direction:column; gap:2px; padding:6px 9px; border-radius:8px;
    background:rgb(15 34 54 / .88); color:#e6edf4; font:11px/1.3 system-ui,sans-serif; }
  .cov-legend[hidden] { display:none; } .cov-legend span { display:flex; align-items:center; gap:6px; }
  .cov-legend i { width:10px; height:10px; border-radius:2px; display:inline-block; }
  .summary > div { margin-bottom:14px; }
  .summary tbody tr:last-child td { font-weight:700; background:#dce3eb; }
  .summary h3 { font-size:15px; margin:0 0 6px; color:var(--navy); }
  .symbology { display:flex; flex-wrap:wrap; gap:6px 14px; align-items:center; font-size:12px; color:var(--muted); margin:8px 0 12px; }
  .symbology span { display:inline-flex; align-items:center; gap:5px; } .symbology b { color:var(--ink); }
  td .dt { width:10px; height:10px; border-radius:50%; display:inline-block; vertical-align:-1px; margin-right:4px; }
  .symbology .dt { width:10px; height:10px; border-radius:50%; display:inline-block; }
  .symbology .ln { width:18px; height:4px; border-radius:2px; display:inline-block; }
  main { max-width:1150px; margin:0 auto; padding:16px 16px 48px; }
  h2 { font-size:18px; border-bottom:1px solid var(--line); padding-bottom:6px; margin:28px 0 10px; }
  h3 { font-size:16px; margin:0 0 8px; } h3 span { font-size:12px; padding:2px 8px; border-radius:99px; color:#fff; }
  .verdict { display:inline-block; margin:0 0 10px; padding:3px 10px; border-radius:99px; color:#fff; font-weight:600; font-size:13px; }
  .ok { background:#06a77d; } .warn { background:#c98a00; } .bad { background:#d64161; } .muted.verdict { background:#6c757d; }
  dt { color:${BRAND.tealDark}; }
  h3 small { font-weight:400; color:var(--muted); font-size:13px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:10px; padding:16px; margin:18px 0; }
  .snap { width:100%; border-radius:8px; display:block; margin-bottom:10px; }
  #map { height:520px; border-radius:10px; overflow:hidden; border:1px solid var(--line); }
  .tbl { overflow-x:auto; } table { border-collapse:collapse; width:100%; background:#fff; font-size:13px; }
  th { background:var(--navy); color:#e6edf4; text-align:left; } tbody tr:nth-child(even) td { background:${BRAND.rowAlt}; } th, td { padding:6px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
  .chart { height:460px; border-radius:8px; overflow:hidden; }
  .cols { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:16px; margin-top:10px; }
  dt { font-weight:600; margin-top:8px; } dd { margin:0; color:var(--muted); }
  .muted { color:var(--muted); font-size:12px; }
  @media (max-width:760px) { .cols { grid-template-columns:1fr; } #map { height:380px; } .chart { height:380px; } }
  @media print { #map, .chart { break-inside:avoid; } }
</style>
</head>
<body>
<header><div class="logo">${logoSvg('#ffffff', BRAND.teal, ' role="img" aria-label="Verea"')}</div><div><h1>${esc(title)}</h1><p>Reporte de red · ${esc(d.generatedAt.toLocaleString('es-MX'))}</p></div></header>
<main>
${d.project.description.trim() ? `<p>${esc(d.project.description)}</p>` : ''}
<h2>Mapa</h2><div id="map"></div>
${legendHtml(d.legend)}
<p class="muted">Pasa el mouse sobre un Perfil de Elevación para ver el punto en este mapa.</p>
<h2>Resumen</h2><div class="summary">${summaryTables(d).map((tb) => `<div><h3>${esc(tb.title)}</h3>${tableHtml(tb.head, tb.rows, tb.colors, 0)}</div>`).join('')}</div>
<p class="muted">${esc(settingsLine(d))}</p>
${statusTable(gatewayTable(d))}
${statusTable(loraTable(d))}
${statusTable(cellTable(d))}
${d.nodes.length ? '<h2>Nodos</h2>' : ''}
${cards}
<h2>Glosario</h2><dl>${GLOSSARY.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
<h2>Fuentes y atribuciones</h2>${SOURCES.map((s) => `<p class="muted">${esc(s)}</p>`).join('')}
</main>
<script id="verea-data" type="application/json">${json}</script>
<script src="${MAPLIBRE}/maplibre-gl.js"></script>
<script src="${PMTILES}"></script>
<script src="${PLOTLY}"></script>
<script>
const D = JSON.parse(document.getElementById('verea-data').textContent);
(async () => {
const icons = {};
await Promise.all(Object.entries(D.icons).map(([id, src]) => { const im = new Image(); im.src = src; icons[id] = im; return im.decode(); }));
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
if (window.pmtiles) maplibregl.addProtocol('pmtiles', new pmtiles.Protocol().tile);
const map = new maplibregl.Map({
  container: 'map', attributionControl: { compact: true },
  locale: { 'NavigationControl.ZoomIn': 'Acercar', 'NavigationControl.ZoomOut': 'Alejar',
    'NavigationControl.ResetBearing': 'Arrastra para girar el mapa; clic para volver al norte',
    'AttributionControl.ToggleAttribution': 'Mostrar u ocultar atribuciones', 'Map.Title': 'Mapa' },
  style: { version: 8, glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      imagery: { type: 'raster', tiles: [ESRI + '/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 18, attribution: 'Imágenes © Esri' },
      places: { type: 'raster', tiles: [ESRI + '/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'], tileSize: 256 },
      coverage: { type: 'raster', url: 'pmtiles://' + D.coverage.url, tileSize: 256,
        attribution: 'Cobertura 4G: CRT / datos.gob.mx (CC BY 4.0)' },
      devices: { type: 'geojson', data: { type: 'FeatureCollection', features: D.devices.map(d => ({ type: 'Feature',
        geometry: { type: 'Point', coordinates: [d.lon, d.lat] }, properties: d })) } },
      links: { type: 'geojson', data: { type: 'FeatureCollection', features: D.links.map(l => ({ type: 'Feature',
        geometry: { type: 'LineString', coordinates: [l.from, l.to] }, properties: l })) } },
      cursor: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      plots: { type: 'geojson', data: { type: 'FeatureCollection', features: D.plots } },
    },
    layers: [
      { id: 'imagery', type: 'raster', source: 'imagery' },
      { id: 'coverage', type: 'raster', source: 'coverage', paint: { 'raster-resampling': 'nearest' },
        layout: { visibility: D.coverage.shown ? 'visible' : 'none' } },
      { id: 'places', type: 'raster', source: 'places' },
      { id: 'plots-fill', type: 'fill', source: 'plots', paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.1 } },
      { id: 'plots-line', type: 'line', source: 'plots', paint: { 'line-color': '#ffffff', 'line-width': 1.4, 'line-opacity': 0.9 } },
      { id: 'links', type: 'line', source: 'links', paint: { 'line-color': ['get', 'color'], 'line-width': 3 } },
      { id: 'devices', type: 'circle', source: 'devices', paint: { 'circle-radius': ['match', ['get', 'kind'], 'gateway', 13, 11],
        'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } },
      { id: 'device-icons', type: 'symbol', source: 'devices', layout: { 'icon-image': ['get', 'icon'],
        'icon-size': ['match', ['get', 'kind'], 'gateway', 0.8, 0.68], 'icon-allow-overlap': true, 'icon-ignore-placement': true } },
      { id: 'labels', type: 'symbol', source: 'devices', layout: { 'text-field': ['get', 'name'], 'text-font': ['Open Sans Semibold'],
        'text-size': 12, 'text-offset': [0, 1.6], 'text-anchor': 'top', 'text-optional': true },
        paint: { 'text-color': '#fff', 'text-halo-color': '#000', 'text-halo-width': 1.5 } },
      { id: 'cursor', type: 'circle', source: 'cursor', paint: { 'circle-radius': 7, 'circle-color': '#ffd166',
        'circle-stroke-color': '#000', 'circle-stroke-width': 2 } },
    ] },
});
window.vereaMap = map;
map.on('styleimagemissing', e => { if (icons[e.id] && !map.hasImage(e.id)) map.addImage(e.id, icons[e.id], { pixelRatio: 2 }); });
map.addControl(new maplibregl.NavigationControl(), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
// 4G coverage on/off beside the attribution, with its legend while shown
map.addControl({
  onAdd() {
    const el = document.createElement('div');
    el.className = 'maplibregl-ctrl cov-ctrl';
    const legend = document.createElement('div');
    legend.className = 'cov-legend';
    legend.innerHTML = D.coverage.legend.map(([c, t]) => '<span><i style="background:' + c + '"></i>' + t + '</span>').join('');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cov-btn';
    btn.textContent = 'Cobertura 4G';
    const show = (on) => {
      map.setLayoutProperty('coverage', 'visibility', on ? 'visible' : 'none');
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', String(on));
      legend.hidden = !on;
    };
    btn.onclick = () => show(map.getLayoutProperty('coverage', 'visibility') !== 'visible');
    map.once('load', () => show(D.coverage.shown));
    el.append(legend, btn);
    return el;
  },
  onRemove() {},
}, 'bottom-right');
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
})();
</script>
</body>
</html>
`
}
