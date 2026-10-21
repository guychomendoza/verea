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
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import shapely

TILE_DEG = 0.2
NEARBY_RADIUS_M = 300            # surroundings checked for the coverage share
EDGE_MARGIN_M = 100              # next to an area without coverage, signal is not certain
#                                  (the operator maps are rasters of 50 m pixels)
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
    margin_ok: bool = False                  # covered and no gap within EDGE_MARGIN_M (certain)


class CoverageSource:
    """One operator / technology / coverage-type file (a CRT GeoPackage)."""

    def __init__(self, path, cache_dir=None):
        self.path = Path(path)
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
    def _local(self, lat: float, lon: float, radius_m: float):
        """Pieces within radius_m of the point, in local metres (equirectangular, < 0.1% error)."""
        dlat = radius_m / 111_320
        dlon = dlat / max(math.cos(math.radians(lat)), 0.1)
        kx, ky = 111_320 * math.cos(math.radians(lat)), 111_320
        return [(level, shapely.transform(g, lambda c: (c - [lon, lat]) * [kx, ky]))
                for level, g in self.geometries((lon - dlon, lat - dlat, lon + dlon, lat + dlat))]

    def status_at(self, lat: float, lon: float) -> CoverageHit:
        """
        Whether the point has coverage, plus two field-useful numbers: how much of
        its surroundings is covered (the operator maps are full of small holes, so
        "distance to the edge" says little) and, without coverage, how far the
        nearest covered area is.
        """
        origin = shapely.Point(0, 0)
        local = self._local(lat, lon, NEARBY_RADIUS_M)
        hit = next(((level, g) for level, g in local if g.covers(origin)), None)
        circle = origin.buffer(NEARBY_RADIUS_M, quad_segs=16)
        covered_area = sum(shapely.intersection(g, circle).area for _, g in local)
        share = min(covered_area / circle.area, 1.0)
        if hit:
            margin = origin.buffer(EDGE_MARGIN_M, quad_segs=16)
            gap = margin.area - sum(shapely.intersection(g, margin).area for _, g in local)
            return CoverageHit(True, hit[0], share, 0.0, margin_ok=gap < 1.0)
        nearest = None
        for radius in SEARCH_STEPS_M:
            pieces = self._local(lat, lon, radius) if radius > NEARBY_RADIUS_M else local
            if pieces:
                d = min(g.distance(origin) for _, g in pieces)
                if d <= radius:
                    nearest = float(d)
                    break
        return CoverageHit(False, None, share, nearest)


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
