"""Tests for the edge classification of scripts/build_coverage_tiles.py."""

import math
import struct
import sys
from pathlib import Path

import numpy as np
import pytest
import shapely

pytest.importorskip("rasterio")
pytest.importorskip("scipy")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import build_coverage_tiles as bct  # noqa: E402

from core.cellular import Relief  # noqa: E402

TILE = (-518, 98)                   # lon -103.6..-103.4, lat 19.6..19.8 (inland Jalisco)


def _band_m(tmp_path, monkeypatch, relief_value, fixed=None):
    """Width (m) of the edge band west of a north-south gap through the tile."""
    west, south, east, north = bct.padded(bct.tile_box(TILE))
    gap_lon = -103.5
    cov = shapely.box(west, south, gap_lon, north).union(shapely.box(gap_lon + 0.01, south, east, north))
    parts = tmp_path / "parts.bin"
    with open(parts, "wb") as f:
        for wkb in shapely.to_wkb(shapely.get_parts(cov)):
            f.write(struct.pack("<I", len(wkb)) + wkb)
    relief = tmp_path / "relief.npz"
    np.savez_compressed(relief, **{"-104_19": np.full((400, 400), relief_value, dtype=np.uint8)})
    monkeypatch.setattr(bct, "_RELIEF", Relief(relief))
    t, areas = bct.classify_grid((TILE, str(parts), fixed, str(tmp_path)))
    classes = np.load(tmp_path / f"{TILE[0]}_{TILE[1]}.npz")["c"]
    row = classes[bct.N // 2]
    col_gap = round((gap_lon - TILE[0] * bct.TILE_DEG) / bct.CELL)
    edge_cells = int((row[:col_gap] == 2).sum())
    _band_m.possible = int((row == 4).sum()) * bct.CELL * 111_320 * math.cos(math.radians(19.7))
    return edge_cells * bct.CELL * 111_320 * math.cos(math.radians(19.7))


def test_flat_edges_get_a_wide_margin(tmp_path, monkeypatch):
    assert _band_m(tmp_path, monkeypatch, 5) == pytest.approx(250, abs=45)
    assert _band_m.possible == pytest.approx(2 * 300, abs=90)      # both sides of the 1 km gap


def test_steep_edges_get_a_narrow_margin(tmp_path, monkeypatch):
    assert _band_m(tmp_path, monkeypatch, 200) == pytest.approx(125, abs=45)
    assert _band_m.possible == pytest.approx(2 * 100, abs=90)


def test_fixed_margin_ignores_relief(tmp_path, monkeypatch):
    assert _band_m(tmp_path, monkeypatch, 200, fixed=100) == pytest.approx(100, abs=45)


def test_small_holes_get_a_narrow_margin(tmp_path, monkeypatch):
    west, south, east, north = bct.padded(bct.tile_box(TILE))
    hole = shapely.box(-103.5, 19.7, -103.5 + 4 * bct.CELL, 19.7 + 4 * bct.CELL)    # ≈170 m
    cov = shapely.box(west, south, east, north).difference(hole)
    parts = tmp_path / "parts.bin"
    with open(parts, "wb") as f:
        for wkb in shapely.to_wkb(shapely.get_parts(cov)):
            f.write(struct.pack("<I", len(wkb)) + wkb)
    relief = tmp_path / "relief.npz"
    np.savez_compressed(relief, **{"-104_19": np.full((400, 400), 5, dtype=np.uint8)})   # flat
    monkeypatch.setattr(bct, "_RELIEF", Relief(relief))
    bct.classify_grid((TILE, str(parts), None, str(tmp_path)))
    classes = np.load(tmp_path / f"{TILE[0]}_{TILE[1]}.npz")["c"]
    # 4x4 hole: a ~50 m ring around it, the hole itself "possible"
    assert 10 < (classes == 2).sum() < 45        # ring of ~1 cell (~50 m), not 250 m
    assert (classes == 4).sum() >= 12
