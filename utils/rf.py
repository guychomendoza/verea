"""
RF Utilities
============
Unit conversions, wavelength calculations, thermal noise.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np
from config import SPEED_OF_LIGHT, NOISE_FLOOR_DBM


def db_to_linear(db: float) -> float:
    """Convert decibels to linear power ratio."""
    return 10 ** (db / 10)


def linear_to_db(linear: float) -> float:
    """Convert linear power ratio to decibels."""
    return 10 * np.log10(linear)


def dbm_to_watts(dbm: float) -> float:
    """Convert dBm to watts."""
    return 10 ** ((dbm - 30) / 10)


def watts_to_dbm(watts: float) -> float:
    """Convert watts to dBm."""
    return 10 * np.log10(watts) + 30


def wavelength(freq_hz: float) -> float:
    """
    Calculate wavelength in meters.
    At 915 MHz → λ ≈ 0.3278 m
    """
    return SPEED_OF_LIGHT / freq_hz


def thermal_noise_dbm(bandwidth_hz: float, noise_figure_db: float = 6.0) -> float:
    """
    Calculate thermal noise floor.
    N = -174 dBm/Hz + 10·log10(BW) + NF
    """
    return -174 + 10 * np.log10(bandwidth_hz) + noise_figure_db
