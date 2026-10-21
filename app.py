"""
Verea
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
import copy
import html
import json
import shapely
import shapely.geometry
from pathlib import Path
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
    MAX_ELEVATION_POINTS,
    MAP_DEFAULT_CENTER,
    MAP_DEFAULT_ZOOM,
    NOISE_FLOOR_DBM,
    MIN_FRESNEL_CLEARANCE_PCT,
    REQUIRED_LINK_MARGIN_DB,
    DEFAULT_DIFFRACTION_METHOD,
    DEFAULT_PROPAGATION_MODEL,
    ENVIRONMENT_PROFILES,
    DEFAULT_FADING_MARGIN_DB,
    DEFAULT_SAFETY_MARGIN_DB,
    US915_UPLINK_SF,
    clamp_sf,
)
from core.devices import Gateway, EndNode, WeatherStation, Antenna
from core.terrain import TerrainProfile, ElevationAPI, link_samples
from core.link_budget import calculate_link_budget, route_to_best_gateway
from core.propagation import fspl, max_fresnel_radius
from ui.profile_chart import get_elevation_summary
from ui.profile_interactive import build_profile_html
from ui.report import build_report_html
from ui.map_base import base_map, fit_view, CoverageTiles
from ui.tile_server import start_tile_server
from core.coverage import compute_radial, compute_coverage, initial_bearing, viable_segments
from core.profiles import (
    GATEWAY_PROFILES, NODE_PROFILES, DEFAULT_GATEWAY_PROFILE, DEFAULT_NODE_PROFILE,
    gateway_profile, node_profile, is_cellular, new_gateway, new_node, estimated_note,
)
from core.project import project_to_dict, project_from_dict
from core.cellular import find_sources, EDGE_MARGIN_M
from utils.geo import haversine

# Terrain model actually used for a link (ITM falls back to the short-path model)
MODEL_USED_LABELS = {
    "itm": "Longley-Rice (ITM)",
    "short": "short path, ITU-R P.526",
    "simple": "FSPL + knife-edge",
}

# ══════════════════════════════════════════════════════════════
# Page config
# ══════════════════════════════════════════════════════════════
st.set_page_config(
    page_title="Verea",
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
    "project": {"name": "", "description": ""},
    "project_settings": {},         # RF settings restored from an opened project
    "project_rev": 0,               # bumps on open/clear so settings widgets re-read defaults
    "loaded_project_file": None,    # id of the last uploaded project (avoid re-applying)
    "recalc_pending": False,        # links must be recalculated (survives interrupted runs)
    "link_errors": {},              # node name -> why it has no link result
}
for key, val in defaults.items():
    if key not in st.session_state:
        st.session_state[key] = copy.deepcopy(val)


for _old, _new in st.session_state.pop("pending_check_moves", []):
    if st.session_state.pop(f"chk_{_old}", False):
        st.session_state[f"chk_{_new}"] = True


def checked_node_names() -> list:
    """Nodes ticked in the right panel (multi-selection)."""
    return [n["name"] for n in st.session_state.nodes if st.session_state.get(f"chk_{n['name']}")]


def clear_checks():
    for k in [k for k in st.session_state if str(k).startswith("chk_")]:
        del st.session_state[k]


def request_recalc():
    """Recalculate every link at the end of this run (or the next, if this one is cut short)."""
    st.session_state.recalc_pending = True


def focus_map(lat: float, lon: float, zoom: int | None = None):
    """Move the main map to a point (keeping the user's zoom unless one is given)."""
    n = st.session_state.get("map_view", {}).get("n", 0) + 1
    st.session_state.map_view = {"center": [lat, lon], "zoom": zoom, "n": n}


def fit_map(points: list):
    """Move and zoom the main map so all points are visible."""
    if len(points) == 1:
        focus_map(*points[0], zoom=16)
    elif points:
        center, zoom = fit_view(points)
        focus_map(*center, zoom=zoom)


def apply_project(loaded: dict):
    """Replace the current work with a loaded project (from a file or the autosave)."""
    st.session_state.project = {"name": loaded["name"], "description": loaded["description"]}
    st.session_state.project_settings = loaded["settings"]
    st.session_state.gateways = loaded["gateways"]
    st.session_state.nodes = loaded["nodes"]
    st.session_state.name_counters = loaded["name_counters"]
    for k in ("link_results", "terrain_cache", "radial_cache"):
        st.session_state[k] = {}
    st.session_state.coverage = None
    st.session_state.report_html = None
    st.session_state.selected_node = None
    st.session_state.selected_gateway = None
    fit_map([[d["lat"], d["lon"]] for d in loaded["gateways"] + loaded["nodes"]])
    clear_checks()
    st.session_state.project_rev += 1
    st.session_state.link_errors = {}
    request_recalc()


# Local autosave until projects are stored in the cloud
AUTOSAVE_PATH = Path(os.environ.get("VEREA_AUTOSAVE",
                                    Path.home() / ".verea" / "autosave.verea.json"))


def read_autosave() -> dict | None:
    try:
        data = json.loads(AUTOSAVE_PATH.read_text(encoding="utf-8"))
        loaded = project_from_dict(data)
    except (OSError, ValueError, KeyError, TypeError):
        return None
    loaded["saved_at"] = str(data.get("saved_at", ""))
    return loaded if loaded["gateways"] or loaded["nodes"] else None


def write_autosave(doc: dict):
    """Write the project if it changed since the last write (never an empty one)."""
    if not (doc["gateways"] or doc["nodes"]):
        return
    body = json.dumps(doc, ensure_ascii=False, sort_keys=True)
    if body == st.session_state.get("last_autosave"):
        return
    try:
        AUTOSAVE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = AUTOSAVE_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps({**doc, "saved_at": datetime.now().strftime("%Y-%m-%d %H:%M")},
                                  ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(AUTOSAVE_PATH)
        st.session_state.last_autosave = body
    except OSError:
        pass


# ── 4G coverage (operator maps published by the regulator, see data/coverage/README.md) ──
COVERAGE_DIR = Path(__file__).parent / "data" / "coverage"


@st.cache_resource
def coverage_sources() -> dict:
    """{operator: {"guaranteed": source, "differentiated": source}} for the files on disk."""
    out = {}
    for s in find_sources(COVERAGE_DIR):
        if s.tech == "4G":
            out.setdefault(s.operator, {})[s.kind] = s
    return out


@st.cache_resource
def tiles_base_url() -> str:
    """Local server for the coverage PMTiles (started once per app process)."""
    return start_tile_server(COVERAGE_DIR)


def coverage_tiles_file(operator: str) -> Path | None:
    """Newest PMTiles built for the operator (scripts/build_coverage_tiles.py), if any."""
    files = sorted(COVERAGE_DIR.glob(f"{operator.lower()}_4g_*.pmtiles"))
    return files[-1] if files else None


def cell_status(nd: dict, operator: str | None) -> dict:
    """4G coverage of a cellular node: state (ok / edge / differentiated / none / unknown) and text."""
    srcs = coverage_sources().get(operator) if operator else None
    if not srcs:
        return {"state": "unknown", "text": "4G (no coverage data)", "short": "4G", "hit": None}
    key = (operator, round(nd["lat"], 6), round(nd["lon"], 6))
    cache = st.session_state.setdefault("cell_status_cache", {})
    if key not in cache:
        g = srcs.get("guaranteed")
        hit = g.status_at(nd["lat"], nd["lon"]) if g else None
        d = srcs.get("differentiated")
        diff = d.status_at(nd["lat"], nd["lon"]) if d and not (hit and hit.covered) else None
        if hit and hit.covered and hit.margin_ok:
            st_ = ("ok", f"✅ {operator} 4G guaranteed", f"{operator} 4G ✓")
        elif hit and hit.covered:
            st_ = ("edge", f"⚠️ {operator} 4G uncertain: less than {EDGE_MARGIN_M} m from an area "
                           f"without signal", f"{operator} 4G uncertain")
        elif diff and diff.covered:
            st_ = ("differentiated", f"⚠️ {operator} 4G differentiated only (no guarantee)",
                   f"{operator} 4G no guarantee")
        else:
            near = (f"nearest {hit.nearest_m:,.0f} m away" if hit and hit.nearest_m is not None
                    else "none within 20 km")
            st_ = ("none", f"❌ No {operator} 4G declared ({near})", f"no {operator} 4G")
        cache[key] = {"state": st_[0], "text": st_[1], "short": st_[2], "hit": hit}
    return cache[key]


def project_slug() -> str:
    name = st.session_state.project["name"].strip() or "verea_project"
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in name)[:60]

# Shared elevation API instance
if st.session_state.elevation_api is None:
    st.session_state.elevation_api = ElevationAPI()


# ══════════════════════════════════════════════════════════════
# Sidebar
# ══════════════════════════════════════════════════════════════
with st.sidebar:
    st.markdown("## 📡 Verea")
    st.divider()

    # ── Project ──
    st.markdown("### 🗂️ Project")
    rev = st.session_state.project_rev
    proj = st.session_state.project
    proj["name"] = st.text_input("Project name", value=proj["name"],
                                 placeholder="e.g. Rancho El Mezquite", key=f"proj_name_{rev}")
    proj["description"] = st.text_area("Description", value=proj["description"], height=68,
                                       key=f"proj_desc_{rev}")
    project_save_slot = st.container()   # filled at the end of the sidebar (needs all settings)
    uploaded = st.file_uploader("📂 Open project", type=["json"], key="project_upload")
    if uploaded is not None and uploaded.file_id != st.session_state.loaded_project_file:
        st.session_state.loaded_project_file = uploaded.file_id
        try:
            loaded = project_from_dict(json.loads(uploaded.getvalue()))
        except (ValueError, KeyError, TypeError) as e:
            st.error(f"Could not open project: {e}")
        else:
            apply_project(loaded)
            st.rerun()

    # Restore the autosaved work when the app starts empty (e.g. after a restart)
    if not (st.session_state.gateways or st.session_state.nodes) \
            and not st.session_state.get("autosave_dismissed"):
        saved = read_autosave()
        if saved:
            n_dev = len(saved["gateways"]) + len(saved["nodes"])
            st.info(f"Unsaved work found: **{saved['name'] or 'untitled'}** "
                    f"({n_dev} devices, {saved['saved_at']}).")
            ra1, ra2 = st.columns(2)
            if ra1.button("↩️ Restore", use_container_width=True, type="primary"):
                apply_project(saved)
                st.rerun()
            if ra2.button("Dismiss", use_container_width=True):
                st.session_state.autosave_dismissed = True
                st.rerun()

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
                    focus_map(location.latitude, location.longitude, zoom=15)
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
    mode_options = ["gateway", "node", "move"]
    mode_labels = {
        "gateway": "🏗️ Gateway",
        "node": "📱 Node (sensor / weather station)",
        "move": "✋ Move selected device",
    }
    # Set the radio through its key (before it is drawn) so code can change the mode,
    # e.g. switch to Node after placing a gateway
    if "switch_mode_to" in st.session_state:
        st.session_state.mode_radio = st.session_state.pop("switch_mode_to")
    if st.session_state.get("mode_radio") not in mode_options:
        st.session_state.mode_radio = (st.session_state.placement_mode
                                       if st.session_state.placement_mode in mode_options
                                       else "gateway")
    mode = st.radio(
        "Device type",
        options=mode_options,
        format_func=lambda x: mode_labels[x],
        key="mode_radio",
    )
    st.session_state.placement_mode = mode
    if mode == "gateway":
        place_gw_profile = st.selectbox(
            "Gateway model", list(GATEWAY_PROFILES),
            index=list(GATEWAY_PROFILES).index(DEFAULT_GATEWAY_PROFILE),
            format_func=lambda k: GATEWAY_PROFILES[k]["label"], key="place_gw_profile",
        )
        st.caption(estimated_note(GATEWAY_PROFILES[place_gw_profile]))
    elif mode == "node":
        place_node_profile = st.selectbox(
            "Node model", list(NODE_PROFILES),
            index=list(NODE_PROFILES).index(DEFAULT_NODE_PROFILE),
            format_func=lambda k: NODE_PROFILES[k]["label"], key="place_node_profile",
        )
        st.caption(estimated_note(NODE_PROFILES[place_node_profile]))
    if mode == "move":
        st.caption("Click a device on the map (or in the right panel) to select it, "
                   "then click the destination on the map.")

    st.divider()

    show_labels = st.toggle("Show labels on map", value=True,
                            help="Name of each device and its distance to the gateway.")

    st.divider()

    # ── Environment ──
    st.markdown("### Environment")
    ps = st.session_state.project_settings
    env_keys = list(ENVIRONMENT_PROFILES.keys())
    environment = st.selectbox(
        "Clutter profile",
        options=env_keys,
        index=env_keys.index(ps["environment"]) if ps.get("environment") in env_keys else 0,
        key=f"set_env_{rev}",
        help="Default for NEW nodes. Each existing node keeps its own environment "
             "(edit it in the right panel).",
    )
    env_info = ENVIRONMENT_PROFILES[environment]
    st.caption(f"{env_info['description']} (+{env_info['clutter_loss_db']:.0f} dB)")

    st.divider()

    # ── RF parameters ──
    st.markdown("### RF parameters")
    freq_options = [915, 868, 923, 433]
    freq_mhz = st.selectbox("Frequency (MHz)", freq_options,
                            index=freq_options.index(ps["freq_mhz"]) if ps.get("freq_mhz") in freq_options else 0,
                            key=f"set_freq_{rev}")
    freq_hz = freq_mhz * 1e6
    # Older projects stored the reserve as fading margin + minimum margin threshold
    default_safety = ps.get("safety_margin",
                            ps.get("fading_margin", DEFAULT_FADING_MARGIN_DB) + ps.get("margin_threshold", 3.0)
                            if "fading_margin" in ps else DEFAULT_SAFETY_MARGIN_DB)
    safety_margin = st.slider(
        "Safety margin (dB)", 0.0, 25.0, float(min(max(default_safety, 0.0), 25.0)), 0.5,
        key=f"set_safety_{rev}",
        help="How many dB above the gateway's minimum the signal must arrive to call a link "
             "viable. It is the reserve for bad days: rain, wet or moving foliage, a vehicle "
             "in the way. Higher = stricter. Link margin shows what is left over it.",
    )

    st.divider()

    # ── Coverage ──
    st.markdown("### Coverage")
    cv1, cv2 = st.columns(2)
    with cv1:
        compute_cov = st.button("📡 Compute", disabled=not st.session_state.gateways,
                                help="How far the signal reaches around each online gateway "
                                     "(settings in Advanced)")
    with cv2:
        if st.button("Hide", disabled=st.session_state.coverage is None):
            st.session_state.coverage = None
            st.rerun()

    # ── 4G coverage ──
    st.markdown("### 📶 4G coverage")
    cell_ops = list(coverage_sources())
    if cell_ops:
        saved_op = ps.get("cell_operator")
        cell_operator = st.selectbox(
            "Operator", cell_ops, index=cell_ops.index(saved_op) if saved_op in cell_ops else 0,
            key=f"set_cell_op_{rev}",
            help="Coverage declared by the operator to the regulator (CRT open data). "
                 "4G sensors are checked against it.")
        show_cell = st.toggle("Show on map", value=False, key="show_cell_layer",
                              help=f"Green = 4G guaranteed. Yellow = covered but less than "
                                   f"{EDGE_MARGIN_M} m from an area without signal (not certain). "
                                   f"Red = no 4G declared.")
        if show_cell and not coverage_tiles_file(cell_operator):
            st.caption("Map tiles not found: showing only the area around the project. "
                       "Run `python scripts/get_coverage.py` to see the whole country.")
        st.caption(" · ".join(s.label for s in coverage_sources()[cell_operator].values())
                   + " — source: CRT / datos.gob.mx (CC BY 4.0)")
    else:
        cell_operator, show_cell = None, False
        st.caption("No coverage files yet. From the project folder run "
                   "`python scripts/get_coverage.py` (one-time download, ≈1.2 GB), "
                   "then restart the app.")

    st.divider()

    # ── Advanced (rarely changed) ──
    with st.expander("⚙️ Advanced"):
        model_labels = {
            "itm": "Longley-Rice (ITM)",
            "simple": "Simple (FSPL + diffraction)",
        }
        propagation_model = st.selectbox(
            "Propagation model",
            options=list(model_labels),
            format_func=model_labels.get,
            index=list(model_labels).index(ps.get("propagation_model", DEFAULT_PROPAGATION_MODEL)
                                           if ps.get("propagation_model") in model_labels
                                           else DEFAULT_PROPAGATION_MODEL),
            key=f"set_model_{rev}",
            help="ITM models ground reflection and diffraction over multiple ridges "
                 "on the real terrain. Paths under ~1 km, where ITM does not apply, use a "
                 "short-path model (ITU-R P.526: rounded hills + ground reflection). "
                 "Simple is the old optimistic model, only for comparison.",
        )
        diff_options = ["dominant_knife_edge", "deygout", "empirical_fresnel"]
        diffraction_method = st.selectbox(
            "Diffraction model (simple)",
            diff_options,
            index=diff_options.index(ps["diffraction_method"])
            if ps.get("diffraction_method") in diff_options else 0,
            key=f"set_diff_{rev}",
            help="Only used by the Simple model.",
        )
        st.markdown("**Coverage map**")
        cov_sf = st.selectbox(
            "Sensor SF", list(US915_UPLINK_SF), index=len(US915_UPLINK_SF) - 1,
            help="Spreading factor of the test sensor. SF10 reaches the farthest.",
        )
        cov_radius_km = st.slider("Max radius (km)", 2, 40, 15, 1,
                                  help="How far from the gateway to look.")
        cov_radials = st.select_slider("Directions", options=[12, 24, 36], value=24,
                                       help="More directions = finer map, slower (~1 s each).")

    st.divider()

    # ── Actions ──
    col_a, col_b = st.columns(2)
    with col_a:
        recalc = st.button("🔄 Recalculate", type="primary")
    with col_b:
        if st.button("🗑️ Clear all"):
            next_rev = st.session_state.project_rev + 1
            for key in defaults:
                st.session_state[key] = copy.deepcopy(defaults[key])
            st.session_state.project_rev = next_rev
            clear_checks()
            st.session_state.loaded_project_file = st.session_state.get("project_upload") and \
                st.session_state["project_upload"].file_id
            st.session_state.elevation_api = ElevationAPI()
            st.session_state.pop("map_view", None)
            st.rerun()

    n_checked = len(checked_node_names())
    report_only_checked = st.checkbox(
        f"Report: only checked nodes ({n_checked})", value=False, disabled=n_checked == 0,
        help="Check nodes in the right panel to choose which ones go in the report.",
    )
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
rf_settings = (freq_mhz, propagation_model, diffraction_method, safety_margin)

with project_save_slot:
    project_doc = project_to_dict(
        st.session_state.project["name"], st.session_state.project["description"],
        st.session_state.gateways, st.session_state.nodes, st.session_state.name_counters,
        settings={
            "freq_mhz": freq_mhz, "propagation_model": propagation_model,
            "diffraction_method": diffraction_method, "safety_margin": safety_margin,
            "cell_operator": cell_operator,
            "environment": environment,
        },
    )
    write_autosave(project_doc)
    st.caption(f"✔ Autosaved locally" if st.session_state.get("last_autosave") else "")
    st.download_button(
        "💾 Save project (file)",
        data=json.dumps(project_doc, indent=2, ensure_ascii=False),
        file_name=f"{project_slug()}.verea.json",
        mime="application/json",
        use_container_width=True,
        disabled=not (st.session_state.gateways or st.session_state.nodes),
    )


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
    prof = gateway_profile(gw_info)
    gw_dev = Gateway(
        name=gw_info.get("name", "Gateway"),
        lat=gw_info["lat"], lon=gw_info["lon"],
        tx_power_dbm=gw_info.get("tx_power", prof["tx_power"]),
        antenna=Antenna(
            gain_dbi=gw_info.get("gain", prof["gain"]),
            height_m=gw_info.get("height", prof["height"]),
            cable_loss_db=gw_info.get("cable_loss", prof["cable_loss"]),
        ),
        frequency_hz=freq_hz,
        online=gw_info.get("online", True),
        sensitivity=prof["sensitivity"],
    )
    return gw_dev


def node_device(node_info: dict) -> EndNode:
    """EndNode / WeatherStation object from its session-state dict."""
    prof = node_profile(node_info)
    cls = WeatherStation if prof["type"] == "weather" else EndNode
    node_dev = cls(
        name=node_info["name"],
        lat=node_info["lat"], lon=node_info["lon"],
        tx_power_dbm=node_info.get("tx_power", prof["tx_power"]),
        spreading_factor=clamp_sf(node_info.get("sf", prof["sf"])),
        antenna=Antenna(
            gain_dbi=node_info.get("gain", prof["gain"]),
            height_m=node_info.get("height", prof["height"]),
            cable_loss_db=node_info.get("cable_loss", prof["cable_loss"]),
        ),
        frequency_hz=freq_hz,
    )
    return node_dev


def best_link(nd: dict) -> tuple[dict | None, str | None]:
    """
    Analysis against the online gateway with the best margin, and the reason
    when there is none (cellular nodes have neither).
    """
    if is_cellular(nd):
        return None, None
    online = [gw for gw in st.session_state.gateways if gw.get("online", True)]
    if not online:
        return None, "No gateway online"
    best, error = None, None
    for gw in online:
        try:
            analysis = run_analysis(gw, nd, node_environment=nd.get("environment"))
        except Exception as e:
            error = f"Calculation failed ({type(e).__name__}: {e})"
            continue
        if best is None or analysis["result"].link_margin_db > best["result"].link_margin_db:
            best = analysis
    return best, (None if best else error)


MAX_NAME_LEN = 40


def rename_device(kind: str, old: str, new: str) -> str | None:
    """
    Rename a gateway or node and every place that refers to it by name.
    Returns an error message, or None when it worked (or nothing changed).
    """
    new = new.strip()
    if new == old:
        return None
    if not new:
        return "The name cannot be empty."
    if len(new) > MAX_NAME_LEN:
        return f"The name can have at most {MAX_NAME_LEN} characters."
    taken = {d["name"].casefold() for d in st.session_state.gateways + st.session_state.nodes
             if d["name"] != old}
    if new.casefold() in taken:
        return f"There is already a device called '{new}'."

    ss = st.session_state
    if kind == "node":
        nd = next(n for n in ss.nodes if n["name"] == old)
        nd["name"] = new
        for store in (ss.link_results, ss.link_errors):
            if old in store:
                store[new] = store.pop(old)
        if new in ss.link_results:
            ss.link_results[new]["node_dev"].name = new
        if ss.selected_node == old:
            ss.selected_node = new
        # The checkbox widget was already drawn this run: move its state next run
        ss.setdefault("pending_check_moves", []).append((old, new))
    else:
        gw = next(g for g in ss.gateways if g["name"] == old)
        gw["name"] = new
        for analysis in ss.link_results.values():
            if analysis["result"].gateway_name == old:
                analysis["result"].gateway_name = new
                analysis["gw_dev"].name = new
        if ss.selected_gateway == old:
            ss.selected_gateway = new
        if ss.coverage and old in ss.coverage["radials"]:
            ss.coverage["radials"][new] = ss.coverage["radials"].pop(old)
    return None


CELL_COLORS = {"ok": "green", "edge": "orange", "differentiated": "orange", "none": "red",
               "unknown": "purple"}




CELL_LAYER_STYLE = {
    "guaranteed": {"color": "#2a9d8f", "weight": 0.5, "opacity": 0.5, "fillColor": "#2a9d8f", "fillOpacity": 0.12},
    "differentiated": {"color": "#e9c46a", "weight": 0.5, "opacity": 0.6, "fillColor": "#e9c46a", "fillOpacity": 0.25},
    "none": {"color": "#e63946", "weight": 0.8, "opacity": 0.8, "fillColor": "#e63946", "fillOpacity": 0.35},
}


def cell_layer(operator: str, bbox: tuple) -> list:
    """GeoJSON features of the operator's 4G coverage inside bbox (simplified for drawing)."""
    key = (operator, tuple(round(v, 3) for v in bbox))
    cache = st.session_state.setdefault("cell_layer_cache", {})
    if key not in cache:
        feats, covered = [], []
        for kind, src in coverage_sources().get(operator, {}).items():
            for level, g in src.geometries(bbox):
                g = shapely.simplify(g, 0.0002, preserve_topology=True)
                if not g.is_empty:
                    covered.append(g)
                    feats.append({"type": "Feature", "geometry": shapely.geometry.mapping(g),
                                  "properties": {"kind": kind}})
        # Where there is no coverage at all: in a mostly covered valley this is what stands out
        gaps = shapely.difference(shapely.box(*bbox), shapely.union_all(covered)) if covered \
            else shapely.box(*bbox)
        if not gaps.is_empty:
            feats.append({"type": "Feature", "geometry": shapely.geometry.mapping(gaps),
                          "properties": {"kind": "none"}})
        cache[key] = feats
    return cache[key]


def no_result_text(nd: dict) -> str:
    """Why a LoRa node has no link result right now."""
    if st.session_state.recalc_pending:
        return "calculating…"
    return "⚠ " + st.session_state.link_errors.get(nd["name"], "not calculated — press Recalculate")


def store_link(name: str, best: dict | None, error: str | None):
    st.session_state.link_results.pop(name, None)
    st.session_state.link_errors.pop(name, None)
    if best:
        st.session_state.link_results[name] = best
    elif error:
        st.session_state.link_errors[name] = error


def budget_kwargs(env: str) -> dict:
    """Link budget settings from the sidebar."""
    return dict(
        diffraction_method=diffraction_method,
        environment=env,
        # The whole safety margin is the reserve: Link margin = dB left over it,
        # viable when >= 0 (same result as the old fading 8 dB + minimum 3 dB)
        margin_threshold=0.0,
        fading_margin_db=safety_margin,
        propagation_model=propagation_model,
    )


def device_signature(d: dict) -> tuple:
    keys = ("lat", "lon", "height", "gain", "tx_power", "sf", "environment", "online", "type",
            "model", "cable_loss")
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
                n_points=MAX_ELEVATION_POINTS, api=st.session_state.elevation_api,
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
    n_points = link_samples(haversine(gw_info["lat"], gw_info["lon"],
                                      node_info["lat"], node_info["lon"]))
    cache_key = (
        f"{gw_info['lat']:.6f},{gw_info['lon']:.6f}_"
        f"{node_info['lat']:.6f},{node_info['lon']:.6f}_"
        f"{n_points}"
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
                n_points=n_points,
                api=api,
            )
        except Exception:
            terrain = TerrainProfile.from_manual_elevations(
                gw_info["lat"], gw_info["lon"],
                node_info["lat"], node_info["lon"],
                np.full(n_points, 1500.0),
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
    template = node_device({**new_node("coverage", 0.0, 0.0, DEFAULT_NODE_PROFILE, environment),
                            "sf": cov_sf})
    online = [g for g in st.session_state.gateways if g.get("online", True)]
    bar = st.progress(0.0, text="Computing coverage…")
    radials = {}
    for gi, gw in enumerate(online):
        radials[gw["name"]] = compute_coverage(
            gateway_device(gw), template, cov_radius_km * 1000,
            n_radials=cov_radials, n_points=MAX_ELEVATION_POINTS,
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


def build_layers(sel_radial=None, only_nodes=None, highlight=True,
                 labels=True) -> folium.FeatureGroup:
    """
    Devices, links, coverage and the selected node's range as one layer.
    only_nodes: names of the nodes to draw (None = all). highlight: draw the
    selection / checked halos (off for the report).
    """
    nodes = [n for n in st.session_state.nodes if only_nodes is None or n["name"] in only_nodes]
    checked = set(checked_node_names()) if highlight else set()
    m = folium.FeatureGroup(name="Network")

    # ── 4G coverage of the selected operator (bottom layer, not clickable) ──
    tiles = coverage_tiles_file(cell_operator) if show_cell and cell_operator else None
    if tiles:
        # Whole country as vector tiles: the browser loads only what is on screen
        CoverageTiles(f"{tiles_base_url()}/{tiles.name}").add_to(m)
    elif show_cell and cell_operator:
        # Fallback without tiles: polygons around the project, straight from the GeoPackage
        pts = network_points() or [MAP_DEFAULT_CENTER]
        lats, lons = [p[0] for p in pts], [p[1] for p in pts]
        bbox = (min(lons) - 0.05, min(lats) - 0.05, max(lons) + 0.05, max(lats) + 0.05)
        feats = cell_layer(cell_operator, bbox)
        if feats:
            folium.GeoJson(
                {"type": "FeatureCollection", "features": feats},
                style_function=lambda f: CELL_LAYER_STYLE[f["properties"]["kind"]],
                interactive=False,
            ).add_to(m)

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

    # ── Selection halos (under the markers) ──
    def halo(lat, lon, color, radius=22):
        folium.CircleMarker([lat, lon], radius=radius, color=color, weight=4,
                            fill=True, fill_color=color, fill_opacity=0.15,
                            interactive=False).add_to(m)

    if highlight:
        for nd in nodes:
            if nd["name"] == st.session_state.selected_node:
                halo(nd["lat"], nd["lon"], "#ffffff", 24)
            elif nd["name"] in checked:
                halo(nd["lat"], nd["lon"], "#ffd166", 20)
        for gw in st.session_state.gateways:
            if gw["name"] == st.session_state.selected_gateway:
                halo(gw["lat"], gw["lon"], "#ffffff", 24)

    # ── Draw Gateways ──
    for gw in st.session_state.gateways:
        color = "green" if gw.get("online", True) else "gray"
        icon_name = "tower-broadcast" if gw.get("online", True) else "power-off"
        popup_html = (
            f"<b>{gw['name']}</b><br>"
            f"{gateway_profile(gw)['label']}<br>"
            f"({'🟢 ONLINE' if gw.get('online', True) else '🔴 OFFLINE'})<br>"
            f"({gw['lat']:.5f}, {gw['lon']:.5f})<br>"
            f"Height: {gw.get('height', DEFAULT_GW_ANTENNA_HEIGHT_M)} m AGL"
        )
        folium.Marker(
            [gw["lat"], gw["lon"]],
            popup=folium.Popup(popup_html, max_width=200),
            icon=folium.Icon(color=color, icon=icon_name, prefix="fa"),
            tooltip=map_label(gw["name"], gateway_profile(gw)["label"]) if labels else None,
        ).add_to(m)

    # ── Draw Nodes + Link lines ──
    for nd in nodes:
        node_id = nd["name"]
        link = st.session_state.link_results.get(node_id)
        cellular = is_cellular(nd)

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

        # Draw lines to all online gateways (best link is solid); cellular nodes have none
        for gw in ([] if cellular else st.session_state.gateways):
            if gw.get("online", True):
                is_best = link and link["result"].gateway_name == gw["name"]
                folium.PolyLine(
                    [[gw["lat"], gw["lon"]], [nd["lat"], nd["lon"]]],
                    color=line_color if is_best else "#6c757d",
                    weight=line_weight if is_best else 0.8,
                    opacity=0.8 if is_best else 0.3,
                    dash_array=line_dash if is_best else "4",
                ).add_to(m)

        # Node marker: green / red by link, gray while it has no result, purple for 4G
        no_result = no_result_text(nd) if not cellular and not link else None
        cell = cell_status(nd, cell_operator) if cellular else None
        if cellular:
            icon_name, icon_color = "signal", CELL_COLORS[cell["state"]]
        else:
            icon_name = "cloud-sun" if nd.get("type") == "weather" else "microchip"
            icon_color = "gray" if viable is None else ("green" if viable else "red")

        popup_lines = [f"<b>{node_id}</b><br>{node_profile(nd)['label']}<br>"
                       f"({nd['lat']:.5f}, {nd['lon']:.5f})"]
        if cellular:
            popup_lines.append(f"<br>📶 {html.escape(cell['text'])}")
        if no_result:
            popup_lines.append(f"<br>{html.escape(no_result)}")
        if link:
            r = link["result"]
            popup_lines.extend([
                f"<br><b>→ {r.gateway_name}</b>",
                f"<br>Dist: {r.distance_km:.2f} km",
                f"<br>Margin: {r.link_margin_db:+.1f} dB",
                f"<br>{'✅ VIABLE' if r.link_viable else '❌ FAIL'}",
            ])

        if cellular:
            label_sub = cell["short"]
        elif link:
            label_sub = f"{link['result'].distance_km:.2f} km → {link['result'].gateway_name}"
        else:
            label_sub = no_result
        folium.Marker(
            [nd["lat"], nd["lon"]],
            popup=folium.Popup("".join(popup_lines), max_width=220),
            icon=folium.Icon(color=icon_color, icon=icon_name, prefix="fa"),
            tooltip=map_label(node_id, label_sub) if labels else None,
        ).add_to(m)

    return m


def map_label(name: str, sub: str | None = None) -> folium.Tooltip:
    """Small always-visible label next to a marker."""
    text = html.escape(name) + (f' <span class="sub">· {html.escape(sub)}</span>' if sub else "")
    return folium.Tooltip(text, permanent=True, direction="right", offset=(14, -18),
                          class_name="verea-label", sticky=False)


def network_points(only_nodes=None) -> list:
    nodes = [n for n in st.session_state.nodes if only_nodes is None or n["name"] in only_nodes]
    return [[d["lat"], d["lon"]] for d in st.session_state.gateways + nodes]


def build_map(sel_radial=None, height=None, fit_all=False, only_nodes=None,
              highlight=True, labels=True) -> folium.Map:
    """Standalone map (report): base map + network layer, framed on the devices."""
    pts = network_points(only_nodes)
    cov = st.session_state.coverage
    if cov and cov["sig"] == coverage_signature(cov["params"]):
        pts += [list(r.coordinates[-1]) for rads in cov["radials"].values() for r in rads]
    center = pts[0] if pts else MAP_DEFAULT_CENTER
    m = base_map(center, MAP_DEFAULT_ZOOM, height=height)
    build_layers(sel_radial, only_nodes, highlight, labels).add_to(m)
    if fit_all and len(pts) >= 2:
        m.fit_bounds(pts, padding=(30, 30))
    return m


# ══════════════════════════════════════════════════════════════
# Main Layout
# ══════════════════════════════════════════════════════════════
st.markdown("# 📡 Verea")

# ── Summary metrics bar ──
if st.session_state.gateways or st.session_state.nodes:
    mc1, mc2, mc3, mc4 = st.columns(4)
    n_gw = len(st.session_state.gateways)
    n_gw_online = sum(1 for g in st.session_state.gateways if g.get("online", True))
    n_nodes = len(st.session_state.nodes)
    n_lora = sum(1 for n in st.session_state.nodes if not is_cellular(n))
    n_viable = sum(
        1 for n in st.session_state.nodes
        if n["name"] in st.session_state.link_results
        and st.session_state.link_results[n["name"]]["result"].link_viable
    )
    mc1.metric("Gateways", f"{n_gw_online}/{n_gw} online")
    mc2.metric("Nodes", n_nodes)
    mc3.metric("Viable links", f"{n_viable}/{n_lora}" if n_lora else "—",
               help="LoRa nodes only; 4G nodes do not link to a gateway.")

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
        "gateway": "🏗️ Click map to place a Gateway",
        "node": "📱 Click map to place a Node",
        "move": "✋ Click a device to select it, then click the destination",
    }
    st.caption(mode_text.get(st.session_state.placement_mode, ""))
    cov = st.session_state.coverage
    if cov and cov["sig"] != coverage_signature(cov["params"]):
        st.caption("📡 Coverage is outdated (devices or settings changed) — press Compute again.")
    elif cov:
        p = cov["params"]
        st.caption(f"📡 Coverage: SF{p['sf']}, {NODE_PROFILES[DEFAULT_NODE_PROFILE]['label']} at 1.5 m, up to {p['radius_km']} km — "
                   "green = signal, red = no signal, dashed area = continuous coverage.")

    sel_nd_for_map = next((n for n in st.session_state.nodes
                           if n["name"] == st.session_state.selected_node), None)
    sel_radial = range_along_link(sel_nd_for_map) if sel_nd_for_map else None
    if "map_view" not in st.session_state:
        pts = network_points()
        if len(pts) > 1:
            fit_map(pts)
        else:
            focus_map(*(pts[0] if pts else MAP_DEFAULT_CENTER), zoom=MAP_DEFAULT_ZOOM)
    view = st.session_state.map_view

    # ── Render map and capture clicks ──
    # The base map never changes, so the component keeps the user's pan/zoom;
    # devices and links go in as a layer that is swapped on every rerun.
    # center/zoom only move the map when they change (the tiny offset makes
    # each focus request distinct, so re-focusing the same node works).
    map_data = st_folium(
        base_map(MAP_DEFAULT_CENTER, MAP_DEFAULT_ZOOM), width=None, height=520,
        returned_objects=["last_clicked", "last_object_clicked"],
        key="main_map",
        feature_group_to_add=build_layers(sel_radial, labels=show_labels),
        center=(view["center"][0] + view["n"] * 1e-9, view["center"][1]),
        zoom=(view["zoom"] + view["n"] * 1e-6) if view.get("zoom") else None,
    )
    st.caption("🟢 viable · 🔴 not viable · ⚪ no result yet (calculating, or no gateway online) "
               "· 📶 4G sensors: same colors for the operator's declared coverage "
               f"(🟠 within {EDGE_MARGIN_M} m of an area without signal)")

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
                    # Its old result no longer applies; recalculated below
                    st.session_state.link_results.pop(sel, None)
                    moved = True
            # If no node selected, try selected gateway
            if not moved:
                sel_gw = st.session_state.selected_gateway
                if sel_gw:
                    gw = next((g for g in st.session_state.gateways if g["name"] == sel_gw), None)
                    if gw:
                        gw["lat"] = clat
                        gw["lon"] = clon
                        moved = True
            if moved:
                request_recalc()
                st.rerun()
            else:
                st.warning("Select a device first (click its name in the right panel)")

        elif st.session_state.placement_mode == "gateway":
            new_gw = new_gateway(f"GW-{next_device_index('GW')}", clat, clon, place_gw_profile)
            st.session_state.gateways.append(new_gw)
            st.session_state.selected_gateway = new_gw["name"]
            st.session_state.selected_node = None
            # Re-route every node: the new gateway may be their best one
            request_recalc()
            # Next click places a node, not another gateway
            st.session_state["switch_mode_to"] = "node"
            st.rerun()

        elif st.session_state.placement_mode == "node":
            prof = NODE_PROFILES[place_node_profile]
            if not st.session_state.gateways and prof["link"] == "lora":
                st.warning("Place a Gateway first!")
            else:
                prefix = {"weather": "WX", "cellular": "4G"}.get(prof["type"], "Node")
                nd_new = new_node(f"{prefix}-{next_device_index(prefix)}", clat, clon,
                                  place_node_profile, environment)
                st.session_state.nodes.append(nd_new)
                st.session_state.selected_node = nd_new["name"]
                st.session_state.selected_gateway = None

                with st.spinner(f"Analyzing {nd_new['name']}..."):
                    store_link(nd_new["name"], *best_link(nd_new))

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
            gc1, gc2, gc4 = st.columns([4, 1, 1], vertical_alignment="center")
            with gc1:
                if st.button(f"🏗️ {gw['name']}", key=f"gw_sel_{i}", use_container_width=True,
                             type="primary" if gw["name"] == st.session_state.selected_gateway
                             else "secondary",
                             help=f"{gateway_profile(gw)['label']} — click to edit"):
                    st.session_state.selected_gateway = gw["name"]
                    st.session_state.selected_node = None  # deselect node
                    focus_map(gw["lat"], gw["lon"])
                    st.rerun()
            with gc2:
                online = st.toggle("ON", value=gw.get("online", True), key=f"gw_online_{i}")
                if online != gw.get("online", True):
                    gw["online"] = online
                    request_recalc()
                    st.rerun()
            with gc4:
                if st.button("🗑️", key=f"gw_del_{i}"):
                    removed = st.session_state.gateways.pop(i)
                    if st.session_state.selected_gateway == removed["name"]:
                        st.session_state.selected_gateway = None
                    request_recalc()
                    st.rerun()

        # ── Selected gateway properties ──
        sel_gw = next((g for g in st.session_state.gateways
                       if g["name"] == st.session_state.selected_gateway), None)
        if sel_gw and not st.session_state.selected_node:
            st.markdown(f"#### ⚙️ {sel_gw['name']} properties")
            gw_sig = abs(hash((sel_gw["name"],) + device_signature(sel_gw)))
            gw_keys = list(GATEWAY_PROFILES)
            cur_model = sel_gw.get("model") if sel_gw.get("model") in GATEWAY_PROFILES else "custom"
            g_model = st.selectbox("Model", gw_keys, index=gw_keys.index(cur_model),
                                   format_func=lambda k: GATEWAY_PROFILES[k]["label"],
                                   key=f"gwp_model_{gw_sig}")
            gp = GATEWAY_PROFILES[g_model]
            st.caption(estimated_note(gp))
            g_name = st.text_input("Name", value=sel_gw["name"], max_chars=MAX_NAME_LEN,
                                   key=f"gwp_name_{gw_sig}")
            # Picking another model loads its values; same model keeps this gateway's values
            src = sel_gw if g_model == cur_model else gp
            fkey = f"{gw_sig}_{g_model}"
            g1, g2 = st.columns(2)
            with g1:
                g_lat = st.number_input("Latitude", value=sel_gw["lat"], format="%.6f",
                                        key=f"gwp_lat_{fkey}")
                g_height = st.number_input("Antenna height AGL (m)",
                                           value=float(src.get("height", gp["height"])),
                                           min_value=0.5, max_value=60.0, step=0.5,
                                           key=f"gwp_h_{fkey}")
                g_cable = st.number_input("Cable loss (dB)",
                                          value=float(src.get("cable_loss", gp["cable_loss"])),
                                          min_value=0.0, max_value=10.0, step=0.1,
                                          key=f"gwp_cable_{fkey}")
            with g2:
                g_lon = st.number_input("Longitude", value=sel_gw["lon"], format="%.6f",
                                        key=f"gwp_lon_{fkey}")
                g_gain = st.number_input("Antenna gain (dBi)",
                                         value=float(src.get("gain", gp["gain"])),
                                         min_value=0.0, max_value=15.0, step=0.5,
                                         key=f"gwp_gain_{fkey}")
                g_tx = st.number_input("TX power (dBm)",
                                       value=float(src.get("tx_power", gp["tx_power"])),
                                       min_value=0.0, max_value=30.0, step=1.0,
                                       key=f"gwp_tx_{fkey}",
                                       help="Downlink power. The uplink budget (node → gateway) "
                                            "depends on antenna height, gain and cable loss.")
            new_vals = {"model": g_model, "lat": g_lat, "lon": g_lon, "height": g_height,
                        "gain": g_gain, "cable_loss": g_cable, "tx_power": g_tx}
            rf_changed = any(sel_gw.get(k) != v for k, v in new_vals.items())
            if rf_changed or g_name.strip() != sel_gw["name"]:
                if st.button("📝 Apply changes", key="apply_gw_changes", type="primary"):
                    error = rename_device("gateway", sel_gw["name"], g_name)
                    if error:
                        st.error(error)
                    else:
                        if rf_changed:
                            sel_gw.update(new_vals)
                            request_recalc()
                        focus_map(sel_gw["lat"], sel_gw["lon"])
                        st.rerun()

        st.divider()

        # ── Node list ──
        st.markdown("### 📱 Nodes")
        if st.session_state.nodes:
            st.caption("Tick nodes to highlight them on the map or to pick them for the report.")
        for i, nd in enumerate(st.session_state.nodes):
            nc0, nc1, nc2, nc3 = st.columns([0.6, 4, 1, 1], vertical_alignment="center")
            link = st.session_state.link_results.get(nd["name"])
            margin_str = ""
            if is_cellular(nd):
                margin_str = " " + cell_status(nd, cell_operator)["text"].split(" ")[0] + " 4G"
            elif link:
                r = link["result"]
                status = "✅" if r.link_viable else "❌"
                margin_str = f" {status} {r.link_margin_db:+.1f}dB"
            else:
                margin_str = " ⏳" if st.session_state.recalc_pending else " ⚠️"

            with nc0:
                st.checkbox("Select", key=f"chk_{nd['name']}", label_visibility="collapsed")
            with nc1:
                label = f"{nd['name']}{margin_str}"
                is_sel = nd["name"] == st.session_state.selected_node
                if st.button(label, key=f"nd_sel_{i}", use_container_width=True,
                             type="primary" if is_sel else "secondary",
                             help=node_profile(nd)["label"] + (
                                 f" — {no_result_text(nd)}" if not link and not is_cellular(nd) else "")):
                    st.session_state.selected_node = nd["name"]
                    st.session_state.selected_gateway = None  # deselect gateway
                    focus_map(nd["lat"], nd["lon"])
                    st.rerun()
            with nc2:
                type_icon = {"weather": "🌤️", "cellular": "📶"}.get(node_profile(nd)["type"], "📱")
                st.caption(type_icon)
            with nc3:
                if st.button("🗑️", key=f"nd_del_{i}"):
                    name = nd["name"]
                    st.session_state.nodes.pop(i)
                    st.session_state.link_results.pop(name, None)
                    st.session_state.link_errors.pop(name, None)
                    if st.session_state.selected_node == name:
                        st.session_state.selected_node = None
                    st.rerun()

        checked_now = checked_node_names()
        if checked_now:
            lc1, lc2 = st.columns(2)
            with lc1:
                if st.button(f"📍 Locate checked ({len(checked_now)})", use_container_width=True):
                    fit_map([[n["lat"], n["lon"]] for n in st.session_state.nodes
                             if n["name"] in checked_now])
                    st.rerun()
            with lc2:
                st.button("✖ Uncheck all", use_container_width=True, on_click=clear_checks)

        st.divider()

        # ── Selected device properties ──
        sel_node = st.session_state.selected_node
        sel_nd = next((n for n in st.session_state.nodes if n["name"] == sel_node), None)

        if sel_nd:
            st.markdown(f"### ⚙️ {sel_nd['name']} properties")
            st.caption(f"**{node_profile(sel_nd)['label']}** — {estimated_note(node_profile(sel_nd))}")

            # Widget keys depend on the node's stored values: switching nodes, moving
            # or applying changes renders fresh widgets instead of reusing stale state.
            prop_sig = abs(hash((
                sel_nd["name"], sel_nd["lat"], sel_nd["lon"], sel_nd.get("height"),
                sel_nd.get("tx_power"), sel_nd.get("gain"), sel_nd.get("sf"),
                sel_nd.get("environment"),
            )))

            new_name = st.text_input("Name", value=sel_nd["name"], max_chars=MAX_NAME_LEN,
                                     key=f"prop_name_{prop_sig}")

            p1, p2 = st.columns(2)
            with p1:
                new_lat = st.number_input("Latitude", value=sel_nd["lat"],
                                          format="%.6f", key=f"prop_lat_{prop_sig}")
            with p2:
                new_lon = st.number_input("Longitude", value=sel_nd["lon"],
                                          format="%.6f", key=f"prop_lon_{prop_sig}")

            if is_cellular(sel_nd):
                cell = cell_status(sel_nd, cell_operator)
                box = {"ok": st.success, "none": st.error}.get(cell["state"], st.warning)
                box(cell["text"])
                hit = cell["hit"]
                if hit:
                    c1, c2 = st.columns(2)
                    c1.metric("Covered around (300 m)", f"{hit.nearby_share:.0%}",
                              help="Share of the surroundings inside the operator's guaranteed "
                                   "4G area. Low values mean a spotty area: moving the sensor a "
                                   "few metres can change the signal.")
                    if hit.covered:
                        c2.metric("Declared signal", f"{hit.level_dbm:.0f} dBm" if hit.level_dbm else "—",
                                  help="Signal level the operator declares for this area.")
                    else:
                        c2.metric("Nearest coverage", f"{hit.nearest_m:,.0f} m"
                                  if hit.nearest_m is not None else "> 20 km")
                st.caption("Sends data over the cell network (NB-IoT / LTE-M), not through a "
                           "LoRaWAN gateway. Coverage = what the operator declares to the regulator "
                           "for outdoor 4G; LTE-M / NB-IoT usually reach as far or a bit farther.")
                new_height, new_tx, new_gain = sel_nd.get("height"), sel_nd.get("tx_power"), sel_nd.get("gain")
                new_sf, new_env = sel_nd.get("sf"), sel_nd.get("environment", environment)
            else:
                p3, p4 = st.columns(2)
                with p3:
                    new_height = st.number_input("Height AGL (m)", value=float(sel_nd.get("height", 1.5)),
                                                 min_value=0.5, max_value=30.0, step=0.5,
                                                 key=f"prop_height_{prop_sig}")
                with p4:
                    new_tx = st.number_input("TX power (dBm)", value=float(sel_nd.get("tx_power", 14)),
                                             min_value=2.0, max_value=22.0, step=1.0,
                                             key=f"prop_tx_{prop_sig}")

                p5, p6 = st.columns(2)
                with p5:
                    new_gain = st.number_input("Antenna gain (dBi)",
                                               value=float(sel_nd.get("gain", DEFAULT_NODE_ANTENNA_GAIN_DBI)),
                                               min_value=0.0, max_value=10.0, step=0.5,
                                               key=f"prop_gain_{prop_sig}")
                with p6:
                    new_sf = st.selectbox("Spreading factor",
                                          options=list(US915_UPLINK_SF),
                                          index=US915_UPLINK_SF.index(clamp_sf(sel_nd.get("sf", 7))),
                                          help="US915 uplinks allow SF7–SF10 (125 kHz). "
                                               "Higher SF = more range, slower and longer airtime.",
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
            renamed = new_name.strip() != sel_nd["name"]
            changed = (
                new_lat != sel_nd["lat"] or new_lon != sel_nd["lon"]
                or new_height != sel_nd.get("height")
                or new_tx != sel_nd.get("tx_power")
                or new_gain != sel_nd.get("gain")
                or new_sf != sel_nd.get("sf")
                or new_env != sel_nd.get("environment", environment)
            )
            if changed or renamed:
                if st.button("📝 Apply changes", key="apply_node_changes", type="primary"):
                    error = rename_device("node", sel_nd["name"], new_name)
                    if error:
                        st.error(error)
                    elif not changed:
                        st.rerun()
                    else:
                        sel_nd["lat"] = new_lat
                        sel_nd["lon"] = new_lon
                        sel_nd["height"] = new_height
                        sel_nd["tx_power"] = new_tx
                        sel_nd["gain"] = new_gain
                        sel_nd["sf"] = new_sf
                        sel_nd["environment"] = new_env
                        focus_map(sel_nd["lat"], sel_nd["lon"])
                        # Re-route to best gateway
                        store_link(sel_nd["name"], *best_link(sel_nd))
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
                                + MODEL_USED_LABELS.get(r.propagation_model, r.propagation_model))

                mc7, mc8 = st.columns(2)
                mc7.metric("Fresnel clear.", f"{r.fresnel_min_clearance_pct:.0f}%")
                mc8.metric("Clutter loss", f"+{r.clutter_loss_db:.1f} dB")

                mc9, mc10 = st.columns(2)
                mc9.metric("Safety margin", f"{r.fading_margin_db:.1f} dB",
                           help="Reserve required over the gateway's minimum; set in the sidebar.")
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
                               f"SF{clamp_sf(sel_nd.get('sf', 7))}).")

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
                    for sf_val in US915_UPLINK_SF:
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
                        "Fresnel": "—",
                        "Status": cell_status(nd, cell_operator)["text"] if is_cellular(nd)
                        else no_result_text(nd),
                    })
            if rows:
                st.dataframe(pd.DataFrame(rows), hide_index=True)

# ══════════════════════════════════════════════════════════════
# Recalculate all links
# ══════════════════════════════════════════════════════════════
# Recalculate when global RF settings change or a device / gateway changed.
# The pending flag is cleared only after every node is done: if the user
# touches something mid-way, Streamlit stops this run and the next one
# starts over instead of leaving nodes without a result.
if st.session_state.get("last_rf_settings") not in (None, rf_settings):
    request_recalc()
st.session_state["last_rf_settings"] = rf_settings
if recalc:
    st.session_state.terrain_cache = {}
    request_recalc()

if st.session_state.recalc_pending:
    new_results, new_errors = {}, {}
    nodes = st.session_state.nodes
    progress = st.progress(0, text="Recalculating links...") if nodes else None
    for i, nd in enumerate(nodes):
        best, error = best_link(nd)
        if best:
            new_results[nd["name"]] = best
        elif error:
            new_errors[nd["name"]] = error
        progress.progress((i + 1) / len(nodes), text=f"Analyzed {nd['name']} ({i + 1}/{len(nodes)})")
    st.session_state.link_results = new_results
    st.session_state.link_errors = new_errors
    st.session_state.recalc_pending = False
    st.rerun()

# ══════════════════════════════════════════════════════════════
# Report (built on request, offered as a download in the sidebar)
# ══════════════════════════════════════════════════════════════
if st.session_state.pop("make_report", False):
    with st.spinner("Building report…"):
        rep_nodes = set(checked_node_names()) if report_only_checked else None
        m_rep = build_map(fit_all=True, only_nodes=rep_nodes, highlight=False)
        map_doc = m_rep.get_root().render().replace(
            "</body>",
            f"<script>window.addEventListener('load', () => {{ window.map = {m_rep.get_name()}; }});</script></body>",
        )
        model_name = {"itm": "Longley-Rice (ITM)", "simple": "Simple (FSPL + diffraction)"}[propagation_model]
        settings_rows = [
            ("Propagation model", model_name),
            ("Frequency", f"{freq_mhz} MHz"),
            ("Diffraction model (simple)", diffraction_method),
            ("Terrain samples per link", "automatic (one per ~90 m, up to 100)"),
            ("Safety margin", f"{safety_margin:.1f} dB"),
            ("Default environment", environment),
            ("4G coverage data", " · ".join(s.label for s in coverage_sources().get(cell_operator, {}).values())
             + " — Comisión Reguladora de Telecomunicaciones, datos.gob.mx (CC BY 4.0)"
             if cell_operator else "—"),
            ("Elevation data", st.session_state.elevation_api.source_name
             if st.session_state.elevation_api else "—"),
        ]
        cov = st.session_state.coverage
        if cov and cov["sig"] == coverage_signature(cov["params"]):
            p = cov["params"]
            settings_rows.append(("Coverage map", f"SF{p['sf']}, {NODE_PROFILES[DEFAULT_NODE_PROFILE]['label']} at 1.5 m, {p['radius_km']} km, "
                                                  f"{p['radials']} directions"))

        gateway_rows = [
            (g["name"], gateway_profile(g)["label"], "Online" if g.get("online", True) else "Offline",
             f"{g['lat']:.6f}", f"{g['lon']:.6f}",
             g.get("height", DEFAULT_GW_ANTENNA_HEIGHT_M),
             g.get("gain", DEFAULT_GW_ANTENNA_GAIN_DBI),
             g.get("cable_loss", DEFAULT_CABLE_LOSS_DB),
             g.get("tx_power", DEFAULT_GW_TX_POWER_DBM))
            for g in st.session_state.gateways
        ]

        node_rows, link_sections = [], []
        for nd in st.session_state.nodes:
            if rep_nodes is not None and nd["name"] not in rep_nodes:
                continue
            link = st.session_state.link_results.get(nd["name"])
            r = link["result"] if link else None
            env = nd.get("environment", environment)
            cellular = is_cellular(nd)
            node_rows.append((
                nd["name"], node_profile(nd)["label"],
                f"{nd['lat']:.6f}", f"{nd['lon']:.6f}", nd.get("height"), nd.get("tx_power"),
                nd.get("gain"), "—" if cellular else f"SF{clamp_sf(nd.get('sf', 7))}",
                "—" if cellular else env,
                r.gateway_name if r else "—",
                f"{r.distance_km:.2f}" if r else "—",
                f"{r.rx_power_dbm:.1f}" if r else "—",
                f"{r.link_margin_db:+.1f}" if r else "—",
                cell_status(nd, cell_operator)["text"] if cellular else
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
                    ("Terrain loss", f"+{r.terrain_loss_db:.1f} dB ({MODEL_USED_LABELS.get(r.propagation_model, r.propagation_model)})"),
                    ("Clutter loss", f"+{r.clutter_loss_db:.1f} dB ({env})"),
                    ("Total path loss", f"{r.total_path_loss_db:.1f} dB"),
                    ("RX power at gateway", f"{r.rx_power_dbm:.1f} dBm"),
                    (f"Sensitivity (SF{r.spreading_factor})", f"{r.sensitivity_dbm:.1f} dBm"),
                    ("Safety margin required", f"−{r.fading_margin_db:.1f} dB"),
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
                title=st.session_state.project["name"].strip() or "Verea — network report",
                description=st.session_state.project["description"].strip(),
                generated_at=stamp.strftime("%Y-%m-%d %H:%M"),
                map_html=map_doc,
                settings=settings_rows,
                gateway_rows=gateway_rows,
                node_rows=node_rows,
                links=link_sections,
            ),
            "name": f"{project_slug()}_report_{stamp:%Y%m%d_%H%M}.html",
        }
    st.rerun()
