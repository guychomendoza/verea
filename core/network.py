"""
Network
=======
Device dicts (the project format of core/project.py) -> calculations. Shared by
the Streamlit app and the web API (backend/) so both give the same numbers.
"""

from dataclasses import dataclass, asdict
from typing import Optional

import numpy as np

from config import (
    DEFAULT_DIFFRACTION_METHOD, DEFAULT_FADING_MARGIN_DB, DEFAULT_PROPAGATION_MODEL,
    DEFAULT_SAFETY_MARGIN_DB, ENVIRONMENT_PROFILES, clamp_sf,
)
from core.cellular import MARGIN_FLAT_M, MARGIN_STEEP_M, SMALL_GAP_MARGIN_M
from core.devices import Antenna, EndNode, Gateway, WeatherStation
from core.link_budget import calculate_link_budget
from core.profiles import gateway_profile, node_profile
from core.terrain import TerrainProfile, link_samples
from utils.geo import haversine

FREQ_OPTIONS_MHZ = (915, 868, 923, 433)
PROPAGATION_MODELS = ("itm", "simple")
DIFFRACTION_METHODS = ("dominant_knife_edge", "deygout", "empirical_fresnel")
DEFAULT_ENVIRONMENT = "Rural / Open"
FALLBACK_ELEVATION_M = 1500.0


@dataclass(frozen=True)
class RFSettings:
    """Project-wide radio settings (the app's sidebar)."""
    freq_mhz: float = FREQ_OPTIONS_MHZ[0]
    propagation_model: str = DEFAULT_PROPAGATION_MODEL
    diffraction_method: str = DEFAULT_DIFFRACTION_METHOD
    safety_margin: float = DEFAULT_SAFETY_MARGIN_DB
    environment: str = DEFAULT_ENVIRONMENT        # default for nodes without their own

    @property
    def freq_hz(self) -> float:
        return self.freq_mhz * 1e6

    @classmethod
    def from_project(cls, settings: dict) -> "RFSettings":
        """From a project's "settings" (older projects stored fading margin + threshold)."""
        s = settings or {}
        safety = s.get("safety_margin")
        if safety is None:
            safety = (s.get("fading_margin", DEFAULT_FADING_MARGIN_DB) + s.get("margin_threshold", 3.0)
                      if "fading_margin" in s else DEFAULT_SAFETY_MARGIN_DB)

        def pick(key, options, default):
            return s[key] if s.get(key) in options else default

        return cls(
            freq_mhz=pick("freq_mhz", FREQ_OPTIONS_MHZ, FREQ_OPTIONS_MHZ[0]),
            propagation_model=pick("propagation_model", PROPAGATION_MODELS, DEFAULT_PROPAGATION_MODEL),
            diffraction_method=pick("diffraction_method", DIFFRACTION_METHODS, DEFAULT_DIFFRACTION_METHOD),
            safety_margin=float(min(max(safety, 0.0), 25.0)),
            environment=pick("environment", ENVIRONMENT_PROFILES, DEFAULT_ENVIRONMENT),
        )


def gateway_device(gw: dict, rf: RFSettings) -> Gateway:
    """Gateway object from its project dict."""
    prof = gateway_profile(gw)
    return Gateway(
        name=gw.get("name", "Gateway"),
        lat=gw["lat"], lon=gw["lon"],
        tx_power_dbm=gw.get("tx_power", prof["tx_power"]),
        antenna=Antenna(
            gain_dbi=gw.get("gain", prof["gain"]),
            height_m=gw.get("height", prof["height"]),
            cable_loss_db=gw.get("cable_loss", prof["cable_loss"]),
        ),
        frequency_hz=rf.freq_hz,
        online=gw.get("online", True),
        sensitivity=prof["sensitivity"],
    )


def node_device(nd: dict, rf: RFSettings) -> EndNode:
    """EndNode / WeatherStation object from its project dict."""
    prof = node_profile(nd)
    cls = WeatherStation if prof["type"] == "weather" else EndNode
    return cls(
        name=nd["name"],
        lat=nd["lat"], lon=nd["lon"],
        tx_power_dbm=nd.get("tx_power", prof["tx_power"]),
        spreading_factor=clamp_sf(nd.get("sf", prof["sf"])),
        antenna=Antenna(
            gain_dbi=nd.get("gain", prof["gain"]),
            height_m=nd.get("height", prof["height"]),
            cable_loss_db=nd.get("cable_loss", prof["cable_loss"]),
        ),
        frequency_hz=rf.freq_hz,
    )


def budget_kwargs(rf: RFSettings, environment: Optional[str] = None) -> dict:
    """calculate_link_budget settings."""
    return dict(
        diffraction_method=rf.diffraction_method,
        environment=environment or rf.environment,
        # The whole safety margin is the reserve: Link margin = dB left over it,
        # viable when >= 0 (same result as the old fading 8 dB + minimum 3 dB)
        margin_threshold=0.0,
        fading_margin_db=rf.safety_margin,
        propagation_model=rf.propagation_model,
    )


def link_terrain(gw: dict, nd: dict, api) -> TerrainProfile:
    """Terrain GW (position 0) -> node (position -1); flat ground if elevations fail."""
    n_points = link_samples(haversine(gw["lat"], gw["lon"], nd["lat"], nd["lon"]))
    try:
        return TerrainProfile.from_coordinates(gw["lat"], gw["lon"], nd["lat"], nd["lon"],
                                               n_points=n_points, api=api)
    except Exception:
        return TerrainProfile.from_manual_elevations(gw["lat"], gw["lon"], nd["lat"], nd["lon"],
                                                     np.full(n_points, FALLBACK_ELEVATION_M))


def analyze_link(gw: dict, nd: dict, rf: RFSettings, api=None,
                 terrain: Optional[TerrainProfile] = None) -> dict:
    """Terrain + link budget for a gateway-node pair (pass `terrain` to reuse a cached one)."""
    gw_dev, node_dev = gateway_device(gw, rf), node_device(nd, rf)
    if terrain is None:
        terrain = link_terrain(gw, nd, api)
    gw_dev.altitude_m = float(terrain.elevations[0])
    node_dev.altitude_m = float(terrain.elevations[-1])
    result = calculate_link_budget(gw_dev, node_dev, terrain, **budget_kwargs(rf, nd.get("environment")))
    los_data = terrain.compute_los_clearance(
        h_tx_asl=gw_dev.antenna_height_asl,
        h_rx_asl=node_dev.antenna_height_asl,
        freq_hz=rf.freq_hz,
        diffraction_method=rf.diffraction_method,
    )
    return {"result": result, "terrain": terrain, "los_data": los_data,
            "gw_dev": gw_dev, "node_dev": node_dev}


def best_link(gateways: list, nd: dict, analyze) -> tuple[Optional[dict], Optional[str]]:
    """
    Analysis against the online gateway with the best margin, and the reason when
    there is none. `analyze(gw)` runs one pair (so callers can cache terrain).
    """
    online = [gw for gw in gateways if gw.get("online", True)]
    if not online:
        return None, "Ningún gateway en línea"
    best, error = None, None
    for gw in online:
        try:
            analysis = analyze(gw)
        except Exception as e:
            error = f"Falló el cálculo ({type(e).__name__}: {e})"
            continue
        if best is None or analysis["result"].link_margin_db > best["result"].link_margin_db:
            best = analysis
    return best, (None if best else error)


def cell_state(operator: str, hit, diff) -> dict:
    """4G state of a cellular node from its guaranteed (`hit`) and differentiated (`diff`) status."""
    if hit and hit.covered and hit.margin_ok:
        state = ("ok", f"✅ {operator} 4G garantizado", f"{operator} 4G ✓")
    elif hit and hit.covered:
        terrain = ("hueco pequeño" if hit.margin_m <= SMALL_GAP_MARGIN_M
                   else "terreno abrupto" if hit.margin_m <= MARGIN_STEEP_M + 20
                   else "terreno plano" if hit.margin_m >= MARGIN_FLAT_M - 50 else "terreno ondulado")
        state = ("edge", f"⚠️ {operator} 4G incierto: a {hit.edge_m:,.0f} m de una zona sin "
                         f"señal (margen ahí {hit.margin_m:,.0f} m, {terrain})",
                 f"{operator} 4G incierto")
    elif diff and diff.covered:
        state = ("differentiated", f"⚠️ {operator} 4G solo diferenciado (sin garantía)",
                 f"{operator} 4G sin garantía")
    elif hit and hit.possible:
        where = ("en un hueco pequeño de la cobertura" if hit.reach_m is None
                 else f"a {hit.nearest_m:,.0f} m de la cobertura (alcance estimado ahí {hit.reach_m:,.0f} m)")
        state = ("possible", f"🟠 {operator} 4G posible con LTE-M / NB-IoT: {where}; verificar en campo",
                 f"{operator} 4G posible")
    else:
        near = (f"la más cercana a {hit.nearest_m:,.0f} m" if hit and hit.nearest_m is not None
                else "ninguna en 20 km")
        state = ("none", f"❌ Sin 4G {operator} declarado ({near})", f"sin 4G {operator}")
    return {"state": state[0], "text": state[1], "short": state[2]}


def result_dict(result) -> dict:
    """LinkBudgetResult as plain JSON-ready values."""
    out = {}
    for k, v in asdict(result).items():
        if isinstance(v, (np.floating, np.integer)):
            v = v.item()
        elif isinstance(v, np.bool_):
            v = bool(v)
        out[k] = v
    return out
