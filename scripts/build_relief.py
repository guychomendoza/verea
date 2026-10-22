"""
Build the national terrain-relief grid used to size the 4G uncertainty margin.

Downloads the Copernicus DEM GLO-90 (≈90 m; the same model behind the Open-Meteo
elevation API) for Mexico, once, into data/dem/, and computes the local relief
(highest minus lowest point within RELIEF_RADIUS_M) at every DEM cell. The result
is sampled every 0.0025° (≈270 m) and saved as data/coverage/relief_mx.npz: one
uint8 array (metres, capped at 255) per 1° tile, keyed "lon_lat" of its SW corner.

    python scripts/build_relief.py

Needs requirements-build.txt (rasterio, scipy). ≈220 tiles, ≈1 GB of downloads.
Copernicus DEM: © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018,
provided under COPERNICUS by the European Union and ESA; free use with attribution.
"""

import argparse
import json
import math
import sys
import time
import urllib.request
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path

import numpy as np
import shapely
import shapely.geometry

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from core.cellular import RELIEF_CELL_DEG, RELIEF_FILE, RELIEF_RADIUS_M  # noqa: E402

BUCKET = "https://copernicus-dem-90m.s3.amazonaws.com"
DEM_DIR = ROOT / "data" / "dem"
LAND_FILE = ROOT / "data" / "mexico_land.geojson"
DEM_N = 1200                                  # 3" cells per 1° tile (all of Mexico is below 50°N)
STEP = round(RELIEF_CELL_DEG * DEM_N)         # DEM cells per relief cell (3)
PAD = 8                                       # neighbour cells read around each tile (> radius)


def tile_name(lon: int, lat: int) -> str:
    ns, ew = ("N" if lat >= 0 else "S"), ("E" if lon >= 0 else "W")
    return f"Copernicus_DSM_COG_30_{ns}{abs(lat):02d}_00_{ew}{abs(lon):03d}_00_DEM"


def wanted_tiles() -> list[tuple[int, int]]:
    """1° tiles touching Mexican land that exist in the DEM (open sea has none)."""
    doc = json.loads(LAND_FILE.read_text())
    land = shapely.union_all([shapely.geometry.shape(f["geometry"]) for f in doc["features"]])
    shapely.prepare(land)
    with urllib.request.urlopen(f"{BUCKET}/tileList.txt", timeout=60) as r:
        available = set(r.read().decode().split())
    x0, y0, x1, y1 = land.bounds
    return [(x, y) for x in range(math.floor(x0), math.floor(x1) + 1)
            for y in range(math.floor(y0), math.floor(y1) + 1)
            if tile_name(x, y) in available and land.intersects(shapely.box(x, y, x + 1, y + 1))]


def download(t) -> Path:
    name = tile_name(*t)
    path = DEM_DIR / f"{name}.tif"
    if not path.exists():
        tmp = path.with_suffix(".part")
        urllib.request.urlretrieve(f"{BUCKET}/{name}/{name}.tif", tmp)
        tmp.replace(path)
    return path


@lru_cache(maxsize=16)
def _dem(lon: int, lat: int):
    path = DEM_DIR / f"{tile_name(lon, lat)}.tif"
    if not path.exists():
        return None
    import rasterio
    with rasterio.open(path) as ds:
        return ds.read(1)


def relief_tile(t):
    """Relief (m) of one 1° tile, sampled every STEP DEM cells."""
    from scipy.ndimage import maximum_filter, minimum_filter
    lon, lat = t
    # Tile plus a PAD-cell border from the neighbours (missing neighbour = sea level)
    big = np.zeros((DEM_N + 2 * PAD, DEM_N + 2 * PAD), dtype=np.float32)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            d = _dem(lon + dx, lat + dy)
            if d is None:
                continue
            d = d[:DEM_N, :DEM_N]
            # rows run north -> south: the tile to the north (dy=+1) goes on top
            r0, c0 = PAD + (-dy) * DEM_N, PAD + dx * DEM_N
            rs, cs = slice(max(r0, 0), min(r0 + DEM_N, big.shape[0])), \
                slice(max(c0, 0), min(c0 + DEM_N, big.shape[1]))
            big[rs, cs] = d[rs.start - r0:rs.stop - r0, cs.start - c0:cs.stop - c0]
    big = np.maximum(big, 0)                  # no negative "sea" values next to the coast
    ry = RELIEF_RADIUS_M / (111_320 / DEM_N)
    rx = RELIEF_RADIUS_M / (111_320 * math.cos(math.radians(lat + 0.5)) / DEM_N)
    yy, xx = np.mgrid[-math.ceil(ry):math.ceil(ry) + 1, -math.ceil(rx):math.ceil(rx) + 1]
    disk = (yy / ry) ** 2 + (xx / rx) ** 2 <= 1.0
    relief = maximum_filter(big, footprint=disk) - minimum_filter(big, footprint=disk)
    relief = relief[PAD:-PAD, PAD:-PAD][STEP // 2::STEP, STEP // 2::STEP]
    return t, np.clip(np.round(relief), 0, 255).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=RELIEF_FILE)
    ap.add_argument("--workers", type=int, default=None)
    args = ap.parse_args()
    t0 = time.time()
    tiles = wanted_tiles()
    DEM_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {len(tiles)} DEM tiles into {DEM_DIR} (kept for later runs)", flush=True)
    with ThreadPoolExecutor(max_workers=8) as pool:
        for i, _ in enumerate(pool.map(download, tiles), 1):
            if i % 20 == 0 or i == len(tiles):
                print(f"  {i}/{len(tiles)} ({time.time() - t0:.0f}s)", flush=True)
    print(f"Computing relief within {RELIEF_RADIUS_M} m", flush=True)
    arrays = {}
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        for (lon, lat), r in pool.map(relief_tile, sorted(tiles)):
            arrays[f"{lon}_{lat}"] = r
    args.out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(args.out, **arrays)
    print(f"Done: {args.out} ({args.out.stat().st_size / 1e6:.1f} MB, {len(arrays)} tiles) "
          f"in {(time.time() - t0) / 60:.1f} min", flush=True)


if __name__ == "__main__":
    main()
