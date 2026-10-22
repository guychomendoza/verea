"""
Link Budget Calculator
======================
Orchestrates all RF calculations: EIRP, path loss, terrain analysis,
diffraction, clutter loss, and link viability.

Includes multi-gateway routing with automatic failover.

CRITICAL FIXES APPLIED:
- Terrain direction: GW at position 0, Node at position -1
- h_tx_asl = gateway.antenna_height_asl (not node)
- h_rx_asl = node.antenna_height_asl (not gateway)
- LOS obstruction is WARNING only, not auto-fail
- Configurable margin threshold
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from dataclasses import dataclass
from typing import Optional
import numpy as np

from core.devices import Gateway, EndNode
from core.terrain import TerrainProfile, ElevationAPI
from core.propagation import (
    fspl, fresnel_obstruction_loss, clutter_loss, itm_path_loss, short_path_excess_loss,
)
from config import (
    NOISE_FLOOR_DBM,
    SX1276_SENSITIVITY,
    SNR_REQUIREMENTS,
    REQUIRED_LINK_MARGIN_DB,
    MIN_FRESNEL_CLEARANCE_PCT,
    DEFAULT_DIFFRACTION_METHOD,
    DEFAULT_FADING_MARGIN_DB,
    DEFAULT_PROPAGATION_MODEL,
)


@dataclass
class LinkBudgetResult:
    """Complete link budget calculation result."""

    # TX side
    tx_power_dbm: float
    tx_antenna_gain_dbi: float
    tx_cable_loss_db: float
    eirp_dbm: float

    # Path
    distance_m: float
    fspl_db: float
    diffraction_loss_db: float
    clutter_loss_db: float
    total_path_loss_db: float
    frequency_hz: float

    # RX side
    rx_antenna_gain_dbi: float
    rx_cable_loss_db: float
    rx_power_dbm: float
    sensitivity_dbm: float
    spreading_factor: int

    # Margins
    fading_margin_db: float
    link_margin_db: float
    snr_db: float
    snr_required_db: float

    # Terrain analysis
    fresnel_min_clearance_pct: float
    los_obstructed: bool
    worst_point_distance_m: float
    diffraction_method: str

    # Verdict
    link_viable: bool
    viability_reasons: list

    # Gateway info (for multi-GW routing)
    gateway_name: str = ""

    # Loss over free space from terrain/ground (ITM) or knife-edge (simple)
    terrain_loss_db: float = 0.0
    propagation_model: str = "simple"

    @property
    def distance_km(self) -> float:
        return self.distance_m / 1000

    @property
    def path_loss_db(self) -> float:
        return self.total_path_loss_db

    def summary(self) -> str:
        """Human-readable link budget summary."""
        status = "✅ VIABLE" if self.link_viable else "❌ NOT VIABLE"
        lines = [
            f"═══ Link Budget Report ═══",
            f"Status: {status}",
            f"",
            f"── TX ──",
            f"  TX Power:       {self.tx_power_dbm:+.1f} dBm",
            f"  Antenna Gain:   {self.tx_antenna_gain_dbi:+.1f} dBi",
            f"  Cable Loss:     {self.tx_cable_loss_db:.1f} dB",
            f"  EIRP:           {self.eirp_dbm:+.1f} dBm",
            f"",
            f"── Path ──",
            f"  Distance:       {self.distance_km:.2f} km",
            f"  Frequency:      {self.frequency_hz/1e6:.1f} MHz",
            f"  FSPL:           {self.fspl_db:.1f} dB",
            f"  Terrain loss:   {self.terrain_loss_db:+.1f} dB  ({self.propagation_model})",
            f"  Clutter:        {self.clutter_loss_db:+.1f} dB",
            f"  Total Path Loss:{self.total_path_loss_db:.1f} dB",
            f"",
            f"── RX ──",
            f"  Antenna Gain:   {self.rx_antenna_gain_dbi:+.1f} dBi",
            f"  Cable Loss:     {self.rx_cable_loss_db:.1f} dB",
            f"  RX Power:       {self.rx_power_dbm:+.1f} dBm",
            f"  Sensitivity:    {self.sensitivity_dbm:+.1f} dBm (SF{self.spreading_factor})",
            f"",
            f"── Margins ──",
            f"  Fading Margin:  {self.fading_margin_db:.1f} dB (subtracted from link margin)",
            f"  Link Margin:    {self.link_margin_db:+.1f} dB",
            f"  SNR:            {self.snr_db:+.1f} dB (req: {self.snr_required_db:+.1f} dB)",
            f"",
            f"── Terrain ──",
            f"  LOS Obstructed: {'YES ⚠ (warning — diffraction penalty applied)' if self.los_obstructed else 'No'}",
            f"  Fresnel Clear.: {self.fresnel_min_clearance_pct:.0f}% (min {MIN_FRESNEL_CLEARANCE_PCT:.0f}%)",
        ]
        if self.diffraction_loss_db > 0:
            lines.append(f"  ⚠ Diffraction penalty applied: {self.diffraction_loss_db:.1f} dB")
        if not self.link_viable:
            lines.append(f"")
            lines.append(f"── Issues ──")
            for reason in self.viability_reasons:
                lines.append(f"  ⚠ {reason}")
        return "\n".join(lines)


def calculate_link_budget(
    gateway: Gateway,
    node: EndNode,
    terrain: TerrainProfile,
    diffraction_method: str = DEFAULT_DIFFRACTION_METHOD,
    environment: str = "Rural / Open",
    margin_threshold: float = 3.0,
    fading_margin_db: float = DEFAULT_FADING_MARGIN_DB,
    propagation_model: str = DEFAULT_PROPAGATION_MODEL,
) -> LinkBudgetResult:
    """
    Full link budget calculation for a Gateway↔EndNode pair.

    TERRAIN DIRECTION: Gateway at position 0, Node at position -1.
    Therefore:
      h_tx_asl = gateway.antenna_height_asl
      h_rx_asl = node.antenna_height_asl

    LOS obstruction does NOT auto-fail the link. The diffraction
    penalty is already factored into the margin calculation.
    Only insufficient margin or SNR causes failure.
    """
    # ── TX Side (uplink: node → gateway) ──
    tx_power = node.tx_power_dbm
    tx_gain = node.antenna.gain_dbi
    tx_cable_loss = node.antenna.cable_loss_db
    eirp = tx_power + tx_gain - tx_cable_loss

    # ── Path ──
    distance = terrain.total_distance
    freq = node.frequency_hz
    fspl_loss = fspl(distance, freq)

    # ── Clutter Loss ──
    env_clutter = clutter_loss(environment)

    # ── Terrain Analysis ──
    # CRITICAL: GW is at position 0, Node is at position -1
    los_analysis = terrain.compute_los_clearance(
        h_tx_asl=gateway.antenna_height_asl,   # GW at pos 0
        h_rx_asl=node.antenna_height_asl,       # Node at pos -1
        freq_hz=freq,
        diffraction_method=diffraction_method,
    )

    fresnel_clearance = los_analysis["min_clearance_pct"]
    los_obstructed = los_analysis["obstructed"]
    worst_idx = los_analysis["worst_point_idx"]
    worst_distance = float(terrain.distances[worst_idx])

    # ── Diffraction Penalty ──
    diffraction_loss_val, v_params = fresnel_obstruction_loss(
        clearance_m=los_analysis["clearance_m"],
        fresnel_radii=los_analysis["fresnel_radii"],
        method=diffraction_method,
    )

    # Fading margin is a reserve, not a physical loss: it is subtracted from
    # the margins below so predicted RSSI/SNR stay comparable to field readings.
    # ── Terrain loss over free space ──
    # ITM (default) models ground reflection and multi-obstacle diffraction over
    # the real profile; the delta-Bullington short-path model (ITU-R P.526) does
    # the same more simply and also covers paths under ~1 km, where ITM does not
    # apply. With the low antennas of field sensors ITM is outside its comfort
    # zone: it swings 8-15 dB with the profile sampling and can come out ~12 dB
    # below P.526 on the same terrain. So the larger (more conservative) of the
    # two is used. The simple model only adds the knife-edge penalty (comparison).
    terrain_loss = diffraction_loss_val
    model_used = "simple"
    if propagation_model == "itm":
        short_loss = short_path_excess_loss(
            terrain.elevations, distance,
            gateway.antenna.height_m, node.antenna.height_m, freq,
        )
        itm_loss = itm_path_loss(
            terrain.elevations, distance,
            gateway.antenna.height_m, node.antenna.height_m, freq,
        )
        # Never better than free space
        itm_excess = None if itm_loss is None else max(itm_loss - fspl_loss, 0.0)
        if itm_excess is not None and itm_excess >= short_loss:
            terrain_loss, model_used = itm_excess, "itm"
        else:
            terrain_loss, model_used = short_loss, "short"

    total_path_loss = fspl_loss + terrain_loss + env_clutter

    # ── RX Side ──
    rx_gain = gateway.antenna.gain_dbi
    rx_cable_loss = gateway.antenna.cable_loss_db
    rx_power = eirp - total_path_loss + rx_gain - rx_cable_loss

    sf = node.spreading_factor
    sens_table = gateway.sensitivity or SX1276_SENSITIVITY
    sensitivity = sens_table.get(sf, SX1276_SENSITIVITY.get(sf, -123.0))
    snr_required = SNR_REQUIREMENTS.get(sf, -7.5)

    # ── Margins ──
    link_margin = rx_power - sensitivity - fading_margin_db
    snr = rx_power - NOISE_FLOOR_DBM

    # ── Viability Determination ──
    # LOS obstruction is a WARNING, not an auto-fail.
    # The diffraction penalty is already in the margin calculation.
    reasons = []
    viable = True
    model_name = {"itm": "ITM", "short": "ITU-R P.526", "simple": "simple"}.get(model_used, model_used)

    if link_margin < margin_threshold:
        viable = False
        reasons.append(
            f"Margen insuficiente: {link_margin:.1f} dB < umbral de {margin_threshold:.1f} dB"
        )

    if snr - fading_margin_db < snr_required:
        viable = False
        reasons.append(
            f"SNR demasiado baja: {snr:.1f} dB - {fading_margin_db:.1f} dB de reserva "
            f"< {snr_required:.1f} dB requeridos en SF{sf}"
        )

    # LOS obstruction is informational only
    if los_obstructed:
        reasons.append(
            f"Línea de vista obstruida (pérdida por terreno de {terrain_loss:.1f} dB ya aplicada, {model_name})"
        )

    if fresnel_clearance < MIN_FRESNEL_CLEARANCE_PCT:
        reasons.append(
            f"Despeje de Fresnel {fresnel_clearance:.0f}% < {MIN_FRESNEL_CLEARANCE_PCT:.0f}% "
            f"(+{terrain_loss:.1f} dB de pérdida por terreno aplicados, {model_name})"
        )

    return LinkBudgetResult(
        tx_power_dbm=tx_power,
        tx_antenna_gain_dbi=tx_gain,
        tx_cable_loss_db=tx_cable_loss,
        eirp_dbm=eirp,
        distance_m=distance,
        fspl_db=fspl_loss,
        diffraction_loss_db=diffraction_loss_val,
        clutter_loss_db=env_clutter,
        total_path_loss_db=total_path_loss,
        frequency_hz=freq,
        rx_antenna_gain_dbi=rx_gain,
        rx_cable_loss_db=rx_cable_loss,
        rx_power_dbm=rx_power,
        sensitivity_dbm=sensitivity,
        spreading_factor=sf,
        fading_margin_db=fading_margin_db,
        link_margin_db=link_margin,
        snr_db=snr,
        snr_required_db=snr_required,
        fresnel_min_clearance_pct=fresnel_clearance,
        los_obstructed=los_obstructed,
        worst_point_distance_m=worst_distance,
        diffraction_method=diffraction_method,
        link_viable=viable,
        viability_reasons=reasons,
        gateway_name=gateway.name,
        terrain_loss_db=terrain_loss,
        propagation_model=model_used,
    )


def route_to_best_gateway(
    gateways: list[Gateway],
    node: EndNode,
    diffraction_method: str = DEFAULT_DIFFRACTION_METHOD,
    environment: str = "Rural / Open",
    margin_threshold: float = 3.0,
    fading_margin_db: float = DEFAULT_FADING_MARGIN_DB,
    propagation_model: str = DEFAULT_PROPAGATION_MODEL,
    n_terrain_points: int = 100,
    elevation_api: Optional[ElevationAPI] = None,
) -> Optional[LinkBudgetResult]:
    """
    Multi-gateway routing with automatic failover.

    Evaluates the link budget to each ONLINE gateway and returns
    the best viable link (highest margin). If no viable link exists,
    returns the least-bad option.

    Skips gateways with online=False.

    TERRAIN DIRECTION: GW at position 0, Node at position -1.
    """
    if elevation_api is None:
        elevation_api = ElevationAPI()

    online_gateways = [gw for gw in gateways if gw.online]

    if not online_gateways:
        return None

    results = []
    for gw in online_gateways:
        try:
            # Terrain: GW (pos 0) → Node (pos -1)
            terrain = TerrainProfile.from_coordinates(
                gw.lat, gw.lon,
                node.lat, node.lon,
                n_points=n_terrain_points,
                api=elevation_api,
            )

            # Set ground elevations from terrain data
            gw.altitude_m = float(terrain.elevations[0])
            node.altitude_m = float(terrain.elevations[-1])

            result = calculate_link_budget(
                gw, node, terrain,
                diffraction_method=diffraction_method,
                environment=environment,
                margin_threshold=margin_threshold,
                fading_margin_db=fading_margin_db,
                propagation_model=propagation_model,
            )
            results.append(result)
        except Exception:
            continue

    if not results:
        return None

    # Prefer viable links, then highest margin
    viable_results = [r for r in results if r.link_viable]
    if viable_results:
        return max(viable_results, key=lambda r: r.link_margin_db)

    # No viable link — return the one with the best margin
    return max(results, key=lambda r: r.link_margin_db)
