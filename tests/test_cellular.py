"""Tests for core/cellular.py with a small synthetic CRT-style GeoPackage."""

import math

import numpy as np
import pytest
import shapely

geopandas = pytest.importorskip("geopandas")

from core.cellular import CoverageSource, Relief, find_sources, margin_for_relief


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


def test_margin_near_a_gap(coverage_file):
    """Without relief data, covered points closer than EDGE_MARGIN_M (250 m) to a gap are not certain."""
    from core.cellular import EDGE_MARGIN_M
    s = CoverageSource(coverage_file, relief=Relief(None))
    deg_lon = 111_320 * math.cos(math.radians(19.62))
    near = s.status_at(19.62, -103.50 + 200 / deg_lon)    # 200 m inside the west edge
    far = s.status_at(19.62, -103.50 + 300 / deg_lon)     # 300 m inside
    assert near.covered and not near.margin_ok
    assert far.covered and far.margin_ok
    assert EDGE_MARGIN_M == 250


def test_split_by_margin_partitions_coverage():
    from core.cellular import split_by_margin
    cov = shapely.box(0, 0, 1000, 600).difference(shapely.box(400, 200, 450, 250))   # 50 m hole
    certain, edge = split_by_margin(cov, 100)
    assert certain.intersection(edge).area < 1e-6
    assert abs(certain.union(edge).area - cov.area) < 1e-3
    assert not certain.intersects(shapely.Point(425, 300))      # within 100 m of the hole
    assert certain.contains(shapely.Point(700, 300))


def test_margin_for_relief():
    assert margin_for_relief(0) == pytest.approx(500)
    assert margin_for_relief(15) == pytest.approx(500)
    assert margin_for_relief(120) == pytest.approx(250)
    assert margin_for_relief(255) == pytest.approx(250)
    m = margin_for_relief([20, 40, 80])
    assert 500 > m[0] > m[1] > m[2] > 250
    assert margin_for_relief(np.nan) == 250


def _relief_file(tmp_path, value):
    """Relief grid for the 1° tile of the fixtures (lon -104, lat 19), constant value."""
    path = tmp_path / "relief.npz"
    np.savez_compressed(path, **{"-104_19": np.full((400, 400), value, dtype=np.uint8)})
    return Relief(path)


def test_relief_lookup(tmp_path):
    r = _relief_file(tmp_path, 7)
    assert r.available
    vals = r.at([-103.5, -103.5, 10.0], [19.62, 19.62, 10.0])
    assert vals[0] == 7 and np.isnan(vals[2])
    assert np.isnan(Relief(None).at(-103.5, 19.62))


@pytest.mark.parametrize("relief, inside_m, ok", [
    (5, 450, False),      # flat: 500 m margin
    (5, 530, True),
    (200, 280, True),     # steep: 250 m margin
    (200, 220, False),
])
def test_margin_follows_relief(coverage_file, tmp_path, relief, inside_m, ok):
    s = CoverageSource(coverage_file, relief=_relief_file(tmp_path, relief))
    deg_lon = 111_320 * math.cos(math.radians(19.62))
    hit = s.status_at(19.62, -103.50 + inside_m / deg_lon)
    assert hit.covered and hit.margin_ok is ok
    if inside_m < 500:
        assert hit.edge_m == pytest.approx(inside_m, abs=3)
        assert hit.margin_m == pytest.approx(margin_for_relief(relief))
    else:
        assert hit.edge_m is None          # no edge within the largest margin


def test_small_hole_gets_the_steep_margin(tmp_path):
    """On flat ground a 150 m hole is a local obstruction: 100 m margin, not 500 m."""
    deg_lon = 111_320 * math.cos(math.radians(19.65))
    hole = shapely.box(-103.45, 19.65, -103.45 + 150 / deg_lon, 19.65 + 150 / 111_320)
    area = shapely.box(-103.50, 19.60, -103.40, 19.70).difference(hole)
    gdf = geopandas.GeoDataFrame({"NIVEL": [-100.0], "REGION": ["R5"]},
                                 geometry=[shapely.MultiPolygon([area])], crs="EPSG:4326")
    path = tmp_path / "RADIOMOVIL_4G_GARANTIZADA_2T_2026.gpkg"
    gdf.to_file(path, driver="GPKG")
    s = CoverageSource(path, relief=_relief_file(tmp_path, 5))      # flat
    hit = s.status_at(19.65 + 75 / 111_320, -103.45 - 130 / deg_lon)   # 130 m west of the hole
    assert hit.covered and hit.margin_ok
    assert hit.edge_m == pytest.approx(130, abs=3) and hit.margin_m == 100
    near = s.status_at(19.65 + 75 / 111_320, -103.45 - 70 / deg_lon)
    assert not near.margin_ok
