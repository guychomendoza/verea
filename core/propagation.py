"""
Propagation Models
==================
Free-Space Path Loss (ITU-R P.525), Fresnel zone calculations,
knife-edge diffraction (ITU-R P.526), clutter loss (ITU-R P.833)
and the Longley-Rice irregular terrain model (ITM).
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from typing import Optional

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
# Longley-Rice / ITM (point-to-point mode)
# ──────────────────────────────────────────────────────────────
ITM_MIN_DISTANCE_M = 1000.0   # ITM is defined for 1–2000 km paths


def itm_path_loss(
    elevations: np.ndarray,
    distance_m: float,
    h_tx_agl: float,
    h_rx_agl: float,
    freq_hz: float,
    reliability_pct: float = 50.0,
    confidence_pct: float = 50.0,
    climate: int = 2,
    vertical_pol: bool = True,
) -> Optional[float]:
    """
    Basic transmission loss (dB) from the ITS Irregular Terrain Model.

    Unlike FSPL + knife-edge, ITM accounts for ground reflection over the
    real profile, multiple obstacles (two-horizon diffraction over rounded
    terrain) and troposcatter — the effects that make long, low-antenna
    agricultural links far weaker than free space suggests.

    Returns None when ITM does not apply (short path, invalid parameters),
    so the caller can fall back to the simple model.
    """
    if distance_m < ITM_MIN_DISTANCE_M or len(elevations) < 3:
        return None

    try:
        from itmlogic.misc.qerfi import qerfi
        from itmlogic.preparatory_subroutines.qlrpfl import qlrpfl
        from itmlogic.statistics.avar import avar
    except ImportError:
        return None

    fmhz = freq_hz / 1e6
    prop = {
        "fmhz": fmhz,
        "hg": [float(h_tx_agl), float(h_rx_agl)],
        "ipol": 1 if vertical_pol else 0,
        "d": distance_m / 1000,
        "eps": 15.0,       # average ground permittivity
        "sgm": 0.005,      # average ground conductivity (S/m)
        "klim": climate,   # 2 = continental subtropical (central Mexico)
        "ens0": 314.0,     # surface refractivity (N-units)
        "lvar": 5,
        "gma": 157e-9,
        "kwx": 0,
        "klimx": 0,
        "mdvarx": 11,      # point-to-point, accidental mode
    }
    n = len(elevations)
    prop["pfl"] = [n - 1, distance_m / (n - 1)] + [float(e) for e in elevations]
    prop["wn"] = fmhz / 47.7
    prop["ens"] = prop["ens0"]
    prop["gme"] = prop["gma"] * (1 - 0.04665 * np.exp(prop["ens"] / 179.3))
    zq = complex(prop["eps"], 376.62 * prop["sgm"] / prop["wn"])
    prop["zgnd"] = np.sqrt(zq - 1) / zq if vertical_pol else np.sqrt(zq - 1)

    try:
        prop = qlrpfl(prop)
        free_space = 8.685890 * np.log(2 * prop["wn"] * prop["dist"])
        zr = qerfi([reliability_pct / 100])[0]
        zc = qerfi([confidence_pct / 100])[0]
        excess, prop = avar(zr, 0, zc, prop)
    except (ValueError, ZeroDivisionError, OverflowError):
        return None

    # kwx >= 4: parameters out of the model's valid range
    if prop.get("kwx", 0) >= 4 or not np.isfinite(excess):
        return None
    return float(free_space + excess)
