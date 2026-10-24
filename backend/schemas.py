"""Request bodies of the API, with the limits that keep one request from hogging the server."""

from typing import Optional

from pydantic import BaseModel, Field

MAX_GATEWAYS = 30
MAX_NODES = 300
MAX_POINTS = 300

Lat = Field(ge=-90, le=90)
Lon = Field(ge=-180, le=180)
Name = Field(min_length=1, max_length=40)


class GatewayIn(BaseModel):
    name: str = Name
    lat: float = Lat
    lon: float = Lon
    model: str = Field("custom", max_length=40)
    height: Optional[float] = Field(None, ge=0.5, le=100)
    tx_power: Optional[float] = Field(None, ge=-10, le=36)
    gain: Optional[float] = Field(None, ge=-10, le=20)
    cable_loss: Optional[float] = Field(None, ge=0, le=20)
    online: bool = True
    backhaul: Optional[str] = Field(None, pattern="^(4g|red)$")

    def model_dump(self, **kw):
        return super().model_dump(exclude_none=True, **kw)


class NodeIn(BaseModel):
    name: str = Name
    lat: float = Lat
    lon: float = Lon
    model: str = Field("custom_sensor", max_length=40)
    type: Optional[str] = Field(None, max_length=20)
    sf: Optional[int] = Field(None, ge=7, le=12)
    height: Optional[float] = Field(None, ge=0.1, le=100)
    tx_power: Optional[float] = Field(None, ge=-10, le=30)
    gain: Optional[float] = Field(None, ge=-10, le=20)
    cable_loss: Optional[float] = Field(None, ge=0, le=20)
    environment: Optional[str] = Field(None, max_length=40)

    def model_dump(self, **kw):
        return super().model_dump(exclude_none=True, **kw)


class SettingsIn(BaseModel):
    """Project settings; unknown or out-of-range values fall back to defaults (RFSettings.from_project)."""
    freq_mhz: Optional[float] = None
    propagation_model: Optional[str] = Field(None, max_length=40)
    diffraction_method: Optional[str] = Field(None, max_length=40)
    safety_margin: Optional[float] = Field(None, ge=0, le=25)
    environment: Optional[str] = Field(None, max_length=40)

    def model_dump(self, **kw):
        return super().model_dump(exclude_none=True, **kw)


class LinksRequest(BaseModel):
    gateways: list[GatewayIn] = Field(max_length=MAX_GATEWAYS)
    nodes: list[NodeIn] = Field(max_length=MAX_NODES)
    settings: SettingsIn = SettingsIn()


class LinkRequest(BaseModel):
    gateway: GatewayIn
    node: NodeIn
    settings: SettingsIn = SettingsIn()


class RadialRequest(LinkRequest):
    bearing_deg: float = Field(ge=0, lt=360)
    max_distance_m: float = Field(ge=500, le=40_000)


class CoverageRequest(BaseModel):
    gateway: GatewayIn
    settings: SettingsIn = SettingsIn()
    node_model: str = Field("dragino_se0x_lb", max_length=40)
    sf: int = Field(10, ge=7, le=12)
    radius_km: float = Field(5, ge=0.5, le=20)
    radials: int = Field(24, ge=4, le=72)


class PointIn(BaseModel):
    name: Optional[str] = Field(None, max_length=40)
    lat: float = Lat
    lon: float = Lon


class CellRequest(BaseModel):
    operator: str = Field(max_length=40)
    points: list[PointIn] = Field(min_length=1, max_length=MAX_POINTS)


class ProjectBody(BaseModel):
    project: dict


class SuggestGatewaysRequest(BaseModel):
    """Nodes to serve and the 4G gateway to place (its model and mast height)."""
    nodes: list[NodeIn] = Field(min_length=1, max_length=MAX_NODES)
    gateway: GatewayIn
    settings: SettingsIn = SettingsIn()
    operator: Optional[str] = Field(None, max_length=40)
    max_gateways: int = Field(5, ge=1, le=20)
    max_link_km: float = Field(8, ge=1, le=15)


class NewUserRequest(BaseModel):
    """An account an administrator creates: it signs in with this password and must change it."""
    email: str = Field(min_length=3, max_length=254, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    full_name: str = Field("", max_length=120)
    role: str = Field("member", pattern="^(admin|member|viewer)$")
    password: str = Field(min_length=10, max_length=128)
