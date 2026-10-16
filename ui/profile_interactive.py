"""
Interactive Terrain Profile
============================
Plotly-based terrain profile rendered as an HTML component.

Hovering the chart moves a marker on the main Folium map to the exact
sampled point; clicking pins it so points of interest (ridges, steep
slopes, obstructions) can be located on the map.

The main map lives in the streamlit-folium iframe, which exposes its
Leaflet instance as `window.map` (same origin), so the component reaches
it through `window.parent`.
"""

import json

import numpy as np

from core.terrain import TerrainProfile

PLOTLY_CDN = "https://cdn.jsdelivr.net/npm/plotly.js-dist-min@2.35.2/plotly.min.js"


def _r(values, nd=2) -> list:
    return [round(float(v), nd) for v in values]


def build_profile_html(
    terrain: TerrainProfile,
    h_tx_asl: float,
    h_rx_asl: float,
    los_analysis: dict,
    title: str,
    height_px: int = 420,
) -> str:
    """
    Build the HTML/JS for the interactive profile.

    Convention: position 0 = Gateway (left), position -1 = Node (right).
    """
    d_km = terrain.distances / 1000
    elev = terrain.elevations
    eff = los_analysis["effective_terrain"]
    los = los_analysis["los_heights"]
    fr = los_analysis["fresnel_radii"]
    clearance = los_analysis["clearance_m"]

    # Ground slope (%) over a ~60 m window: the DEM is 30–90 m per cell, so
    # sample-to-sample differences are mostly 0 with spikes at cell edges.
    n = len(elev)
    if n > 1:
        spacing = float(terrain.distances[1] - terrain.distances[0]) or 1.0
        w = max(1, int(round(30.0 / spacing)))
        idx = np.arange(n)
        lo, hi = np.clip(idx - w, 0, n - 1), np.clip(idx + w, 0, n - 1)
        run = terrain.distances[hi] - terrain.distances[lo]
        slope = np.where(run > 0, (elev[hi] - elev[lo]) / np.where(run > 0, run, 1) * 100, 0.0)
    else:
        slope = np.zeros_like(elev)

    all_h = np.concatenate([elev, eff, los + fr, los - fr, [h_tx_asl, h_rx_asl]])
    y_min, y_max = float(np.min(all_h)), float(np.max(all_h))
    y_pad = max((y_max - y_min) * 0.15, 5.0)

    obstructed = clearance < 0

    data = {
        "x": _r(d_km, 4),
        "elev": _r(elev, 1),
        "eff": _r(eff, 1),
        "los": _r(los, 1),
        "fr_up": _r(los + fr, 1),
        "fr_lo": _r(los - fr, 1),
        "clear": _r(clearance, 1),
        "slope": _r(slope, 1),
        "coords": [[round(lat, 6), round(lon, 6)] for lat, lon in terrain.coordinates],
        "obs_x": _r(d_km[obstructed], 4),
        "obs_y": _r(eff[obstructed], 1),
        "y_range": [y_min - y_pad, y_max + y_pad],
        "gw": [float(d_km[0]), float(elev[0]), float(h_tx_asl)],
        "nd": [float(d_km[-1]), float(elev[-1]), float(h_rx_asl)],
        "title": title,
        # Identifies this GW→Node path so pins survive Streamlit reruns
        "key": f"{terrain.coordinates[0]}|{terrain.coordinates[-1]}|{n}",
    }

    return f"""
<div id="wrap" style="font-family: system-ui, sans-serif; color:#adb5bd;">
  <div id="chart" style="width:100%; height:{height_px - 34}px;"></div>
  <div style="display:flex; justify-content:space-between; align-items:center; font-size:12px; padding:4px 6px;">
    <span id="hint">Hover to locate the point on the map · click to pin it (click again to remove)</span>
    <button id="clear" style="background:#1a1a2e; color:#adb5bd; border:1px solid #495057;
            border-radius:4px; padding:2px 8px; cursor:pointer;">Clear pins</button>
  </div>
</div>
<script src="{PLOTLY_CDN}"></script>
<script>
const D = {json.dumps(data)};
const custom = D.x.map((_, i) => [D.coords[i][0], D.coords[i][1], D.clear[i], D.slope[i]]);
const base = Array(D.x.length).fill(D.y_range[0]);

const traces = [
  {{x: D.x, y: base, mode: "lines", line: {{width: 0}}, hoverinfo: "skip", showlegend: false}},
  {{x: D.x, y: D.elev, name: "Terrain", mode: "lines", fill: "tonexty",
    fillcolor: "rgba(45,106,79,0.5)", line: {{color: "#40916c", width: 1.5}},
    customdata: custom,
    hovertemplate: "<b>%{{x:.2f}} km</b> · %{{y:.0f}} m<br>" +
                   "slope %{{customdata[3]:+.1f}}% · Fresnel %{{customdata[2]:.0f}} m<br>" +
                   "<span style='font-size:10px'>%{{customdata[0]:.5f}}, %{{customdata[1]:.5f}}</span>" +
                   "<extra></extra>"}},
  {{x: D.x, y: D.eff, name: "Eff. terrain (k=4/3)", mode: "lines",
    line: {{color: "#95d5b2", width: 1, dash: "dash"}}, hoverinfo: "skip"}},
  {{x: D.x, y: D.fr_lo, mode: "lines", line: {{color: "rgba(255,209,102,0.5)", width: 0.5}},
    hoverinfo: "skip", showlegend: false}},
  {{x: D.x, y: D.fr_up, name: "Fresnel F1", mode: "lines", fill: "tonexty",
    fillcolor: "rgba(255,209,102,0.15)", line: {{color: "rgba(255,209,102,0.5)", width: 0.5}},
    hoverinfo: "skip"}},
  {{x: D.x, y: D.los, name: "LOS", mode: "lines", line: {{color: "#e0e0e0", width: 1.5}},
    hoverinfo: "skip"}},
  {{x: D.obs_x, y: D.obs_y, name: "Obstruction", mode: "markers",
    marker: {{color: "#ef476f", symbol: "triangle-up", size: 8}}, hoverinfo: "skip"}},
  {{x: [D.gw[0], D.gw[0]], y: [D.gw[1], D.gw[2]], name: "Gateway", mode: "lines+markers",
    line: {{color: "#118ab2", width: 3}}, marker: {{symbol: "square", size: [0, 10]}}, hoverinfo: "skip"}},
  {{x: [D.nd[0], D.nd[0]], y: [D.nd[1], D.nd[2]], name: "Node", mode: "lines+markers",
    line: {{color: "#06d6a0", width: 3}}, marker: {{symbol: "square", size: [0, 10]}}, hoverinfo: "skip"}},
  {{x: [], y: [], text: [], name: "Pins", mode: "markers+text", showlegend: false,
    textposition: "top center", textfont: {{size: 10, color: "#ffffff"}},
    marker: {{color: "#ef476f", size: 9, line: {{color: "#ffffff", width: 1.5}}}}, hoverinfo: "skip"}},
];
const PIN_TRACE = traces.length - 1;
const TERRAIN_TRACE = 1;

const layout = {{
  title: {{text: D.title, font: {{color: "#e9ecef", size: 14}}}},
  paper_bgcolor: "#0e1117", plot_bgcolor: "#0e1117",
  font: {{color: "#adb5bd"}},
  margin: {{l: 60, r: 20, t: 40, b: 80}},
  hovermode: "x",
  hoverlabel: {{font: {{size: 11, color: "#e9ecef"}}, bgcolor: "#1a1d24", bordercolor: "#495057"}},
  xaxis: {{title: "Distance (km)", range: [D.x[0], D.x[D.x.length - 1]], gridcolor: "#262b33",
          showspikes: true, spikemode: "across", spikecolor: "#ffd166", spikethickness: 1, spikedash: "solid"}},
  yaxis: {{title: "Elevation (m ASL)", range: D.y_range, gridcolor: "#262b33"}},
  legend: {{orientation: "h", y: -0.22, x: 0.5, xanchor: "center", yanchor: "top",
           font: {{size: 10}}, bgcolor: "rgba(0,0,0,0)"}},
}};

const chart = document.getElementById("chart");
Plotly.newPlot(chart, traces, layout, {{responsive: true, displaylogo: false,
  modeBarButtonsToRemove: ["select2d", "lasso2d"]}});

// ── Link to the main Folium map ──
function mainMap() {{
  try {{
    for (const f of window.parent.document.querySelectorAll("iframe")) {{
      const w = f.contentWindow;
      if ((f.src || "").includes("streamlit_folium") && w && w.map && w.L) return w;
    }}
  }} catch (e) {{}}
  return null;
}}

let cursor = null;

// Pins are stored as profile indices in the parent window, keyed by path,
// so chart and map stay in sync across Streamlit reruns.
const store = (() => {{
  try {{ return (window.parent.__vereaPins = window.parent.__vereaPins || {{}}); }}
  catch (e) {{ return {{}}; }}
}})();
const pins = (store[D.key] = store[D.key] || []);

function pinLabel(i) {{
  return `${{D.x[i].toFixed(2)}} km · ${{D.elev[i].toFixed(0)}} m · slope ${{D.slope[i] >= 0 ? "+" : ""}}${{D.slope[i].toFixed(1)}}%`;
}}

function pinIcon(w, n) {{
  return w.L.divIcon({{
    className: "",
    iconSize: [18, 18], iconAnchor: [9, 9],
    html: `<div style="width:18px;height:18px;border-radius:50%;background:#ef476f;
           border:2px solid #fff;color:#fff;font:600 10px/14px system-ui,sans-serif;
           text-align:center;box-sizing:border-box;box-shadow:0 1px 3px rgba(0,0,0,.5)">${{n}}</div>`,
  }});
}}

function syncPins() {{
  // Chart
  Plotly.restyle(chart, {{
    x: [pins.map(i => D.x[i])],
    y: [pins.map(i => D.elev[i])],
    text: [pins.map((_, k) => String(k + 1))],
  }}, [PIN_TRACE]);

  // Map
  const w = mainMap();
  if (!w) return;
  if (w.map.__vereaPins) w.map.__vereaPins.remove();
  const layer = w.L.layerGroup().addTo(w.map);
  w.map.__vereaPins = layer;
  pins.forEach((i, k) => {{
    w.L.marker(D.coords[i], {{icon: pinIcon(w, k + 1)}})
      .bindTooltip(`<span style="font-size:11px">${{k + 1}} · ${{pinLabel(i)}}</span>`, {{direction: "top", offset: [0, -8]}})
      .on("mouseover", () => Plotly.Fx.hover(chart, [{{curveNumber: TERRAIN_TRACE, pointNumber: i}}]))
      .on("mouseout", () => Plotly.Fx.unhover(chart))
      .addTo(layer);
  }});
}}

function pointIndex(ev) {{
  const p = ev.points.find(p => p.data.name === "Terrain") || ev.points[0];
  return p ? p.pointIndex : null;
}}

chart.on("plotly_hover", ev => {{
  const i = pointIndex(ev);
  const w = mainMap();
  if (i === null || !w) return;
  const ll = D.coords[i];
  if (!cursor || cursor._map !== w.map) {{
    if (cursor) cursor.remove();
    cursor = w.L.circleMarker(ll, {{radius: 7, color: "#ffffff", weight: 2,
      fillColor: "#ffd166", fillOpacity: 1, interactive: false}}).addTo(w.map);
  }} else {{
    cursor.setLatLng(ll);
  }}
  // Map was re-rendered by Streamlit: restore pins
  if (pins.length && w.map.__vereaPins === undefined) syncPins();
}});

chart.on("plotly_unhover", () => {{
  if (cursor) {{ cursor.remove(); cursor = null; }}
}});

chart.on("plotly_click", ev => {{
  const i = pointIndex(ev);
  if (i === null) return;
  // Clicking near an existing pin removes it; otherwise add a new one
  const tol = Math.max(1, Math.round(D.x.length / 100));
  const k = pins.findIndex(p => Math.abs(p - i) <= tol);
  if (k >= 0) pins.splice(k, 1); else pins.push(i);
  syncPins();
  const w = mainMap();
  if (k < 0 && w && !w.map.getBounds().contains(D.coords[i])) w.map.panTo(D.coords[i]);
}});

document.getElementById("clear").onclick = () => {{
  pins.length = 0;
  syncPins();
}};

syncPins();
setTimeout(syncPins, 1500);   // map iframe may finish loading after the chart

setTimeout(() => {{
  if (!mainMap()) document.getElementById("hint").textContent =
    "Map link unavailable — hover still shows coordinates";
}}, 2000);
</script>
"""
