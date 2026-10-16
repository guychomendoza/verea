"""
Verea — LoRaWAN Packet Tracer
==============================
Interactive GIS-based simulator for planning agricultural IoT networks.

Features:
- Multi-gateway support with online/offline toggle (failover)
- SenseCAP S2120 weather station entity
- Real elevation data (Open-Meteo / OpenTopoData cascade)
- Click-to-add devices on satellite map
- Location search via Nominatim (geopy)
- Configurable margin threshold, environment, diffraction model
- Terrain profile chart with GATEWAY/NODE labels
- SF comparison table
- Per-device elevation info

Run with:  streamlit run app.py
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import streamlit as st
import numpy as np
import pandas as pd
import folium
from streamlit_folium import st_folium
import streamlit.components.v1 as components
from datetime import datetime

from config import (
    DEFAULT_FREQUENCY_HZ,
    DEFAULT_TX_POWER_DBM,
    DEFAULT_GW_TX_POWER_DBM,
    DEFAULT_GW_ANTENNA_GAIN_DBI,
    DEFAULT_GW_ANTENNA_HEIGHT_M,
    DEFAULT_NODE_ANTENNA_GAIN_DBI,
    DEFAULT_CABLE_LOSS_DB,
    SX1276_SENSITIVITY,
    SX1276_DATARATE_BPS,
    TERRAIN_SAMPLE_POINTS,
    MAP_DEFAULT_CENTER,
    MAP_DEFAULT_ZOOM,
    NOISE_FLOOR_DBM,
    MIN_FRESNEL_CLEARANCE_PCT,
    REQUIRED_LINK_MARGIN_DB,
    DEFAULT_DIFFRACTION_METHOD,
    DEFAULT_PROPAGATION_MODEL,
    ENVIRONMENT_PROFILES,
    DEFAULT_FADING_MARGIN_DB,
)
from core.devices import Gateway, EndNode, WeatherStation, Antenna
from core.terrain import TerrainProfile, ElevationAPI
from core.link_budget import calculate_link_budget, route_to_best_gateway
from core.propagation import fspl, max_fresnel_radius
from ui.profile_chart import get_elevation_summary
from ui.profile_interactive import build_profile_html
from ui.report import build_report_html
from core.coverage import compute_radial, compute_coverage, initial_bearing, viable_segments
from utils.geo import haversine

# ══════════════════════════════════════════════════════════════
# Page config
# ══════════════════════════════════════════════════════════════
st.set_page_config(
    page_title="Verea — LoRaWAN Simulator",
    page_icon="📡",
    layout="wide",
    initial_sidebar_state="expanded",
)

st.markdown("""
<style>
    .block-container { padding-top: 1rem; }
    div[data-testid="stMetric"] { background: var(--secondary-background-color);
        border-radius: 8px; padding: 8px 12px; }
    .link-viable { border-left: 4px solid #06d6a0; padding-left: 8px; }
    .link-warning { border-left: 4px solid #ffd166; padding-left: 8px; }
    .link-fail { border-left: 4px solid #ef476f; padding-left: 8px; }
</style>
""", unsafe_allow_html=True)

# ══════════════════════════════════════════════════════════════
# Session State
# ══════════════════════════════════════════════════════════════
defaults = {
    "placement_mode": "gateway",
    "gateways": [],
    "nodes": [],
    "link_results": {},
    "selected_node": None,
    "selected_gateway": None,
    "terrain_cache": {},
    "elevation_api": None,
    "last_processed_click": None,   # Fix #1: track last click to avoid phantoms
    "last_processed_object": None,  # same for marker clicks (device selection)
    "name_counters": {},            # monotonic per prefix, so deleted names are never reused
    "coverage": None,               # last computed gateway coverage map
    "radial_cache": {},             # max-range radials per GW/node/settings
    "report_html": None,
}
for key, val in defaults.items():
    if key not in st.session_state:
        st.session_state[key] = val

# Shared elevation API instance
if st.session_state.elevation_api is None:
    st.session_state.elevation_api = ElevationAPI()


# ══════════════════════════════════════════════════════════════
# Sidebar
# ══════════════════════════════════════════════════════════════
with st.sidebar:
    st.markdown("## 📡 Verea")
    st.caption("LoRaWAN Packet Tracer — Agricultural IoT")
    st.divider()

    # ── Location search (Nominatim) ──
    st.markdown("### 🔍 Search location")
    search_query = st.text_input("Place name", placeholder="e.g. Tonaya, Jalisco")
    if search_query:
        try:
            from geopy.geocoders import Nominatim
            geolocator = Nominatim(user_agent="verea_simulator")
            location = geolocator.geocode(search_query)
            if location:
                st.success(f"📍 {location.address[:60]}")
                st.caption(f"({location.latitude:.5f}, {location.longitude:.5f})")
                if st.button("📌 Center map here"):
                    st.session_state["map_center"] = [location.latitude, location.longitude]
                    st.rerun()
            else:
                st.warning("Location not found")
        except ImportError:
            st.warning("Install geopy: `pip install geopy`")
        except Exception as e:
            st.warning(f"Search error: {e}")

    st.divider()

    # ── Placement mode ──
    st.markdown("### Click-to-add mode")
    mode_options = ["gateway", "sensor", "weather", "move"]
    mode_labels = {
        "gateway": "🏗️ Gateway",
        "sensor": "📱 Sensor Node",
        "weather": "🌤️ Weather Station (S2120)",
        "move": "✋ Move selected device",
    }
    mode = st.radio(
        "Device type",
        options=mode_options,
        format_func=lambda x: mode_labels[x],
        index=mode_options.index(st.session_state.placement_mode)
        if st.session_state.placement_mode in mode_options
        else 0,
        key="mode_radio",
    )
    st.session_state.placement_mode = mode
    if mode == "move":
        st.caption("Click a device on the map (or in the right panel) to select it, "
                   "then click the destination on the map.")

    st.divider()

    # ── Environment ──
    st.markdown("### Environment")
    environment = st.selectbox(
        "Clutter profile",
        options=list(ENVIRONMENT_PROFILES.keys()),
        index=0,
        help="Default for NEW nodes. Each existing node keeps its own environment "
             "(edit it in the right panel).",
    )
    env_info = ENVIRONMENT_PROFILES[environment]
    st.caption(f"{env_info['description']} (+{env_info['clutter_loss_db']:.0f} dB)")

    st.divider()

    # ── RF parameters ──
    st.markdown("### RF parameters")
    freq_mhz = st.selectbox("Frequency (MHz)", [915, 868, 923, 433], index=0)
    freq_hz = freq_mhz * 1e6
    model_labels = {
        "itm": "Longley-Rice (ITM)",
        "simple": "Simple (FSPL + diffraction)",
    }
    propagation_model = st.selectbox(
        "Propagation model",
        options=list(model_labels),
        format_func=model_labels.get,
        index=list(model_labels).index(DEFAULT_PROPAGATION_MODEL),
        help="ITM models ground reflection and diffraction over multiple ridges "
             "on the real terrain. Paths under 1 km always use the simple model.",
    )
    diffraction_method = st.selectbox(
        "Diffraction model (simple)",
        ["dominant_knife_edge", "deygout", "empirical_fresnel"],
        index=0,
    )
    n_terrain_points = st.slider("Terrain samples", 30, 200,
                                 TERRAIN_SAMPLE_POINTS, 10)
    margin_threshold = st.slider("Min margin threshold (dB)", 0.0, 20.0, 3.0, 0.5,
                                 help="Links below this margin are marked NOT VIABLE")
    fading_margin = st.slider("Fading margin (dB)", 0.0, 15.0, DEFAULT_FADING_MARGIN_DB, 0.5,
                              help="Extra loss for rain, humidity, foliage sway. "
                                   "8 dB is conservative for agriculture.")

    st.divider()

    # ── Coverage ──
    st.markdown("### Coverage")
    cov_sf = st.selectbox(
        "Sensor SF", [7, 8, 9, 10], index=3,
        help="Spreading factor of the sensor used for the coverage map. US915 uplinks "
             "on 125 kHz channels allow SF7–SF10; SF10 reaches the farthest.",
    )
    cov_radius_km = st.slider("Max radius (km)", 2, 40, 15, 1)
    cov_radials = st.select_slider("Directions", options=[12, 24, 36], value=24,
                                   help="More directions = finer map, slower to compute (~1 s each)")
    cv1, cv2 = st.columns(2)
    with cv1:
        compute_cov = st.button("📡 Compute", disabled=not st.session_state.gateways,
                                help="Where a 1.5 m sensor with the sidebar environment "
                                     "reaches each online gateway")
    with cv2:
        if st.button("Hide", disabled=st.session_state.coverage is None):
            st.session_state.coverage = None
            st.rerun()

    st.divider()

    # ── Actions ──
    col_a, col_b = st.columns(2)
    with col_a:
        recalc = st.button("🔄 Recalculate", type="primary")
    with col_b:
        if st.button("🗑️ Clear all"):
            for key in defaults:
                st.session_state[key] = defaults[key] if not isinstance(defaults[key], list) else []
            st.session_state.elevation_api = ElevationAPI()
            if "map_center" in st.session_state:
                del st.session_state["map_center"]
            st.rerun()

    if st.button("📄 Generate report", use_container_width=True,
                 disabled=not (st.session_state.gateways or st.session_state.nodes)):
        st.session_state["make_report"] = True
    if st.session_state.report_html:
        st.download_button(
            "⬇️ Download report (HTML)",
            data=st.session_state.report_html["html"],
            file_name=st.session_state.report_html["name"],
            mime="text/html",
            use_container_width=True,
        )

# Global RF settings — any change triggers a full recalculation
rf_settings = (freq_mhz, propagation_model, diffraction_method, n_terrain_points,
               margin_threshold, fading_margin)


# ══════════════════════════════════════════════════════════════
# Analysis helper
# ══════════════════════════════════════════════════════════════
def next_device_index(prefix: str) -> int:
    """Next unused number for a device name prefix (GW, Node, WX)."""
    counters = st.session_state.name_counters
    counters[prefix] = counters.get(prefix, 0) + 1
    return counters[prefix]


def gateway_device(gw_info: dict) -> Gateway:
    """Gateway object from its session-state dict."""
    gw_dev = Gateway(
        name=gw_info.get("name", "Gateway"),
        lat=gw_info["lat"], lon=gw_info["lon"],
        tx_power_dbm=gw_info.get("tx_power", DEFAULT_GW_TX_POWER_DBM),
        antenna=Antenna(
            gain_dbi=gw_info.get("gain", DEFAULT_GW_ANTENNA_GAIN_DBI),
            height_m=gw_info.get("height", DEFAULT_GW_ANTENNA_HEIGHT_M),
            cable_loss_db=gw_info.get("cable_loss", DEFAULT_CABLE_LOSS_DB),
        ),
        frequency_hz=freq_hz,
        online=gw_info.get("online", True),
    )
    return gw_dev


def node_device(node_info: dict) -> EndNode:
    """EndNode / WeatherStation object from its session-state dict."""
    if node_info.get("type") == "weather":
        node_dev = WeatherStation(
            name=node_info["name"],
            lat=node_info["lat"], lon=node_info["lon"],
            tx_power_dbm=node_info.get("tx_power", 19),
            spreading_factor=node_info.get("sf", 10),
            antenna=Antenna(
                gain_dbi=node_info.get("gain", 2.0),
                height_m=node_info.get("height", 3.0),
                cable_loss_db=0.0,
            ),
            frequency_hz=freq_hz,
        )
    else:
        node_dev = EndNode(
            name=node_info["name"],
            lat=node_info["lat"], lon=node_info["lon"],
            tx_power_dbm=node_info.get("tx_power", DEFAULT_TX_POWER_DBM),
            spreading_factor=node_info.get("sf", 7),
            antenna=Antenna(
                gain_dbi=node_info.get("gain", DEFAULT_NODE_ANTENNA_GAIN_DBI),
                height_m=node_info.get("height", 1.5),
                cable_loss_db=0.5,
            ),
            frequency_hz=freq_hz,
        )
    return node_dev


def budget_kwargs(env: str) -> dict:
    """Link budget settings from the sidebar."""
    return dict(
        diffraction_method=diffraction_method,
        environment=env,
        margin_threshold=margin_threshold,
        fading_margin_db=fading_margin,
        propagation_model=propagation_model,
    )


def device_signature(d: dict) -> tuple:
    keys = ("lat", "lon", "height", "gain", "tx_power", "sf", "environment", "online", "type")
    return tuple(d.get(k) for k in keys)


def range_along_link(nd: dict):
    """
    Radial from the node's best gateway through the node, extended past it,
    to show how far the signal reaches in that direction. Cached.
    """
    link = st.session_state.link_results.get(nd["name"])
    if not link:
        return None
    gw = next((g for g in st.session_state.gateways if g["name"] == link["result"].gateway_name), None)
    if not gw:
        return None
    d = link["result"].distance_m
    max_d = min(max(2.5 * d, d + 5000, 10000), 40000)
    env = nd.get("environment", environment)
    key = (device_signature(gw), device_signature(nd), rf_settings, env, round(max_d))
    cache = st.session_state.radial_cache
    if key not in cache:
        bearing = initial_bearing(gw["lat"], gw["lon"], nd["lat"], nd["lon"])
        try:
            cache[key] = compute_radial(
                gateway_device(gw), node_device(nd), bearing, max_d,
                n_points=n_terrain_points, api=st.session_state.elevation_api,
                **budget_kwargs(env),
            )
        except Exception:
            return None
    return cache[key]


def coverage_signature(params: dict) -> tuple:
    gws = tuple(device_signature(g) for g in st.session_state.gateways if g.get("online", True))
    return (gws, rf_settings, environment, tuple(sorted(params.items())))


def run_analysis(gw_info: dict, node_info: dict, node_environment: str = None) -> dict:
    """Run full terrain + link budget analysis for a GW-Node pair."""
    cache_key = (
        f"{gw_info['lat']:.6f},{gw_info['lon']:.6f}_"
        f"{node_info['lat']:.6f},{node_info['lon']:.6f}_"
        f"{n_terrain_points}"
    )

    gw_dev = gateway_device(gw_info)
    node_dev = node_device(node_info)

    # Fetch terrain (with cache)
    api = st.session_state.elevation_api
    if cache_key in st.session_state.terrain_cache:
        terrain = st.session_state.terrain_cache[cache_key]
    else:
        try:
            # Terrain direction: GW (pos 0) → Node (pos -1)
            terrain = TerrainProfile.from_coordinates(
                gw_info["lat"], gw_info["lon"],
                node_info["lat"], node_info["lon"],
                n_points=n_terrain_points,
                api=api,
            )
        except Exception:
            terrain = TerrainProfile.from_manual_elevations(
                gw_info["lat"], gw_info["lon"],
                node_info["lat"], node_info["lon"],
                np.full(n_terrain_points, 1500.0),
            )
        st.session_state.terrain_cache[cache_key] = terrain

    gw_dev.altitude_m = float(terrain.elevations[0])    # GW ground at pos 0
    node_dev.altitude_m = float(terrain.elevations[-1])  # Node ground at pos -1

    # Per-node environment (Fix #3) or global fallback
    env = node_environment if node_environment else environment
    result = calculate_link_budget(gw_dev, node_dev, terrain, **budget_kwargs(env))

    # LOS analysis for chart (same direction: GW pos0, Node pos-1)
    los_data = terrain.compute_los_clearance(
        h_tx_asl=gw_dev.antenna_height_asl,
        h_rx_asl=node_dev.antenna_height_asl,
        freq_hz=freq_hz,
        diffraction_method=diffraction_method,
    )

    return {
        "result": result,
        "terrain": terrain,
        "los_data": los_data,
        "gw_dev": gw_dev,
        "node_dev": node_dev,
    }


if compute_cov:
    params = {"sf": cov_sf, "radius_km": cov_radius_km, "radials": cov_radials}
    template = node_device({"name": "coverage", "lat": 0.0, "lon": 0.0, "sf": cov_sf})
    online = [g for g in st.session_state.gateways if g.get("online", True)]
    bar = st.progress(0.0, text="Computing coverage…")
    radials = {}
    for gi, gw in enumerate(online):
        radials[gw["name"]] = compute_coverage(
            gateway_device(gw), template, cov_radius_km * 1000,
            n_radials=cov_radials, n_points=n_terrain_points,
            api=st.session_state.elevation_api,
            progress=lambda f, gi=gi: bar.progress((gi + f) / len(online),
                                                   text=f"Computing coverage of {gw['name']}…"),
            **budget_kwargs(environment),
        )
    bar.empty()
    st.session_state.coverage = {"params": params, "sig": coverage_signature(params), "radials": radials}


def draw_radial(m, radial, weight=3, opacity=0.6):
    for ok, pts in viable_segments(radial):
        folium.PolyLine(pts, color="#06d6a0" if ok else "#ef476f",
                        weight=weight, opacity=opacity).add_to(m)


def build_map(sel_radial=None, height=None, fit_all=False) -> folium.Map:
    """Folium map with devices, links, coverage and the selected node's range."""
    if "map_center" in st.session_state:
        center = st.session_state["map_center"]
    elif st.session_state.gateways:
        g = st.session_state.gateways[0]
        center = [g["lat"], g["lon"]]
    else:
        center = MAP_DEFAULT_CENTER

    # ESRI satellite tiles
    m = folium.Map(
        location=center,
        zoom_start=MAP_DEFAULT_ZOOM,
        tiles="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        attr="Esri",
        **({"height": height} if height else {}),
    )

    # ── Coverage map (drawn first, under the devices) ──
    cov = st.session_state.coverage
    if cov and cov["sig"] == coverage_signature(cov["params"]):
        for gw_name, radials in cov["radials"].items():
            for radial in radials:
                draw_radial(m, radial, weight=2, opacity=0.55)
            reach = [r.coordinates[int(np.searchsorted(r.distances_m, r.continuous_range_m))]
                     for r in radials if r.continuous_range_m > 0]
            if len(reach) >= 3:
                folium.Polygon(reach, color="#06d6a0", weight=1, dash_array="6",
                               fill=True, fill_opacity=0.08,
                               tooltip=f"{gw_name}: continuous coverage (SF{cov['params']['sf']})").add_to(m)

    # ── Selected node: range along its direction ──
    if sel_radial is not None:
        draw_radial(m, sel_radial, weight=4, opacity=0.7)
        if sel_radial.max_range_m > 0:
            k = int(np.searchsorted(sel_radial.distances_m, sel_radial.max_range_m))
            folium.CircleMarker(
                sel_radial.coordinates[k], radius=6, color="#ffffff", weight=2,
                fill=True, fill_color="#06d6a0", fill_opacity=1,
                tooltip=f"Farthest point with signal: {sel_radial.max_range_m / 1000:.2f} km",
            ).add_to(m)

    # ── Draw Gateways ──
    for gw in st.session_state.gateways:
        color = "green" if gw.get("online", True) else "gray"
        icon_name = "tower-broadcast" if gw.get("online", True) else "power-off"
        popup_html = (
            f"<b>{gw['name']}</b><br>"
            f"({'🟢 ONLINE' if gw.get('online', True) else '🔴 OFFLINE'})<br>"
            f"({gw['lat']:.5f}, {gw['lon']:.5f})<br>"
            f"Height: {gw.get('height', DEFAULT_GW_ANTENNA_HEIGHT_M)} m AGL"
        )
        folium.Marker(
            [gw["lat"], gw["lon"]],
            popup=folium.Popup(popup_html, max_width=200),
            icon=folium.Icon(color=color, icon=icon_name, prefix="fa"),
        ).add_to(m)

    # ── Draw Nodes + Link lines ──
    for nd in st.session_state.nodes:
        node_id = nd["name"]
        link = st.session_state.link_results.get(node_id)

        if link:
            r = link["result"]
            viable = r.link_viable
            margin = r.link_margin_db
            line_color = "#06d6a0" if viable else ("#ffd166" if margin > -5 else "#ef476f")
            line_weight = 2.5 if viable else 1.5
            line_dash = None if viable else "8"
        else:
            line_color = "#6c757d"
            line_weight = 1
            line_dash = "4"
            viable = None
            margin = None

        # Draw lines to all online gateways (best link is solid)
        for gw in st.session_state.gateways:
            if gw.get("online", True):
                is_best = link and link["result"].gateway_name == gw["name"]
                folium.PolyLine(
                    [[gw["lat"], gw["lon"]], [nd["lat"], nd["lon"]]],
                    color=line_color if is_best else "#6c757d",
                    weight=line_weight if is_best else 0.8,
                    opacity=0.8 if is_best else 0.3,
                    dash_array=line_dash if is_best else "4",
                ).add_to(m)

        # Node marker
        if nd.get("type") == "weather":
            icon_name = "cloud-sun"
            icon_color = "orange" if viable is None else ("green" if viable else "red")
        else:
            icon_name = "microchip"
            icon_color = "blue" if viable is None else ("green" if viable else "red")

        popup_lines = [f"<b>{node_id}</b><br>({nd['lat']:.5f}, {nd['lon']:.5f})"]
        if link:
            r = link["result"]
            popup_lines.extend([
                f"<br><b>→ {r.gateway_name}</b>",
                f"<br>Dist: {r.distance_km:.2f} km",
                f"<br>Margin: {r.link_margin_db:+.1f} dB",
                f"<br>{'✅ VIABLE' if r.link_viable else '❌ FAIL'}",
            ])

        folium.Marker(
            [nd["lat"], nd["lon"]],
            popup=folium.Popup("".join(popup_lines), max_width=220),
            icon=folium.Icon(color=icon_color, icon=icon_name, prefix="fa"),
        ).add_to(m)


    if fit_all:
        pts = [[d["lat"], d["lon"]] for d in st.session_state.gateways + st.session_state.nodes]
        if cov and cov["sig"] == coverage_signature(cov["params"]):
            pts += [list(r.coordinates[-1]) for rads in cov["radials"].values() for r in rads]
        if len(pts) >= 2:
            m.fit_bounds(pts, padding=(30, 30))
    return m


# ══════════════════════════════════════════════════════════════
# Main Layout
# ══════════════════════════════════════════════════════════════
st.markdown("# 📡 Verea — LoRaWAN Packet Tracer")

# ── Summary metrics bar ──
if st.session_state.gateways or st.session_state.nodes:
    mc1, mc2, mc3, mc4 = st.columns(4)
    n_gw = len(st.session_state.gateways)
    n_gw_online = sum(1 for g in st.session_state.gateways if g.get("online", True))
    n_nodes = len(st.session_state.nodes)
    n_viable = sum(
        1 for n in st.session_state.nodes
        if n["name"] in st.session_state.link_results
        and st.session_state.link_results[n["name"]]["result"].link_viable
    )
    mc1.metric("Gateways", f"{n_gw_online}/{n_gw} online")
    mc2.metric("Nodes", n_nodes)
    mc3.metric("Viable links", f"{n_viable}/{n_nodes}" if n_nodes else "—")

    # Show elevation source
    source = "—"
    if st.session_state.elevation_api:
        source = st.session_state.elevation_api.source_name
    mc4.metric("Elevation source", source[:30])

col_map, col_panel = st.columns([3, 2])

# ──────────────────────────────────────────────────────────────
# Left column: Map + Terrain Chart
# ──────────────────────────────────────────────────────────────
with col_map:
    mode_text = {
        "gateway": "🏗️ Click map to place Gateway",
        "sensor": "📱 Click map to place Sensor Node",
        "weather": "🌤️ Click map to place Weather Station",
        "move": "✋ Click a device to select it, then click the destination",
    }
    st.caption(mode_text.get(st.session_state.placement_mode, ""))
    cov = st.session_state.coverage
    if cov and cov["sig"] != coverage_signature(cov["params"]):
        st.caption("📡 Coverage is outdated (devices or settings changed) — press Compute again.")
    elif cov:
        p = cov["params"]
        st.caption(f"📡 Coverage: SF{p['sf']}, sensor at 1.5 m, up to {p['radius_km']} km — "
                   "green = signal, red = no signal, dashed area = continuous coverage.")

    sel_nd_for_map = next((n for n in st.session_state.nodes
                           if n["name"] == st.session_state.selected_node), None)
    sel_radial = range_along_link(sel_nd_for_map) if sel_nd_for_map else None
    m = build_map(sel_radial)

    # ── Render map and capture clicks ──
    map_data = st_folium(
        m, width=None, height=520,
        returned_objects=["last_clicked", "last_object_clicked"],
        key="main_map",
    )

    # ── Handle marker click: select the device under it ──
    obj = map_data.get("last_object_clicked") if map_data else None
    if obj:
        obj_id = (round(obj["lat"], 8), round(obj["lng"], 8))
        if obj_id != st.session_state.last_processed_object:
            st.session_state.last_processed_object = obj_id
            devices = [("node", n) for n in st.session_state.nodes] + \
                      [("gateway", g) for g in st.session_state.gateways]
            hit = min(
                devices,
                key=lambda d: (d[1]["lat"] - obj["lat"]) ** 2 + (d[1]["lon"] - obj["lng"]) ** 2,
                default=None,
            )
            if hit and abs(hit[1]["lat"] - obj["lat"]) < 1e-6 and abs(hit[1]["lon"] - obj["lng"]) < 1e-6:
                if hit[0] == "node":
                    st.session_state.selected_node = hit[1]["name"]
                    st.session_state.selected_gateway = None
                else:
                    st.session_state.selected_gateway = hit[1]["name"]
                    st.session_state.selected_node = None
                st.rerun()

    # ── Handle map click (Fix #1: ghost click prevention) ──
    if map_data and map_data.get("last_clicked"):
        click = map_data["last_clicked"]
        click_id = (round(click["lat"], 8), round(click["lng"], 8))
        if click_id == st.session_state.last_processed_click:
            click = None  # Already processed this click — skip
        else:
            st.session_state.last_processed_click = click_id

    if map_data and map_data.get("last_clicked") and click is not None:
        clat, clon = click["lat"], click["lng"]

        if st.session_state.placement_mode == "move":
            # Fix #4: Move selected device to new position
            moved = False
            # Try to move selected node
            sel = st.session_state.selected_node
            if sel:
                nd = next((n for n in st.session_state.nodes if n["name"] == sel), None)
                if nd:
                    nd["lat"] = clat
                    nd["lon"] = clon
                    # Invalidate cached results for this node
                    st.session_state.link_results.pop(sel, None)
                    st.session_state.terrain_cache = {}
                    moved = True
            # If no node selected, try selected gateway
            if not moved:
                sel_gw = st.session_state.selected_gateway
                if sel_gw:
                    gw = next((g for g in st.session_state.gateways if g["name"] == sel_gw), None)
                    if gw:
                        gw["lat"] = clat
                        gw["lon"] = clon
                        st.session_state.link_results = {}
                        st.session_state.terrain_cache = {}
                        moved = True
            if moved:
                st.session_state["force_recalc"] = True
                st.rerun()
            else:
                st.warning("Select a device first (click its name in the right panel)")

        elif st.session_state.placement_mode == "gateway":
            idx = next_device_index("GW")
            new_gw = {
                "name": f"GW-{idx}",
                "lat": clat, "lon": clon,
                "height": DEFAULT_GW_ANTENNA_HEIGHT_M,
                "tx_power": DEFAULT_GW_TX_POWER_DBM,
                "gain": DEFAULT_GW_ANTENNA_GAIN_DBI,
                "cable_loss": DEFAULT_CABLE_LOSS_DB,
                "online": True,
            }
            st.session_state.gateways.append(new_gw)
            st.session_state.selected_gateway = new_gw["name"]
            st.session_state.placement_mode = "sensor"
            # Auto-analyze existing nodes against new gateway
            st.session_state.link_results = {}
            st.session_state.terrain_cache = {}
            st.rerun()

        elif st.session_state.placement_mode in ("sensor", "weather"):
            if not st.session_state.gateways:
                st.warning("Place a Gateway first!")
            else:
                is_weather = st.session_state.placement_mode == "weather"
                idx = next_device_index("WX" if is_weather else "Node")
                new_node = {
                    "name": f"{'WX' if is_weather else 'Node'}-{idx}",
                    "lat": clat, "lon": clon,
                    "type": "weather" if is_weather else "sensor",
                    "sf": 10 if is_weather else 7,
                    "tx_power": 19 if is_weather else DEFAULT_TX_POWER_DBM,
                    "height": 3.0 if is_weather else 1.5,
                    "gain": 2.0 if is_weather else DEFAULT_NODE_ANTENNA_GAIN_DBI,
                    "environment": environment,  # Fix #3: per-node environment
                }
                st.session_state.nodes.append(new_node)
                st.session_state.selected_node = new_node["name"]

                # Auto-route to best gateway
                with st.spinner(f"Analyzing {new_node['name']}..."):
                    best_result = None
                    best_analysis = None
                    for gw in st.session_state.gateways:
                        if gw.get("online", True):
                            try:
                                analysis = run_analysis(gw, new_node, node_environment=new_node.get("environment"))
                                if best_analysis is None or analysis["result"].link_margin_db > best_result.link_margin_db:
                                    best_result = analysis["result"]
                                    best_analysis = analysis
                            except Exception:
                                continue
                    if best_analysis:
                        st.session_state.link_results[new_node["name"]] = best_analysis

                st.rerun()

    # ── Terrain profile chart (for selected node) ──
    selected_node_name = st.session_state.selected_node
    if selected_node_name and selected_node_name in st.session_state.link_results:
        analysis = st.session_state.link_results[selected_node_name]
        r = analysis["result"]
        terrain = analysis["terrain"]
        los_data = analysis["los_data"]
        gw_dev = analysis["gw_dev"]
        node_dev = analysis["node_dev"]

        components.html(
            build_profile_html(
                terrain=terrain,
                h_tx_asl=gw_dev.antenna_height_asl,
                h_rx_asl=node_dev.antenna_height_asl,
                los_analysis=los_data,
                title=(
                    f"{r.gateway_name} → {selected_node_name} | "
                    f"{r.distance_km:.2f} km | SF{r.spreading_factor} | {freq_mhz} MHz"
                ),
            ),
            height=430,
        )

        # ── Elevation summary below chart ──
        elev = get_elevation_summary(
            terrain,
            h_tx_agl=gw_dev.antenna.height_m,
            h_rx_agl=node_dev.antenna.height_m,
        )
        ec1, ec2, ec3, ec4 = st.columns(4)
        ec1.metric("GW ground", f"{elev['tx_ground']:.1f} m ASL")
        ec2.metric("GW antenna", f"{elev['tx_asl']:.1f} m ASL")
        ec3.metric("Node ground", f"{elev['rx_ground']:.1f} m ASL")
        ec4.metric("Node antenna", f"{elev['rx_asl']:.1f} m ASL")

        ed1, ed2, ed3 = st.columns(3)
        delta = elev["delta"]
        ed1.metric("Elev. difference", f"{delta:+.1f} m",
                   help="Positive = GW higher than Node")
        ed2.metric("Max terrain", f"{elev['max_terrain']:.1f} m")
        ed3.metric("Source", elev["source"][:35])


# ──────────────────────────────────────────────────────────────
# Right column: Device Management + Link Analysis
# ──────────────────────────────────────────────────────────────
with col_panel:
    if not st.session_state.gateways and not st.session_state.nodes:
        st.info(
            "**Getting started:**\n\n"
            "1. Select '🏗️ Gateway' mode in the sidebar\n"
            "2. Click the map to place your gateway\n"
            "3. Switch to '📱 Sensor' or '🌤️ Weather Station'\n"
            "4. Click the map to add nodes\n\n"
            "Each node auto-calculates link budget with terrain data."
        )
    else:
        # ── Gateway list ──
        st.markdown("### 🏗️ Gateways")
        for i, gw in enumerate(st.session_state.gateways):
            gc1, gc2, gc3, gc4 = st.columns([3, 1, 1, 1])
            with gc1:
                new_name = st.text_input(
                    "Name", value=gw["name"], key=f"gw_name_{i}",
                    label_visibility="collapsed",
                )
                if new_name != gw["name"]:
                    gw["name"] = new_name
            with gc2:
                online = st.toggle("ON", value=gw.get("online", True), key=f"gw_online_{i}")
                if online != gw.get("online", True):
                    gw["online"] = online
                    st.session_state.link_results = {}
                    st.session_state.terrain_cache = {}
                    st.rerun()
            with gc3:
                if st.button("📍", key=f"gw_sel_{i}"):
                    st.session_state.selected_gateway = gw["name"]
                    st.session_state.selected_node = None  # deselect node
                    st.session_state["map_center"] = [gw["lat"], gw["lon"]]
                    st.rerun()
            with gc4:
                if st.button("🗑️", key=f"gw_del_{i}"):
                    st.session_state.gateways.pop(i)
                    st.session_state.link_results = {}
                    st.session_state.terrain_cache = {}
                    st.rerun()

        st.divider()

        # ── Node list ──
        st.markdown("### 📱 Nodes")
        for i, nd in enumerate(st.session_state.nodes):
            nc1, nc2, nc3 = st.columns([4, 1, 1])
            link = st.session_state.link_results.get(nd["name"])
            margin_str = ""
            if link:
                r = link["result"]
                status = "✅" if r.link_viable else "❌"
                margin_str = f" {status} {r.link_margin_db:+.1f}dB"

            with nc1:
                label = f"{nd['name']}{margin_str}"
                if st.button(label, key=f"nd_sel_{i}"):
                    st.session_state.selected_node = nd["name"]
                    st.session_state.selected_gateway = None  # deselect gateway
                    st.rerun()
            with nc2:
                type_icon = "🌤️" if nd.get("type") == "weather" else "📱"
                st.caption(type_icon)
            with nc3:
                if st.button("🗑️", key=f"nd_del_{i}"):
                    name = nd["name"]
                    st.session_state.nodes.pop(i)
                    st.session_state.link_results.pop(name, None)
                    if st.session_state.selected_node == name:
                        st.session_state.selected_node = None
                    st.rerun()

        st.divider()

        # ── Selected device properties ──
        sel_node = st.session_state.selected_node
        sel_nd = next((n for n in st.session_state.nodes if n["name"] == sel_node), None)

        if sel_nd:
            st.markdown(f"### ⚙️ {sel_nd['name']} properties")

            # Widget keys depend on the node's stored values: switching nodes, moving
            # or applying changes renders fresh widgets instead of reusing stale state.
            prop_sig = abs(hash((
                sel_nd["name"], sel_nd["lat"], sel_nd["lon"], sel_nd.get("height"),
                sel_nd.get("tx_power"), sel_nd.get("gain"), sel_nd.get("sf"),
                sel_nd.get("environment"),
            )))

            p1, p2 = st.columns(2)
            with p1:
                new_lat = st.number_input("Latitude", value=sel_nd["lat"],
                                          format="%.6f", key=f"prop_lat_{prop_sig}")
            with p2:
                new_lon = st.number_input("Longitude", value=sel_nd["lon"],
                                          format="%.6f", key=f"prop_lon_{prop_sig}")

            p3, p4 = st.columns(2)
            with p3:
                new_height = st.number_input("Height AGL (m)", value=sel_nd.get("height", 1.5),
                                             min_value=0.5, max_value=30.0, step=0.5,
                                             key=f"prop_height_{prop_sig}")
            with p4:
                new_tx = st.number_input("TX power (dBm)", value=sel_nd.get("tx_power", 14),
                                         min_value=2, max_value=20, key=f"prop_tx_{prop_sig}")

            p5, p6 = st.columns(2)
            with p5:
                new_gain = st.number_input("Antenna gain (dBi)",
                                           value=sel_nd.get("gain", DEFAULT_NODE_ANTENNA_GAIN_DBI),
                                           min_value=0.0, max_value=10.0, step=0.5,
                                           key=f"prop_gain_{prop_sig}")
            with p6:
                new_sf = st.selectbox("Spreading factor",
                                      options=list(range(7, 13)),
                                      index=sel_nd.get("sf", 7) - 7,
                                      key=f"prop_sf_{prop_sig}")

            # Fix #3: per-node environment selector
            env_options = list(ENVIRONMENT_PROFILES.keys())
            current_env = sel_nd.get("environment", environment)
            env_idx = env_options.index(current_env) if current_env in env_options else 0
            new_env = st.selectbox(
                "Environment / Clutter",
                options=env_options,
                index=env_idx,
                key=f"prop_env_{prop_sig}",
                help=ENVIRONMENT_PROFILES[env_options[env_idx]]["description"],
            )

            # Update node if changed
            changed = (
                new_lat != sel_nd["lat"] or new_lon != sel_nd["lon"]
                or new_height != sel_nd.get("height")
                or new_tx != sel_nd.get("tx_power")
                or new_gain != sel_nd.get("gain")
                or new_sf != sel_nd.get("sf")
                or new_env != sel_nd.get("environment", environment)
            )
            if changed:
                if st.button("📝 Apply changes", key="apply_node_changes", type="primary"):
                    sel_nd["lat"] = new_lat
                    sel_nd["lon"] = new_lon
                    sel_nd["height"] = new_height
                    sel_nd["tx_power"] = new_tx
                    sel_nd["gain"] = new_gain
                    sel_nd["sf"] = new_sf
                    sel_nd["environment"] = new_env
                    # Invalidate and recalculate
                    st.session_state.link_results.pop(sel_nd["name"], None)
                    st.session_state.terrain_cache = {}
                    # Re-route to best gateway
                    best_result = None
                    best_analysis = None
                    for gw in st.session_state.gateways:
                        if gw.get("online", True):
                            try:
                                analysis = run_analysis(gw, sel_nd, node_environment=new_env)
                                if best_analysis is None or analysis["result"].link_margin_db > (best_result.link_margin_db if best_result else -999):
                                    best_result = analysis["result"]
                                    best_analysis = analysis
                            except Exception:
                                continue
                    if best_analysis:
                        st.session_state.link_results[sel_nd["name"]] = best_analysis
                    st.rerun()

            # Per-device elevation caption
            if sel_nd["name"] in st.session_state.link_results:
                analysis = st.session_state.link_results[sel_nd["name"]]
                node_dev = analysis["node_dev"]
                terrain = analysis["terrain"]
                st.caption(
                    f"📍 Ground: {node_dev.altitude_m:.1f}m ASL | "
                    f"Antenna: {node_dev.antenna_height_asl:.1f}m ASL | "
                    f"Source: {terrain.elevation_source[:30]}"
                )

            st.divider()

            # ── Link budget metrics ──
            if sel_nd["name"] in st.session_state.link_results:
                analysis = st.session_state.link_results[sel_nd["name"]]
                r = analysis["result"]

                if r.link_viable:
                    css_class = "link-viable"
                    status = f"✅ VIABLE — margin {r.link_margin_db:+.1f} dB → {r.gateway_name}"
                elif r.link_margin_db > -5:
                    css_class = "link-warning"
                    status = f"⚠️ MARGINAL — margin {r.link_margin_db:+.1f} dB"
                else:
                    css_class = "link-fail"
                    status = f"❌ FAIL — margin {r.link_margin_db:+.1f} dB"

                st.markdown(f'<div class="{css_class}">{status}</div>',
                            unsafe_allow_html=True)

                mc1, mc2 = st.columns(2)
                mc1.metric("Distance", f"{r.distance_km:.2f} km")
                mc2.metric(f"Sensitivity (SF{r.spreading_factor})",
                           f"{r.sensitivity_dbm} dBm")

                mc3, mc4 = st.columns(2)
                mc3.metric("RX power", f"{r.rx_power_dbm:+.1f} dBm")
                mc4.metric("Link margin", f"{r.link_margin_db:+.1f} dB")

                mc5, mc6 = st.columns(2)
                mc5.metric("FSPL", f"{r.fspl_db:.1f} dB")
                mc6.metric("Terrain loss", f"+{r.terrain_loss_db:.1f} dB",
                           help="Loss over free space caused by the terrain: ground "
                                "reflection and diffraction over ridges. Model: "
                                + ("Longley-Rice (ITM)" if r.propagation_model == "itm"
                                   else "FSPL + knife-edge"))

                mc7, mc8 = st.columns(2)
                mc7.metric("Fresnel clear.", f"{r.fresnel_min_clearance_pct:.0f}%")
                mc8.metric("Clutter loss", f"+{r.clutter_loss_db:.1f} dB")

                mc9, mc10 = st.columns(2)
                mc9.metric("Fading margin", f"+{r.fading_margin_db:.1f} dB")
                mc10.metric("Total loss", f"{r.total_path_loss_db:.1f} dB")

                rad = range_along_link(sel_nd)
                if rad is not None:
                    st.markdown("**📏 Range in this direction**")
                    rc1, rc2 = st.columns(2)
                    more = "≥ " if rad.reaches_end else ""
                    rc1.metric("Continuous coverage",
                               f"{'≥ ' if rad.first_dead_spot_m is None else ''}{rad.continuous_range_m / 1000:.2f} km",
                               help="Distance from the gateway, along the line through this node, "
                                    "before the first point without signal.")
                    rc2.metric("Farthest signal", f"{more}{rad.max_range_m / 1000:.2f} km",
                               help="Last point on this line that still has signal "
                                    "(e.g. a hilltop past a dead zone).")
                    st.caption("Shown on the map as the green/red line from the gateway "
                               f"(checked up to {rad.distances_m[-1] / 1000:.1f} km, "
                               f"SF{sel_nd.get('sf', 7)}).")

                if not terrain.elevation_source.startswith(("Open-Meteo", "OpenTopoData")):
                    st.error(
                        f"⚠️ No real elevation data for this link ({terrain.elevation_source}). "
                        "Hills and ridges are NOT being considered — press Recalculate to retry."
                    )

                if r.los_obstructed:
                    st.warning(
                        f"⚠️ LOS obstructed — terrain loss of "
                        f"{r.terrain_loss_db:.1f} dB already applied to margin."
                    )

                if r.viability_reasons:
                    for reason in r.viability_reasons:
                        st.caption(f"ℹ️ {reason}")

                # ── SF comparison table ──
                with st.expander("📊 SF comparison"):
                    sf_rows = []
                    for sf_val in range(7, 13):
                        nd_copy = {**sel_nd, "sf": sf_val}
                        # Use first online gateway for comparison
                        best_gw = next(
                            (g for g in st.session_state.gateways if g.get("online", True)),
                            st.session_state.gateways[0] if st.session_state.gateways else None,
                        )
                        if best_gw:
                            try:
                                a = run_analysis(best_gw, nd_copy, node_environment=sel_nd.get("environment"))
                                rr = a["result"]
                                sf_rows.append({
                                    "SF": sf_val,
                                    "Sens. (dBm)": f"{rr.sensitivity_dbm}",
                                    "Margin (dB)": f"{rr.link_margin_db:+.1f}",
                                    "Diffr. (dB)": f"+{rr.diffraction_loss_db:.1f}",
                                    "Rate (bps)": f"{SX1276_DATARATE_BPS[sf_val]}",
                                    "Status": "✅" if rr.link_viable else "❌",
                                })
                            except Exception:
                                pass
                    if sf_rows:
                        st.dataframe(pd.DataFrame(sf_rows), hide_index=True)

                # ── Full link budget report ──
                with st.expander("📋 Full link budget report"):
                    st.code(r.summary(), language="text")

        # ── All links summary ──
        if st.session_state.nodes:
            st.markdown("### All links")
            rows = []
            for nd in st.session_state.nodes:
                link = st.session_state.link_results.get(nd["name"])
                if link:
                    r = link["result"]
                    rows.append({
                        "Node": nd["name"],
                        "→ GW": r.gateway_name,
                        "Dist (km)": f"{r.distance_km:.2f}",
                        "Margin": f"{r.link_margin_db:+.1f}",
                        "Fresnel": f"{r.fresnel_min_clearance_pct:.0f}%",
                        "Status": "✅" if r.link_viable else "❌",
                    })
                else:
                    rows.append({
                        "Node": nd["name"], "→ GW": "—",
                        "Dist (km)": "—", "Margin": "—",
                        "Fresnel": "—", "Status": "⏳",
                    })
            if rows:
                st.dataframe(pd.DataFrame(rows), hide_index=True)

# ══════════════════════════════════════════════════════════════
# Recalculate all links
# ══════════════════════════════════════════════════════════════
# Auto-recalculate when global RF settings change or a device was moved
settings_changed = st.session_state.get("last_rf_settings") not in (None, rf_settings)
st.session_state["last_rf_settings"] = rf_settings
force_recalc = st.session_state.pop("force_recalc", False)

if (recalc or settings_changed or force_recalc) and st.session_state.gateways and st.session_state.nodes:
    if recalc:
        st.session_state.terrain_cache = {}
    st.session_state.link_results = {}
    progress = st.progress(0, text="Recalculating links...")
    total = len(st.session_state.nodes)
    for i, nd in enumerate(st.session_state.nodes):
        best_result = None
        best_analysis = None
        for gw in st.session_state.gateways:
            if gw.get("online", True):
                try:
                    analysis = run_analysis(gw, nd, node_environment=nd.get("environment"))
                    if best_analysis is None or analysis["result"].link_margin_db > (best_result.link_margin_db if best_result else -999):
                        best_result = analysis["result"]
                        best_analysis = analysis
                except Exception:
                    continue
        if best_analysis:
            st.session_state.link_results[nd["name"]] = best_analysis
        progress.progress((i + 1) / total, text=f"Analyzed {nd['name']} ({i + 1}/{total})")
    progress.empty()
    st.rerun()

# ══════════════════════════════════════════════════════════════
# Report (built on request, offered as a download in the sidebar)
# ══════════════════════════════════════════════════════════════
if st.session_state.pop("make_report", False):
    with st.spinner("Building report…"):
        m_rep = build_map(fit_all=True)
        map_doc = m_rep.get_root().render().replace(
            "</body>",
            f"<script>window.addEventListener('load', () => {{ window.map = {m_rep.get_name()}; }});</script></body>",
        )
        model_name = {"itm": "Longley-Rice (ITM)", "simple": "Simple (FSPL + diffraction)"}[propagation_model]
        settings_rows = [
            ("Propagation model", model_name),
            ("Frequency", f"{freq_mhz} MHz"),
            ("Diffraction model (simple)", diffraction_method),
            ("Terrain samples per link", n_terrain_points),
            ("Min margin threshold", f"{margin_threshold:.1f} dB"),
            ("Fading margin", f"{fading_margin:.1f} dB"),
            ("Default environment", environment),
            ("Elevation data", st.session_state.elevation_api.source_name
             if st.session_state.elevation_api else "—"),
        ]
        cov = st.session_state.coverage
        if cov and cov["sig"] == coverage_signature(cov["params"]):
            p = cov["params"]
            settings_rows.append(("Coverage map", f"SF{p['sf']}, sensor 1.5 m, {p['radius_km']} km, "
                                                  f"{p['radials']} directions"))

        gateway_rows = [
            (g["name"], "Online" if g.get("online", True) else "Offline",
             f"{g['lat']:.6f}", f"{g['lon']:.6f}",
             g.get("height", DEFAULT_GW_ANTENNA_HEIGHT_M),
             g.get("gain", DEFAULT_GW_ANTENNA_GAIN_DBI),
             g.get("tx_power", DEFAULT_GW_TX_POWER_DBM))
            for g in st.session_state.gateways
        ]

        node_rows, link_sections = [], []
        for nd in st.session_state.nodes:
            link = st.session_state.link_results.get(nd["name"])
            r = link["result"] if link else None
            env = nd.get("environment", environment)
            node_rows.append((
                nd["name"], "Weather station" if nd.get("type") == "weather" else "Sensor",
                f"{nd['lat']:.6f}", f"{nd['lon']:.6f}", nd.get("height"), nd.get("tx_power"),
                nd.get("gain"), f"SF{nd.get('sf', 7)}", env,
                r.gateway_name if r else "—",
                f"{r.distance_km:.2f}" if r else "—",
                f"{r.rx_power_dbm:.1f}" if r else "—",
                f"{r.link_margin_db:+.1f}" if r else "—",
                ("Viable" if r.link_viable else "Not viable") if r else "Not calculated",
            ))
            if not r:
                continue
            rad = range_along_link(nd)
            link_sections.append({
                "name": f"{r.gateway_name} → {nd['name']}",
                "status": "VIABLE" if r.link_viable else "NOT VIABLE",
                "viable": r.link_viable,
                "budget_rows": [
                    ("Distance", f"{r.distance_km:.2f} km"),
                    ("EIRP (node)", f"{r.eirp_dbm:+.1f} dBm"),
                    ("Free-space loss", f"{r.fspl_db:.1f} dB"),
                    ("Terrain loss", f"+{r.terrain_loss_db:.1f} dB ({'ITM' if r.propagation_model == 'itm' else 'knife-edge'})"),
                    ("Clutter loss", f"+{r.clutter_loss_db:.1f} dB ({env})"),
                    ("Total path loss", f"{r.total_path_loss_db:.1f} dB"),
                    ("RX power at gateway", f"{r.rx_power_dbm:.1f} dBm"),
                    (f"Sensitivity (SF{r.spreading_factor})", f"{r.sensitivity_dbm:.1f} dBm"),
                    ("Fading margin", f"−{r.fading_margin_db:.1f} dB"),
                    ("Link margin", f"{r.link_margin_db:+.1f} dB"),
                    ("SNR", f"{r.snr_db:+.1f} dB (needs {r.snr_required_db:+.1f})"),
                    ("Fresnel clearance", f"{r.fresnel_min_clearance_pct:.0f}%"),
                    ("Line of sight", "Obstructed" if r.los_obstructed else "Clear"),
                ],
                "profile_html": build_profile_html(
                    terrain=link["terrain"],
                    h_tx_asl=link["gw_dev"].antenna_height_asl,
                    h_rx_asl=link["node_dev"].antenna_height_asl,
                    los_analysis=link["los_data"],
                    title=f"{r.gateway_name} → {nd['name']} | {r.distance_km:.2f} km | "
                          f"SF{r.spreading_factor} | {freq_mhz} MHz",
                ),
                "range_text": (
                    f"Range in this direction: continuous coverage up to "
                    f"{'≥ ' if rad.first_dead_spot_m is None else ''}{rad.continuous_range_m / 1000:.2f} km, "
                    f"farthest signal at {'≥ ' if rad.reaches_end else ''}{rad.max_range_m / 1000:.2f} km "
                    f"(checked up to {rad.distances_m[-1] / 1000:.1f} km)."
                ) if rad is not None else "",
            })

        stamp = datetime.now()
        st.session_state.report_html = {
            "html": build_report_html(
                title="Verea — LoRaWAN network report",
                generated_at=stamp.strftime("%Y-%m-%d %H:%M"),
                map_html=map_doc,
                settings=settings_rows,
                gateway_rows=gateway_rows,
                node_rows=node_rows,
                links=link_sections,
            ),
            "name": f"verea_report_{stamp:%Y%m%d_%H%M}.html",
        }
    st.rerun()
