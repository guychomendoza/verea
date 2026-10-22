"""
Terrain Module
==============
Elevation data acquisition and terrain profile analysis.
Multi-source elevation API cascade:
  1. Open-Meteo (Copernicus DEM 90m) — primary
  2. OpenTopoData (SRTM 30m) — fallback
  3. Flat terrain at 1500m ASL — last resort
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from dataclasses import dataclass, field
from typing import Optional
import numpy as np
import requests

from config import (
    OPEN_METEO_ELEVATION_URL,
    OPENTOPODATA_ELEVATION_URL,
    TERRAIN_SAMPLE_POINTS,
    MAX_ELEVATION_POINTS,
    MAX_PROFILE_POINTS,
    EFFECTIVE_EARTH_K,
    MIN_FRESNEL_CLEARANCE_PCT,
    FLAT_TERRAIN_ELEVATION_M,
)
from utils.geo import (
    haversine,
    interpolate_coordinates,
    earth_curvature_offset,
    los_height_at_point,
)
from utils.rf import wavelength
from core.propagation import fresnel_obstruction_loss


# Module-level flag to print fallback warning only once
_flat_terrain_warned = False


def link_samples(distance_m: float) -> int:
    """
    Elevation points for a link: about one per 90 m DEM cell (coarser samples miss
    ridges: up to ±10 dB on long links), between 30 and MAX_PROFILE_POINTS.
    """
    return int(min(max(np.ceil(distance_m / 90.0) + 1, 30), MAX_PROFILE_POINTS))


class ElevationAPI:
    """
    Multi-source elevation data client with automatic failover.

    Cascade order:
    1. Open-Meteo API (Copernicus DEM 90m) — fast, reliable, batched GET
    2. OpenTopoData API (SRTM 30m) — good accuracy, rate-limited
    3. Flat terrain at 1500m ASL — last resort when offline

    Caches the working source to avoid retrying failed APIs.
    """

    def __init__(self, timeout: int = 15):
        self.timeout = timeout
        self._working_source = None  # Cache which API works
        self._source_name = "unknown"

    @property
    def source_name(self) -> str:
        """Name of the elevation data source currently in use."""
        return self._source_name

    def fetch_elevations(self, coordinates: list[tuple[float, float]]) -> np.ndarray:
        """
        Query elevation for a list of (lat, lon) pairs.
        Tries each source in cascade order.
        """
        # If we already know which source works, try it first
        if self._working_source == "open_meteo":
            result = self._try_open_meteo(coordinates)
            if result is not None:
                return result
        elif self._working_source == "opentopodata":
            result = self._try_opentopodata(coordinates)
            if result is not None:
                return result

        # Full cascade
        result = self._try_open_meteo(coordinates)
        if result is not None:
            self._working_source = "open_meteo"
            return result

        result = self._try_opentopodata(coordinates)
        if result is not None:
            self._working_source = "opentopodata"
            return result

        # Last resort: flat terrain
        return self._flat_terrain_fallback(len(coordinates))

    def _try_open_meteo(self, coordinates: list[tuple[float, float]]) -> Optional[np.ndarray]:
        """
        Open-Meteo Elevation API (Copernicus DEM 90m).
        Uses batched GET request with comma-separated coordinates.
        """
        try:
            lats = ",".join(f"{lat:.6f}" for lat, _ in coordinates)
            lons = ",".join(f"{lon:.6f}" for _, lon in coordinates)

            response = requests.get(
                OPEN_METEO_ELEVATION_URL,
                params={"latitude": lats, "longitude": lons},
                timeout=self.timeout,
            )
            response.raise_for_status()
            data = response.json()
            elevations = data.get("elevation", [])

            if len(elevations) == len(coordinates):
                self._source_name = "Open-Meteo (Copernicus DEM 90m)"
                return np.array(elevations, dtype=np.float64)
            return None

        except (requests.RequestException, KeyError, ValueError, TypeError):
            return None

    def _try_opentopodata(self, coordinates: list[tuple[float, float]]) -> Optional[np.ndarray]:
        """
        OpenTopoData API (SRTM 30m).
        Uses pipe-separated coordinate pairs.
        """
        try:
            locations = "|".join(f"{lat:.6f},{lon:.6f}" for lat, lon in coordinates)

            response = requests.get(
                OPENTOPODATA_ELEVATION_URL,
                params={"locations": locations},
                timeout=self.timeout,
            )
            response.raise_for_status()
            data = response.json()
            results = data.get("results", [])

            if len(results) == len(coordinates):
                elevs = [r.get("elevation", 0) or 0 for r in results]
                self._source_name = "OpenTopoData (SRTM 30m)"
                return np.array(elevs, dtype=np.float64)
            return None

        except (requests.RequestException, KeyError, ValueError, TypeError):
            return None

    def _flat_terrain_fallback(self, n: int) -> np.ndarray:
        """Flat terrain at configured elevation — last resort."""
        global _flat_terrain_warned
        if not _flat_terrain_warned:
            print(
                f"ℹ Elevation APIs not available — using flat terrain "
                f"fallback at {FLAT_TERRAIN_ELEVATION_M:.0f}m ASL."
            )
            _flat_terrain_warned = True
        self._source_name = f"Flat terrain ({FLAT_TERRAIN_ELEVATION_M:.0f}m fallback)"
        return np.full(n, FLAT_TERRAIN_ELEVATION_M, dtype=np.float64)

    def fetch_single(self, lat: float, lon: float) -> float:
        """Get elevation for a single point."""
        elevations = self.fetch_elevations([(lat, lon)])
        return float(elevations[0])


@dataclass
class TerrainProfile:
    """
    Complete terrain profile between two points with RF analysis.

    Direction convention: position 0 = Gateway, position -1 = Node.
    """
    lat1: float
    lon1: float
    lat2: float
    lon2: float
    elevations: np.ndarray = field(default_factory=lambda: np.array([]))
    distances: np.ndarray = field(default_factory=lambda: np.array([]))
    coordinates: list = field(default_factory=list)
    n_points: int = TERRAIN_SAMPLE_POINTS
    elevation_source: str = "unknown"

    @property
    def total_distance(self) -> float:
        """Total link distance in meters."""
        return haversine(self.lat1, self.lon1, self.lat2, self.lon2)

    @classmethod
    def from_coordinates(
        cls,
        lat1: float, lon1: float,
        lat2: float, lon2: float,
        n_points: int = TERRAIN_SAMPLE_POINTS,
        api: Optional[ElevationAPI] = None,
    ) -> "TerrainProfile":
        """
        Factory: create TerrainProfile by querying real elevation data.
        Terrain direction: position 0 = first coordinate (Gateway),
        position -1 = last coordinate (Node).
        """
        if api is None:
            api = ElevationAPI()

        n_points = max(3, min(int(n_points), MAX_PROFILE_POINTS))
        coords = interpolate_coordinates(lat1, lon1, lat2, lon2, n_points)
        # The elevation APIs accept MAX_ELEVATION_POINTS per request
        elevations = np.concatenate([
            np.asarray(api.fetch_elevations(coords[i:i + MAX_ELEVATION_POINTS]), dtype=float)
            for i in range(0, n_points, MAX_ELEVATION_POINTS)
        ])

        total_d = haversine(lat1, lon1, lat2, lon2)
        distances = np.linspace(0, total_d, n_points)

        return cls(
            lat1=lat1, lon1=lon1,
            lat2=lat2, lon2=lon2,
            elevations=elevations,
            distances=distances,
            coordinates=coords,
            n_points=n_points,
            elevation_source=api.source_name,
        )

    @classmethod
    def from_manual_elevations(
        cls,
        lat1: float, lon1: float,
        lat2: float, lon2: float,
        elevations: np.ndarray,
    ) -> "TerrainProfile":
        """Create profile from manually provided elevation data (for testing)."""
        n = len(elevations)
        total_d = haversine(lat1, lon1, lat2, lon2)
        distances = np.linspace(0, total_d, n)
        coords = interpolate_coordinates(lat1, lon1, lat2, lon2, n)
        return cls(
            lat1=lat1, lon1=lon1,
            lat2=lat2, lon2=lon2,
            elevations=elevations,
            distances=distances,
            coordinates=coords,
            n_points=n,
            elevation_source="Manual / test data",
        )

    def compute_los_clearance(
        self,
        h_tx_asl: float,
        h_rx_asl: float,
        freq_hz: float,
        k: float = EFFECTIVE_EARTH_K,
        diffraction_method: str = "dominant_knife_edge",
    ) -> dict:
        """
        Compute Line of Sight analysis with Fresnel zone and earth curvature.

        IMPORTANT: h_tx_asl is the antenna at position 0 (Gateway),
        h_rx_asl is the antenna at position -1 (Node).
        """
        d_total = self.total_distance
        n = self.n_points
        lam = wavelength(freq_hz)

        los_heights = np.zeros(n)
        effective_terrain = np.zeros(n)
        fresnel_radii = np.zeros(n)
        clearance_m = np.zeros(n)

        for i in range(n):
            d1 = self.distances[i]
            d2 = d_total - d1

            los_heights[i] = los_height_at_point(h_tx_asl, h_rx_asl, d_total, d1)

            earth_bulge = earth_curvature_offset(d1, d2, k) if (d1 > 0 and d2 > 0) else 0
            effective_terrain[i] = self.elevations[i] + earth_bulge

            if d1 > 0 and d2 > 0:
                fresnel_radii[i] = np.sqrt(lam * d1 * d2 / d_total)
            else:
                fresnel_radii[i] = 0

            clearance_m[i] = los_heights[i] - effective_terrain[i]

        with np.errstate(divide="ignore", invalid="ignore"):
            clearance_pct = np.where(
                fresnel_radii > 0,
                (clearance_m / fresnel_radii) * 100,
                np.inf,
            )

        inner_mask = (fresnel_radii > 0)
        if inner_mask.any():
            inner_clearance_pct = clearance_pct.copy()
            inner_clearance_pct[~inner_mask] = np.inf
            worst_idx = int(np.argmin(inner_clearance_pct))
            min_clearance = float(inner_clearance_pct[worst_idx])
        else:
            worst_idx = n // 2
            min_clearance = float("inf")

        obstructed = bool(np.any(clearance_m[inner_mask] < 0)) if inner_mask.any() else False

        diffraction_loss, v_params = fresnel_obstruction_loss(
            clearance_m, fresnel_radii, method=diffraction_method,
        )

        return {
            "los_heights": los_heights,
            "effective_terrain": effective_terrain,
            "fresnel_radii": fresnel_radii,
            "clearance_m": clearance_m,
            "clearance_pct": clearance_pct,
            "min_clearance_pct": min_clearance,
            "obstructed": obstructed,
            "worst_point_idx": worst_idx,
            "v_params": v_params,
            "diffraction_loss_db": float(diffraction_loss),
        }
