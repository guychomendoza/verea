"""
Verea — Configuration & Physical Constants
============================================
LoRaWAN Packet Tracer Simulator for Agricultural IoT Networks.
Based on Semtech SX1276 datasheet and ITU-R recommendations.
"""

import numpy as np

# ─── Physical Constants ───────────────────────────────────────
SPEED_OF_LIGHT = 299_792_458          # m/s
EARTH_RADIUS = 6_371_000              # meters (mean)
EFFECTIVE_EARTH_K = 4 / 3             # standard refractivity factor (k=4/3)
BOLTZMANN_DB = -228.6                 # dBW/K/Hz

# ─── LoRaWAN Radio Defaults ───────────────────────────────────
DEFAULT_FREQUENCY_HZ = 915e6          # US915 / AU915
DEFAULT_BANDWIDTH_HZ = 125e3          # 125 kHz standard BW
DEFAULT_TX_POWER_DBM = 14             # end-node typical (max +20)
DEFAULT_GW_TX_POWER_DBM = 27          # gateway typical

# ─── SX1276 Sensitivity Table (BW=125kHz) ────────────────────
# Source: Semtech SX1276 datasheet, Table 10
SX1276_SENSITIVITY = {
    7:  -123.0,
    8:  -126.0,
    9:  -129.0,
    10: -132.0,
    11: -134.5,
    12: -137.0,
}

# ─── US915 uplink spreading factors ─────────────────────────
# US915 uplinks on 125 kHz channels are DR0–DR3 = SF10–SF7 (dwell time
# limits SF11/SF12 out). SF11/12 stay in the tables above for reference only.
US915_UPLINK_SF = (7, 8, 9, 10)


def clamp_sf(sf) -> int:
    """Nearest allowed US915 uplink SF (older saved nodes may carry SF11/12)."""
    try:
        sf = int(sf)
    except (TypeError, ValueError):
        return US915_UPLINK_SF[0]
    return min(max(sf, US915_UPLINK_SF[0]), US915_UPLINK_SF[-1])


# ─── SX1276 Data Rates (BW=125kHz, CR=4/5) ──────────────────
SX1276_DATARATE_BPS = {
    7:  5470,
    8:  3125,
    9:  1760,
    10: 980,
    11: 440,
    12: 250,
}

# ─── Noise Floor ──────────────────────────────────────────────
# Thermal noise = -174 dBm/Hz + 10·log10(BW) + NF
# For BW=125kHz: -174 + 50.97 + ~6 dB NF ≈ -117 dBm
NOISE_FLOOR_DBM = -120.0

# ─── Antenna Defaults ─────────────────────────────────────────
DEFAULT_GW_ANTENNA_GAIN_DBI = 6.0     # typical fiberglass omni
DEFAULT_GW_ANTENNA_HEIGHT_M = 10.0    # rooftop mount (rural default)
DEFAULT_GW_MIN_HEIGHT_M = 3.0
DEFAULT_GW_MAX_HEIGHT_M = 60.0
DEFAULT_NODE_ANTENNA_GAIN_DBI = 2.15  # quarter-wave whip ≈ dipole
DEFAULT_CABLE_LOSS_DB = 1.5           # coax + connectors

# ─── Terrain / GIS ───────────────────────────────────────────
TERRAIN_SAMPLE_POINTS = 100
MIN_FRESNEL_CLEARANCE_PCT = 60.0      # 60% of F1 = acceptable
FLAT_TERRAIN_ELEVATION_M = 1500.0     # last-resort fallback elevation

# ─── Elevation API Sources ───────────────────────────────────
# Primary: Open-Meteo (Copernicus DEM 90m) — fast, reliable
OPEN_METEO_ELEVATION_URL = "https://api.open-meteo.com/v1/elevation"
# Fallback: OpenTopoData (SRTM 30m)
OPENTOPODATA_ELEVATION_URL = "https://api.opentopodata.org/v1/srtm30m"
# Legacy (unreachable from most networks)
ELEVATION_API_URL = "https://api.open-elevation.com/api/v1/lookup"

# ─── Diffraction / Obstruction ───────────────────────────────
DEFAULT_DIFFRACTION_METHOD = "dominant_knife_edge"

# ─── Propagation model ───────────────────────────────────────
# "itm" = Longley-Rice (falls back to "simple" below 1 km)
# "simple" = FSPL + knife-edge diffraction
DEFAULT_PROPAGATION_MODEL = "itm"

# ─── Environment Profiles (Clutter Loss per ITU-R P.833 + agricultural) ──
ENVIRONMENT_PROFILES = {
    "Rural / Open":           {"clutter_loss_db": 0.0,  "description": "Open fields, no obstructions"},
    "Cultivo bajo":           {"clutter_loss_db": 5.0,  "description": "Low crops: alfalfa, vegetables, stubble (<1m)"},
    "Orchard / Trees":        {"clutter_loss_db": 12.0, "description": "Orchards, vineyards, scattered trees"},
    "Huerta densa":           {"clutter_loss_db": 15.0, "description": "Dense orchard: avocado, mango, citrus canopy"},
    "Cultivo alto / Milpa":   {"clutter_loss_db": 20.0, "description": "Tall crops: corn/milpa >2m, sugarcane, sorghum"},
    "Suburban":               {"clutter_loss_db": 15.0, "description": "Low-density residential areas"},
    "Urban":                  {"clutter_loss_db": 18.0, "description": "Dense urban, buildings"},
}

# ─── Fading Margin ───────────────────────────────────────────
# Extra margin to account for temporal fading (rain, humidity, foliage sway)
DEFAULT_FADING_MARGIN_DB = 8.0    # conservative default for agricultural

# ─── Link Budget Thresholds ──────────────────────────────────
REQUIRED_LINK_MARGIN_DB = 10.0        # default, overridden by UI slider
SNR_REQUIREMENTS = {
    7:  -7.5,
    8:  -10.0,
    9:  -12.5,
    10: -15.0,
    11: -17.5,
    12: -20.0,
}

# ─── Map Defaults ────────────────────────────────────────────
MAP_DEFAULT_CENTER = [21.9614, -102.3494]   # Aguascalientes region
MAP_DEFAULT_ZOOM = 14
