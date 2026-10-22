"""Tests for core/towers.py and core/cell_signal.py with synthetic terrain and coverage."""

import gzip
import math

import numpy as np
import pytest

from core.cell_signal import SIGMA_DB, calibration_edge, estimate
from core.towers import Tower, TowerIndex, read_opencellid, sites_from_cells

SITE = (20.50, -100.80)
KX = 111_320 * math.cos(math.radians(SITE[0]))


class FlatAPI:
    source_name = "test"

    def __init__(self, ridge_lon=None):
        self.ridge_lon = ridge_lon
        self.calls = 0

    def fetch_elevations(self, coords):
        self.calls += 1
        assert len(coords) <= 100
        z = np.full(len(coords), 1800.0)
        if self.ridge_lon is not None:
            lons = np.array([c[1] for c in coords])
            z += 120 * np.exp(-((lons - self.ridge_lon) * KX / 150) ** 2)
        return z


class DiskCoverage:
    """Declared coverage: everything within radius_m of the site."""

    def __init__(self, radius_m):
        self.radius_m = radius_m

    def covered_at(self, lats, lons):
        d = np.hypot((np.asarray(lats) - SITE[0]) * 111_320, (np.asarray(lons) - SITE[1]) * KX)
        return d <= self.radius_m


def point_east(m):
    return SITE[0], SITE[1] + m / KX


@pytest.fixture
def towers():
    return TowerIndex([Tower("Telcel", 1, *SITE, 3, 100), Tower("AT&T", 2, 20.6, -100.8, 1, 5)])


def test_sites_from_cells(tmp_path):
    rows = [
        "LTE,334,20,100,2561,0,-100.801,20.501,1000,10,1,0,0,0",   # eNB 10
        "LTE,334,20,100,2562,0,-100.799,20.499,1000,5,1,0,0,0",    # eNB 10
        "LTE,334,20,100,2563,0,-100.900,20.600,1000,5,1,0,0,0",    # eNB 10, outlier
        "LTE,334,50,100,2561,0,-101.0,21.0,1000,5,1,0,0,0",        # AT&T
        "GSM,334,20,100,2561,0,-101.0,21.0,1000,5,1,0,0,0",        # not LTE
        "LTE,310,20,100,2561,0,-101.0,21.0,1000,5,1,0,0,0",        # not Mexico
    ]
    path = tmp_path / "334.csv.gz"
    with gzip.open(path, "wt") as f:
        f.write("\n".join(rows) + "\n")
    sites = sites_from_cells(read_opencellid(path))
    telcel = [s for s in sites if s.operator == "Telcel"]
    assert len(sites) == 2 and len(telcel) == 1
    assert (telcel[0].site, telcel[0].cells, telcel[0].samples) == (10, 3, 20)
    assert telcel[0].lat == pytest.approx(20.501) and telcel[0].lon == pytest.approx(-100.801)


def test_nearest(towers):
    near = towers.nearest("Telcel", *point_east(2000), radius_m=5000)
    assert len(near) == 1 and near[0][1] == pytest.approx(2000, rel=0.01)
    assert towers.nearest("Telcel", *point_east(9000), radius_m=5000) == []
    assert towers.nearest("Altán", *SITE, radius_m=5000) == []


def test_calibration_edge_bounds_the_sensor_area():
    cov = np.array([1, 1, 1, 0, 0, 1, 1, 1, 0, 0], dtype=bool)
    x = np.arange(10) * 1000.0
    assert calibration_edge(cov, x, sensor_i=5) == 7        # covered: first edge beyond
    assert calibration_edge(cov, x, sensor_i=4) == 2        # uncovered: last edge before
    assert calibration_edge(cov, x, sensor_i=9) == 7
    assert calibration_edge(np.ones(10, bool), x, sensor_i=5) is None


def test_calibrated_on_the_declared_edge(towers):
    """At the declared edge the estimate is the threshold; inside it is higher, outside lower."""
    src = DiskCoverage(4000)
    at_edge = estimate(*point_east(4000), "Telcel", src, towers, FlatAPI())
    inside = estimate(*point_east(3500), "Telcel", src, towers, FlatAPI())
    outside = estimate(*point_east(4600), "Telcel", src, towers, FlatAPI())
    assert at_edge.calibrated and at_edge.edge_m < 100
    assert inside.edge_m == pytest.approx(500, abs=100)
    assert at_edge.rsrp_dbm == pytest.approx(-100, abs=1.5)
    assert inside.rsrp_dbm > -100 > outside.rsrp_dbm
    assert inside.probability["LTE"] > 0.5 > outside.probability["LTE"]
    assert outside.probability["NB-IoT"] > outside.probability["LTE-M"] > outside.probability["LTE"]
    # Flat ground: the signal falls slowly, so the edge is uncertain by hundreds of metres
    assert 0.05 < at_edge.gradient_db_per_100m < 2
    assert at_edge.edge_uncertainty_m > 400


def test_ridge_makes_a_sharp_edge(towers):
    """Just behind a ridge the signal drops fast: the edge is certain within tens of metres."""
    ridge = SITE[1] + 3000 / KX
    # The operator's coverage ends at the ridge top; the sensor is 100 m behind it
    est = estimate(*point_east(3100), "Telcel", DiskCoverage(3000), towers, FlatAPI(ridge))
    flat = estimate(*point_east(3100), "Telcel", DiskCoverage(3000), towers, FlatAPI())
    assert est.calibrated and est.probability["LTE"] < flat.probability["LTE"]
    assert est.gradient_db_per_100m > 3 * flat.gradient_db_per_100m
    assert est.edge_uncertainty_m < flat.edge_uncertainty_m


def test_no_edge_no_numbers(towers):
    """Coverage continues past the radial: no calibration, so no RSRP or probabilities."""
    est = estimate(*point_east(2000), "Telcel", DiskCoverage(50_000), towers, FlatAPI())
    assert not est.calibrated and est.covered and est.rsrp_dbm is None and est.probability == {}
    assert est.gradient_db_per_100m > 0
    assert estimate(*point_east(20_000), "Telcel", DiskCoverage(1), towers, FlatAPI()) is None


def test_profile_requests_stay_within_api_limit(towers):
    api = FlatAPI()
    estimate(*point_east(12_000), "Telcel", DiskCoverage(10_000), towers, api)
    assert api.calls >= 2
