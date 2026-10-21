"""Tests for core/cellular.py with a small synthetic CRT-style GeoPackage."""

import math

import numpy as np
import pytest
import shapely

geopandas = pytest.importorskip("geopandas")

from core.cellular import CoverageSource, find_sources


@pytest.fixture
def coverage_file(tmp_path):
    # Two disjoint areas like the CRT files (NIVEL -100 / -101), one with a hole
    big = shapely.Polygon([(-103.50, 19.60), (-103.40, 19.60), (-103.40, 19.70), (-103.50, 19.70)],
                          holes=[[(-103.46, 19.64), (-103.44, 19.64), (-103.44, 19.66), (-103.46, 19.66)]])
    small = shapely.box(-103.30, 19.60, -103.29, 19.61)
    gdf = geopandas.GeoDataFrame(
        {"NIVEL": [-100.0, -101.0], "REGION": ["R5", "R5"], "archivo_origen": ["a.TAB", "a.TAB"]},
        geometry=[shapely.MultiPolygon([big]), shapely.MultiPolygon([small])], crs="EPSG:4326")
    path = tmp_path / "RADIOMOVIL_4G_GARANTIZADA_2T_2026.gpkg"
    gdf.to_file(path, layer="Radiomovil_Dipsa_4G_Garantizada_2do_Trimestre", driver="GPKG")
    return path


def test_name_parsing(coverage_file, tmp_path):
    s = CoverageSource(coverage_file)
    assert (s.operator, s.tech, s.kind, s.quarter) == ("Telcel", "4G", "guaranteed", "Q2 2026")
    (tmp_path / "notes.gpkg").write_bytes(b"")
    assert [x.path.name for x in find_sources(tmp_path)] == [coverage_file.name]


def test_inside_outside_and_level(coverage_file):
    s = CoverageSource(coverage_file)
    inside = s.status_at(19.62, -103.48)
    assert inside.covered and inside.level_dbm == -100.0 and inside.nearby_share > 0.99
    assert s.status_at(19.605, -103.295).level_dbm == -101.0
    hole = s.status_at(19.65, -103.45)          # centre of the 2 km hole
    assert not hole.covered
    assert hole.nearest_m == pytest.approx(0.01 * 111_320 * math.cos(math.radians(19.65)), rel=0.02)
    far = s.status_at(19.40, -103.10)
    assert not far.covered and far.nearest_m is None and far.nearby_share == 0


def test_partial_surroundings(coverage_file):
    s = CoverageSource(coverage_file)
    # On the west edge: about half of the 300 m circle is covered
    edge = s.status_at(19.65, -103.50)
    assert 0.4 < edge.nearby_share < 0.6


def test_disk_cache_is_reused(coverage_file):
    s = CoverageSource(coverage_file)
    s.status_at(19.62, -103.48)
    assert any(s.cache_dir.glob("*.json"))
    coverage_file.rename(coverage_file.with_suffix(".moved"))   # source gone: must use the cache
    s2 = CoverageSource(coverage_file, cache_dir=s.cache_dir)
    assert s2.status_at(19.62, -103.48).covered


def test_geometries_clip_to_bbox(coverage_file):
    s = CoverageSource(coverage_file)
    bbox = (-103.49, 19.61, -103.41, 19.69)
    pieces = s.geometries(bbox)
    assert pieces and all(shapely.box(*bbox).buffer(1e-9).covers(g) for _, g in pieces)
