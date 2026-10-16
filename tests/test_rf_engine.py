"""
Verea RF Engine Test Suite
================================
Tests covering FSPL, Fresnel zones, diffraction, clutter (including
agricultural profiles), fading margin, device models, link budget,
multi-gateway routing, failover, and geographic utilities.

Run:  python -m pytest tests/test_rf_engine.py -v
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np
import pytest

from config import (
    SPEED_OF_LIGHT, DEFAULT_FREQUENCY_HZ, SX1276_SENSITIVITY,
    ENVIRONMENT_PROFILES, FLAT_TERRAIN_ELEVATION_M,
)
from core.devices import Gateway, EndNode, WeatherStation, Antenna
from core.propagation import (
    fspl, max_fresnel_radius, knife_edge_diffraction_loss,
    fresnel_obstruction_loss, clutter_loss,
)
from core.terrain import TerrainProfile
from core.link_budget import calculate_link_budget, LinkBudgetResult
from utils.geo import haversine, interpolate_coordinates, earth_curvature_offset, los_height_at_point
from utils.rf import wavelength, thermal_noise_dbm, db_to_linear, linear_to_db


# ══════════════════════════════════════════════════════════════
# 1. FSPL Tests
# ══════════════════════════════════════════════════════════════

class TestFSPL:
    def test_fspl_1km_915mhz(self):
        """FSPL at 1 km, 915 MHz ≈ 91.7 dB (ITU-R P.525)."""
        loss = fspl(1000, 915e6)
        assert 91.0 < loss < 92.5, f"FSPL 1km@915MHz = {loss:.1f} dB"

    def test_fspl_10km_915mhz(self):
        """FSPL at 10 km, 915 MHz ≈ 111.7 dB."""
        loss = fspl(10000, 915e6)
        assert 111.0 < loss < 112.5, f"FSPL 10km@915MHz = {loss:.1f} dB"

    def test_fspl_zero_distance(self):
        """FSPL at 0 m should return 0 (or near-zero)."""
        loss = fspl(0.001, 915e6)
        assert loss < 10, "Near-zero distance should give minimal FSPL"

    def test_fspl_inverse_square(self):
        """Doubling distance should add ~6 dB."""
        loss_1 = fspl(1000, 915e6)
        loss_2 = fspl(2000, 915e6)
        delta = loss_2 - loss_1
        assert 5.8 < delta < 6.2, f"Distance doubling adds {delta:.1f} dB (expected ~6)"


# ══════════════════════════════════════════════════════════════
# 2. Fresnel Zone Tests
# ══════════════════════════════════════════════════════════════

class TestFresnel:
    def test_max_fresnel_radius_midpoint(self):
        """F1 radius at midpoint of 1 km link at 915 MHz ≈ 9.5 m."""
        r = max_fresnel_radius(1000, 915e6)
        assert 8.0 < r < 11.0, f"Fresnel radius = {r:.1f} m"

    def test_fresnel_obstruction_dominant_knife_edge(self):
        """Clear path should give ~0 dB diffraction loss."""
        # 50 points, all well below LOS
        clearance = np.full(50, 10.0)
        radii = np.full(50, 5.0)
        loss, _ = fresnel_obstruction_loss(clearance, radii, method="dominant_knife_edge")
        assert loss < 1.0, f"Clear path diffraction = {loss:.1f} dB"

    def test_fresnel_obstruction_blocked(self):
        """Fully blocked path should have significant diffraction loss."""
        clearance = np.full(50, -5.0)  # Below LOS
        radii = np.full(50, 5.0)
        loss, _ = fresnel_obstruction_loss(clearance, radii, method="dominant_knife_edge")
        assert loss > 5.0, f"Blocked path diffraction = {loss:.1f} dB"


# ══════════════════════════════════════════════════════════════
# 3. Diffraction Tests
# ══════════════════════════════════════════════════════════════

class TestDiffraction:
    def test_knife_edge_positive_v(self):
        """Positive v (obstructed) should give > 6 dB loss."""
        loss = knife_edge_diffraction_loss(1.0)
        assert loss > 6.0

    def test_knife_edge_negative_v(self):
        """Negative v (clear path) should give < 1 dB loss."""
        loss = knife_edge_diffraction_loss(-1.0)
        assert loss < 1.0

    def test_knife_edge_zero_v(self):
        """v=0 (grazing) should give ~6 dB loss."""
        loss = knife_edge_diffraction_loss(0.0)
        assert 5.5 < loss < 6.5, f"Grazing loss = {loss:.1f} dB"


# ══════════════════════════════════════════════════════════════
# 4. Clutter Loss Tests
# ══════════════════════════════════════════════════════════════

class TestClutter:
    def test_rural_no_clutter(self):
        assert clutter_loss("Rural / Open") == 0.0

    def test_cultivo_bajo(self):
        assert clutter_loss("Cultivo bajo") == 5.0

    def test_orchard_clutter(self):
        assert clutter_loss("Orchard / Trees") == 12.0

    def test_huerta_densa(self):
        assert clutter_loss("Huerta densa") == 15.0

    def test_cultivo_alto_milpa(self):
        assert clutter_loss("Cultivo alto / Milpa") == 20.0

    def test_suburban_clutter(self):
        assert clutter_loss("Suburban") == 15.0

    def test_urban_clutter(self):
        assert clutter_loss("Urban") == 18.0

    def test_unknown_environment(self):
        """Unknown environment should default to 0 dB."""
        assert clutter_loss("Unknown") == 0.0


# ══════════════════════════════════════════════════════════════
# 5. Device Model Tests
# ══════════════════════════════════════════════════════════════

class TestDevices:
    def test_gateway_defaults(self):
        gw = Gateway()
        assert gw.tx_power_dbm == 27.0
        assert gw.antenna.gain_dbi == 6.0
        assert gw.antenna.height_m == 10.0
        assert gw.online is True

    def test_gateway_offline(self):
        gw = Gateway(online=False)
        assert gw.online is False

    def test_endnode_antenna_height_asl(self):
        node = EndNode(altitude_m=1500.0)
        node.antenna = Antenna(height_m=1.5)
        assert node.antenna_height_asl == 1501.5

    def test_weather_station_defaults(self):
        ws = WeatherStation()
        assert ws.tx_power_dbm == 19
        assert ws.spreading_factor == 10
        assert ws.antenna.gain_dbi == 2.0
        assert ws.antenna.height_m == 3.0
        assert ws.model == "SenseCAP S2120 8-in-1"

    def test_weather_station_is_endnode(self):
        ws = WeatherStation()
        assert isinstance(ws, EndNode)


# ══════════════════════════════════════════════════════════════
# 6. Link Budget Tests
# ══════════════════════════════════════════════════════════════

class TestLinkBudget:
    def _make_flat_terrain(self, dist_m=1000, elev=1500.0, n=50):
        """Create flat terrain at given elevation."""
        return TerrainProfile.from_manual_elevations(
            21.0, -102.0, 21.009, -102.0,
            np.full(n, elev),
        )

    def test_short_link_viable(self):
        """1 km flat link at SF7 should be viable with large margin."""
        gw = Gateway(altitude_m=1500.0)
        node = EndNode(altitude_m=1500.0)
        terrain = self._make_flat_terrain(1000)
        result = calculate_link_budget(gw, node, terrain, fading_margin_db=0.0)
        assert result.link_viable, f"1km link should be viable, margin={result.link_margin_db:.1f}"
        assert result.link_margin_db > 20

    def test_los_obstruction_is_warning(self):
        """LOS obstruction should NOT auto-fail a viable link."""
        gw = Gateway(altitude_m=1500.0, antenna=Antenna(height_m=15.0))
        node = EndNode(altitude_m=1500.0, antenna=Antenna(height_m=1.5))
        # Terrain with a small hill in the middle
        elevations = np.full(50, 1500.0)
        elevations[25] = 1520.0  # Hill slightly above antenna level
        terrain = TerrainProfile.from_manual_elevations(
            21.0, -102.0, 21.009, -102.0, elevations,
        )
        result = calculate_link_budget(gw, node, terrain, fading_margin_db=0.0)
        # Should still have positive margin and be viable
        # (diffraction penalty applied, but at short distance margin is huge)
        assert result.link_margin_db > 0

    def test_margin_threshold(self):
        """Link with margin below threshold should fail."""
        gw = Gateway(altitude_m=1500.0)
        node = EndNode(altitude_m=1500.0)
        terrain = self._make_flat_terrain(1000)
        # With very high threshold, even a good link fails
        result = calculate_link_budget(gw, node, terrain, margin_threshold=200.0, fading_margin_db=0.0)
        assert not result.link_viable

    def test_clutter_in_total_path_loss(self):
        """Urban clutter should increase total path loss."""
        gw = Gateway(altitude_m=1500.0)
        node = EndNode(altitude_m=1500.0)
        terrain = self._make_flat_terrain(1000)

        result_rural = calculate_link_budget(gw, node, terrain, environment="Rural / Open", fading_margin_db=0.0)
        result_urban = calculate_link_budget(gw, node, terrain, environment="Urban", fading_margin_db=0.0)

        assert result_urban.total_path_loss_db > result_rural.total_path_loss_db
        delta = result_urban.total_path_loss_db - result_rural.total_path_loss_db
        assert abs(delta - 18.0) < 1.0, f"Urban adds {delta:.1f} dB (expected ~18)"

    def test_fading_margin_reduces_margin_only(self):
        """Fading margin reduces link margin but not predicted RSSI/SNR."""
        gw = Gateway(altitude_m=1500.0)
        node = EndNode(altitude_m=1500.0)
        terrain = self._make_flat_terrain(1000)

        r_no_fading = calculate_link_budget(gw, node, terrain, fading_margin_db=0.0)
        r_with_fading = calculate_link_budget(gw, node, terrain, fading_margin_db=8.0)

        assert r_with_fading.total_path_loss_db == r_no_fading.total_path_loss_db
        assert r_with_fading.rx_power_dbm == r_no_fading.rx_power_dbm
        assert r_with_fading.snr_db == r_no_fading.snr_db
        delta = r_no_fading.link_margin_db - r_with_fading.link_margin_db
        assert abs(delta - 8.0) < 0.1, f"Fading reduces margin by {delta:.1f} dB (expected 8.0)"
        assert r_with_fading.fading_margin_db == 8.0

    def test_milpa_clutter(self):
        """Cultivo alto / Milpa should add 20 dB clutter."""
        gw = Gateway(altitude_m=1500.0)
        node = EndNode(altitude_m=1500.0)
        terrain = self._make_flat_terrain(1000)

        r_rural = calculate_link_budget(gw, node, terrain, environment="Rural / Open", fading_margin_db=0.0)
        r_milpa = calculate_link_budget(gw, node, terrain, environment="Cultivo alto / Milpa", fading_margin_db=0.0)

        delta = r_milpa.total_path_loss_db - r_rural.total_path_loss_db
        assert abs(delta - 20.0) < 1.0, f"Milpa adds {delta:.1f} dB (expected ~20)"

    def test_gateway_name_in_result(self):
        """Result should carry the gateway name."""
        gw = Gateway(name="MyGW", altitude_m=1500.0)
        node = EndNode(altitude_m=1500.0)
        terrain = self._make_flat_terrain()
        result = calculate_link_budget(gw, node, terrain, fading_margin_db=0.0)
        assert result.gateway_name == "MyGW"


# ══════════════════════════════════════════════════════════════
# 7. Multi-Gateway Routing & Failover
# ══════════════════════════════════════════════════════════════

class TestMultiGateway:
    def test_offline_gateway_skipped(self):
        """route_to_best_gateway should skip offline gateways."""
        from core.link_budget import route_to_best_gateway

        gw_online = Gateway(name="GW-Online", lat=21.0, lon=-102.0,
                            altitude_m=1500.0, online=True)
        gw_offline = Gateway(name="GW-Offline", lat=21.001, lon=-102.001,
                             altitude_m=1500.0, online=False)
        node = EndNode(lat=21.005, lon=-102.005, altitude_m=1500.0)

        result = route_to_best_gateway(
            [gw_online, gw_offline], node, n_terrain_points=20,
        )
        assert result is not None
        assert result.gateway_name == "GW-Online"

    def test_all_offline_returns_none(self):
        """All gateways offline should return None."""
        from core.link_budget import route_to_best_gateway

        gw1 = Gateway(name="GW-1", online=False)
        gw2 = Gateway(name="GW-2", online=False)
        node = EndNode(lat=21.005, lon=-102.005)

        result = route_to_best_gateway([gw1, gw2], node, n_terrain_points=20)
        assert result is None


# ══════════════════════════════════════════════════════════════
# 8. Geographic Utility Tests
# ══════════════════════════════════════════════════════════════

class TestGeo:
    def test_haversine_known_distance(self):
        """Aguascalientes to Guadalajara ≈ 178 km."""
        d = haversine(21.88, -102.30, 20.67, -103.35)
        d_km = d / 1000
        assert 170 < d_km < 190, f"Distance = {d_km:.1f} km"

    def test_haversine_zero(self):
        """Same point should give 0 distance."""
        assert haversine(21.0, -102.0, 21.0, -102.0) == pytest.approx(0.0, abs=0.1)

    def test_interpolate_count(self):
        coords = interpolate_coordinates(21.0, -102.0, 22.0, -103.0, 50)
        assert len(coords) == 50

    def test_interpolate_endpoints(self):
        coords = interpolate_coordinates(21.0, -102.0, 22.0, -103.0, 10)
        assert coords[0] == pytest.approx((21.0, -102.0), abs=1e-6)
        assert coords[-1] == pytest.approx((22.0, -103.0), abs=1e-6)

    def test_earth_curvature_10km(self):
        """At 10 km total, midpoint bulge ≈ 1.47 m (k=4/3)."""
        bulge = earth_curvature_offset(5000, 5000)
        assert 1.0 < bulge < 2.0, f"Bulge = {bulge:.2f} m"

    def test_los_height_midpoint(self):
        h = los_height_at_point(100.0, 200.0, 1000.0, 500.0)
        assert h == pytest.approx(150.0, abs=0.1)


# ══════════════════════════════════════════════════════════════
# 9. RF Utility Tests
# ══════════════════════════════════════════════════════════════

class TestRF:
    def test_wavelength_915mhz(self):
        """915 MHz → λ ≈ 0.328 m."""
        lam = wavelength(915e6)
        assert 0.32 < lam < 0.34

    def test_db_roundtrip(self):
        """dB ↔ linear conversion roundtrip."""
        original = 3.0
        assert linear_to_db(db_to_linear(original)) == pytest.approx(original, abs=0.01)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])


# ═══════════════════════════════════════════════════════════════
# Longley-Rice (ITM)
# ═══════════════════════════════════════════════════════════════
class TestITM:
    """ITM must be more pessimistic than free space on long, low-antenna paths."""

    def _terrain(self, distance_m, elevations):
        from utils.geo import interpolate_coordinates
        n = len(elevations)
        lat2 = 21.0 + distance_m / 111_320
        return TerrainProfile(
            lat1=21.0, lon1=-102.0, lat2=lat2, lon2=-102.0,
            elevations=np.asarray(elevations, dtype=float),
            distances=np.linspace(0, distance_m, n),
            coordinates=interpolate_coordinates(21.0, -102.0, lat2, -102.0, n),
            n_points=n,
        )

    def test_itm_short_path_falls_back(self):
        from core.propagation import itm_path_loss
        assert itm_path_loss(np.full(50, 1500.0), 800, 10, 1.5, 915e6) is None

    def test_itm_long_flat_path_exceeds_fspl(self):
        """20 km over flat ground with a 1.5 m node: ground reflection adds >15 dB."""
        from core.propagation import itm_path_loss
        loss = itm_path_loss(np.full(100, 1500.0), 20_000, 10, 1.5, 915e6)
        assert loss is not None
        assert loss > fspl(20_000, 915e6) + 15

    def test_itm_mountain_worse_than_flat(self):
        from core.propagation import itm_path_loss
        flat = np.full(100, 1500.0)
        ridge = flat.copy()
        ridge[40:60] += 400 * np.sin(np.linspace(0, np.pi, 20))
        l_flat = itm_path_loss(flat, 15_000, 10, 1.5, 915e6)
        l_ridge = itm_path_loss(ridge, 15_000, 10, 1.5, 915e6)
        assert l_ridge > l_flat + 10

    def test_link_budget_uses_itm_by_default(self):
        gw = Gateway(altitude_m=1500.0)
        node = EndNode(altitude_m=1500.0)
        terrain = self._terrain(18_000, np.full(100, 1500.0))
        r_itm = calculate_link_budget(gw, node, terrain, fading_margin_db=0.0)
        r_simple = calculate_link_budget(gw, node, terrain, fading_margin_db=0.0,
                                         propagation_model="simple")
        assert r_itm.propagation_model == "itm"
        assert r_simple.propagation_model == "simple"
        assert r_itm.total_path_loss_db > r_simple.total_path_loss_db + 15
