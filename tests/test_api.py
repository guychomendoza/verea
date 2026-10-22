"""Tests for the web API (backend/) with a stub elevation source."""

import time

import numpy as np
import pytest

pytest.importorskip("fastapi")
jwt = pytest.importorskip("jwt")
from fastapi.testclient import TestClient  # noqa: E402

import backend.auth as auth  # noqa: E402
import backend.main as api  # noqa: E402
import core.network as net  # noqa: E402

GW = {"name": "GW-1", "lat": 21.262, "lon": -102.300, "model": "sensecap_m2", "height": 6.0}
NODE = {"name": "N-1", "lat": 21.2519, "lon": -102.2952, "model": "dragino_se0x_lb", "sf": 10}
CELL = {"name": "4G-1", "lat": 21.30, "lon": -102.39, "model": "dragino_se0x_cs"}


class Hill:
    """Flat ground with a 60 m hill between the test gateway and node."""
    source_name = "test"

    def fetch_elevations(self, coords):
        lat = np.array([c[0] for c in coords])
        return 1800 + 60 * np.exp(-((lat - 21.257) / 0.002) ** 2)


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("VEREA_DEV", "1")
    monkeypatch.setattr(api.ELEVATIONS, "_src", Hill())
    return TestClient(api.app)


def test_links_match_core(client):
    r = client.post("/api/links", json={"gateways": [GW], "nodes": [NODE, CELL],
                                        "settings": {"safety_margin": 11}})
    assert r.status_code == 200
    res = r.json()["results"]
    assert set(res) == {"N-1"}                       # cellular nodes have no LoRa link
    direct = net.analyze_link(GW, NODE, net.RFSettings(safety_margin=11), Hill())["result"]
    assert res["N-1"]["link"]["margin_db"] == pytest.approx(direct.link_margin_db)
    assert res["N-1"]["link"]["gateway"] == "GW-1"


def test_no_gateway_online(client):
    r = client.post("/api/links", json={"gateways": [{**GW, "online": False}], "nodes": [NODE]})
    assert r.json()["results"]["N-1"] == {"link": None, "error": "Ningún gateway en línea"}


def test_link_detail_has_profile(client):
    r = client.post("/api/link", json={"gateway": GW, "node": NODE}).json()
    prof = r["profile"]
    assert len(prof["distances_m"]) == len(prof["elevations_m"]) == len(prof["los_m"]) >= 30
    assert max(prof["elevations_m"]) == pytest.approx(1860, abs=2)
    n = len(prof["elevations_m"])
    assert len(prof["effective_terrain_m"]) == len(prof["clearance_m"]) == n
    assert prof["gw_antenna_asl"] == pytest.approx(prof["elevations_m"][0] + 6.0)
    assert min(prof["clearance_m"]) < 0          # the 60 m hill blocks the line of sight
    assert r["budget"]["link_margin_db"] == pytest.approx(r["summary"]["margin_db"])


def test_radial_and_coverage(client):
    r = client.post("/api/radial", json={"gateway": GW, "node": NODE, "bearing_deg": 180,
                                         "max_distance_m": 3000}).json()
    assert r["segments"] and len(r["margins_db"]) == len(r["coordinates"])
    cov = client.post("/api/coverage", json={"gateway": GW, "radius_km": 1, "radials": 4}).json()
    assert len(cov["radials"]) == 4


def test_limits(client):
    many = [{**GW, "name": f"GW-{i}"} for i in range(31)]
    assert client.post("/api/links", json={"gateways": many, "nodes": [NODE]}).status_code == 422
    assert client.post("/api/coverage", json={"gateway": GW, "radials": 500}).status_code == 422
    assert client.post("/api/links", json={"gateways": [{**GW, "lat": 95}], "nodes": []}).status_code == 422


def test_project_normalize(client):
    ok = client.post("/api/project/normalize", json={"project": {"gateways": [GW], "nodes": [NODE]}})
    assert ok.status_code == 200 and ok.json()["nodes"][0]["type"] == "sensor"
    bad = client.post("/api/project/normalize", json={"project": {"nodes": []}})
    assert bad.status_code == 422


def test_project_keeps_owner_and_area(client):
    nodes = [dict(NODE, name="A", owner="  Ana López ", area_ha="2.5"),
             dict(NODE, name="B", owner="", area_ha=-1), dict(NODE, name="C", area_ha="x")]
    r = client.post("/api/project/normalize", json={"project": {"gateways": [GW], "nodes": nodes}})
    out = {n["name"]: n for n in r.json()["nodes"]}
    assert (out["A"]["owner"], out["A"]["area_ha"]) == ("Ana López", 2.5)
    assert "owner" not in out["B"] and "area_ha" not in out["B"] and "area_ha" not in out["C"]


def test_cell_status(client):
    if "Telcel" not in api.coverage_sources():
        pytest.skip("no coverage data")
    r = client.post("/api/cell-status", json={"operator": "Telcel", "points": [CELL]}).json()
    assert r["points"][0]["state"] in {"ok", "edge", "differentiated", "possible", "none"}
    assert client.post("/api/cell-status", json={"operator": "Nope", "points": [CELL]}).status_code == 404


# ── login ──
def test_refused_without_login_config(monkeypatch):
    monkeypatch.delenv("VEREA_DEV", raising=False)
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    c = TestClient(api.app)
    assert c.get("/api/health").status_code == 200          # public
    assert c.get("/api/catalog").status_code == 503


@pytest.fixture
def supabase(monkeypatch):
    """A fake Supabase project: its signing key and a token factory."""
    from cryptography.hazmat.primitives.asymmetric import ec
    url = "https://test.supabase.co"
    key = ec.generate_private_key(ec.SECP256R1())
    monkeypatch.delenv("VEREA_DEV", raising=False)
    monkeypatch.setenv("SUPABASE_URL", url)

    class Jwks:
        def get_signing_key_from_jwt(self, token):
            jwt.get_unverified_header(token)                  # malformed tokens fail here
            return type("K", (), {"key": key.public_key()})()

    monkeypatch.setattr(auth, "_jwks_client", lambda u: Jwks())

    def token(**claims):
        base = {"sub": "user-1", "aud": "authenticated", "iss": f"{url}/auth/v1",
                "exp": int(time.time()) + 600}
        return jwt.encode({**base, **claims}, key, algorithm="ES256")
    return token


def test_login_required(supabase):
    c = TestClient(api.app)
    assert c.get("/api/catalog").status_code == 401
    assert c.get("/api/catalog", headers={"Authorization": "Bearer garbage"}).status_code == 401
    ok = c.get("/api/catalog", headers={"Authorization": f"Bearer {supabase()}"})
    assert ok.status_code == 200 and "node_profiles" in ok.json()


def test_small_clock_skew_tolerated(supabase):
    """Tokens issued a few seconds 'in the future' by a server whose clock runs ahead."""
    c = TestClient(api.app)
    t = supabase(iat=int(time.time()) + 5, nbf=int(time.time()) + 5)
    assert c.get("/api/catalog", headers={"Authorization": f"Bearer {t}"}).status_code == 200


@pytest.mark.parametrize("claims", [
    {"exp": int(time.time()) - 120},                     # expired
    {"aud": "anon"},                                     # not a logged-in user
    {"iss": "https://other.supabase.co/auth/v1"},        # another project
])
def test_bad_tokens_rejected(supabase, claims):
    c = TestClient(api.app)
    assert c.get("/api/catalog", headers={"Authorization": f"Bearer {supabase(**claims)}"}).status_code == 401


def test_cors_only_allowed_origins(client):
    r = client.options("/api/links", headers={"Origin": "https://evil.example",
                                              "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in r.headers


def test_geocode_coordinates_and_places(client, monkeypatch):
    r = client.get("/api/geocode", params={"q": "21.8818, -102.2916"}).json()["results"]
    assert r == [{"name": "21.881800, -102.291600", "lat": 21.8818, "lon": -102.2916, "kind": "coordinates"}]
    calls = []

    def fake_search(q):
        calls.append(q)
        return [{"name": "Aguascalientes, México", "lat": 21.88, "lon": -102.29, "kind": "city"}]
    monkeypatch.setattr(api.GEOCODER, "search", fake_search)
    r = client.get("/api/geocode", params={"q": "Aguascalientes"}).json()["results"]
    assert r[0]["kind"] == "city" and calls == ["Aguascalientes"]
    assert client.get("/api/geocode", params={"q": "x"}).status_code == 422


def test_geocoder_caches_and_waits(monkeypatch):
    g = api.Geocoder()
    hits = []

    class Resp:
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def read(self, *a):
            return b'[{"display_name": "Calvillo", "lat": "21.85", "lon": "-102.71", "type": "town"}]'

    def fake_open(req, timeout):
        hits.append((time.monotonic(), req.get_header("User-agent")))
        return Resp()
    monkeypatch.setattr(api.urllib.request, "urlopen", fake_open)
    assert g.search("Calvillo")[0]["lat"] == 21.85
    assert g.search("calvillo ")[0]["lon"] == -102.71          # cached, no request
    g.search("Jesús María")
    assert len(hits) == 2 and "Verea" in hits[0][1]
    assert hits[1][0] - hits[0][0] >= 0.99                      # 1 request per second


def test_legacy_shared_secret(monkeypatch, supabase):
    url = "https://test.supabase.co"
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "s" * 40)
    base = {"sub": "u", "aud": "authenticated", "iss": f"{url}/auth/v1", "exp": int(time.time()) + 600}
    c = TestClient(api.app)
    good = jwt.encode(base, "s" * 40, algorithm="HS256")
    assert c.get("/api/catalog", headers={"Authorization": f"Bearer {good}"}).status_code == 200
    forged = jwt.encode(base, "x" * 40, algorithm="HS256")
    assert c.get("/api/catalog", headers={"Authorization": f"Bearer {forged}"}).status_code == 401
    assert c.get("/api/catalog", headers={"Authorization": f"Bearer {supabase()}"}).status_code == 200
    monkeypatch.delenv("SUPABASE_JWT_SECRET")
    assert c.get("/api/catalog", headers={"Authorization": f"Bearer {good}"}).status_code == 401
