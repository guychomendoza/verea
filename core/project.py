"""
Projects
========
Save / load a Verea project (devices + settings) as JSON.

The format is versioned so the same file can later be stored in the cloud.
"""

from config import clamp_sf
from core.profiles import GATEWAY_PROFILES, NODE_PROFILES, LEGACY_NODE_PROFILE

PROJECT_VERSION = 1

_GW_KEYS = ("name", "lat", "lon", "model", "height", "tx_power", "gain", "cable_loss", "online")
_NODE_KEYS = ("name", "lat", "lon", "model", "type", "sf", "tx_power", "height", "gain",
              "cable_loss", "environment", "owner", "area_ha")
MAX_OWNER_LEN = 80


def project_to_dict(name: str, description: str, gateways: list, nodes: list,
                    name_counters: dict, settings: dict) -> dict:
    return {
        "version": PROJECT_VERSION,
        "name": name,
        "description": description,
        "gateways": [{k: g[k] for k in _GW_KEYS if k in g} for g in gateways],
        "nodes": [{k: n[k] for k in _NODE_KEYS if k in n} for n in nodes],
        "name_counters": dict(name_counters),
        "settings": dict(settings),
    }


def _num(d: dict, key: str, kind=float):
    if key in d:
        d[key] = kind(d[key])


def _optional_info(n: dict) -> None:
    """Owner (titular) and area of the plot: optional, dropped when empty or invalid."""
    owner = str(n.pop("owner", "") or "").strip()[:MAX_OWNER_LEN]
    if owner:
        n["owner"] = owner
    try:
        area = float(n.pop("area_ha", ""))
    except (TypeError, ValueError):
        return
    if area >= 0 and area == area and area != float("inf"):
        n["area_ha"] = area


def project_from_dict(data: dict) -> dict:
    """Validate and normalise a loaded project. Raises ValueError if invalid."""
    if not isinstance(data, dict) or "gateways" not in data or "nodes" not in data:
        raise ValueError("Not a Verea project file")
    if data.get("version", 1) > PROJECT_VERSION:
        raise ValueError(f"Project version {data['version']} is newer than this app")

    gateways, nodes, names = [], [], set()
    for g in data["gateways"]:
        g = {k: g[k] for k in _GW_KEYS if k in g}
        if not {"name", "lat", "lon"} <= g.keys():
            raise ValueError("Gateway without name or position")
        for k in ("lat", "lon", "height", "tx_power", "gain", "cable_loss"):
            _num(g, k)
        if g.get("model") not in GATEWAY_PROFILES:
            g["model"] = "custom"
        g["online"] = bool(g.get("online", True))
        gateways.append(g)
        names.add(g["name"])
    for n in data["nodes"]:
        n = {k: n[k] for k in _NODE_KEYS if k in n}
        if not {"name", "lat", "lon"} <= n.keys():
            raise ValueError("Node without name or position")
        if n["name"] in names:
            raise ValueError(f"Duplicate device name: {n['name']}")
        for k in ("lat", "lon", "height", "tx_power", "gain", "cable_loss"):
            _num(n, k)
        if n.get("model") not in NODE_PROFILES:
            n["model"] = LEGACY_NODE_PROFILE.get(n.get("type"), "custom_sensor")
        n["type"] = NODE_PROFILES[n["model"]]["type"]
        n["sf"] = clamp_sf(n.get("sf", 10))
        _optional_info(n)
        nodes.append(n)
        names.add(n["name"])

    return {
        "name": str(data.get("name", "")),
        "description": str(data.get("description", "")),
        "gateways": gateways,
        "nodes": nodes,
        "name_counters": {str(k): int(v) for k, v in data.get("name_counters", {}).items()},
        "settings": dict(data.get("settings", {})),
    }
