"""
Administrators create team accounts (email + temporary password) through Supabase's admin API,
which needs the project's secret key (SUPABASE_SERVICE_ROLE_KEY: a new sb_secret_… key or the legacy
service_role JWT; set only on the server).
The account is confirmed at once, gets its role in profiles, and carries must_change_password in
its metadata so the app asks for a new password at the first sign-in.
"""

import json
import os
import urllib.error
import urllib.request

from fastapi import HTTPException


def _call(method: str, path: str, body: dict, key: str) -> dict | list | None:
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    headers = {"apikey": key, "Content-Type": "application/json", "Prefer": "return=minimal"}
    if not key.startswith("sb_secret_"):        # a legacy service_role JWT also goes as the bearer;
        headers["Authorization"] = f"Bearer {key}"   # a new secret key only in apikey (Supabase mints the JWT)
    req = urllib.request.Request(f"{url}{path}", method=method, data=json.dumps(body).encode(), headers=headers)
    with urllib.request.urlopen(req, timeout=15) as r:
        raw = r.read()
    return json.loads(raw) if raw else None


def create_user(email: str, full_name: str, role: str, password: str) -> dict:
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not key or not os.environ.get("SUPABASE_URL"):
        raise HTTPException(503, "Crear cuentas no está configurado en este servidor (falta la clave de servicio)")
    try:
        user = _call("POST", "/auth/v1/admin/users", {
            "email": email.strip().lower(), "password": password, "email_confirm": True,
            "user_metadata": {"full_name": full_name.strip(), "must_change_password": True},
        }, key)
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        if e.code in (409, 422) and ("already" in detail or "exists" in detail):
            raise HTTPException(409, "Ya existe una cuenta con ese correo: cámbiale el rol en la lista")
        raise HTTPException(502, f"Supabase no creó la cuenta ({e.code})")
    uid = user["id"]
    # the new-user trigger made its profile (as viewer): set the role and the name
    _call("PATCH", f"/rest/v1/profiles?id=eq.{uid}", {"role": role, "full_name": full_name.strip()}, key)
    return {"id": uid, "email": user.get("email", email), "role": role}
