"""
Gateway siting
==============
Where to put 4G gateways so that LoRa nodes get a viable link: candidates on the high points
of the terrain around each group of nodes (local DEM), kept only where the operator declares
4G (the gateway needs internet), every candidate × node pair checked with the same link budget
as the app (terrain profile, ITM / ITU-R P.526, Fresnel, margin), then a greedy choice: the
candidate that serves most nodes first, until every reachable node is served.

Only for gateways with their own 4G connection: a gateway on WiFi / Ethernet needs power and
a network, so its place is decided by hand.
"""

import math
from typing import Callable, Optional

import numpy as np

from core import network as net
from utils.geo import haversine

GROUP_LINK_M = 5_000          # nodes closer than this to each other form one group
SEARCH_PAD_M = 2_000          # candidates up to this far outside a group's box
GRID_STEP_M = 270             # three DEM cells
MIN_SPACING_M = 300           # between candidates
MAX_CANDIDATES = 40           # per group


def groups_of(nodes: list[dict], link_m: float = GROUP_LINK_M) -> list[list[dict]]:
    """Single-linkage groups: a node joins a group when it is within link_m of any member."""
    left, out = list(nodes), []
    while left:
        group, frontier = [left.pop(0)], 0
        while frontier < len(group):
            a = group[frontier]
            near = [n for n in left if haversine(a["lat"], a["lon"], n["lat"], n["lon"]) <= link_m]
            for n in near:
                left.remove(n)
            group += near
            frontier += 1
        out.append(group)
    return out


def high_points(group: list[dict], elevations, max_candidates: int = MAX_CANDIDATES) -> list[tuple[float, float, float]]:
    """(lat, lon, elevation) of the local maxima of the terrain around a group, highest first,
    at least MIN_SPACING_M apart, plus the group's centre."""
    lats = [n["lat"] for n in group]
    lons = [n["lon"] for n in group]
    lat0 = sum(lats) / len(lats)
    dlat = SEARCH_PAD_M / 111_320
    dlon = dlat / max(math.cos(math.radians(lat0)), 0.1)
    s, n = min(lats) - dlat, max(lats) + dlat
    w, e = min(lons) - dlon, max(lons) + dlon
    step_lat = GRID_STEP_M / 111_320
    step_lon = step_lat / max(math.cos(math.radians(lat0)), 0.1)
    ys = np.arange(s, n + step_lat / 2, step_lat)
    xs = np.arange(w, e + step_lon / 2, step_lon)
    grid = [(y, x) for y in ys for x in xs]
    z = np.asarray(elevations.fetch_elevations(grid), dtype=float).reshape(len(ys), len(xs))
    # Local maxima (≥ every neighbour), on the padded grid so the border counts too
    pad = np.pad(z, 1, constant_values=-np.inf)
    neigh = np.stack([pad[1 + dy:1 + dy + z.shape[0], 1 + dx:1 + dx + z.shape[1]]
                      for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx])
    peaks = np.argwhere(z >= neigh.max(axis=0))
    order = sorted(peaks.tolist(), key=lambda rc: -z[rc[0], rc[1]])
    out: list[tuple[float, float, float]] = []
    for r, c in order:
        lat, lon = float(ys[r]), float(xs[c])
        if all(haversine(lat, lon, a, b) >= MIN_SPACING_M for a, b, _ in out):
            out.append((lat, lon, float(z[r, c])))
        if len(out) >= max_candidates - 1:
            break
    lon0 = sum(lons) / len(lons)
    centre = float(elevations.fetch_elevations([(lat0, lon0)])[0])
    out.append((lat0, lon0, centre))
    return out


def suggest_gateways(
    nodes: list[dict],
    gateway: dict,
    rf: net.RFSettings,
    elevations,
    has_4g: Optional[Callable[[list[tuple[float, float]]], list[Optional[str]]]] = None,
    max_gateways: int = 5,
    max_link_m: float = 8_000,
    progress: Optional[Callable[[float], None]] = None,
) -> dict:
    """
    Proposed gateways for the nodes. `gateway` is the template (model, height, ...); `has_4g`
    returns the 4G state at each candidate ("ok" / "edge" keep it, anything else drops it; None
    = no coverage data, every candidate kept).
    """
    proposals, unreachable, over_limit, dropped_no_4g, evaluated = [], [], [], 0, 0
    groups = groups_of(nodes)
    for gi, group in enumerate(groups):
        cands = high_points(group, elevations)
        states: list[Optional[str]] = [None] * len(cands)
        if has_4g:
            states = has_4g([(c[0], c[1]) for c in cands])
            keep = [i for i, st in enumerate(states) if st in ("ok", "edge")]
            dropped_no_4g += len(cands) - len(keep)
            cands, states = [cands[i] for i in keep], [states[i] for i in keep]
        # margin[c][node] for every pair within reach
        margins: list[dict[str, float]] = []
        for ci, (lat, lon, _) in enumerate(cands):
            gw = {**gateway, "name": "candidato", "lat": lat, "lon": lon}
            row = {}
            for nd in group:
                if haversine(lat, lon, nd["lat"], nd["lon"]) > max_link_m:
                    continue
                a = net.analyze_link(gw, nd, rf, api=elevations)
                evaluated += 1
                if a["result"].link_viable:
                    row[nd["name"]] = float(a["result"].link_margin_db)
            margins.append(row)
            if progress:
                progress((gi + (ci + 1) / max(len(cands), 1)) / len(groups))
        # Greedy: most nodes served, then the best worst margin
        left = {nd["name"] for nd in group}
        while left and len(proposals) < max_gateways:
            best, best_key = None, None
            for ci, row in enumerate(margins):
                served = {k: v for k, v in row.items() if k in left}
                if not served:
                    continue
                key = (len(served), min(served.values()))
                if best_key is None or key > best_key:
                    best, best_key = ci, key
            if best is None:
                break
            lat, lon, elev = cands[best]
            served = {k: v for k, v in margins[best].items() if k in left}
            proposals.append({
                "lat": round(lat, 6), "lon": round(lon, 6), "elevation_m": elev, "cell_state": states[best],
                "nodes": sorted(({"name": k, "margin_db": round(v, 1)} for k, v in served.items()),
                                key=lambda x: -x["margin_db"]),
                "min_margin_db": round(min(served.values()), 1),
            })
            left -= set(served)
        reachable = set().union(*margins) if margins else set()
        unreachable += sorted(left - reachable)
        over_limit += sorted(left & reachable)          # a gateway would reach them: limit reached
    return {"proposals": proposals, "unreachable": unreachable, "over_limit": over_limit,
            "candidates_without_4g": dropped_no_4g, "links_evaluated": evaluated}
