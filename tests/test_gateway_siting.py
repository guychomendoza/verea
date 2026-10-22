"""Gateway siting on a synthetic terrain: flat ground with one hill."""

import math

import numpy as np

from core import network as net
from core.gateway_siting import groups_of, high_points, suggest_gateways

HILL = (19.60, -103.30)


class HillDEM:
    """1000 m plain with a 120 m hill (Gaussian, ~800 m wide) at HILL."""
    source_name = "synthetic"

    def fetch_elevations(self, coords):
        out = []
        for lat, lon in coords:
            dy = (lat - HILL[0]) * 111_320
            dx = (lon - HILL[1]) * 111_320 * math.cos(math.radians(lat))
            out.append(1000 + 120 * math.exp(-(dx * dx + dy * dy) / (2 * 400 ** 2)))
        return np.round(np.array(out))


def node(name, dlat_m, dlon_m):
    return {"name": name, "lat": HILL[0] + dlat_m / 111_320,
            "lon": HILL[1] + dlon_m / (111_320 * math.cos(math.radians(HILL[0]))), "model": "dragino_se0x_lb"}


NODES = [node("A", 2500, 0), node("B", -2500, 0), node("C", 0, 2500), node("D", 0, -2500)]
GW = {"model": "milesight_sg50", "height": 6.0}
RF = net.RFSettings.from_project({"propagation_model": "itm"})


def test_groups_by_distance():
    far = node("Z", 40_000, 0)
    assert sorted(len(g) for g in groups_of(NODES + [far])) == [1, 4]


def test_high_points_find_the_hill_first():
    lat, lon, elev = high_points(NODES, HillDEM())[0]
    assert abs(lat - HILL[0]) * 111_320 < 300 and elev >= 1110


def test_one_gateway_on_the_hill_serves_everyone():
    out = suggest_gateways(NODES, GW, RF, HillDEM(), max_gateways=3)
    assert len(out["proposals"]) == 1 and not out["unreachable"]
    p = out["proposals"][0]
    assert {n["name"] for n in p["nodes"]} == {"A", "B", "C", "D"}
    assert math.hypot((p["lat"] - HILL[0]) * 111_320, (p["lon"] - HILL[1]) * 105_000) < 400


def test_candidates_without_4g_are_dropped():
    # No 4G anywhere: nothing can be proposed
    out = suggest_gateways(NODES, GW, RF, HillDEM(), has_4g=lambda pts: ["none"] * len(pts))
    assert out["proposals"] == [] and out["candidates_without_4g"] > 0
    assert sorted(out["unreachable"]) == ["A", "B", "C", "D"]


def test_limit_leaves_nodes_pending():
    far = [node("Z1", 60_000, 0), node("Z2", 60_300, 0)]
    out = suggest_gateways(NODES + far, GW, RF, HillDEM(), max_gateways=1)
    assert len(out["proposals"]) == 1
    assert set(out["over_limit"]) | set(out["unreachable"]) == {"Z1", "Z2"}
