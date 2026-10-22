"""
Local DEM
=========
Elevations from the Copernicus GLO-90 tiles in data/dem/ (scripts/build_relief.py
downloads them), with the same fetch_elevations() interface as
core.terrain.ElevationAPI: no request limits, no network. Needs rasterio.
"""

import math
from collections import OrderedDict
from pathlib import Path
from typing import Optional

import numpy as np

DEM_DIR = Path(__file__).resolve().parent.parent / "data" / "dem"
DEM_N = 1200                     # 3" cells per 1° tile below 50° latitude
CACHE_TILES = 12


def tile_name(lon: int, lat: int) -> str:
    ns, ew = ("N" if lat >= 0 else "S"), ("E" if lon >= 0 else "W")
    return f"Copernicus_DSM_COG_30_{ns}{abs(lat):02d}_00_{ew}{abs(lon):03d}_00_DEM"


class LocalDEM:
    source_name = "Copernicus DEM GLO-90 (local)"

    def __init__(self, directory=DEM_DIR):
        self.dir = Path(directory)
        self._tiles: OrderedDict = OrderedDict()

    @classmethod
    def open(cls, directory=DEM_DIR) -> Optional["LocalDEM"]:
        """The local DEM if its tiles and rasterio are available, else None."""
        try:
            import rasterio  # noqa: F401
        except ImportError:
            return None
        d = Path(directory)
        return cls(d) if d.is_dir() and any(d.glob("*.tif")) else None

    def _tile(self, key) -> Optional[np.ndarray]:
        if key in self._tiles:
            self._tiles.move_to_end(key)
            return self._tiles[key]
        path = self.dir / f"{tile_name(*key)}.tif"
        arr = None
        if path.exists():
            import rasterio
            with rasterio.open(path) as ds:
                arr = ds.read(1)
        self._tiles[key] = arr
        if len(self._tiles) > CACHE_TILES:
            self._tiles.popitem(last=False)
        return arr

    def fetch_elevations(self, coordinates: list[tuple[float, float]]) -> np.ndarray:
        """Bilinear elevations (m) at (lat, lon) points; 0 where there is no tile (sea)."""
        lat = np.array([c[0] for c in coordinates], dtype=float)
        lon = np.array([c[1] for c in coordinates], dtype=float)
        out = np.zeros(len(lat))
        tx, ty = np.floor(lon).astype(int), np.floor(lat).astype(int)
        for key in set(zip(tx.tolist(), ty.tolist())):
            arr = self._tile(key)
            if arr is None:
                continue
            m = (tx == key[0]) & (ty == key[1])
            # Pixel centres: row 0 at the north edge
            fx = (lon[m] - key[0]) * DEM_N - 0.5
            fy = (key[1] + 1 - lat[m]) * DEM_N - 0.5
            x0 = np.clip(np.floor(fx).astype(int), 0, arr.shape[1] - 2)
            y0 = np.clip(np.floor(fy).astype(int), 0, arr.shape[0] - 2)
            ax, ay = np.clip(fx - x0, 0, 1), np.clip(fy - y0, 0, 1)
            out[m] = (arr[y0, x0] * (1 - ax) * (1 - ay) + arr[y0, x0 + 1] * ax * (1 - ay)
                      + arr[y0 + 1, x0] * (1 - ax) * ay + arr[y0 + 1, x0 + 1] * ax * ay)
        return out
