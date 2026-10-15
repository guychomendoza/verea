"""
Geographic Utilities
====================
Haversine distance, earth curvature compensation, coordinate interpolation.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np
from config import EARTH_RADIUS, EFFECTIVE_EARTH_K


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Calculate great-circle distance between two GPS points.

    Returns distance in meters.
    """
    lat1, lon1, lat2, lon2 = map(np.radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = np.sin(dlat / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS * np.arcsin(np.sqrt(a))


def interpolate_coordinates(
    lat1: float, lon1: float,
    lat2: float, lon2: float,
    n_points: int
) -> list[tuple[float, float]]:
    """
    Generate n_points evenly spaced coordinates along the path.
    For short distances (<100 km), linear interpolation is sufficient.
    """
    lats = np.linspace(lat1, lat2, n_points)
    lons = np.linspace(lon1, lon2, n_points)
    return list(zip(lats.tolist(), lons.tolist()))


def earth_curvature_offset(d1: float, d2: float, k: float = EFFECTIVE_EARTH_K) -> float:
    """
    Calculate the effective earth bulge at a point between TX and RX.

    h = (d1 * d2) / (2 * k * R_earth)
    At 10 km total distance, midpoint bulge ≈ 1.47 m (k=4/3).
    """
    return (d1 * d2) / (2 * k * EARTH_RADIUS)


def los_height_at_point(
    h_tx: float, h_rx: float,
    d_total: float, d_point: float
) -> float:
    """
    Calculate the LOS height at a given distance from TX.
    Simple linear interpolation between TX and RX antenna heights.
    """
    if d_total == 0:
        return h_tx
    fraction = d_point / d_total
    return h_tx + (h_rx - h_tx) * fraction
