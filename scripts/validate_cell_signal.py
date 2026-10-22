"""
Validate core.cell_signal against the declared coverage map (leave-out test).

For random points near declared coverage edges, the model is fitted on each site
radial leaving out EXCLUDE_M around the point, and predicts whether the map
declares the point covered. It is compared (Brier score, lower is better) with a
model-free baseline: the covered share of the same radial within 1.5 km of the
point, outside the left-out window.

    python scripts/validate_cell_signal.py [points per area]

Needs data/coverage/towers_mx.csv (scripts/get_towers.py) and the local DEM
(scripts/build_relief.py). Result on 2026-10-21 (Telcel, 40 points per area):

    area             model   baseline   (Brier)
    Aguascalientes   0.163   0.151
    Jalisco hills    0.155   0.114
    Bajío flat       0.143   0.089

The terrain model beats a distance-only one (0.185 / 0.206 in the hills / flat)
but not the map's own neighbourhood: with approximate site positions and no
sectors it cannot add to what the operator published, so the app does not show
it. Run again with better site data or field RSSI.
"""

import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import core.cell_signal as cs  # noqa: E402
from core.cellular import find_sources  # noqa: E402
from core.dem import LocalDEM  # noqa: E402
from core.towers import TowerIndex  # noqa: E402

EXCLUDE_M = 300
BASELINE_M = 1_500
AREAS = {"Aguascalientes": (21.15, -102.5), "Jalisco hills": (20.45, -103.75),
         "Bajío flat": (20.40, -101.0)}           # SW corner of a 0.35° square


def near_edge(hit) -> bool:
    return ((hit.covered and hit.edge_m is not None)
            or (not hit.covered and hit.nearest_m is not None and hit.nearest_m < BASELINE_M))


def predict(lat, lon, src, towers, dem):
    """(P model, P baseline) for the strongest fitted site, or None."""
    best = None
    for tower, _ in towers.nearest("Telcel", lat, lon, cs.SEARCH_RADIUS_M, limit=cs.CANDIDATES):
        r = cs.Radial(tower, lat, lon, dem)
        cov = src.covered_at(np.array([c[0] for c in r.coords]), np.array([c[1] for c in r.coords]))
        fit = cs.site_estimate(r, cov, cs.DEFAULT_THRESHOLD_DBM, EXCLUDE_M)
        if not fit or abs(fit[0]) > cs.MAX_OFFSET_DB:
            continue
        s = r.signal(r.sensor_i, fit[0])
        ring = [i for i in range(len(r.x)) if EXCLUDE_M <= abs(r.x[i] - r.distance_m) <= BASELINE_M]
        base = float(cov[ring].mean()) if ring else 0.5
        if best is None or s > best[0]:
            best = (s, cs._phi((s - cs.DEFAULT_THRESHOLD_DBM) / fit[1]), base)
    return best[1:] if best else None


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 40
    src = find_sources(ROOT / "data" / "coverage")[0]
    towers, dem = TowerIndex.load(), LocalDEM.open()
    if towers is None or dem is None:
        print("Needs towers_mx.csv (scripts/get_towers.py) and data/dem (scripts/build_relief.py).")
        return 1
    for name, (lat0, lon0) in AREAS.items():
        rng, rows, t0 = np.random.default_rng(3), [], time.time()
        for _ in range(4000):
            if len(rows) >= n:
                break
            lat, lon = lat0 + rng.random() * 0.35, lon0 + rng.random() * 0.35
            hit = src.status_at(lat, lon)
            if near_edge(hit) and (p := predict(lat, lon, src, towers, dem)):
                rows.append((float(hit.covered), *p))
        y, pm, pb = (np.array(c) for c in zip(*rows))
        print(f"{name}: n={len(rows)} ({time.time() - t0:.0f}s)  Brier model {np.mean((pm - y) ** 2):.3f}"
              f"  baseline {np.mean((pb - y) ** 2):.3f}  (coin 0.250)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
