"""
Cell Signal Estimate
====================
Estimated 4G signal (RSRP) at a sensor from the nearest operator sites
(core/towers.py) and the terrain engine, calibrated against the operator's own
declared coverage.

The absolute power of a site is unknown (sector, tilt, band, real mast position),
so it is not guessed: along the radial from the site through the sensor, every
place where the declared coverage ends going outward is where the operator's own
model puts the signal at the coverage threshold. The offset that makes our model
agree there is applied at the sensor. What the terrain model contributes is the
shape: how fast the signal falls around the sensor (flat ground: slowly, so the
declared edge is uncertain by hundreds of metres; behind a ridge: tens of dB in
a few metres).

The result is a probability of service with the usual location variability
(SIGMA_DB), for phone LTE and for LTE-M / NB-IoT, which reach further.
"""

import math
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from core.coverage import destination_point, initial_bearing
from core.propagation import fspl, itm_path_loss, short_path_excess_loss
from core.towers import Tower, TowerIndex
from utils.geo import interpolate_coordinates

FREQ_HZ = 1.9e9                  # LTE bands 2 / 4 / 66 (1.7-2.1 GHz) used in Mexico
TOWER_AGL_M = 30.0
SENSOR_AGL_M = 1.5
NOMINAL_RS_EIRP_DBM = 30.0       # per resource element, only used without calibration
SIGMA_DB = 8.0                   # location variability (shadowing) around the model
DEFAULT_THRESHOLD_DBM = -100.0   # declared coverage level when the file has none
EXTRA_DB = {"LTE": 0.0, "LTE-M": 15.0, "NB-IoT": 20.0}   # link budget over phone LTE
SEARCH_RADIUS_M = 15_000
CANDIDATES = 4                   # nearest sites compared at the sensor
BEYOND_M = 2_000                 # radial continues past the sensor (edges beyond it)
STEP_M = 90.0                    # one sample per DEM cell
MAX_POINTS = 400
GRADIENT_WINDOW_M = 300
MAX_OFFSET_DB = 25.0             # beyond this the site is probably not the serving one


@dataclass
class CellSignal:
    tower: Tower
    distance_m: float
    rsrp_dbm: Optional[float]            # calibrated estimate at the sensor (None: not calibrated)
    threshold_dbm: float                 # declared coverage level
    offset_db: Optional[float]           # applied to the nominal model
    calibrated: bool                     # a declared edge bounds the sensor's area on the radial
    covered: bool                        # declared coverage at the sensor
    edge_m: Optional[float]              # distance sensor -> calibration edge along the radial
    gradient_db_per_100m: float          # signal drop per 100 m moving away from the site
    probability: dict = field(default_factory=dict)   # tech -> P(service) 0-1 (empty: not calibrated)
    elevation_source: str = ""

    @property
    def edge_uncertainty_m(self) -> Optional[float]:
        """How far the coverage edge can move for SIGMA_DB of model error."""
        g = abs(self.gradient_db_per_100m) / 100
        return SIGMA_DB / g if g > 1e-4 else None


def _phi(z: float) -> float:
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def path_loss_db(elevations: np.ndarray, distance_m: float) -> float:
    """Basic transmission loss site -> sensor over the profile (ITM, short-path model below 1 km)."""
    d = max(distance_m, 30.0)
    loss = itm_path_loss(elevations, d, TOWER_AGL_M, SENSOR_AGL_M, FREQ_HZ)
    if loss is None:
        loss = fspl(d, FREQ_HZ) + short_path_excess_loss(elevations, d, TOWER_AGL_M, SENSOR_AGL_M, FREQ_HZ)
    return float(loss)


class Radial:
    """Terrain from a site through the sensor and BEYOND_M past it."""

    def __init__(self, tower: Tower, lat: float, lon: float, api):
        self.tower = tower
        self.distance_m = _distance(tower.lat, tower.lon, lat, lon)
        bearing = initial_bearing(tower.lat, tower.lon, lat, lon)
        end = destination_point(lat, lon, bearing, BEYOND_M)
        length = self.distance_m + BEYOND_M
        n = int(min(max(math.ceil(length / STEP_M) + 1, 30), MAX_POINTS))
        self.coords = interpolate_coordinates(tower.lat, tower.lon, end[0], end[1], n)
        self.x = np.linspace(0, length, n)
        self.elevations = np.concatenate([api.fetch_elevations(self.coords[i:i + 100])
                                          for i in range(0, n, 100)])
        self.source = getattr(api, "source_name", "")
        self.sensor_i = int(round(self.distance_m / length * (n - 1)))
        self._loss: dict = {}

    def loss(self, i: int) -> float:
        if i not in self._loss:
            self._loss[i] = path_loss_db(self.elevations[:i + 1], self.x[i])
        return self._loss[i]

    def signal(self, i: int, offset_db: float = 0.0) -> float:
        return NOMINAL_RS_EIRP_DBM + offset_db - self.loss(max(i, 1))


def _distance(lat1, lon1, lat2, lon2) -> float:
    kx = 111_320 * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot((lat2 - lat1) * 111_320, (lon2 - lon1) * kx)


def calibration_edge(covered: np.ndarray, x: np.ndarray, sensor_i: int,
                     min_x: float = 500.0) -> Optional[int]:
    """
    Sample i where declared coverage ends (i covered, i+1 not) that bounds the sensor's
    own area: the first one past a covered sensor, the last one before an uncovered
    sensor. Edges on the other side belong to other islands, often other sites.
    """
    idx = [int(i) for i in np.where(covered[:-1] & ~covered[1:])[0] if x[i] >= min_x]
    if covered[sensor_i]:
        beyond = [i for i in idx if i >= sensor_i]
        return beyond[0] if beyond else None
    before = [i for i in idx if i < sensor_i]
    return before[-1] if before else None


def estimate(lat: float, lon: float, operator: str, source, towers: TowerIndex, api,
             threshold_dbm: Optional[float] = None) -> Optional[CellSignal]:
    """
    Best-server signal estimate at (lat, lon), calibrated on the declared coverage of
    `source` (a core.cellular.CoverageSource). None when there is no site within
    SEARCH_RADIUS_M.
    """
    near = towers.nearest(operator, lat, lon, SEARCH_RADIUS_M, limit=CANDIDATES)
    if not near:
        return None
    thr = DEFAULT_THRESHOLD_DBM if threshold_dbm is None else threshold_dbm

    results = []
    for tower, _ in near:
        r = Radial(tower, lat, lon, api)
        lats = np.array([c[0] for c in r.coords])
        lons = np.array([c[1] for c in r.coords])
        covered = source.covered_at(lats, lons)
        edge = calibration_edge(covered, r.x, r.sensor_i)
        s_nominal = r.signal(r.sensor_i)
        offset, calibrated = 0.0, edge is not None
        if calibrated:
            # Edge between sample i (covered) and i+1: the model there equals the threshold
            offset = thr - (r.signal(edge) + r.signal(edge + 1)) / 2
        # Too large an offset: the edge is probably another site's, not this one's
        calibrated = calibrated and abs(offset) <= MAX_OFFSET_DB
        edge_m = abs(r.x[edge] + (r.x[1] - r.x[0]) / 2 - r.distance_m) if calibrated else None
        results.append((calibrated, s_nominal + offset if calibrated else -math.inf, r,
                        offset if calibrated else None, edge_m, bool(covered[r.sensor_i])))

    # Best server: the strongest calibrated site (else the nearest, for its terrain gradient)
    calibrated, rsrp, r, offset, edge_m, cov = max(results, key=lambda t: (t[0], t[1]))
    if not calibrated:
        calibrated, rsrp, r, offset, edge_m, cov = results[0]
        rsrp = None
    w = max(1, int(round(GRADIENT_WINDOW_M / (r.x[1] - r.x[0]))))
    idx = [i for i in range(r.sensor_i - w, r.sensor_i + w + 1) if 1 <= i < len(r.x)]
    slope = np.polyfit(r.x[idx], [r.signal(i) for i in idx], 1)[0] if len(idx) >= 3 else 0.0
    prob = ({tech: _phi((rsrp - (thr - extra)) / SIGMA_DB) for tech, extra in EXTRA_DB.items()}
            if calibrated else {})
    return CellSignal(r.tower, r.distance_m, rsrp, thr, offset, calibrated, cov, edge_m,
                      -float(slope) * 100, prob, r.source)
