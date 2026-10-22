"""
Verea web API
=============
FastAPI over core/: the same calculations as the Streamlit app (core/network.py),
for the web frontend. Run from the repository root:

    .venv/bin/uvicorn backend.main:app --port 8000

Environment:
  VEREA_CORS_ORIGINS   comma-separated origins allowed to call the API
  VEREA_DEV=1          accept requests without a login (local development only)
"""

import math
import os
import sys
import threading
from pathlib import Path
from typing import Optional

import numpy as np
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import core.network as net  # noqa: E402
from backend.auth import require_user  # noqa: E402
from backend.schemas import (  # noqa: E402
    CellRequest, CoverageRequest, LinkRequest, LinksRequest, ProjectBody, RadialRequest,
)
from config import ENVIRONMENT_PROFILES, US915_UPLINK_SF  # noqa: E402
from core.cellular import find_sources  # noqa: E402
from core.coverage import compute_coverage, compute_radial, viable_segments  # noqa: E402
from core.dem import LocalDEM  # noqa: E402
from core.profiles import GATEWAY_PROFILES, NODE_PROFILES, is_cellular  # noqa: E402
from core.project import project_from_dict  # noqa: E402
from core.terrain import ElevationAPI  # noqa: E402

COVERAGE_DIR = ROOT / "data" / "coverage"
MAX_RADIAL_POINTS = 100


class SharedElevations:
    """One elevation source for all requests (local DEM if present), one call at a time."""

    def __init__(self):
        self._src = LocalDEM.open() or ElevationAPI()
        self._lock = threading.Lock()

    @property
    def source_name(self) -> str:
        return self._src.source_name

    def fetch_elevations(self, coordinates):
        with self._lock:
            return self._src.fetch_elevations(coordinates)


ELEVATIONS = SharedElevations()
_SOURCES_LOCK = threading.Lock()
_SOURCES: dict = {}


def coverage_sources() -> dict:
    """{operator: {kind: CoverageSource}} for the 4G files on disk."""
    if not _SOURCES:
        for s in find_sources(COVERAGE_DIR):
            if s.tech == "4G":
                _SOURCES.setdefault(s.operator, {})[s.kind] = s
    return _SOURCES


app = FastAPI(title="Verea API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.environ.get("VEREA_CORS_ORIGINS", "").split(",") if o.strip()],
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)


def _clean(values) -> list:
    """Floats for JSON: NaN/inf -> None."""
    return [None if v is None or not math.isfinite(float(v)) else float(v) for v in values]


def _link_summary(analysis: dict) -> dict:
    r = analysis["result"]
    return {
        "gateway": r.gateway_name, "viable": bool(r.link_viable),
        "margin_db": float(r.link_margin_db), "rssi_dbm": float(r.rx_power_dbm),
        "snr_db": float(r.snr_db), "distance_m": float(r.distance_m),
        "model": r.propagation_model, "reasons": list(r.viability_reasons),
    }


# ── endpoints ──
@app.get("/api/health")
def health():
    return {"status": "ok", "elevation": ELEVATIONS.source_name,
            "coverage": sorted(coverage_sources())}


@app.get("/api/catalog")
def catalog(user=Depends(require_user)):
    """Presets and options the frontend needs to build its forms."""
    return {
        "gateway_profiles": GATEWAY_PROFILES,
        "node_profiles": NODE_PROFILES,
        "environments": ENVIRONMENT_PROFILES,
        "freq_mhz": list(net.FREQ_OPTIONS_MHZ),
        "propagation_models": list(net.PROPAGATION_MODELS),
        "diffraction_methods": list(net.DIFFRACTION_METHODS),
        "spreading_factors": list(US915_UPLINK_SF),
        "cell_operators": sorted(coverage_sources()),
        "defaults": net.RFSettings().__dict__,
    }


@app.post("/api/project/normalize")
def normalize_project(body: ProjectBody, user=Depends(require_user)):
    """Validate an imported .verea.json and return it in the current format."""
    try:
        return project_from_dict(body.project)
    except (ValueError, TypeError, KeyError) as e:
        raise HTTPException(422, f"Invalid project: {e}")


@app.post("/api/links")
def links(req: LinksRequest, user=Depends(require_user)):
    """Best gateway for every LoRa node (the app's Recalculate)."""
    rf = net.RFSettings.from_project(req.settings.model_dump())
    gws = [g.model_dump() for g in req.gateways]
    terrains: dict = {}

    def analyze(gw, nd):
        key = (gw["lat"], gw["lon"], nd["lat"], nd["lon"])
        if key not in terrains:
            terrains[key] = net.link_terrain(gw, nd, ELEVATIONS)
        return net.analyze_link(gw, nd, rf, terrain=terrains[key])

    out = {}
    for n in req.nodes:
        nd = n.model_dump()
        if is_cellular(nd):
            continue
        best, error = net.best_link(gws, nd, lambda gw: analyze(gw, nd))
        out[nd["name"]] = {"link": _link_summary(best) if best else None, "error": error}
    return {"results": out, "elevation": ELEVATIONS.source_name}


@app.post("/api/link")
def link(req: LinkRequest, user=Depends(require_user)):
    """Full link budget and terrain profile of one gateway-node pair (detail panel and chart)."""
    rf = net.RFSettings.from_project(req.settings.model_dump())
    a = net.analyze_link(req.gateway.model_dump(), req.node.model_dump(), rf, ELEVATIONS)
    t, los = a["terrain"], a["los_data"]
    return {
        "summary": _link_summary(a),
        "budget": net.result_dict(a["result"]),
        "profile": {
            "distances_m": _clean(t.distances), "elevations_m": _clean(t.elevations),
            "coordinates": [list(c) for c in t.coordinates],
            "los_m": _clean(los["los_heights"]), "fresnel_radius_m": _clean(los["fresnel_radii"]),
            "clearance_pct": _clean(los["clearance_pct"]),
            "worst_point_idx": int(los["worst_point_idx"]),
            "elevation_source": t.elevation_source,
        },
    }


def _radial_dict(r) -> dict:
    return {
        "bearing_deg": r.bearing_deg,
        "distances_m": _clean(r.distances_m),
        "coordinates": [list(c) for c in r.coordinates],
        "margins_db": _clean(r.margins_db),
        "viable": [bool(v) for v in r.viable],
        "continuous_range_m": float(r.continuous_range_m),
        "segments": [{"viable": ok, "points": [list(p) for p in pts]} for ok, pts in viable_segments(r)],
    }


@app.post("/api/radial")
def radial(req: RadialRequest, user=Depends(require_user)):
    """Signal along one bearing from a gateway (range along the link)."""
    rf = net.RFSettings.from_project(req.settings.model_dump())
    nd = req.node.model_dump()
    r = compute_radial(net.gateway_device(req.gateway.model_dump(), rf), net.node_device(nd, rf),
                       req.bearing_deg, req.max_distance_m, n_points=MAX_RADIAL_POINTS, api=ELEVATIONS,
                       **net.budget_kwargs(rf, nd.get("environment")))
    return _radial_dict(r)


@app.post("/api/coverage")
def coverage(req: CoverageRequest, user=Depends(require_user)):
    """Coverage radials of one gateway for a test sensor."""
    rf = net.RFSettings.from_project(req.settings.model_dump())
    template = net.node_device({"name": "coverage", "lat": 0.0, "lon": 0.0,
                                "model": req.node_model, "sf": req.sf}, rf)
    radials = compute_coverage(net.gateway_device(req.gateway.model_dump(), rf), template,
                               req.radius_km * 1000, n_radials=req.radials,
                               n_points=MAX_RADIAL_POINTS, api=ELEVATIONS, **net.budget_kwargs(rf))
    return {"radials": [_radial_dict(r) for r in radials]}


@app.post("/api/cell-status")
def cell_status(req: CellRequest, user=Depends(require_user)):
    """4G coverage declared by the operator at each point."""
    srcs = coverage_sources().get(req.operator)
    if not srcs:
        raise HTTPException(404, f"No coverage data for {req.operator}")
    out = []
    with _SOURCES_LOCK:
        for p in req.points:
            g, d = srcs.get("guaranteed"), srcs.get("differentiated")
            hit = g.status_at(p.lat, p.lon) if g else None
            diff = d.status_at(p.lat, p.lon) if d and not (hit and hit.covered) else None
            item = {"name": p.name, **net.cell_state(req.operator, hit, diff)}
            if hit:
                item.update(covered=hit.covered, level_dbm=hit.level_dbm, nearby_share=hit.nearby_share,
                            nearest_m=hit.nearest_m, edge_m=hit.edge_m, margin_m=hit.margin_m)
            out.append(item)
    return {"points": out, "sources": [s.label for s in srcs.values()]}
