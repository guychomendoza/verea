"""
End-to-end check of the cloud mode (login, autosave, team projects, edit conflicts)
against a fake Supabase answered inside the browser: Playwright intercepts the auth
and REST calls and serves them from an in-memory table. The real database rules are
tested in supabase/tests.

Needs a development API (accepts any token) and a dev server in cloud mode pointing at it:

    VEREA_DEV=1 VEREA_CORS_ORIGINS=http://127.0.0.1:5174 .venv/bin/uvicorn backend.main:app --port 8001
    cd frontend && VITE_API_URL=http://127.0.0.1:8001 VITE_SUPABASE_URL=https://fake.supabase.co \
        VITE_SUPABASE_ANON_KEY=x npx vite --host 127.0.0.1 --port 5174
    .venv/bin/python frontend/e2e/cloud.py
"""
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path
import uuid
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright

URL = os.environ.get("VEREA_E2E_URL", "http://127.0.0.1:5175/")
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix="verea-cloud-"))
SUPA = "https://fake.supabase.co"
ME = {"id": str(uuid.uuid4()), "email": "ana@farm.mx", "full_name": "Ana", "role": "member"}
OTHER = {"id": str(uuid.uuid4()), "email": "beto@farm.mx", "full_name": "Beto", "role": "member"}
PROFILES = {p["id"]: p for p in (ME, OTHER)}
PROJECTS: dict[str, dict] = {}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def add_project(name, owner, data=None):
    pid = str(uuid.uuid4())
    PROJECTS[pid] = {"id": pid, "name": name, "data": data or {"version": 1, "name": name, "description": "",
                     "gateways": [], "nodes": [], "name_counters": {}, "settings": {}},
                     "owner_id": owner, "updated_by": owner, "updated_at": now()}
    time.sleep(0.002)
    return pid


def row_view(r, select):
    out = {}
    for part in re.split(r",(?![^(]*\))", select):
        part = part.strip()
        m = re.match(r"(\w+):profiles!projects_(owner_id|updated_by)_fkey\((.*)\)", part)
        if m:
            prof = PROFILES.get(r[m[2]])
            out[m[1]] = {k: prof[k] for k in ("full_name", "email")} if prof else None
        else:
            out[part] = r[part]
    return out


def rest(route, request):
    u = urlparse(request.url)
    table = u.path.rsplit("/", 1)[-1]
    q = {k: v[0] for k, v in parse_qs(u.query).items()}
    select = q.pop("select", "*")
    order = q.pop("order", None)
    filters = {k: v.split(".", 1)[1] for k, v in q.items() if v.startswith("eq.")}
    single = "vnd.pgrst.object" in (request.headers.get("accept") or "")
    rows_src = PROFILES if table == "profiles" else PROJECTS

    def match(r):
        return all(str(r.get(k)) == v for k, v in filters.items())

    method = request.method
    if method == "GET":
        rows = [r for r in rows_src.values() if match(r)]
        if order:
            col, direction = order.split(".")[:2]
            rows.sort(key=lambda r: r[col], reverse=direction == "desc")
        rows = [row_view(r, select) if select != "*" else r for r in rows]
    elif method == "POST":
        body = json.loads(request.post_data)
        pid = add_project(body["name"], ME["id"], body["data"])
        rows = [row_view(PROJECTS[pid], select)]
    elif method == "PATCH":
        body = json.loads(request.post_data)
        rows = []
        for r in [r for r in PROJECTS.values() if match(r)]:
            r.update(body, updated_at=now(), updated_by=ME["id"])
            rows.append(row_view(r, select))
    elif method == "DELETE":
        rows = []
        for r in [r for r in PROJECTS.values() if match(r) and r["owner_id"] == ME["id"]]:
            del PROJECTS[r["id"]]
            rows.append({"id": r["id"]})
    else:
        return route.fulfill(status=405)
    if single:
        if not rows and "maybe" not in (request.headers.get("accept") or ""):
            return route.fulfill(status=406, json={"message": "no rows"})
        return route.fulfill(json=rows[0] if rows else None)
    route.fulfill(json=rows)


def auth(route, request):
    if "/token" in request.url:
        body = json.loads(request.post_data or "{}")
        if body.get("password") != "correct-horse-battery":
            return route.fulfill(status=400, json={"error": "invalid_grant", "error_description": "Invalid login credentials",
                                                   "code": "invalid_credentials", "msg": "Invalid login credentials"})
        return route.fulfill(json={
            "access_token": "fake.jwt.token", "token_type": "bearer", "expires_in": 3600,
            "expires_at": int(time.time()) + 3600, "refresh_token": "r",
            "user": {"id": ME["id"], "email": ME["email"], "aud": "authenticated", "role": "authenticated"}})
    if request.url.endswith("/logout") or "/logout?" in request.url:
        return route.fulfill(status=204)
    if "/user" in request.url:
        return route.fulfill(json={"id": ME["id"], "email": ME["email"], "aud": "authenticated"})
    route.fulfill(status=404, json={})


def main():
    errors = []
    sample = json.load(open("frontend/e2e/sample.verea.json"))
    add_project("Beto's orchard", OTHER["id"], {**sample, "name": "Beto's orchard"})
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        page = b.new_page(viewport={"width": 1400, "height": 860})
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.route(f"{SUPA}/rest/v1/**", rest)
        page.route(f"{SUPA}/auth/v1/**", auth)
        page.goto(URL)
        expect(page.get_by_role("button", name="Iniciar sesión")).to_be_visible(timeout=20000)
        page.screenshot(path=f"{OUT}/login.png")
        # login
        page.get_by_label("Correo").fill(ME["email"])
        page.get_by_label("Contraseña").fill("wrong")
        page.get_by_role("button", name="Iniciar sesión").click()
        expect(page.get_by_role("alert")).to_contain_text("Correo o contraseña incorrectos")
        page.get_by_label("Contraseña").fill("correct-horse-battery")
        page.get_by_role("button", name="Iniciar sesión").click()
        side = page.get_by_role("complementary", name="Proyecto", exact=True)
        expect(side).to_contain_text("Ana", timeout=20000)
        # opens the most recent team project (Beto's)
        expect(page.get_by_label("Nombre del proyecto")).to_have_value("Beto's orchard", timeout=20000)
        print("opened most recent:", page.get_by_label("Nombre del proyecto").input_value())
        # edit -> autosaved
        page.get_by_label("Nombre del proyecto").fill("Beto's orchard v2")
        expect(page.get_by_role("status")).to_contain_text("Guardado", timeout=10000)
        pid = next(k for k, v in PROJECTS.items() if v["name"] == "Beto's orchard v2")
        print("autosaved name:", PROJECTS[pid]["name"], "updated_by Ana:", PROJECTS[pid]["updated_by"] == ME["id"])
        # someone else saves meanwhile -> my next save is refused, not overwritten
        PROJECTS[pid].update(name="Beto's edit", data={**PROJECTS[pid]["data"], "name": "Beto's edit"},
                             updated_at=now(), updated_by=OTHER["id"])
        page.get_by_label("Nombre del proyecto").fill("Ana's late edit")
        expect(page.get_by_role("alert").filter(has_text="Alguien más guardó")).to_be_visible(timeout=10000)
        assert PROJECTS[pid]["name"] == "Beto's edit"
        print("conflict detected, their version kept:", PROJECTS[pid]["name"])
        page.get_by_role("button", name="Guardar la mía como copia").click()
        expect(page.get_by_label("Nombre del proyecto")).to_have_value("Ana's late edit (mi copia)", timeout=10000)
        assert any(v["name"] == "Ana's late edit (mi copia)" and v["owner_id"] == ME["id"] for v in PROJECTS.values())
        print("copy saved:", len(PROJECTS), "projects")
        # projects dialog: list, no delete on someone else's, delete own
        side.get_by_role("button", name="Proyectos…").click()
        dialog = page.get_by_role("dialog", name="Proyectos del equipo")
        expect(dialog).to_contain_text("Beto's edit")
        page.screenshot(path=f"{OUT}/projects.png")
        assert dialog.get_by_role("button", name="Eliminar Beto's edit").count() == 0
        page.on("dialog", lambda d: d.accept())
        dialog.get_by_role("button", name=re.compile("Eliminar Ana's late edit")).click()
        expect(dialog).not_to_contain_text("Ana's late edit (mi copia)", timeout=10000)
        dialog.get_by_role("button", name=re.compile("Beto's edit")).click()
        expect(page.get_by_label("Nombre del proyecto")).to_have_value("Beto's edit", timeout=10000)
        # reload: session kept, last project reopened
        page.reload()
        expect(page.get_by_label("Nombre del proyecto")).to_have_value("Beto's edit", timeout=20000)
        print("reload keeps session and project: ok")
        side.get_by_role("button", name="Cerrar sesión").click()
        expect(page.get_by_role("button", name="Iniciar sesión")).to_be_visible(timeout=10000)
        print("signed out: ok")
        b.close()
    print("page errors:", errors)
    print("screenshots in", OUT)
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
