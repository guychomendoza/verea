"""
Cellular Coverage
=================
Mobile coverage declared by the operators and published by Mexico's
telecom regulator (CRT) as open data on datos.gob.mx (CC BY 4.0), e.g.
RADIOMOVIL_4G_GARANTIZADA_2T_2026.gpkg for Telcel 4G.

The national files are large (≈1.2 GB, a few dozen huge multipolygons), so
geometry is read once per 0.2° tile, clipped and cached on disk; later
lookups and map layers only touch the small cached tiles.
"""

import json
import math
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np
import shapely

TILE_DEG = 0.2
NEARBY_RADIUS_M = 300            # surroundings checked for the coverage share
EDGE_MARGIN_M = 125              # next to an area without coverage, signal is not certain
#                                  (the operator maps are rasters of 50 m pixels); used where
#                                  there is no relief data

# Terrain-adaptive margin: where the coverage edge is a terrain shadow (steep relief) the
# signal drops within a few tens of metres; on flat ground the edge is set by distance to the
# tower and moves hundreds of metres with a few dB of model error.
RELIEF_FILE = Path(__file__).resolve().parent.parent / "data" / "coverage" / "relief_mx.npz"
RELIEF_CELL_DEG = 0.0025         # relief grid (scripts/build_relief.py), ≈270 m
RELIEF_RADIUS_M = 500            # relief = highest minus lowest point within this radius
RELIEF_FLAT_M, RELIEF_STEEP_M = 15, 120
# The operator maps are for a phone outdoors at ~1.5 m. The sensors (Dragino SE0X-CS, LTE-M /
# NB-IoT) have +15–20 dB of link budget over a phone and sit at ~2.5 m, but in a sugar-cane
# field the grown crop covers them (−10 to −20 dB): net ≈ 0 to +10 dB in the worst season.
# So since 2026-10-22 (user's decision) the uncertainty band straddles the declared edge:
# inside, half the earlier margin (250 m flat, 125 m steep); outside, a "possible" band
# (LTE-M / NB-IoT may still connect: 300 m flat, 100 m steep). Field RSSI should calibrate it.
MARGIN_FLAT_M, MARGIN_STEEP_M = 250, 125     # log-interpolated in between
SMALL_GAP_MARGIN_M = 50          # small holes inside coverage (see below)
MARGIN_LEVELS_M = (50, 125, 150, 175, 200, 225, 250)   # steps used by the map tiles
REACH_FLAT_M, REACH_STEEP_M = 300, 100       # "possible" band outside the declared coverage
EDGE_REACH_M = 150               # its width without relief data
REACH_LEVELS_M = (100, 150, 200, 250, 300)
# A small hole inside coverage is a local obstruction (a building, a hollow), not a
# distance-limited edge: towers reach all around it, so it gets a small margin
SMALL_GAP_M2 = 100_000           # 0.1 km², ≈40 cells of the operator's 50 m raster
GAP_WINDOW_M = 900               # half-side of the square where gap sizes are measured
SEARCH_STEPS_M = (1_000, 5_000, 20_000)  # where to look for the nearest coverage

OPERATORS = {
    "RADIOMOVIL": "Telcel",
    "PEGASO": "Movistar",
    "ATT": "AT&T",
    "AT&T": "AT&T",
    "ALTAN": "Altán",
}
KINDS = {"GARANTIZADA": "guaranteed", "GAR": "guaranteed",
         "DIFERENCIADA": "differentiated", "DIF": "differentiated"}

_NAME_RE = re.compile(
    r"^(?P<op>RADIOMOVIL|PEGASO|AT&T|ATT|ALTAN)_(?P<tech>[2345]G)_(?P<kind>GARANTIZADA|DIFERENCIADA|GAR|DIF)"
    r"(?:_(?P<q>\d)T_(?P<year>\d{4}))?",
    re.IGNORECASE,
)


@dataclass
class CoverageHit:
    covered: bool
    level_dbm: Optional[float] = None       # signal level the operator declares for that area
    nearby_share: float = 0.0                # share of the surroundings (300 m) with coverage, 0–1
    nearest_m: Optional[float] = None        # outside: distance to the nearest coverage (None = > 20 km)
    margin_ok: bool = False                  # covered and no gap within the edge margin (certain)
    edge_m: Optional[float] = None           # covered: distance to the nearest gap (None = > 500 m)
    margin_m: Optional[float] = None         # covered: margin of the edge that decides margin_ok
    possible: bool = False                   # outside, but within reach for LTE-M / NB-IoT
    reach_m: Optional[float] = None          # outside: that reach here (m)


def _by_relief(relief, flat: float, steep: float, nodata: float):
    """Distance log-interpolated between flat and steep ground; NaN relief -> nodata."""
    r = np.asarray(relief, dtype=float)
    f = (np.log(np.maximum(r, 1.0)) - math.log(RELIEF_FLAT_M)) / math.log(RELIEF_STEEP_M / RELIEF_FLAT_M)
    f = np.clip(f, 0.0, 1.0)
    m = np.exp(math.log(flat) + f * math.log(steep / flat))
    return np.where(np.isnan(r), float(nodata), m)


def margin_for_relief(relief):
    """Edge margin (m) inside the coverage for the local relief (m)."""
    return _by_relief(relief, MARGIN_FLAT_M, MARGIN_STEEP_M, EDGE_MARGIN_M)


def reach_for_relief(relief):
    """Width (m) of the "possible" band outside the coverage for the local relief (m)."""
    return _by_relief(relief, REACH_FLAT_M, REACH_STEEP_M, EDGE_REACH_M)


class Relief:
    """National relief grid (scripts/build_relief.py): one uint8 array per 1° tile."""

    def __init__(self, path=None):
        self.path = Path(path) if path else None
        self._npz, self._pid = None, None
        self._tiles: dict = {}

    @property
    def available(self) -> bool:
        return bool(self.path and self.path.exists())

    def _tile(self, key):
        if key not in self._tiles:
            # One open file per process: forked workers must not share the file offset
            if self._pid != os.getpid():
                self._npz, self._pid = np.load(self.path), os.getpid()
            name = f"{key[0]}_{key[1]}"
            self._tiles[key] = self._npz[name] if name in self._npz.files else None
        return self._tiles[key]

    def at(self, lon, lat) -> np.ndarray:
        """Relief (m) at the points; NaN where there is no data."""
        lon, lat = np.broadcast_arrays(np.asarray(lon, dtype=float), np.asarray(lat, dtype=float))
        out = np.full(lon.shape, np.nan)
        if not self.available:
            return out
        tx, ty = np.floor(lon).astype(int), np.floor(lat).astype(int)
        for key in set(zip(tx.ravel().tolist(), ty.ravel().tolist())):
            arr = self._tile(key)
            if arr is None:
                continue
            m = (tx == key[0]) & (ty == key[1])
            n = arr.shape[0]
            col = ((lon[m] - key[0]) / RELIEF_CELL_DEG).astype(int).clip(0, n - 1)
            row = ((key[1] + 1 - lat[m]) / RELIEF_CELL_DEG).astype(int).clip(0, n - 1)
            out[m] = arr[row, col]
        return out

    def margin_at(self, lon, lat) -> np.ndarray:
        return margin_for_relief(self.at(lon, lat))

    def reach_at(self, lon, lat) -> np.ndarray:
        return reach_for_relief(self.at(lon, lat))


_DEFAULT_RELIEF = None


def default_relief() -> Relief:
    global _DEFAULT_RELIEF
    if _DEFAULT_RELIEF is None:
        _DEFAULT_RELIEF = Relief(RELIEF_FILE)
    return _DEFAULT_RELIEF


class CoverageSource:
    """One operator / technology / coverage-type file (a CRT GeoPackage)."""

    def __init__(self, path, cache_dir=None, relief: Optional[Relief] = None):
        self.path = Path(path)
        self.relief = relief if relief is not None else default_relief()
        m = _NAME_RE.match(self.path.stem)
        if not m:
            raise ValueError(f"Unrecognised coverage file name: {self.path.name}")
        self.operator = OPERATORS[m["op"].upper()]
        self.tech = m["tech"].upper()
        self.kind = KINDS[m["kind"].upper()]
        self.quarter = f"Q{m['q']} {m['year']}" if m["q"] else ""
        self.cache_dir = Path(cache_dir) if cache_dir else self.path.parent / "cache" / self.path.stem
        self._tiles: dict = {}
        self._layer = None

    @property
    def label(self) -> str:
        kind = "guaranteed" if self.kind == "guaranteed" else "differentiated"
        return f"{self.operator} {self.tech} {kind}" + (f" ({self.quarter})" if self.quarter else "")

    # ── tiles ──
    @staticmethod
    def _tile_of(lon: float, lat: float) -> tuple[int, int]:
        return math.floor(lon / TILE_DEG), math.floor(lat / TILE_DEG)

    @staticmethod
    def _tile_box(t: tuple[int, int]) -> tuple[float, float, float, float]:
        return (t[0] * TILE_DEG, t[1] * TILE_DEG, (t[0] + 1) * TILE_DEG, (t[1] + 1) * TILE_DEG)

    def _tiles_for(self, bbox) -> list[tuple[int, int]]:
        x0, y0 = self._tile_of(bbox[0], bbox[1])
        x1, y1 = self._tile_of(bbox[2] - 1e-12, bbox[3] - 1e-12)
        return [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]

    def _tile_file(self, t) -> Path:
        return self.cache_dir / f"{t[0]}_{t[1]}.json"

    def _load_tiles(self, tiles: list):
        missing = [t for t in tiles if t not in self._tiles]
        to_read = []
        for t in missing:
            f = self._tile_file(t)
            if f.exists():
                data = json.loads(f.read_text())
                self._tiles[t] = [(d["level"], shapely.from_wkb(bytes.fromhex(d["wkb"]))) for d in data]
            else:
                to_read.append(t)
        if not to_read:
            return
        # One read of the big file covers every missing tile, then clip per tile
        import pyogrio
        boxes = [self._tile_box(t) for t in to_read]
        bbox = (min(b[0] for b in boxes), min(b[1] for b in boxes),
                max(b[2] for b in boxes), max(b[3] for b in boxes))
        if self._layer is None:
            self._layer = pyogrio.list_layers(self.path)[0][0]
        df = pyogrio.read_dataframe(self.path, layer=self._layer, bbox=bbox)
        level_col = next((c for c in ("NIVEL", "nivel") if c in df.columns), None)
        # Clip first, repair after: make_valid on the national multipolygons takes minutes
        geoms = list(df.geometry.values)
        levels = df[level_col].tolist() if level_col else [None] * len(df)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        for t, b in zip(to_read, boxes):
            parts = []
            for level, g in zip(levels, geoms):
                c = shapely.clip_by_rect(g, *b)
                if not c.is_empty:
                    c = shapely.make_valid(c)
                    parts.append((None if level is None else float(level), c))
            self._tiles[t] = parts
            tmp = self._tile_file(t).with_suffix(".tmp")
            tmp.write_text(json.dumps([{"level": lv, "wkb": shapely.to_wkb(g, hex=True)} for lv, g in parts]))
            tmp.replace(self._tile_file(t))

    def geometries(self, bbox) -> list[tuple[Optional[float], shapely.Geometry]]:
        """(level, geometry) pieces covering bbox = (min_lon, min_lat, max_lon, max_lat)."""
        tiles = self._tiles_for(bbox)
        self._load_tiles(tiles)
        out = []
        for t in tiles:
            for level, g in self._tiles[t]:
                c = shapely.clip_by_rect(g, *bbox)
                if not c.is_empty:
                    out.append((level, c))
        return out

    # ── queries ──
    def covered_at(self, lats, lons) -> np.ndarray:
        """Declared coverage (bool) at many points at once, e.g. along a radial."""
        lats, lons = np.asarray(lats, dtype=float), np.asarray(lons, dtype=float)
        out = np.zeros(lats.shape, dtype=bool)
        pad = 1e-4
        bbox = (lons.min() - pad, lats.min() - pad, lons.max() + pad, lats.max() + pad)
        for _, g in self.geometries(bbox):
            out |= shapely.contains_xy(g, lons, lats)
        return out

    def _local(self, lat: float, lon: float, radius_m: float):
        """Pieces within radius_m of the point, in local metres (equirectangular, < 0.1% error)."""
        dlat = radius_m / 111_320
        dlon = dlat / max(math.cos(math.radians(lat)), 0.1)
        kx, ky = 111_320 * math.cos(math.radians(lat)), 111_320
        return [(level, shapely.transform(g, lambda c: (c - [lon, lat]) * [kx, ky]))
                for level, g in self.geometries((lon - dlon, lat - dlat, lon + dlon, lat + dlat))]

    def _edge_check(self, lat: float, lon: float, local) -> tuple[bool, Optional[float], Optional[float]]:
        """
        (margin_ok, distance to the nearest gap, margin of the deciding edge) for a covered
        point: every coverage edge within MARGIN_FLAT_M is sampled every ~15 m, and each
        sample has the margin of the relief where it lies (SMALL_GAP_MARGIN_M on small holes).
        """
        radius = max(MARGIN_FLAT_M, EDGE_MARGIN_M)
        disk = shapely.Point(0, 0).buffer(radius, quad_segs=32)
        window = shapely.box(-GAP_WINDOW_M, -GAP_WINDOW_M, GAP_WINDOW_M, GAP_WINDOW_M)
        cov = shapely.union_all([shapely.intersection(g, window) for _, g in local])
        cov = cov.buffer(0.5).buffer(-0.5)          # close slivers between adjacent pieces
        edges = shapely.intersection(cov.boundary, disk.buffer(-1.0))
        if edges.is_empty:
            return True, None, None
        xy = shapely.get_coordinates(shapely.segmentize(edges, 15.0))
        d = np.hypot(xy[:, 0], xy[:, 1])
        kx, ky = 111_320 * math.cos(math.radians(lat)), 111_320
        margins = self.relief.margin_at(lon + xy[:, 0] / kx, lat + xy[:, 1] / ky)
        # Gaps that do not reach the window border have a known size
        gaps = shapely.get_parts(shapely.difference(window, cov))
        small = [g for g in gaps if g.area < SMALL_GAP_M2 and not g.intersects(window.exterior)]
        if small:
            on_small = shapely.distance(shapely.union_all(small), shapely.points(xy)) < 1.0
            margins = np.where(on_small, float(SMALL_GAP_MARGIN_M), margins)
        i = int(np.argmin(d - margins))
        return bool(d[i] >= margins[i]), float(d.min()), float(margins[i])

    def status_at(self, lat: float, lon: float) -> CoverageHit:
        """
        Whether the point has coverage, plus two field-useful numbers: how much of
        its surroundings is covered (the operator maps are full of small holes, so
        "distance to the edge" says little) and, without coverage, how far the
        nearest covered area is.
        """
        origin = shapely.Point(0, 0)
        local = self._local(lat, lon, GAP_WINDOW_M)
        hit = next(((level, g) for level, g in local if g.covers(origin)), None)
        circle = origin.buffer(NEARBY_RADIUS_M, quad_segs=16)
        covered_area = sum(shapely.intersection(g, circle).area for _, g in local)
        share = min(covered_area / circle.area, 1.0)
        if hit:
            ok, edge_m, margin_m = self._edge_check(lat, lon, local)
            return CoverageHit(True, hit[0], share, 0.0, margin_ok=ok, edge_m=edge_m, margin_m=margin_m)
        if self._in_small_hole(local):
            return CoverageHit(False, None, share, self._nearest(lat, lon, local), possible=True, reach_m=None)
        nearest = self._nearest(lat, lon, local)
        reach = float(self.relief.reach_at(lon, lat))
        return CoverageHit(False, None, share, nearest, possible=nearest is not None and nearest <= reach,
                           reach_m=reach)

    @staticmethod
    def _in_small_hole(local) -> bool:
        """The point lies in a small hole of the coverage (towers reach all around it)."""
        window = shapely.box(-GAP_WINDOW_M, -GAP_WINDOW_M, GAP_WINDOW_M, GAP_WINDOW_M)
        if not local:
            return False
        cov = shapely.union_all([shapely.intersection(g, window) for _, g in local]).buffer(0.5).buffer(-0.5)
        origin = shapely.Point(0, 0)
        hole = next((g for g in shapely.get_parts(shapely.difference(window, cov)) if g.covers(origin)), None)
        return bool(hole is not None and hole.area < SMALL_GAP_M2 and not hole.intersects(window.exterior))

    def _nearest(self, lat: float, lon: float, local) -> Optional[float]:
        """Distance (m) to the nearest coverage, None beyond 20 km."""
        origin = shapely.Point(0, 0)
        nearest = None
        for radius in SEARCH_STEPS_M:
            pieces = self._local(lat, lon, radius) if radius > NEARBY_RADIUS_M else local
            if pieces:
                d = min(g.distance(origin) for _, g in pieces)
                if d <= radius:
                    nearest = float(d)
                    break
        return nearest


def split_by_margin(covered, margin_m: float = EDGE_MARGIN_M):
    """
    Covered area (in metres) -> (certain, edge): certain = farther than margin_m
    from any area without coverage; edge = the rest of the covered area.
    """
    covered = shapely.make_valid(covered)
    certain = covered.buffer(-margin_m, quad_segs=4)
    edge = shapely.difference(covered, certain)
    return certain, edge


def find_sources(directory) -> list[CoverageSource]:
    """Coverage files found in a directory (unrecognised names are skipped)."""
    sources = []
    for p in sorted(Path(directory).glob("*.gpkg")):
        try:
            sources.append(CoverageSource(p))
        except ValueError:
            continue
    return sources
