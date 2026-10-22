"""
Build the 4G coverage map tiles shown in the app (PMTiles of PNG images).

From an operator coverage GeoPackage (CRT open data) every map pixel gets a class:
  certain - covered and farther than the edge margin from any area without coverage
  edge    - covered, but within the edge margin of an area without coverage
  none    - Mexican land without declared coverage
(transparent: sea / outside Mexico)

Run once per quarter:

    python scripts/build_coverage_tiles.py data/coverage/RADIOMOVIL_4G_GARANTIZADA_2T_2026.gpkg \
        data/coverage/telcel_4g_2026q2.pmtiles

Needs requirements-build.txt (scipy, rasterio, pmtiles) besides the app requirements.
The margin follows the terrain (core.cellular.margin_for_relief: ≈40 m where the relief is
steep, ≈300 m on flat ground) when data/coverage/relief_mx.npz exists
(scripts/build_relief.py); otherwise, or with --fixed-margin, it is the same everywhere.

The operator maps are rasters of 50 m cells published as polygons, so they are
handled as images again:
  1. sort the polygons into 0.2° tiles on disk, region by region (a tile on a region
     border gets both regions);
  2. rasterize each tile to a ~45 m grid; a covered cell is "edge" when some gap cell
     lies within that gap's margin (one distance transform per margin step: milliseconds,
     where polygon buffers took minutes);
  3. render Web-Mercator PNG tiles (z5–13) from the grids and pack them in one
     PMTiles file that the browser reads by HTTP ranges.
"""

import argparse
import io
import json
import math
import shutil
import struct
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from functools import lru_cache
from pathlib import Path

import numpy as np
import pyogrio
import shapely
import shapely.geometry

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from core.cellular import (EDGE_MARGIN_M, MARGIN_FLAT_M, MARGIN_LEVELS_M, MARGIN_STEEP_M,  # noqa: E402
                           RELIEF_FILE, SMALL_GAP_M2, TILE_DEG, Relief)

LAND_FILE = ROOT / "data" / "mexico_land.geojson"
CELL = 0.0004                       # grid cell in degrees (≈44 m N-S), finer than the 50 m source
N = round(TILE_DEG / CELL)          # 500 cells per 0.2° tile
PAD_CELLS = 10                      # neighbour context (> largest margin) so seams make no fake edges
PAD_DEG = PAD_CELLS * CELL
MIN_ZOOM, MAX_ZOOM = 5, 13          # z13 pixels ≈ 18 m; the browser over-zooms beyond
MOSAIC_FACTORS = (4, 16)            # coarse national grids for low zooms (≈180 m, ≈710 m)

# class -> RGBA (index 0 transparent)
PALETTE = {
    0: (0, 0, 0, 0),
    1: (230, 57, 70, 95),           # none
    2: (233, 196, 106, 140),        # edge
    3: (42, 157, 143, 85),          # certain
}
CLASS_NAMES = {1: "none", 2: "edge", 3: "certain"}


def tile_box(t):
    return (t[0] * TILE_DEG, t[1] * TILE_DEG, (t[0] + 1) * TILE_DEG, (t[1] + 1) * TILE_DEG)


def tiles_in(bounds):
    x0, y0 = math.floor(bounds[0] / TILE_DEG), math.floor(bounds[1] / TILE_DEG)
    x1, y1 = math.floor(bounds[2] / TILE_DEG), math.floor(bounds[3] / TILE_DEG)
    return [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]


def padded(b):
    return (b[0] - PAD_DEG, b[1] - PAD_DEG, b[2] + PAD_DEG, b[3] + PAD_DEG)


# ── pass 1: operator polygons -> per-tile files ──
def assign_parts(gpkg: Path, regions: list, parts_dir: Path):
    parts_dir.mkdir(parents=True, exist_ok=True)
    layer = pyogrio.list_layers(gpkg)[0][0]
    for region in regions:
        t0 = time.time()
        df = pyogrio.read_dataframe(gpkg, layer=layer, where=f"REGION = '{region}'")
        parts = shapely.get_parts(df.geometry.values)
        tree = shapely.STRtree(parts)
        extents = shapely.bounds(parts)
        written = 0
        for t in tiles_in(shapely.total_bounds(parts)):
            pb = padded(tile_box(t))
            idx = tree.query(shapely.box(*pb))
            if len(idx) == 0:
                continue
            chunk = parts[idx].copy()
            # Pieces reaching past the tile (the big connected areas) are cut to it,
            # otherwise each would be copied whole into every tile it touches
            e = extents[idx]
            big = (e[:, 0] < pb[0]) | (e[:, 1] < pb[1]) | (e[:, 2] > pb[2]) | (e[:, 3] > pb[3])
            if big.any():
                chunk[big] = shapely.clip_by_rect(chunk[big], *pb)
            chunk = chunk[~shapely.is_empty(chunk)]
            if len(chunk) == 0:
                continue
            with open(parts_dir / f"{t[0]}_{t[1]}.bin", "ab") as f:
                for wkb in shapely.to_wkb(chunk):
                    f.write(struct.pack("<I", len(wkb)))
                    f.write(wkb)
            written += 1
        print(f"  {region}: {len(parts):,} pieces into {written} tiles ({time.time() - t0:.0f}s)", flush=True)
        del df, parts, tree


def read_parts(path: Path):
    data, out, i = path.read_bytes(), [], 0
    while i < len(data):
        (n,) = struct.unpack_from("<I", data, i)
        out.append(data[i + 4:i + 4 + n])
        i += 4 + n
    return shapely.from_wkb(out)


_LAND = None
_RELIEF = None


def _relief():
    global _RELIEF
    if _RELIEF is None:
        _RELIEF = Relief(RELIEF_FILE)
    return _RELIEF


def _land():
    global _LAND
    if _LAND is None:
        doc = json.loads(LAND_FILE.read_text())
        _LAND = shapely.union_all([shapely.geometry.shape(f["geometry"]) for f in doc["features"]])
        shapely.prepare(_LAND)
    return _LAND


# ── pass 2: one 0.2° tile -> class grid ──
def classify_grid(args):
    t, parts_file, fixed_margin, grid_dir = args
    from rasterio.features import rasterize
    from rasterio.transform import from_origin
    from scipy.ndimage import distance_transform_edt, label

    west, south, east, north = padded(tile_box(t))
    n = N + 2 * PAD_CELLS
    transform = from_origin(west, north, CELL, CELL)
    cov = np.zeros((n, n), dtype=bool)
    if parts_file:
        parts = read_parts(Path(parts_file))
        parts = parts[~shapely.is_empty(parts)]
        if len(parts):
            cov = rasterize(parts, out_shape=(n, n), transform=transform, fill=0,
                            default_value=1, dtype="uint8").astype(bool)
    land_geom = shapely.clip_by_rect(_land(), west, south, east, north)
    land = np.zeros((n, n), dtype=bool)
    if not land_geom.is_empty:
        land = rasterize([land_geom], out_shape=(n, n), transform=transform, fill=0,
                         default_value=1, dtype="uint8").astype(bool)

    # Margin of every gap cell, rounded up to a step; then, per step, covered cells closer
    # than it to a gap of that step are edge (cells are not square in metres)
    lat = (south + north) / 2
    gap = ~cov
    edge = np.zeros_like(cov)
    if cov.any() and gap.any():
        if fixed_margin is None:
            centres = west + (np.arange(n) + 0.5) * CELL, north - (np.arange(n) + 0.5) * CELL
            lon_g, lat_g = np.meshgrid(*centres)
            margins = _relief().margin_at(lon_g, lat_g)
            steps = np.array(MARGIN_LEVELS_M, dtype=float)
            level = steps[np.searchsorted(steps, margins - 1e-6).clip(0, len(steps) - 1)]
            # Small holes (not reaching the padded border, where their size is unknown)
            labels, _ = label(gap, structure=np.ones((3, 3)))
            cell_m2 = CELL * 111_320 * CELL * 111_320 * math.cos(math.radians(lat))
            small = np.bincount(labels.ravel()) * cell_m2 < SMALL_GAP_M2
            small[0] = False
            small[np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))] = False
            level[small[labels]] = MARGIN_STEEP_M
        else:
            level = np.full((n, n), float(fixed_margin))
        sampling = (CELL * 111_320, CELL * 111_320 * math.cos(math.radians(lat)))
        half_cell = sum(sampling) / 4           # centre-to-centre -> distance to the gap's border
        for m in np.unique(level[gap]):
            dist = distance_transform_edt(~(gap & (level == m)), sampling=sampling)
            edge |= cov & (dist - half_cell <= m)
    certain = cov & ~edge

    classes = np.zeros((n, n), dtype=np.uint8)
    classes[land & ~cov] = 1
    classes[cov & ~certain] = 2
    classes[certain] = 3
    classes = classes[PAD_CELLS:-PAD_CELLS, PAD_CELLS:-PAD_CELLS]
    if not classes.any():
        return t, None
    np.savez_compressed(Path(grid_dir) / f"{t[0]}_{t[1]}.npz", c=classes)
    cell_km2 = (CELL * 111.32) ** 2 * math.cos(math.radians(lat))
    return t, {k: float((classes == k).sum() * cell_km2) for k in CLASS_NAMES}


# ── pass 3: Web-Mercator PNG tiles ──
_CTX = {}


def _init_render(grid_dir, mosaic_info):
    _CTX["grid_dir"] = Path(grid_dir)
    _CTX["mosaics"] = {f: (np.load(info["path"], mmap_mode="r"), info) for f, info in mosaic_info.items()}


@lru_cache(maxsize=64)
def _grid(tx, ty):
    p = _CTX["grid_dir"] / f"{tx}_{ty}.npz"
    return np.load(p)["c"] if p.exists() else None


def _pixel_lonlat(z, x, y):
    n = 2 ** z
    i = (np.arange(256) + 0.5) / 256
    lon = (x + i) / n * 360.0 - 180.0
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (y + i) / n))))
    return np.meshgrid(lon, lat)


def render_tile(zxy):
    z, x, y = zxy
    lon, lat = _pixel_lonlat(z, x, y)
    out = np.zeros((256, 256), dtype=np.uint8)
    if z >= 12:
        tx = np.floor(lon / TILE_DEG).astype(int)
        ty = np.floor(lat / TILE_DEG).astype(int)
        for a, b in set(zip(tx.ravel().tolist(), ty.ravel().tolist())):
            g = _grid(a, b)
            if g is None:
                continue
            m = (tx == a) & (ty == b)
            col = ((lon[m] - a * TILE_DEG) / CELL).astype(int).clip(0, N - 1)
            row = (((b + 1) * TILE_DEG - lat[m]) / CELL).astype(int).clip(0, N - 1)
            out[m] = g[row, col]
    else:
        factor = MOSAIC_FACTORS[0] if z >= 10 else MOSAIC_FACTORS[1]
        mosaic, info = _CTX["mosaics"][factor]
        cell = CELL * factor
        col = np.floor((lon - info["west"]) / cell).astype(int)
        row = np.floor((info["north"] - lat) / cell).astype(int)
        ok = (col >= 0) & (row >= 0) & (col < mosaic.shape[1]) & (row < mosaic.shape[0])
        if ok.any():
            out[ok] = mosaic[row[ok], col[ok]]
    if not out.any():
        return zxy, None
    from PIL import Image
    img = Image.fromarray(out, mode="P")
    img.putpalette([c for k in range(4) for c in PALETTE[k][:3]])
    buf = io.BytesIO()
    img.save(buf, format="PNG", transparency=bytes(PALETTE[k][3] for k in range(4)))
    return zxy, buf.getvalue()


def tile_range(z, bounds):
    """XYZ tiles covering bounds = (west, south, east, north)."""
    n = 2 ** z

    def tx(lon):
        return min(n - 1, max(0, int((lon + 180.0) / 360.0 * n)))

    def ty(lat):
        r = math.radians(lat)
        return min(n - 1, max(0, int((1 - math.asinh(math.tan(r)) / math.pi) / 2 * n)))

    return [(z, x, y) for x in range(tx(bounds[0]), tx(bounds[2]) + 1)
            for y in range(ty(bounds[3]), ty(bounds[1]) + 1)]


def tile_bounds(z, x, y):
    n = 2 ** z
    west, east = x / n * 360 - 180, (x + 1) / n * 360 - 180
    north = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    south = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return west, south, east, north


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("gpkg", type=Path)
    ap.add_argument("out", type=Path, help="output .pmtiles")
    ap.add_argument("--regions", nargs="*", help="only these REGION codes (testing), e.g. R5")
    ap.add_argument("--fixed-margin", type=float, default=None,
                    help="same margin (m) everywhere instead of the terrain-adaptive one")
    ap.add_argument("--workers", type=int, default=None)
    ap.add_argument("--keep-work", action="store_true", help="keep the intermediate files")
    args = ap.parse_args()
    from pmtiles.tile import Compression, TileType, zxy_to_tileid
    from pmtiles.writer import write

    work = args.out.parent / f".build_{args.out.stem}"
    shutil.rmtree(work, ignore_errors=True)
    parts_dir, grid_dir = work / "parts", work / "grids"
    grid_dir.mkdir(parents=True)
    t_start = time.time()

    all_regions = sorted(pyogrio.read_dataframe(args.gpkg, read_geometry=False, columns=["REGION"])
                         ["REGION"].unique())
    regions = args.regions or all_regions
    print(f"Pass 1/3: sorting coverage into {TILE_DEG}° tiles ({', '.join(regions)})", flush=True)
    assign_parts(args.gpkg, regions, parts_dir)

    cov_tiles = {tuple(map(int, p.stem.split("_"))) for p in parts_dir.glob("*.bin")}
    if args.regions:
        xs, ys = zip(*cov_tiles)
        extent = (min(xs) * TILE_DEG, min(ys) * TILE_DEG, (max(xs) + 1) * TILE_DEG, (max(ys) + 1) * TILE_DEG)
    else:
        extent = _land().bounds
    land_tiles = {t for t in tiles_in(extent) if _land().intersects(shapely.box(*tile_box(t)))}
    tiles = sorted(cov_tiles | land_tiles)
    margin = args.fixed_margin
    if margin is None and not _relief().available:
        print(f"  no {RELIEF_FILE.name} (scripts/build_relief.py): fixed {EDGE_MARGIN_M} m margin", flush=True)
        margin = EDGE_MARGIN_M
    margin_text = (f"{margin:g} m" if margin is not None
                   else f"terrain-adaptive {MARGIN_LEVELS_M[0]}–{MARGIN_FLAT_M} m")
    print(f"Pass 2/3: classifying {len(tiles)} tiles on a {CELL}° grid (margin {margin_text})",
          flush=True)
    jobs = [(t, str(parts_dir / f"{t[0]}_{t[1]}.bin") if t in cov_tiles else None, margin,
             str(grid_dir)) for t in tiles]
    areas, grids = {k: 0.0 for k in CLASS_NAMES.values()}, []
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        for i, (t, a) in enumerate(pool.map(classify_grid, jobs, chunksize=8), 1):
            if a:
                grids.append(t)
                for k, v in a.items():
                    areas[CLASS_NAMES[k]] += v
            if i % 500 == 0 or i == len(jobs):
                print(f"  {i}/{len(jobs)} tiles ({time.time() - t_start:.0f}s)", flush=True)
    print("  area km²: " + ", ".join(f"{k} {v:,.0f}" for k, v in areas.items()), flush=True)
    if not args.keep_work:
        shutil.rmtree(parts_dir, ignore_errors=True)

    # Coarse national mosaics (nearest-cell sampling) for the low zoom levels
    xs, ys = zip(*grids)
    west, north = min(xs) * TILE_DEG, (max(ys) + 1) * TILE_DEG
    width, height = (max(xs) - min(xs) + 1) * N, (max(ys) - min(ys) + 1) * N
    mosaic_info = {}
    for f in MOSAIC_FACTORS:
        arr = np.zeros((height // f, width // f), dtype=np.uint8)
        for (tx, ty) in grids:
            g = np.load(grid_dir / f"{tx}_{ty}.npz")["c"][f // 2::f, f // 2::f]
            r0, c0 = (max(ys) - ty) * N // f, (tx - min(xs)) * N // f
            arr[r0:r0 + g.shape[0], c0:c0 + g.shape[1]] = g
        path = work / f"mosaic_{f}.npy"
        np.save(path, arr)
        mosaic_info[f] = {"path": str(path), "west": west, "north": north}

    bounds = (west, north - height * CELL, west + width * CELL, north)
    grid_set = set(grids)
    zxys = []
    for z in range(MIN_ZOOM, MAX_ZOOM + 1):
        for zxy in tile_range(z, bounds):
            b = tile_bounds(*zxy)
            if z >= 10 and not any(t in grid_set for t in tiles_in(b)):
                continue
            zxys.append(zxy)
    print(f"Pass 3/3: rendering up to {len(zxys):,} map tiles (z{MIN_ZOOM}–{MAX_ZOOM})", flush=True)
    rendered = []
    with ProcessPoolExecutor(max_workers=args.workers, initializer=_init_render,
                             initargs=(str(grid_dir), mosaic_info)) as pool:
        for i, (zxy, png) in enumerate(pool.map(render_tile, zxys, chunksize=64), 1):
            if png:
                rendered.append((zxy_to_tileid(*zxy), png))
            if i % 20000 == 0 or i == len(zxys):
                print(f"  {i:,}/{len(zxys):,} ({time.time() - t_start:.0f}s)", flush=True)
    rendered.sort()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with write(str(args.out)) as writer:
        for tileid, png in rendered:
            writer.write_tile(tileid, png)
        writer.finalize(
            {
                "tile_type": TileType.PNG, "tile_compression": Compression.NONE,
                "min_zoom": MIN_ZOOM, "max_zoom": MAX_ZOOM,
                "min_lon_e7": int(bounds[0] * 1e7), "min_lat_e7": int(bounds[1] * 1e7),
                "max_lon_e7": int(bounds[2] * 1e7), "max_lat_e7": int(bounds[3] * 1e7),
                "center_zoom": 6, "center_lon_e7": int((bounds[0] + bounds[2]) / 2 * 1e7),
                "center_lat_e7": int((bounds[1] + bounds[3]) / 2 * 1e7),
            },
            {
                "name": args.out.stem, "source": args.gpkg.name, "margin": margin_text,
                "classes": {"certain": "covered, farther than the margin from any gap",
                            "edge": "covered, within the margin of a gap",
                            "none": "land without declared coverage"},
                "area_km2": {k: round(v) for k, v in areas.items()},
                "regions": regions, "built": time.strftime("%Y-%m-%d %H:%M"),
                "attribution": "Comisión Reguladora de Telecomunicaciones, datos.gob.mx (CC BY 4.0); "
                               "land: Natural Earth (public domain)",
            },
        )
    if not args.keep_work:
        shutil.rmtree(work, ignore_errors=True)
    size = args.out.stat().st_size
    print(f"Done: {args.out} ({size / 1e6:,.1f} MB, {len(rendered):,} tiles) "
          f"in {(time.time() - t_start) / 60:.1f} min", flush=True)


if __name__ == "__main__":
    main()
