"""
Device Profiles
===============
Preset gateways and end nodes used in the field, with their RF specs.

Values marked in ``estimated`` are not published by the manufacturer and
are typical figures for that kind of antenna; calibrate them with real
RSSI readings when available.
"""

from config import SX1302_SENSITIVITY

GATEWAY_PROFILES = {
    "sensecap_m2": {
        "label": "SenseCAP M2 (US915)",
        "tx_power": 26,
        "gain": 3.0,
        "cable_loss": 0.5,
        "height": 2.5,
        "sensitivity": SX1302_SENSITIVITY,
        "source": "Seeed SenseCAP M2 specs: SX1302, 26 dBm, -125 dBm (SF7) to -139 dBm (SF12), "
                  "3 dBi external antenna included.",
        "estimated": ["cable_loss"],
    },
    "milesight_ug63": {
        "label": "Milesight UG63-L08GL-915M",
        "tx_power": 27,
        "gain": 3.0,
        "cable_loss": 0.3,
        "height": 2.5,
        "sensitivity": SX1302_SENSITIVITY,
        "source": "Milesight UG63 datasheet: SX1302, 27 dBm max, -140 dBm @292 bps, "
                  "1 external antenna (gain not published).",
        "estimated": ["gain", "cable_loss"],
    },
    "milesight_sg50": {
        "label": "Milesight SG50 (solar)",
        "tx_power": 27,
        "gain": 5.0,
        "cable_loss": 0.5,
        "height": 2.5,
        "sensitivity": SX1302_SENSITIVITY,
        "source": "Milesight SG50 datasheet: SX1302, 27 dBm max, -140 dBm @292 bps, "
                  "N-type connector, 60 cm antenna + 1 m coax (gain not published).",
        "estimated": ["gain", "cable_loss"],
    },
    "custom": {
        "label": "Custom",
        "tx_power": 27,
        "gain": 6.0,
        "cable_loss": 1.5,
        "height": 10.0,
        "sensitivity": None,           # falls back to the SX1276 table
        "source": "Generic outdoor gateway with fiberglass omni antenna.",
        "estimated": [],
    },
}

NODE_PROFILES = {
    "dragino_lse01": {
        "label": "Dragino LSE01 (soil)",
        "type": "sensor",
        "link": "lora",
        "tx_power": 20,
        "gain": 0.0,
        "cable_loss": 0.0,
        "height": 1.5,
        "sf": 10,
        "source": "Dragino LSE01: LoRaWAN soil moisture/EC, up to +20 dBm, internal antenna "
                  "(gain not published).",
        "estimated": ["gain"],
    },
    "dragino_se0x_lb": {
        "label": "Dragino SE0X-LB (soil)",
        "type": "sensor",
        "link": "lora",
        "tx_power": 20,
        "gain": 0.0,
        "cable_loss": 0.0,
        "height": 1.5,
        "sf": 10,
        "source": "Dragino SE0X-LB: LoRaWAN soil moisture/EC, radio up to +22 dBm, "
                  "-139 dBm RX; internal antenna (gain not published). 20 dBm used as "
                  "the usual configured power.",
        "estimated": ["gain", "tx_power"],
    },
    "dragino_se0x_cs": {
        "label": "Dragino SE0X-CS (4G, solar)",
        "type": "cellular",
        "link": "cellular",
        "tx_power": 23,
        "gain": 0.0,
        "cable_loss": 0.0,
        "height": 1.5,
        "sf": 10,
        "source": "Dragino SE0X-CS: NB-IoT / LTE-M soil sensor with solar panel. "
                  "Talks to the cell network, not to a LoRaWAN gateway.",
        "estimated": [],
    },
    "sensecap_s2120": {
        "label": "SenseCAP S2120 (weather)",
        "type": "weather",
        "link": "lora",
        "tx_power": 19,
        "gain": 2.0,
        "cable_loss": 0.0,
        "height": 3.0,
        "sf": 10,
        "source": "SenseCAP S2120 8-in-1 weather station: 19 dBm, 2 dBi integrated antenna, "
                  "mast mount.",
        "estimated": [],
    },
    "custom_sensor": {
        "label": "Custom sensor",
        "type": "sensor",
        "link": "lora",
        "tx_power": 14,
        "gain": 2.15,
        "cable_loss": 0.5,
        "height": 1.5,
        "sf": 7,
        "source": "Generic LoRaWAN node with quarter-wave whip.",
        "estimated": [],
    },
}

DEFAULT_GATEWAY_PROFILE = "sensecap_m2"
DEFAULT_NODE_PROFILE = "dragino_se0x_lb"

# Older nodes (before profiles) only carried a type
LEGACY_NODE_PROFILE = {"weather": "sensecap_s2120", "sensor": "custom_sensor"}


def gateway_profile(gw: dict) -> dict:
    return GATEWAY_PROFILES.get(gw.get("model"), GATEWAY_PROFILES["custom"])


def node_profile(nd: dict) -> dict:
    key = nd.get("model") or LEGACY_NODE_PROFILE.get(nd.get("type"), "custom_sensor")
    return NODE_PROFILES.get(key, NODE_PROFILES["custom_sensor"])


def is_cellular(nd: dict) -> bool:
    return node_profile(nd)["link"] == "cellular"


def new_gateway(name: str, lat: float, lon: float, model: str) -> dict:
    p = GATEWAY_PROFILES[model]
    return {
        "name": name, "lat": lat, "lon": lon, "model": model,
        "height": p["height"], "tx_power": p["tx_power"], "gain": p["gain"],
        "cable_loss": p["cable_loss"], "online": True,
    }


def new_node(name: str, lat: float, lon: float, model: str, environment: str) -> dict:
    p = NODE_PROFILES[model]
    return {
        "name": name, "lat": lat, "lon": lon, "model": model, "type": p["type"],
        "sf": p["sf"], "tx_power": p["tx_power"], "height": p["height"],
        "gain": p["gain"], "cable_loss": p["cable_loss"], "environment": environment,
    }


def estimated_note(profile: dict) -> str:
    """Short note listing the estimated fields, for help texts."""
    if not profile["estimated"]:
        return profile["source"]
    return f"{profile['source']} Estimated: {', '.join(profile['estimated'])}."
