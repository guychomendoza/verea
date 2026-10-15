"""
Device Classes
==============
OOP models for LoRaWAN network elements: Antenna, Gateway, EndNode, WeatherStation.
All RF parameters based on Semtech SX1276 specifications.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from dataclasses import dataclass, field
from typing import Optional

from config import (
    DEFAULT_FREQUENCY_HZ,
    DEFAULT_BANDWIDTH_HZ,
    DEFAULT_TX_POWER_DBM,
    DEFAULT_GW_TX_POWER_DBM,
    DEFAULT_GW_ANTENNA_GAIN_DBI,
    DEFAULT_GW_ANTENNA_HEIGHT_M,
    DEFAULT_NODE_ANTENNA_GAIN_DBI,
    DEFAULT_CABLE_LOSS_DB,
    SX1276_SENSITIVITY,
    SX1276_DATARATE_BPS,
)


@dataclass
class Antenna:
    """
    Antenna model with gain and physical properties.

    Attributes
    ----------
    gain_dbi : float
        Antenna gain in dBi.
    height_m : float
        Antenna height above ground level (AGL) in meters.
    cable_loss_db : float
        Total cable and connector loss in dB.
    pattern : str
        Antenna radiation pattern type.
    """
    gain_dbi: float = DEFAULT_NODE_ANTENNA_GAIN_DBI
    height_m: float = 1.5
    cable_loss_db: float = 0.5
    pattern: str = "omnidirectional"

    @property
    def effective_gain_dbi(self) -> float:
        """Net gain after cable losses."""
        return self.gain_dbi - self.cable_loss_db


@dataclass
class Gateway:
    """
    LoRaWAN Gateway with online/offline toggle for failover simulation.
    """
    name: str = "Gateway-1"
    lat: float = 0.0
    lon: float = 0.0
    altitude_m: float = 0.0           # ground elevation ASL (from DEM)
    tx_power_dbm: float = DEFAULT_GW_TX_POWER_DBM
    antenna: Antenna = field(default_factory=lambda: Antenna(
        gain_dbi=DEFAULT_GW_ANTENNA_GAIN_DBI,
        height_m=DEFAULT_GW_ANTENNA_HEIGHT_M,
        cable_loss_db=DEFAULT_CABLE_LOSS_DB,
    ))
    frequency_hz: float = DEFAULT_FREQUENCY_HZ
    bandwidth_hz: float = DEFAULT_BANDWIDTH_HZ
    channels: int = 8                  # US915: 8 uplink channels
    online: bool = True                # Power toggle for failover

    @property
    def antenna_height_asl(self) -> float:
        """Antenna height above sea level."""
        return self.altitude_m + self.antenna.height_m

    @property
    def eirp_dbm(self) -> float:
        """Effective Isotropic Radiated Power."""
        return self.tx_power_dbm + self.antenna.effective_gain_dbi


@dataclass
class EndNode:
    """
    LoRaWAN End Node (sensor / actuator).
    Models a Class A device with configurable SF.
    """
    name: str = "Node-1"
    lat: float = 0.0
    lon: float = 0.0
    altitude_m: float = 0.0
    tx_power_dbm: float = DEFAULT_TX_POWER_DBM
    spreading_factor: int = 7
    antenna: Antenna = field(default_factory=lambda: Antenna(
        gain_dbi=DEFAULT_NODE_ANTENNA_GAIN_DBI,
        height_m=1.5,
        cable_loss_db=0.5,
    ))
    frequency_hz: float = DEFAULT_FREQUENCY_HZ
    bandwidth_hz: float = DEFAULT_BANDWIDTH_HZ

    @property
    def antenna_height_asl(self) -> float:
        """Antenna height above sea level."""
        return self.altitude_m + self.antenna.height_m

    @property
    def eirp_dbm(self) -> float:
        """Effective Isotropic Radiated Power."""
        return self.tx_power_dbm + self.antenna.effective_gain_dbi

    @property
    def sensitivity_dbm(self) -> float:
        """Receiver sensitivity for current SF (from SX1276 datasheet)."""
        return SX1276_SENSITIVITY.get(self.spreading_factor, -123.0)

    @property
    def datarate_bps(self) -> float:
        """Approximate data rate for current SF at BW=125kHz."""
        return SX1276_DATARATE_BPS.get(self.spreading_factor, 5470)

    def set_spreading_factor(self, sf: int) -> None:
        """Update spreading factor with validation."""
        if sf not in range(7, 13):
            raise ValueError(f"SF must be 7-12, got {sf}")
        self.spreading_factor = sf


@dataclass
class WeatherStation(EndNode):
    """
    SenseCAP S2120 8-in-1 Weather Station.

    Pre-configured with manufacturer specs:
    - TX Power: +19 dBm
    - Antenna height: 3 m AGL (mast-mounted)
    - Antenna gain: 2 dBi (integrated)
    - Model: SenseCAP S2120 8-in-1
    """
    name: str = "Weather-1"
    tx_power_dbm: float = 19           # SenseCAP S2120 spec
    spreading_factor: int = 10
    antenna: Antenna = field(default_factory=lambda: Antenna(
        gain_dbi=2.0,                  # integrated antenna
        height_m=3.0,                  # mast mount
        cable_loss_db=0.0,             # no external cable
    ))
    model: str = "SenseCAP S2120 8-in-1"
