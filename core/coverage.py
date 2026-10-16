"""
Coverage / Maximum Range
========================
Walks a radial from a gateway over the real terrain and evaluates the
link budget at every sample, so we can tell how far the signal actually
reaches in a given direction — including dead spots behind ridges and
hilltops that recover further out.

A coverage map is the same calculation repeated for N bearings.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import copy
from dataclasses import dataclass
from typing import Optional

import numpy as np

from config import EARTH_RADIUS
from core.devices import Gateway, EndNode
from core.terrain import TerrainProfile, ElevationAPI
from core.link_budget import calculate_link_budget

MIN_RADIAL_DISTANCE_M = 100.0


def destination_point(lat: float, lon: float, bearing_deg: float, distance_m: float) -> tuple[float, float]:
    """Point reached travelling distance_m from (lat, lon) on a great circle."""
    phi1, lam1, theta = np.radians(lat), np.radians(lon), np.radians(bearing_deg)
    delta = distance_m / EARTH_RADIUS
    phi2 = np.arcsin(np.sin(phi1) * np.cos(delta) + np.cos(phi1) * np.sin(delta) * np.cos(theta))
    lam2 = lam1 + np.arctan2(np.sin(theta) * np.sin(delta) * np.cos(phi1),
                             np.cos(delta) - np.sin(phi1) * np.sin(phi2))
    return float(np.degrees(phi2)), float((np.degrees(lam2) + 540) % 360 - 180)


def initial_bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Initial great-circle bearing (degrees, 0 = north) from point 1 to point 2."""
    phi1, phi2 = np.radians(lat1), np.radians(lat2)
    dlam = np.radians(lon2 - lon1)
    x = np.sin(dlam) * np.cos(phi2)
    y = np.cos(phi1) * np.sin(phi2) - np.sin(phi1) * np.cos(phi2) * np.cos(dlam)
    return float((np.degrees(np.arctan2(x, y)) + 360) % 360)


@dataclass
class RadialResult:
    """Link budget evaluated along one bearing from a gateway."""
    bearing_deg: float
    distances_m: np.ndarray       # sample distances from the gateway
    coordinates: list             # (lat, lon) per sample
    margins_db: np.ndarray        # link margin per sample (NaN where not evaluated)
    viable: np.ndarray            # bool per sample
    elevation_source: str = "unknown"

    @property
    def continuous_range_m(self) -> float:
        """Distance up to the first dead spot (uninterrupted coverage)."""
        evaluated = ~np.isnan(self.margins_db)
        dead = evaluated & ~self.viable
        if not dead.any():
            return float(self.distances_m[evaluated][-1]) if evaluated.any() else 0.0
        first = int(np.argmax(dead))
        return float(self.distances_m[first - 1]) if first > 0 else 0.0

    @property
    def max_range_m(self) -> float:
        """Farthest viable point (signal may reappear on hilltops past a dead spot)."""
        if not self.viable.any():
            return 0.0
        return float(self.distances_m[np.where(self.viable)[0][-1]])

    @property
    def reaches_end(self) -> bool:
        """Signal still present at the last checked point (real range is longer)."""
        evaluated = np.where(~np.isnan(self.margins_db))[0]
        return bool(len(evaluated) and self.viable[evaluated[-1]])

    @property
    def first_dead_spot_m(self) -> Optional[float]:
        evaluated = ~np.isnan(self.margins_db)
        dead = evaluated & ~self.viable
        return float(self.distances_m[int(np.argmax(dead))]) if dead.any() else None


def compute_radial(
    gateway: Gateway,
    node_template: EndNode,
    bearing_deg: float,
    max_distance_m: float,
    n_points: int = 100,
    api: Optional[ElevationAPI] = None,
    terrain: Optional[TerrainProfile] = None,
    **budget_kwargs,
) -> RadialResult:
    """
    Evaluate the uplink (node → gateway) at every sample along a bearing.

    The node is placed at each sample with the template's TX power, SF and
    antenna; budget_kwargs go to calculate_link_budget (environment,
    margin_threshold, fading_margin_db, propagation_model, ...).
    A pre-fetched terrain profile (GW → radial end) can be passed to avoid
    another elevation request.
    """
    if terrain is None:
        end_lat, end_lon = destination_point(gateway.lat, gateway.lon, bearing_deg, max_distance_m)
        terrain = TerrainProfile.from_coordinates(
            gateway.lat, gateway.lon, end_lat, end_lon, n_points=n_points, api=api,
        )

    n = len(terrain.elevations)
    margins = np.full(n, np.nan)
    viable = np.zeros(n, dtype=bool)

    gw = copy.deepcopy(gateway)
    gw.altitude_m = float(terrain.elevations[0])

    for k in range(1, n):
        if terrain.distances[k] < MIN_RADIAL_DISTANCE_M:
            continue
        sub = TerrainProfile(
            lat1=terrain.lat1, lon1=terrain.lon1,
            lat2=terrain.coordinates[k][0], lon2=terrain.coordinates[k][1],
            elevations=terrain.elevations[:k + 1],
            distances=terrain.distances[:k + 1],
            coordinates=terrain.coordinates[:k + 1],
            n_points=k + 1,
            elevation_source=terrain.elevation_source,
        )
        node = copy.deepcopy(node_template)
        node.lat, node.lon = terrain.coordinates[k]
        node.altitude_m = float(terrain.elevations[k])
        result = calculate_link_budget(gw, node, sub, **budget_kwargs)
        margins[k] = result.link_margin_db
        viable[k] = result.link_viable

    return RadialResult(
        bearing_deg=bearing_deg,
        distances_m=terrain.distances.copy(),
        coordinates=list(terrain.coordinates),
        margins_db=margins,
        viable=viable,
        elevation_source=terrain.elevation_source,
    )


def compute_coverage(
    gateway: Gateway,
    node_template: EndNode,
    max_distance_m: float,
    n_radials: int = 24,
    n_points: int = 100,
    api: Optional[ElevationAPI] = None,
    progress=None,
    **budget_kwargs,
) -> list[RadialResult]:
    """Coverage map: one radial every 360/n_radials degrees."""
    radials = []
    for i in range(n_radials):
        bearing = i * 360.0 / n_radials
        radials.append(compute_radial(
            gateway, node_template, bearing, max_distance_m,
            n_points=n_points, api=api, **budget_kwargs,
        ))
        if progress:
            progress((i + 1) / n_radials)
    return radials


def viable_segments(radial: RadialResult) -> list[tuple[bool, list]]:
    """Split a radial into consecutive (viable, [(lat, lon), ...]) runs for drawing."""
    segments = []
    evaluated = np.where(~np.isnan(radial.margins_db))[0]
    if len(evaluated) == 0:
        return segments
    current = bool(radial.viable[evaluated[0]])
    pts = [radial.coordinates[0], radial.coordinates[evaluated[0]]]
    for k in evaluated[1:]:
        v = bool(radial.viable[k])
        if v != current:
            segments.append((current, pts))
            pts = [pts[-1]]
            current = v
        pts.append(radial.coordinates[k])
    segments.append((current, pts))
    return segments
