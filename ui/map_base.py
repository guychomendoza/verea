"""
Base Map
========
Satellite base map shared by the app and the report: Esri imagery (loaded
with CORS so it can be captured), device label styles and a "save as PNG"
button that captures exactly what is on screen.

The app keeps this base map identical between reruns and sends devices,
links and coverage as a separate layer, so the view (pan / zoom) is not
reset every time something changes.
"""

import math

import folium
from branca.element import Element, MacroElement
from folium.elements import JSCSSMixin
from jinja2 import Template

ESRI_IMAGERY = ("https://server.arcgisonline.com/ArcGIS/rest/services/"
                "World_Imagery/MapServer/tile/{z}/{y}/{x}")

LABEL_CSS = """
<style>
  .leaflet-tooltip.verea-label {
    background: rgba(17, 24, 39, 0.78); color: #fff; border: 0; border-radius: 4px;
    padding: 1px 6px; font: 600 11px/1.35 system-ui, sans-serif; box-shadow: none;
    white-space: nowrap;
  }
  .leaflet-tooltip.verea-label::before { display: none; }
  .leaflet-tooltip.verea-label .sub { font-weight: 400; opacity: 0.85; }
  .verea-capture a { font-size: 16px; line-height: 30px; text-align: center; cursor: pointer; }
  .verea-capture a.busy { opacity: 0.4; cursor: progress; }
  .verea-ruler { display: flex; align-items: flex-start; gap: 6px; }
  .verea-ruler > a { font-size: 15px; line-height: 30px; text-align: center; cursor: pointer;
                     background: #fff; width: 30px; height: 30px; display: block; border-radius: 4px; }
  .verea-ruler > a.on { background: #ffd166; }
  .verea-ruler .panel { display: none; background: rgba(255, 255, 255, 0.95); border-radius: 4px;
                        padding: 4px 8px; font: 12px/1.4 system-ui, sans-serif; color: #1d2329;
                        white-space: nowrap; }
  .verea-ruler.active .panel { display: block; }
  .verea-ruler .total { font-weight: 700; font-size: 13px; }
  .verea-ruler .hint { color: #5f6b76; font-size: 11px; }
  .verea-ruler select, .verea-ruler button { font: 12px system-ui, sans-serif; margin-top: 3px; }
  .verea-measuring, .verea-measuring .leaflet-interactive { cursor: crosshair !important; }
  .leaflet-tooltip.verea-ruler-label { background: #ffd166; color: #1d2329; border: 0;
    font: 700 11px system-ui, sans-serif; padding: 1px 5px; box-shadow: none; }
  .leaflet-tooltip.verea-ruler-label::before { display: none; }
</style>
"""


class CaptureControl(JSCSSMixin, MacroElement):
    """Leaflet button that saves the visible map (tiles, lines, markers, labels) as PNG."""

    default_js = [("html2canvas", "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js")]

    _template = Template("""
{% macro script(this, kwargs) %}
(function () {
  const map = {{ this._parent.get_name() }};
  const Capture = L.Control.extend({
    options: { position: "topleft" },
    onAdd: function () {
      const box = L.DomUtil.create("div", "leaflet-bar leaflet-control verea-capture");
      const a = L.DomUtil.create("a", "", box);
      a.href = "#"; a.title = "Save map as image"; a.innerHTML = "&#128247;";
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.on(a, "click", function (e) {
        L.DomEvent.preventDefault(e);
        if (a.classList.contains("busy") || typeof html2canvas === "undefined") return;
        a.classList.add("busy");
        html2canvas(map.getContainer(), {
          useCORS: true, backgroundColor: null, logging: false,
          ignoreElements: el => el.classList && el.classList.contains("leaflet-control-container"),
        }).then(canvas => {
          const link = document.createElement("a");
          const t = new Date();
          const pad = n => String(n).padStart(2, "0");
          link.download = `verea_map_${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}_` +
                          `${pad(t.getHours())}${pad(t.getMinutes())}.png`;
          link.href = canvas.toDataURL("image/png");
          document.body.appendChild(link); link.click(); link.remove();
        }).catch(err => alert("Could not capture the map: " + err))
          .finally(() => a.classList.remove("busy"));
      });
      return box;
    },
  });
  map.addControl(new Capture());
})();
{% endmacro %}
""")


class RulerControl(MacroElement):
    """
    Measuring tool: click points on the map to measure a path in m, km or miles.

    While it is on, clicks are caught on the map container in the capture
    phase and stopped there: every click becomes a point (even over a link
    line or a marker) and none reaches Streamlit, so measuring never places
    or selects a device.
    """

    _template = Template("""
{% macro script(this, kwargs) %}
(function () {
  const map = {{ this._parent.get_name() }};
  const UNITS = {
    m:  { label: "m",  fmt: d => Math.round(d).toLocaleString("en-US") + " m" },
    km: { label: "km", fmt: d => (d / 1000).toFixed(2) + " km" },
    mi: { label: "mi", fmt: d => (d / 1609.344).toFixed(2) + " mi" },
  };
  let unit = "km";
  try { unit = localStorage.getItem("verea-ruler-unit") || "km"; } catch (e) {}
  if (!UNITS[unit]) unit = "km";

  let active = false, done = false, points = [], dblZoom = false;
  const container = map.getContainer();
  const layer = L.layerGroup();
  let line = null, ghost = null, label = null;
  let ui = {};

  function total(pts) {
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += map.distance(pts[i - 1], pts[i]);
    return d;
  }
  function render(cursor) {
    const d = total(points);
    const seg = (!done && cursor && points.length) ? map.distance(points[points.length - 1], cursor) : 0;
    ui.total.textContent = points.length < 2 && !seg ? "Click on the map" : UNITS[unit].fmt(d + seg);
    ui.hint.textContent = done ? "Click to start a new measurement"
      : points.length ? "Double-click to finish · Esc to clear" : "Click points to measure";
    if (label) { layer.removeLayer(label); label = null; }
    if (points.length > 1) {
      label = L.tooltip({ permanent: true, direction: "right", offset: [8, 0],
                          className: "verea-ruler-label" })
        .setLatLng(points[points.length - 1]).setContent(UNITS[unit].fmt(d));
      layer.addLayer(label);
    }
  }
  function clear() {
    layer.clearLayers(); points = []; line = ghost = label = null; done = false; render();
  }
  function addPoint(latlng) {
    if (done) clear();
    points.push(latlng);
    if (!line) {
      line = L.polyline(points, { color: "#ffd166", weight: 3, dashArray: "8 6", interactive: false });
      layer.addLayer(line);
    } else line.setLatLngs(points);
    layer.addLayer(L.circleMarker(latlng, { radius: 4, color: "#1d2329", weight: 1.5,
      fillColor: "#ffd166", fillOpacity: 1, interactive: false }));
    render();
  }
  function fromMap(e) {
    // ignore the ruler's own panel and the other map buttons
    return !(e.target.closest && e.target.closest(".leaflet-control-container"));
  }
  function onClick(e) {
    if (!fromMap(e)) return;
    e.stopPropagation();
    if (map.dragging && map.dragging.moved()) return;   // end of a pan, not a point
    addPoint(map.mouseEventToLatLng(e));
  }
  function onDblClick(e) {
    if (!fromMap(e)) return;
    e.stopPropagation();
    finish();
  }
  function onMove(e) {
    if (!points.length || done) return;
    const pts = [points[points.length - 1], e.latlng];
    if (!ghost) {
      ghost = L.polyline(pts, { color: "#ffffff", weight: 2, dashArray: "4 6", opacity: 0.8,
                                interactive: false });
      layer.addLayer(ghost);
    } else ghost.setLatLngs(pts);
    render(e.latlng);
  }
  function finish() {
    // the double-click also fired two clicks: drop the duplicate point
    while (points.length > 1 && map.distance(points[points.length - 1], points[points.length - 2]) < 0.5) {
      points.pop();
    }
    if (line) line.setLatLngs(points);
    if (ghost) { layer.removeLayer(ghost); ghost = null; }
    done = true; render();
  }
  function onKey(e) { if (e.key === "Escape") clear(); }

  function setActive(on) {
    active = on;
    ui.box.classList.toggle("active", on);
    ui.btn.classList.toggle("on", on);
    map.getContainer().classList.toggle("verea-measuring", on);
    if (on) {
      container.addEventListener("click", onClick, true);
      container.addEventListener("dblclick", onDblClick, true);
      map.on("mousemove", onMove);
      dblZoom = map.doubleClickZoom.enabled();
      map.doubleClickZoom.disable();
      document.addEventListener("keydown", onKey);
      layer.addTo(map);
      clear();
    } else {
      container.removeEventListener("click", onClick, true);
      container.removeEventListener("dblclick", onDblClick, true);
      map.off("mousemove", onMove);
      if (dblZoom) map.doubleClickZoom.enable();
      document.removeEventListener("keydown", onKey);
      clear();
      map.removeLayer(layer);
    }
  }

  const Ruler = L.Control.extend({
    options: { position: "topleft" },
    onAdd: function () {
      const box = L.DomUtil.create("div", "leaflet-bar leaflet-control verea-ruler");
      const btn = L.DomUtil.create("a", "", box);
      btn.href = "#"; btn.title = "Measure distance"; btn.innerHTML = "&#128207;";
      const panel = L.DomUtil.create("div", "panel", box);
      panel.innerHTML =
        '<div class="total"></div><div class="hint"></div>' +
        '<select title="Units">' +
        Object.keys(UNITS).map(k => `<option value="${k}">${UNITS[k].label}</option>`).join("") +
        '</select> <button type="button" data-a="finish">Finish</button> ' +
        '<button type="button" data-a="clear">Clear</button>';
      ui = { box, btn, total: panel.querySelector(".total"), hint: panel.querySelector(".hint") };
      const sel = panel.querySelector("select");
      sel.value = unit;
      sel.addEventListener("change", () => {
        unit = sel.value;
        try { localStorage.setItem("verea-ruler-unit", unit); } catch (e) {}
        render();
      });
      panel.querySelector('[data-a="finish"]').addEventListener("click", finish);
      panel.querySelector('[data-a="clear"]').addEventListener("click", clear);
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.disableScrollPropagation(box);
      L.DomEvent.on(btn, "click", e => { L.DomEvent.preventDefault(e); setActive(!active); });
      render();
      return box;
    },
  });
  map.addControl(new Ruler());
})();
{% endmacro %}
""")


class CoverageLibrary(JSCSSMixin, MacroElement):
    """Loads the PMTiles reader with the base map, so the base never changes."""

    default_js = [("pmtiles", "https://unpkg.com/pmtiles@4.5.0/dist/pmtiles.js")]
    _template = Template("")


class CoverageTiles(MacroElement):
    """
    4G coverage image tiles from a PMTiles file (scripts/build_coverage_tiles.py),
    added to the network layer. The Leaflet layer is kept in
    window.__vereaCoverage and reused across reruns, so tiles already loaded
    are not fetched again.
    """

    _template = Template("""
{% macro script(this, kwargs) %}
(function () {
  if (typeof pmtiles === "undefined") return;
  const url = {{ this.url|tojson }};
  if (!window.__vereaCoverage || window.__vereaCoverageUrl !== url) {
    window.__vereaCoverage = pmtiles.leafletRasterLayer(new pmtiles.PMTiles(url), {
      maxNativeZoom: {{ this.max_zoom }}, maxZoom: 22, zIndex: 2,
      attribution: "4G coverage: CRT / datos.gob.mx (CC BY 4.0)",
    });
    window.__vereaCoverageUrl = url;
  }
  {{ this._parent.get_name() }}.addLayer(window.__vereaCoverage);
})();
{% endmacro %}
""")

    def __init__(self, url: str, max_zoom: int = 13):
        super().__init__()
        self._name = "CoverageTiles"
        self.url = url
        self.max_zoom = max_zoom


def base_map(center, zoom: int, height=None) -> folium.Map:
    # Vectors on canvas (not SVG) so the capture button includes links and halos
    m = folium.Map(location=center, zoom_start=zoom, tiles=None, prefer_canvas=True,
                   **({"height": height} if height else {}))
    folium.TileLayer(ESRI_IMAGERY, attr="Esri", name="Satellite", max_zoom=19,
                     max_native_zoom=18, cross_origin="anonymous").add_to(m)
    m.get_root().header.add_child(Element(LABEL_CSS))
    CaptureControl().add_to(m)
    RulerControl().add_to(m)
    CoverageLibrary().add_to(m)
    return m


def fit_view(points: list, width_px: int = 800, height_px: int = 520,
             max_zoom: int = 17) -> tuple[list, int]:
    """Center and zoom that show all points (Web Mercator), with some padding."""
    lats = [p[0] for p in points]
    lons = [p[1] for p in points]
    center = [(min(lats) + max(lats)) / 2, (min(lons) + max(lons)) / 2]

    def merc_y(lat):
        s = math.sin(math.radians(max(min(lat, 85.0), -85.0)))
        return math.log((1 + s) / (1 - s)) / 2

    dlon = max(max(lons) - min(lons), 1e-6) / 360.0
    dlat = max(merc_y(max(lats)) - merc_y(min(lats)), 1e-6) / (2 * math.pi)
    zoom = min(math.log2(width_px / 256 / dlon / 1.3), math.log2(height_px / 256 / dlat / 1.3))
    return center, int(max(3, min(max_zoom, math.floor(zoom))))
