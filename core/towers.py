"""
Cell Towers
===========
Approximate LTE sites from OpenCelliD (crowd-sourced, CC BY-SA 4.0).

OpenCelliD positions are where phones heard each cell, averaged, not where the
antenna stands: biased towards roads and towns, typically a few hundred metres
off. The cells of one site (same eNodeB: LTE cell id // 256) are merged into a
single site at their median position, which is closer to the mast than any cell.
"""

import csv
import gzip
import io
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

import numpy as np

TOWERS_FILE = Path(__file__).resolve().parent.parent / "data" / "coverage" / "towers_mx.csv"
MCC_MEXICO = 334
OPERATOR_MNC = {            # Mexican mobile network codes
    "Telcel": (20,),
    "AT&T": (40, 50, 90),
    "Movistar": (3, 30),
    "Altán": (140,),
}
_MNC_OPERATOR = {m: op for op, mncs in OPERATOR_MNC.items() for m in mncs}
OCID_COLUMNS = ["radio", "mcc", "net", "area", "cell", "unit", "lon", "lat", "range",
                "samples", "changeable", "created", "updated", "averageSignal"]


@dataclass
class Tower:
    operator: str
    site: int                # eNodeB id
    lat: float
    lon: float
    cells: int               # LTE cells seen on the site
    samples: int             # phone measurements behind the position


def sites_from_cells(rows: Iterable[dict]) -> list[Tower]:
    """Group OpenCelliD LTE rows of Mexican operators into sites (median position)."""
    groups: dict = {}
    for r in rows:
        if r["radio"] != "LTE" or int(r["mcc"]) != MCC_MEXICO:
            continue
        op = _MNC_OPERATOR.get(int(r["net"]))
        if op is None:
            continue
        g = groups.setdefault((op, int(r["cell"]) // 256), ([], [], [0]))
        g[0].append(float(r["lat"]))
        g[1].append(float(r["lon"]))
        g[2][0] += int(r["samples"] or 0)
    return [Tower(op, site, float(np.median(lats)), float(np.median(lons)), len(lats), n[0])
            for (op, site), (lats, lons, n) in sorted(groups.items())]


def read_opencellid(path) -> list[dict]:
    """Rows of an OpenCelliD export (.csv or .csv.gz, with or without header)."""
    path = Path(path)
    raw = gzip.open(path, "rt") if path.suffix == ".gz" else open(path, newline="")
    with raw as f:
        first = f.readline()
        has_header = first.startswith("radio")
        rest = f.read()
    text = rest if has_header else first + rest
    return list(csv.DictReader(io.StringIO(text), fieldnames=OCID_COLUMNS))


def save_towers(towers: list[Tower], path=TOWERS_FILE):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["operator", "site", "lat", "lon", "cells", "samples"])
        for t in towers:
            w.writerow([t.operator, t.site, f"{t.lat:.6f}", f"{t.lon:.6f}", t.cells, t.samples])


class TowerIndex:
    """Sites per operator, searchable by distance."""

    def __init__(self, towers: list[Tower]):
        self.by_op: dict[str, tuple[list[Tower], np.ndarray]] = {}
        for op in {t.operator for t in towers}:
            ts = [t for t in towers if t.operator == op]
            self.by_op[op] = (ts, np.array([[t.lat, t.lon] for t in ts]))

    @classmethod
    def load(cls, path=TOWERS_FILE) -> Optional["TowerIndex"]:
        path = Path(path)
        if not path.exists():
            return None
        with open(path, newline="") as f:
            towers = [Tower(r["operator"], int(r["site"]), float(r["lat"]), float(r["lon"]),
                            int(r["cells"]), int(r["samples"])) for r in csv.DictReader(f)]
        return cls(towers)

    def nearest(self, operator: str, lat: float, lon: float, radius_m: float,
                limit: int = 10) -> list[tuple[Tower, float]]:
        """(tower, distance m) of the operator within radius_m, nearest first."""
        if operator not in self.by_op:
            return []
        ts, xy = self.by_op[operator]
        kx = 111_320 * math.cos(math.radians(lat))
        d = np.hypot((xy[:, 0] - lat) * 111_320, (xy[:, 1] - lon) * kx)
        idx = np.argsort(d)[:limit]
        return [(ts[i], float(d[i])) for i in idx if d[i] <= radius_m]
