"""
Login check for the API: every request carries the Supabase session token
(Authorization: Bearer <jwt>), verified against the project's public signing keys.

Environment:
  SUPABASE_URL         https://<project>.supabase.co  (keys: <url>/auth/v1/.well-known/jwks.json)
  SUPABASE_JWT_SECRET  only for projects still on the legacy shared secret (HS256)
  SUPABASE_ANON_KEY    the project's public key: team-only endpoints read the caller's role with it
  VEREA_DEV=1          no login required (local development only)
Without either, every protected request is refused: the safe default.
"""

import json
import logging
import os
import re
import time
import urllib.request
from functools import lru_cache

from fastapi import Depends, Header, HTTPException

AUDIENCE = "authenticated"
log = logging.getLogger("verea.auth")
CLOCK_LEEWAY_S = 30      # Supabase's clock can be a second or two ahead of ours (iat "in the future")
TEAM_CACHE_S = 60        # how long a caller's role is trusted before asking again
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_team_cache: dict[str, tuple[float, bool]] = {}


@lru_cache(maxsize=1)
def _jwks_client(url: str):
    import jwt
    return jwt.PyJWKClient(f"{url.rstrip('/')}/auth/v1/.well-known/jwks.json", cache_keys=True)


def require_user(authorization: str = Header(default="")) -> dict:
    """The token's claims (sub = user id, email, ...); 401 if missing or invalid."""
    if os.environ.get("VEREA_DEV") == "1":
        return {"sub": "dev", "email": "dev@localhost"}
    url = os.environ.get("SUPABASE_URL")
    if not url:
        raise HTTPException(503, "El inicio de sesión no está configurado en este servidor")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(401, "No has iniciado sesión")
    import jwt
    issuer = f"{url.rstrip('/')}/auth/v1"
    secret = os.environ.get("SUPABASE_JWT_SECRET")
    try:
        if secret and jwt.get_unverified_header(token).get("alg") == "HS256":
            return jwt.decode(token, secret, algorithms=["HS256"], audience=AUDIENCE, issuer=issuer,
                              leeway=CLOCK_LEEWAY_S)
        key = _jwks_client(url).get_signing_key_from_jwt(token)
        return jwt.decode(token, key.key, algorithms=["ES256", "RS256"], audience=AUDIENCE, issuer=issuer,
                          leeway=CLOCK_LEEWAY_S)
    except jwt.PyJWTError as e:
        log.warning("rejected session token: %s: %s", type(e).__name__, e)
        raise HTTPException(401, "Sesión no válida o vencida")


def _is_team(url: str, key: str, token: str, uid: str) -> bool:
    """Whether the caller is an active admin / member, asked to the database as the caller
    (row level security lets everyone read their own profile)."""
    req = urllib.request.Request(f"{url.rstrip('/')}/rest/v1/profiles?id=eq.{uid}&select=role,active",
                                 headers={"apikey": key, "Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=10) as r:
        rows = json.load(r)
    return bool(rows) and bool(rows[0].get("active")) and rows[0].get("role") in ("admin", "member")


def require_team(authorization: str = Header(default=""), claims: dict = Depends(require_user)) -> dict:
    """Like require_user, for the team only: viewers (people a project was shared with) get 403."""
    if os.environ.get("VEREA_DEV") == "1":
        return claims
    url, key = os.environ.get("SUPABASE_URL", ""), os.environ.get("SUPABASE_ANON_KEY")
    uid = str(claims.get("sub", ""))
    if not key:
        raise HTTPException(503, "Falta SUPABASE_ANON_KEY en este servidor")
    if not _UUID.match(uid):
        raise HTTPException(403, "Solo para el equipo")
    hit = _team_cache.get(uid)
    if hit and time.monotonic() - hit[0] < TEAM_CACHE_S:
        team = hit[1]
    else:
        try:
            team = _is_team(url, key, authorization.partition(" ")[2], uid)
        except Exception as e:  # noqa: BLE001 - network / Supabase errors: refuse, never let through
            log.warning("role check failed: %s", e)
            raise HTTPException(503, "No se pudo comprobar tu cuenta; intenta de nuevo")
        _team_cache[uid] = (time.monotonic(), team)
    if not team:
        raise HTTPException(403, "Solo para el equipo")
    return claims
