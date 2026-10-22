"""
Cell Signal Estimate
====================
Estimated 4G signal (RSRP) at a sensor from the nearest operator sites
(core/towers.py) and the terrain engine, calibrated against the operator's own
declared coverage.

The absolute power of a site is unknown (sector, tilt, band, real mast position),
so it is not guessed. Along the radial from the site through the sensor, the
declared map says, sample by sample, whether the operator's own model puts the
signal above its coverage threshold. Our model is fitted to those answers as a
probit: P(covered) = Φ((S + offset − threshold) / σ), by maximum likelihood over
offset and σ. The offset absorbs the unknown site power; σ says how well the
terrain explains the map along that path (small: sharp, terrain-driven edges;
large: the map follows things the 90 m DEM does not see, such as trees and
buildings, and the estimate is correspondingly vague).

The result is a probability of service for phone LTE and for LTE-M / NB-IoT,
which work with weaker signal, plus how fast the signal changes around the sensor.

Not shown in the app: scripts/validate_cell_signal.py found it does not predict
the declared map better than the map's own neighbourhood. Kept for field RSSI.
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
MAX_OFFSET_DB = 30.0             # beyond this the site is probably not the serving one
FIT_FROM_M = 500                 # radial samples used for the fit start here
MIN_CLASS_SAMPLES = 3            # covered and uncovered samples needed to fit
FIT_OFFSETS = np.arange(-60.0, 60.5, 0.5)
FIT_SIGMAS = np.array([2.0, 3.0, 4.0, 6.0, 8.0, 11.0, 15.0, 20.0])


@dataclass
class CellSignal:
    tower: Tower
    distance_m: float
    rsrp_dbm: Optional[float]            # calibrated estimate at the sensor (None: not calibrated)
    threshold_dbm: float                 # declared coverage level
    offset_db: Optional[float]           # applied to the nominal model
    calibrated: bool                     # the radial had covered and uncovered samples to fit
    covered: bool                        # declared coverage at the sensor
    sigma_db: Optional[float]            # fitted spread: how well terrain explains the map
    gradient_db_per_100m: float          # signal drop per 100 m moving away from the site
    probability: dict = field(default_factory=dict)   # tech -> P(service) 0-1 (empty: not calibrated)
    elevation_source: str = ""

    @property
    def edge_uncertainty_m(self) -> Optional[float]:
        """How far the coverage edge can move for one σ of model error."""
        g = abs(self.gradient_db_per_100m) / 100
        sigma = max(self.sigma_db or SIGMA_DB, SIGMA_DB)
        return sigma / g if g > 1e-4 else None


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


def fit_probit(signal: np.ndarray, covered: np.ndarray, threshold: float
               ) -> Optional[tuple[float, float]]:
    """
    (offset, σ) maximising the likelihood of the declared coverage given the model
    signal, P(covered) = Φ((signal + offset − threshold) / σ). None without enough
    covered and uncovered samples.
    """
    covered = np.asarray(covered, dtype=bool)
    if covered.sum() < MIN_CLASS_SAMPLES or (~covered).sum() < MIN_CLASS_SAMPLES:
        return None
    # Logistic approximation of Φ (max error 0.01), vectorised over the whole grid
    z = (signal[None, None, :] + FIT_OFFSETS[:, None, None] - threshold) / FIT_SIGMAS[None, :, None]
    t = 1.702 * z
    log_p = -np.logaddexp(0, -t)          # log Φ
    log_q = -np.logaddexp(0, t)           # log (1 − Φ)
    ll = np.where(covered[None, None, :], log_p, log_q).sum(axis=2)
    i, j = np.unravel_index(int(np.argmax(ll)), ll.shape)
    return float(FIT_OFFSETS[i]), float(FIT_SIGMAS[j])


def site_estimate(r: "Radial", covered: np.ndarray, thr: float, exclude_m: float = 0.0):
    """
    Fit along one radial: (offset, σ) or None. Samples within exclude_m of the sensor
    are left out (used to validate the method against the declared map).
    """
    step = max(1, len(r.x) // 200)                     # ≤ ~200 model evaluations
    idx = [i for i in range(1, len(r.x), step)
           if r.x[i] >= FIT_FROM_M and abs(r.x[i] - r.distance_m) >= exclude_m]
    if not idx:
        return None
    sig = np.array([r.signal(i) for i in idx])
    return fit_probit(sig, covered[idx], thr)


def estimate(lat: float, lon: float, operator: str, source, towers: TowerIndex, api,
             threshold_dbm: Optional[float] = None, exclude_m: float = 0.0) -> Optional[CellSignal]:
    """
    Best-server signal estimate at (lat, lon), fitted to the declared coverage of
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
        fit = site_estimate(r, covered, thr, exclude_m)
        if fit is not None and abs(fit[0]) > MAX_OFFSET_DB:
            fit = None                                  # probably not this site's footprint
        rsrp = r.signal(r.sensor_i, fit[0]) if fit else -math.inf
        results.append((fit is not None, rsrp, r, fit, bool(covered[r.sensor_i])))

    # Best server: the strongest fitted site (else the nearest, for its terrain gradient)
    calibrated, rsrp, r, fit, cov = max(results, key=lambda t: (t[0], t[1]))
    if not calibrated:
        calibrated, rsrp, r, fit, cov = results[0]
    w = max(1, int(round(GRADIENT_WINDOW_M / (r.x[1] - r.x[0]))))
    idx = [i for i in range(r.sensor_i - w, r.sensor_i + w + 1) if 1 <= i < len(r.x)]
    slope = np.polyfit(r.x[idx], [r.signal(i) for i in idx], 1)[0] if len(idx) >= 3 else 0.0
    prob = {}
    if calibrated:
        sigma = max(fit[1], SIGMA_DB)
        prob = {tech: _phi((rsrp - (thr - extra)) / sigma) for tech, extra in EXTRA_DB.items()}
    return CellSignal(r.tower, r.distance_m, rsrp if calibrated else None, thr,
                      fit[0] if calibrated else None, calibrated, cov,
                      fit[1] if calibrated else None, -float(slope) * 100, prob, r.source)
