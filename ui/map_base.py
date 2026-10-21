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


def base_map(center, zoom: int, height=None) -> folium.Map:
    # Vectors on canvas (not SVG) so the capture button includes links and halos
    m = folium.Map(location=center, zoom_start=zoom, tiles=None, prefer_canvas=True,
                   **({"height": height} if height else {}))
    folium.TileLayer(ESRI_IMAGERY, attr="Esri", name="Satellite", max_zoom=19,
                     max_native_zoom=18, cross_origin="anonymous").add_to(m)
    m.get_root().header.add_child(Element(LABEL_CSS))
    CaptureControl().add_to(m)
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
