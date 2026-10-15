"""
Propagation Models
==================
Free-Space Path Loss (ITU-R P.525), Fresnel zone calculations,
knife-edge diffraction (ITU-R P.526), and clutter loss (ITU-R P.833).
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np
from utils.rf import wavelength
from config import SPEED_OF_LIGHT, ENVIRONMENT_PROFILES


def fspl(distance_m: float, freq_hz: float) -> float:
    """
    Free-Space Path Loss (ITU-R P.525).

    FSPL(dB) = 20·log10(d) + 20·log10(f) - 147.55
    """
    if distance_m <= 0:
        return 0.0
    return 20 * np.log10(distance_m) + 20 * np.log10(freq_hz) - 147.55


def fresnel_radius(
    n: int,
    d_total_m: float,
    d1_m: float,
    freq_hz: float,
) -> float:
    """
    Radius of the n-th Fresnel zone at a point along the path.
    r_n = sqrt(n · λ · d1 · d2 / d_total)
    """
    d2_m = d_total_m - d1_m
    if d1_m <= 0 or d2_m <= 0 or d_total_m <= 0:
        return 0.0
    lam = wavelength(freq_hz)
    return np.sqrt(n * lam * d1_m * d2_m / d_total_m)


def max_fresnel_radius(d_total_m: float, freq_hz: float, n: int = 1) -> float:
    """Maximum Fresnel zone radius (occurs at midpoint)."""
    lam = wavelength(freq_hz)
    return 0.5 * np.sqrt(n * lam * d_total_m)


def knife_edge_diffraction_loss(v: float) -> float:
    """
    Knife-edge diffraction loss approximation (ITU-R P.526-15, Lee approx).

    v > 0 → obstruction protrudes above LOS.
    v < 0 → clearance below LOS.
    v = 0 → grazing (~6 dB).
    """
    if v < -0.78:
        return 0.0
    return 6.9 + 20 * np.log10(np.sqrt((v - 0.1) ** 2 + 1) + v - 0.1)


def fresnel_clearance_to_v(clearance_m: float, fresnel_r1: float) -> float:
    """Convert physical clearance to Fresnel-Kirchhoff v parameter."""
    if fresnel_r1 <= 0:
        return -999.0
    return -clearance_m * np.sqrt(2) / fresnel_r1


def fresnel_obstruction_loss(
    clearance_m: np.ndarray,
    fresnel_radii: np.ndarray,
    method: str = "dominant_knife_edge",
) -> tuple[float, np.ndarray]:
    """
    Calculate diffraction loss from partial Fresnel zone obstruction.

    Methods:
    1. "dominant_knife_edge" — single worst-point knife edge (ITU-R P.526)
    2. "deygout" — Deygout multi-edge method
    3. "empirical_fresnel" — smooth empirical model for rural terrain
    """
    n = len(clearance_m)
    v_params = np.full(n, -999.0)

    inner_mask = fresnel_radii > 0
    for i in range(n):
        if inner_mask[i]:
            v_params[i] = fresnel_clearance_to_v(clearance_m[i], fresnel_radii[i])

    if not inner_mask.any():
        return 0.0, v_params

    if method == "empirical_fresnel":
        with np.errstate(divide="ignore", invalid="ignore"):
            clearance_pct = np.where(
                inner_mask,
                (clearance_m / fresnel_radii) * 100,
                np.inf,
            )
        min_pct = float(np.min(clearance_pct[inner_mask]))

        if min_pct >= 60.0:
            return 0.0, v_params
        elif min_pct >= 0.0:
            fraction = (60.0 - min_pct) / 60.0
            loss = 6.9 * fraction ** 1.5
            return loss, v_params
        else:
            worst_v = float(np.max(v_params[inner_mask]))
            return knife_edge_diffraction_loss(worst_v), v_params

    elif method == "deygout":
        inner_v = v_params.copy()
        inner_v[~inner_mask] = -999.0
        dom_idx = int(np.argmax(inner_v))
        dom_v = float(inner_v[dom_idx])

        if dom_v < -0.78:
            return 0.0, v_params

        total_loss = knife_edge_diffraction_loss(dom_v)

        left_mask = inner_mask.copy()
        left_mask[dom_idx:] = False
        if left_mask.any():
            left_v = float(np.max(inner_v[left_mask]))
            if left_v > -0.78:
                total_loss += knife_edge_diffraction_loss(left_v)

        right_mask = inner_mask.copy()
        right_mask[:dom_idx + 1] = False
        if right_mask.any():
            right_v = float(np.max(inner_v[right_mask]))
            if right_v > -0.78:
                total_loss += knife_edge_diffraction_loss(right_v)

        return total_loss, v_params

    else:
        # dominant_knife_edge (default)
        worst_v = float(np.max(v_params[inner_mask]))
        if worst_v < -0.78:
            return 0.0, v_params
        return knife_edge_diffraction_loss(worst_v), v_params


def clutter_loss(environment: str) -> float:
    """
    Clutter/environment loss per ITU-R P.833.

    Parameters
    ----------
    environment : str
        Environment profile name (key in ENVIRONMENT_PROFILES).

    Returns
    -------
    float
        Additional loss in dB.
    """
    profile = ENVIRONMENT_PROFILES.get(environment, {})
    return profile.get("clutter_loss_db", 0.0)


# ──────────────────────────────────────────────────────────────
# Placeholder for Longley-Rice (ITM) integration
# ──────────────────────────────────────────────────────────────
class LongleyRiceModel:
    """Stub for ITM / Longley-Rice. Future integration."""

    def __init__(self, climate: int = 5, polarization: int = 0):
        self.climate = climate
        self.polarization = polarization
        self._available = False

    @property
    def is_available(self) -> bool:
        return self._available

    def path_loss(self, elevations, d_total_m, h_tx_m, h_rx_m, freq_mhz):
        if not self._available:
            return fspl(d_total_m, freq_mhz * 1e6)
        raise NotImplementedError("ITM library not yet integrated")
