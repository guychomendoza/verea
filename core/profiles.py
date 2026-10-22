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
        "source": "Especificaciones Seeed SenseCAP M2: SX1302, 26 dBm, -125 dBm (SF7) a -139 dBm (SF12), "
                  "antena externa de 3 dBi incluida.",
        "estimated": ["cable_loss"],
    },
    "milesight_ug63": {
        "label": "Milesight UG63-L08GL-915M",
        "tx_power": 27,
        "gain": 3.0,
        "cable_loss": 0.3,
        "height": 2.5,
        "sensitivity": SX1302_SENSITIVITY,
        "source": "Hoja de datos Milesight UG63: SX1302, 27 dBm máx., -140 dBm @292 bps, "
                  "1 antena externa (ganancia no publicada).",
        "estimated": ["gain", "cable_loss"],
    },
    "milesight_sg50": {
        "label": "Milesight SG50 (solar)",
        "tx_power": 27,
        "gain": 5.0,
        "cable_loss": 0.5,
        "height": 2.5,
        "sensitivity": SX1302_SENSITIVITY,
        "source": "Hoja de datos Milesight SG50: SX1302, 27 dBm máx., -140 dBm @292 bps, "
                  "conector tipo N, antena de 60 cm + 1 m de coaxial (ganancia no publicada).",
        "estimated": ["gain", "cable_loss"],
    },
    "custom": {
        "label": "Personalizado",
        "tx_power": 27,
        "gain": 6.0,
        "cable_loss": 1.5,
        "height": 10.0,
        "sensitivity": None,           # falls back to the SX1276 table
        "source": "Gateway exterior genérico con antena omnidireccional de fibra de vidrio.",
        "estimated": [],
    },
}

NODE_PROFILES = {
    "dragino_lse01": {
        "label": "Dragino LSE01 (suelo)",
        "type": "sensor",
        "link": "lora",
        "tx_power": 20,
        "gain": 0.0,
        "cable_loss": 0.0,
        "height": 1.5,
        "sf": 10,
        "source": "Dragino LSE01: humedad/CE de suelo LoRaWAN, hasta +20 dBm, antena interna "
                  "(ganancia no publicada).",
        "estimated": ["gain"],
    },
    "dragino_se0x_lb": {
        "label": "Dragino SE0X-LB (suelo)",
        "type": "sensor",
        "link": "lora",
        "tx_power": 20,
        "gain": 0.0,
        "cable_loss": 0.0,
        "height": 1.5,
        "sf": 10,
        "source": "Dragino SE0X-LB: humedad/CE de suelo LoRaWAN, radio hasta +22 dBm, "
                  "-139 dBm RX; antena interna (ganancia no publicada). Se usan 20 dBm, "
                  "la potencia configurada habitual.",
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
        "source": "Dragino SE0X-CS: sensor de suelo NB-IoT / LTE-M con panel solar. "
                  "Usa la red celular, no un gateway LoRaWAN.",
        "estimated": [],
    },
    "sensecap_s2120": {
        "label": "SenseCAP S2120 (estación meteorológica)",
        "type": "weather",
        "link": "lora",
        "tx_power": 19,
        "gain": 2.0,
        "cable_loss": 0.0,
        "height": 3.0,
        "sf": 10,
        "source": "Estación meteorológica 8 en 1 SenseCAP S2120: 19 dBm, antena integrada de 2 dBi, "
                  "montaje en mástil.",
        "estimated": [],
    },
    "custom_sensor": {
        "label": "Sensor personalizado",
        "type": "sensor",
        "link": "lora",
        "tx_power": 14,
        "gain": 2.15,
        "cable_loss": 0.5,
        "height": 1.5,
        "sf": 7,
        "source": "Nodo LoRaWAN genérico con antena de cuarto de onda.",
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
    return f"{profile['source']} Estimados: {', '.join(profile['estimated'])}."
