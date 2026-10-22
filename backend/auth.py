"""
Login check for the API: every request carries the Supabase session token
(Authorization: Bearer <jwt>), verified against the project's public signing keys.

Environment:
  SUPABASE_URL   https://<project>.supabase.co  (keys: <url>/auth/v1/.well-known/jwks.json)
  VEREA_DEV=1    no login required (local development only)
Without either, every protected request is refused: the safe default.
"""

import os
from functools import lru_cache

from fastapi import Header, HTTPException

AUDIENCE = "authenticated"


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
        raise HTTPException(503, "Login is not configured on this server")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(401, "Not logged in")
    import jwt
    try:
        key = _jwks_client(url).get_signing_key_from_jwt(token)
        return jwt.decode(token, key.key, algorithms=["ES256", "RS256"], audience=AUDIENCE,
                          issuer=f"{url.rstrip('/')}/auth/v1")
    except jwt.PyJWTError:
        raise HTTPException(401, "Invalid or expired session")
