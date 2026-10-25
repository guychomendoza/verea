"""
End-to-end check of the cloud mode against a fake Supabase answered inside the browser:
Playwright intercepts the auth, REST and RPC calls and serves them from in-memory tables.
The real database rules are tested in supabase/tests.

Covers: login (Google button, team login with show/hide password), the Guardar button, the unsaved
changes draft and dialog, opt-in autosave, team projects,
edit conflicts; sharing a link; a viewer opening it (read-only workspace, owners hidden, their
own height change saved apart and kept on reload, PDF with the link, their files, profile, lost
access); an admin turning the viewer into an editor.

Needs a development API (accepts any token) and a dev server in cloud mode pointing at it:

    VEREA_DEV=1 VEREA_CORS_ORIGINS=http://127.0.0.1:5175 .venv/bin/uvicorn backend.main:app --port 8001
    cd frontend && VITE_API_URL=http://127.0.0.1:8001 VITE_SUPABASE_URL=https://fake.supabase.co \\
        VITE_SUPABASE_ANON_KEY=x VITE_GOOGLE_CLIENT_ID= npx vite --host 127.0.0.1 --port 5175
    .venv/bin/python frontend/e2e/cloud.py
"""
import json
import math
import os
import re
import sys
import tempfile
import time
import uuid
import zlib
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright

URL = os.environ.get("VEREA_E2E_URL", "http://127.0.0.1:5175/")
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix="verea-cloud-"))
SUPA = "https://fake.supabase.co"
PASSWORD = "correct-horse-battery"


def person(email, name, role):
    return {"id": str(uuid.uuid4()), "email": email, "full_name": name, "role": role, "active": True,
            "phone": "", "company": "", "created_at": now()}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


ANA = person("ana@farm.mx", "Ana", "member")
BETO = person("beto@farm.mx", "Beto", "member")
VERA = person("vera@cliente.mx", "Vera", "viewer")
JEFA = person("jefa@farm.mx", "Jefa", "admin")
PROFILES = {p["id"]: p for p in (ANA, BETO, VERA, JEFA)}
PROJECTS: dict[str, dict] = {}
SHARES: dict[str, dict] = {}
VIEWERS: dict[tuple[str, str], dict] = {}
FIELD_TESTS: dict[str, dict] = {}
FK = {"projects_owner_id_fkey": "owner_id", "projects_updated_by_fkey": "updated_by",
      "project_viewers_user_id_fkey": "user_id"}


def add_project(name, owner, data=None):
    pid = str(uuid.uuid4())
    PROJECTS[pid] = {"id": pid, "name": name, "data": data or {"version": 1, "name": name, "description": "",
                     "gateways": [], "nodes": [], "name_counters": {}, "settings": {}},
                     "owner_id": owner, "updated_by": owner, "updated_at": now()}
    time.sleep(0.002)
    return pid


def row_view(r, select):
    if select == "*":
        return dict(r)
    out = {}
    for part in re.split(r",(?![^(]*\))", select):
        part = part.strip()
        m = re.match(r"(\w+):profiles!(\w+)\((.*)\)", part)
        if m:
            prof = PROFILES.get(r[FK[m[2]]])
            out[m[1]] = {k.strip(): prof[k.strip()] for k in m[3].split(",")} if prof else None
        else:
            out[part] = r[part]
    return out


def caller(request):
    token = (request.headers.get("authorization") or "").removeprefix("Bearer ")
    return PROFILES.get(token.removeprefix("fake."))


def team(me):
    return me and me["active"] and me["role"] in ("admin", "member")


def without_owner_info(d):
    return {**{k: v for k, v in d.items() if k != "plots"},
            "nodes": [{k: v for k, v in n.items() if k not in ("owner", "area_ha", "plot")} for n in d["nodes"]]}


def rpc(route, request, me, fn):
    body = json.loads(request.post_data or "{}")
    if fn == "claim_share":
        s = next((s for s in SHARES.values() if s["token"] == body["share_token"] and not s["revoked_at"]), None)
        if not s:
            return route.fulfill(status=404, json={"code": "P0002", "message": "El link no existe o fue revocado"})
        if not team(me):
            key = (s["project_id"], me["id"])
            VIEWERS[key] = {**VIEWERS.get(key, {"overrides": {}, "first_opened": now()}), "project_id": s["project_id"],
                            "user_id": me["id"], "share_id": s["id"], "last_opened": now()}
        return route.fulfill(json=s["project_id"])
    if fn == "my_files":
        return route.fulfill(json=[{"project_id": v["project_id"], "name": PROJECTS[v["project_id"]]["name"],
                                    "updated_at": PROJECTS[v["project_id"]]["updated_at"], "last_opened": v["last_opened"]}
                                   for (pid, uid), v in VIEWERS.items() if uid == me["id"]])
    if fn == "viewer_project":
        v = VIEWERS.get((body["pid"], me["id"]))
        if not v:
            return route.fulfill(status=403, json={"code": "42501", "message": "No tienes acceso a este proyecto"})
        p, s = PROJECTS[body["pid"]], SHARES.get(v["share_id"]) or {}
        full = s.get("show_owner_info", False)
        return route.fulfill(json={"name": p["name"], "updated_at": p["updated_at"], "overrides": v["overrides"],
                                   "token": None if s.get("revoked_at") else s.get("token"), "show_owner_info": full,
                                   "data": p["data"] if full else without_owner_info(p["data"])})
    if fn == "admin_delete_account":
        if me["role"] != "admin" or body["target"] == me["id"]:
            return route.fulfill(status=403, json={"code": "42501", "message": "Solo un administrador elimina cuentas"})
        for p in PROJECTS.values():
            if p["owner_id"] == body["target"]:
                p["owner_id"] = me["id"]
        PROFILES.pop(body["target"], None)
        return route.fulfill(status=204)
    route.fulfill(status=404, json={"message": f"no function {fn}"})


def rest(route, request):
    me = caller(request)
    if not me:
        return route.fulfill(status=401, json={"message": "JWT expired"})
    u = urlparse(request.url)
    if "/rpc/" in u.path:
        return rpc(route, request, me, u.path.rsplit("/", 1)[-1])
    table = u.path.rsplit("/", 1)[-1]
    q = {k: v[0] for k, v in parse_qs(u.query).items()}
    select = q.pop("select", "*")
    order = q.pop("order", None)
    filters = {k: v.split(".", 1)[1] for k, v in q.items() if v.startswith("eq.")}
    single = "vnd.pgrst.object" in (request.headers.get("accept") or "")
    src = {"profiles": PROFILES, "projects": PROJECTS, "project_shares": SHARES, "project_viewers": VIEWERS,
           "field_tests": FIELD_TESTS}[table]
    # What the database's row level security lets this caller see
    visible = {
        "profiles": lambda r: team(me) or r["id"] == me["id"],
        "projects": lambda r: team(me),
        "project_shares": lambda r: team(me),
        "project_viewers": lambda r: team(me) or r["user_id"] == me["id"],
        "field_tests": lambda r: team(me),
    }[table]

    def match(r):
        return visible(r) and all(str(r.get(k)) == v for k, v in filters.items())

    method = request.method
    body = json.loads(request.post_data) if request.post_data else {}
    rows = [r for r in src.values() if match(r)]
    if method == "GET":
        if order:
            col, direction = order.split(".")[:2]
            rows.sort(key=lambda r: r[col], reverse=direction == "desc")
    elif method == "POST" and table == "projects" and team(me):
        rows = [PROJECTS[add_project(body["name"], me["id"], body["data"])]]
    elif method == "POST" and table == "project_shares" and team(me):
        sid = str(uuid.uuid4())
        SHARES[sid] = {"id": sid, "project_id": body["project_id"], "token": uuid.uuid4().hex,
                       "show_owner_info": body.get("show_owner_info", False), "created_at": now(), "revoked_at": None}
        time.sleep(0.002)
        rows = [SHARES[sid]]
    elif method == "POST" and table == "field_tests" and team(me):
        rows = []
        for t in body if isinstance(body, list) else [body]:
            if t["client_id"] not in FIELD_TESTS:                    # upsert, duplicates ignored
                FIELD_TESTS[t["client_id"]] = {**t, "author_id": me["id"]}
                rows.append(FIELD_TESTS[t["client_id"]])
    elif method == "PATCH":
        allowed = {"projects": team(me), "project_shares": team(me),
                   "profiles": True, "project_viewers": True}[table]
        if table == "profiles" and not me["role"] == "admin":
            rows = [r for r in rows if r["id"] == me["id"]]
            if {"role", "active", "email"} & set(body):
                return route.fulfill(status=400, json={"message": "Only an admin can change role, active, email or id"})
        if table == "project_viewers":
            rows = [r for r in rows if r["user_id"] == me["id"]]
        for r in rows if allowed else []:
            r.update(body)
            if table == "projects":
                r.update(updated_at=now(), updated_by=me["id"])
        rows = rows if allowed else []
    elif method == "DELETE":
        if table in ("projects", "field_tests"):
            owner = "owner_id" if table == "projects" else "author_id"
            rows = [r for r in rows if r[owner] == me["id"] or me["role"] == "admin"]
        for r in rows:
            src.pop(r["id"] if table not in ("project_viewers", "field_tests")
                    else r["client_id"] if table == "field_tests" else (r["project_id"], r["user_id"]))
    else:
        return route.fulfill(status=405)
    rows = [row_view(r, select) for r in rows]
    if single:
        if not rows and "maybe" not in (request.headers.get("accept") or ""):
            return route.fulfill(status=406, json={"message": "no rows"})
        return route.fulfill(json=rows[0] if rows else None)
    route.fulfill(json=rows)


def auth(route, request):
    if "/token" in request.url:
        body = json.loads(request.post_data or "{}")
        who = next((p for p in PROFILES.values() if p["email"] == body.get("email")), None)
        if not who or body.get("password") != PASSWORD:
            return route.fulfill(status=400, json={"error": "invalid_grant", "error_description": "Invalid login credentials",
                                                   "code": "invalid_credentials", "msg": "Invalid login credentials"})
        return route.fulfill(json={
            "access_token": f"fake.{who['id']}", "token_type": "bearer", "expires_in": 3600,
            "expires_at": int(time.time()) + 3600, "refresh_token": "r",
            "user": {"id": who["id"], "email": who["email"], "aud": "authenticated", "role": "authenticated"}})
    if request.url.endswith("/logout") or "/logout?" in request.url:
        return route.fulfill(status=204)
    if "/user" in request.url:
        me = caller(request)
        return route.fulfill(json={"id": me["id"], "email": me["email"], "aud": "authenticated"}) if me \
            else route.fulfill(status=401, json={})
    route.fulfill(status=404, json={})


def team_login(page, email, password=PASSWORD):
    page.get_by_label("Correo").fill(email)
    page.get_by_label("Contraseña", exact=True).fill(password)
    page.get_by_role("button", name="Iniciar sesión").click()


def sign_out(page):
    """Configuración → Cuenta → Cerrar sesión."""
    page.get_by_role("button", name="Configuración").click()
    page.get_by_role("dialog", name="Configuración").get_by_role("button", name="Cerrar sesión").click()
    expect(page.get_by_role("button", name="Continuar con Google")).to_be_visible(timeout=10000)


def pdf_from(page, downloads):
    dialog = page.get_by_role("dialog", name="Reporte")
    dialog.get_by_role("button", name="Generar PDF").click()
    expect(dialog).to_have_count(0, timeout=120000)
    page.wait_for_timeout(300)
    downloads[-1].save_as(OUT / downloads[-1].suggested_filename)
    return Path(downloads[-1].path()).read_bytes()


def pdf_text(pdf: bytes) -> bytes:
    """The PDF's content streams, inflated (jsPDF compresses them)."""
    out = []
    for m in re.finditer(rb"stream\r?\n(.*?)\r?\nendstream", pdf, re.S):
        try:
            out.append(zlib.decompress(m.group(1)))
        except zlib.error:
            out.append(m.group(1))
    return b"\n".join(out)


def main():
    errors = []
    sample = json.load(open("frontend/e2e/sample.verea.json"))
    add_project("Ana's field", ANA["id"], {**sample, "name": "Ana's field"})
    add_project("Beto's orchard", BETO["id"], {**sample, "name": "Beto's orchard"})
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        page = b.new_page(viewport={"width": 1400, "height": 860}, accept_downloads=True)
        page.on("pageerror", lambda e: errors.append(str(e)))
        # only the browser's «leave with unsaved changes?» is native; every other confirmation is Verea's own
        page.on("dialog", lambda d: d.accept() if d.type == "beforeunload"
                else (errors.append(f"native dialog: {d.message}"), d.dismiss()))
        downloads = []
        page.on("download", lambda d: downloads.append(d))
        page.route(f"{SUPA}/rest/v1/**", rest)
        page.route(f"{SUPA}/auth/v1/**", auth)
        page.goto(URL)
        expect(page.get_by_role("button", name="Continuar con Google")).to_be_visible(timeout=20000)
        page.screenshot(path=f"{OUT}/login.png")
        # team login
        page.get_by_label("Correo").fill(ANA["email"])
        page.get_by_label("Contraseña", exact=True).fill("wrong")
        pw_input = page.get_by_label("Contraseña", exact=True)
        assert pw_input.get_attribute("type") == "password"
        page.get_by_role("button", name="Mostrar contraseña").click()
        assert pw_input.get_attribute("type") == "text" and pw_input.input_value() == "wrong"
        page.get_by_role("button", name="Ocultar contraseña").click()
        assert pw_input.get_attribute("type") == "password"
        print("login: Google button, show / hide password ok")
        page.get_by_role("button", name="Iniciar sesión").click()
        expect(page.get_by_role("alert")).to_contain_text("Correo o contraseña incorrectos")
        page.get_by_label("Contraseña", exact=True).fill(PASSWORD)
        page.get_by_role("button", name="Iniciar sesión").click()
        side = page.get_by_role("complementary", name="Proyecto", exact=True)
        expect(side.get_by_role("button", name="Configuración")).to_be_visible(timeout=20000)
        # opens the most recent team project (Beto's)
        expect(page.get_by_label("Nombre del proyecto")).to_have_value("Beto's orchard", timeout=20000)
        save_state = side.locator(".save-state")
        pid = next(k for k, v in PROJECTS.items() if v["name"] == "Beto's orchard")
        # edit -> not saved until Guardar (autosave is off by default)
        page.get_by_label("Nombre del proyecto").fill("Beto's orchard v2")
        expect(save_state).to_have_text("Cambios sin guardar")
        time.sleep(2.5)
        assert PROJECTS[pid]["name"] == "Beto's orchard", "nothing is saved without Guardar"
        side.get_by_role("button", name="Guardar", exact=True).click()
        expect(save_state).to_contain_text("Guardado", timeout=10000)
        assert PROJECTS[pid]["name"] == "Beto's orchard v2" and PROJECTS[pid]["updated_by"] == ANA["id"]
        print("Guardar button:", PROJECTS[pid]["name"])
        # unsaved edits survive a reload as a draft offered back
        page.get_by_label("Nombre del proyecto").fill("Beto's orchard draft")
        time.sleep(1.5)
        page.reload()
        recover = page.get_by_role("alert").filter(has_text="cambios sin guardar de la última vez")
        expect(recover).to_be_visible(timeout=20000)
        expect(page.get_by_label("Nombre del proyecto")).to_have_value("Beto's orchard v2")
        recover.get_by_role("button", name="Recuperar").click()
        expect(page.get_by_label("Nombre del proyecto")).to_have_value("Beto's orchard draft")
        expect(save_state).to_have_text("Cambios sin guardar")
        print("draft recovered after reload")
        # opening another project asks first; Cancelar keeps the edits
        side.get_by_role("button", name="Proyectos…").click()
        page.get_by_role("dialog", name="Proyectos").get_by_role("button", name=re.compile("^Ana's field")).click()
        leave = page.get_by_role("alertdialog", name="Cambios sin guardar")
        expect(leave).to_be_visible()
        leave.get_by_role("button", name="Cancelar").click()
        expect(page.get_by_label("Nombre del proyecto")).to_have_value("Beto's orchard draft")
        side.get_by_role("button", name="Guardar", exact=True).click()
        expect(save_state).to_contain_text("Guardado", timeout=10000)
        assert PROJECTS[pid]["name"] == "Beto's orchard draft"
        print("leave dialog: cancel keeps edits, then saved")
        # autosave, turned on in Configuración
        side.get_by_role("button", name="Configuración").click()
        settings = page.get_by_role("dialog", name="Configuración")
        settings.get_by_role("tab", name="Guardado").click()
        switch = settings.get_by_role("switch", name="Autoguardado")
        expect(switch).to_have_attribute("aria-checked", "false")
        switch.click()
        expect(switch).to_have_attribute("aria-checked", "true")
        settings.get_by_role("button", name="Cerrar").click()
        page.get_by_label("Nombre del proyecto").fill("Beto's orchard v3")
        expect(save_state).to_contain_text("Guardado", timeout=10000)
        assert PROJECTS[pid]["name"] == "Beto's orchard v3"
        print("autosave on:", PROJECTS[pid]["name"])
        # someone else saves meanwhile -> my next save is refused, not overwritten
        PROJECTS[pid].update(name="Beto's edit", data={**PROJECTS[pid]["data"], "name": "Beto's edit"},
                             updated_at=now(), updated_by=BETO["id"])
        page.get_by_label("Nombre del proyecto").fill("Ana's late edit")
        expect(page.get_by_role("alert").filter(has_text="Alguien más guardó")).to_be_visible(timeout=10000)
        assert PROJECTS[pid]["name"] == "Beto's edit"
        page.get_by_role("button", name="Guardar la mía como copia").click()
        expect(page.get_by_label("Nombre del proyecto")).to_have_value("Ana's late edit (mi copia)", timeout=10000)
        print("conflict detected, their version kept, mine saved as a copy")
        # projects dialog: list, no delete on someone else's, delete own
        side.get_by_role("button", name="Proyectos…").click()
        dialog = page.get_by_role("dialog", name="Proyectos")
        expect(dialog).to_contain_text("Beto's edit")
        assert dialog.get_by_role("button", name="Eliminar Beto's edit").count() == 0
        dialog.get_by_role("button", name=re.compile("Eliminar Ana's late edit")).click()
        page.get_by_role("alertdialog", name="Confirmar").get_by_role("button", name="Eliminar proyecto").click()
        expect(dialog).not_to_contain_text("Ana's late edit (mi copia)", timeout=10000)
        dialog.get_by_role("button", name=re.compile("Beto's edit")).click()
        expect(page.get_by_label("Nombre del proyecto")).to_have_value("Beto's edit", timeout=10000)
        page.reload()
        expect(page.get_by_label("Nombre del proyecto")).to_have_value("Beto's edit", timeout=20000)
        print("reload keeps session and project: ok")
        # each project has its own address; back returns to the previous one; an address opens its project
        assert urlparse(page.url).path == f"/p/{pid}", page.url
        side.get_by_role("button", name="Proyectos…").click()
        page.get_by_role("dialog", name="Proyectos").get_by_role("button", name=re.compile("^Ana's field")).click()
        expect(page.get_by_label("Nombre del proyecto")).to_have_value("Ana's field", timeout=10000)
        ana_pid = next(k for k, v in PROJECTS.items() if v["name"] == "Ana's field")
        assert urlparse(page.url).path == f"/p/{ana_pid}", page.url
        page.go_back()
        expect(page.get_by_label("Nombre del proyecto")).to_have_value("Beto's edit", timeout=10000)
        page.goto(URL.rstrip("/") + f"/p/{ana_pid}")
        expect(page.get_by_label("Nombre del proyecto")).to_have_value("Ana's field", timeout=20000)
        page.goto(URL.rstrip("/") + f"/p/{pid}")
        expect(page.get_by_label("Nombre del proyecto")).to_have_value("Beto's edit", timeout=20000)
        assert not page.url.endswith("#"), page.url
        print("addresses: /p/<id>, back button, opened from the address")

        # ── 4G field tests: a team member records what a sensor got; offline ones upload later ──
        ctx = page.context
        ctx.grant_permissions(["geolocation"], origin=URL.rstrip("/"))
        ctx.set_geolocation({"latitude": 21.2, "longitude": -102.3, "accuracy": 12})
        side.get_by_role("button", name="Pruebas de campo 4G").click()
        page.wait_for_url(re.compile(r"/campo/"), timeout=20000)
        record = page.get_by_role("button", name="Registrar prueba aquí")
        expect(record).to_be_enabled(timeout=20000)
        record.click()
        sheet = page.get_by_role("dialog", name="Registrar prueba")
        expect(sheet).to_contain_text("Lo que dice el mapa")
        expect(sheet.locator(".verdict")).to_be_visible(timeout=20000)          # the map's prediction there
        sheet.get_by_role("radio", name=re.compile("Sin señal")).click()
        sheet.get_by_role("radio", name="No", exact=True).click()
        sheet.get_by_role("button", name="Guardar prueba").click()
        expect(page.get_by_role("status").filter(has_text="Al día")).to_be_visible(timeout=20000)
        assert len(FIELD_TESTS) == 1
        t1 = next(iter(FIELD_TESTS.values()))
        assert t1["observed"] == "none" and t1["delivered"] is False and t1["predicted"] and t1["author_id"] == ANA["id"], t1
        # without signal: kept on the phone, uploaded when the connection is back (and the map asked then)
        ctx.set_geolocation({"latitude": 21.3099, "longitude": -102.3945, "accuracy": 8})   # where 4G-1 is
        page.wait_for_timeout(1500)
        ctx.set_offline(True)
        record.click()
        expect(sheet).to_contain_text("Sin conexión")
        sheet.get_by_role("radio", name=re.compile("Señal estable")).click()
        sheet.get_by_role("button", name="Guardar prueba").click()
        expect(page.get_by_role("status").filter(has_text="1 por subir")).to_be_visible()
        assert len(FIELD_TESTS) == 1
        ctx.set_offline(False)
        page.evaluate("window.dispatchEvent(new Event('online'))")
        expect(page.get_by_role("status").filter(has_text="Al día")).to_be_visible(timeout=20000)
        assert len(FIELD_TESTS) == 2 and all(t["predicted"] for t in FIELD_TESTS.values()), FIELD_TESTS
        page.screenshot(path=f"{OUT}/field.png")
        # the map's answer must match exactly: «possible» (orange) with a stable sensor does not agree
        ctx.set_geolocation({"latitude": 21.2, "longitude": -102.3, "accuracy": 12})
        page.wait_for_timeout(1500)
        record.click()
        expect(sheet.locator(".verdict")).to_be_visible(timeout=20000)
        predicted = FIELD_TESTS[t1["client_id"]]["predicted"]
        sheet.get_by_role("radio", name=re.compile("Señal estable")).click()
        if predicted == "ok":
            expect(sheet.get_by_text("Coincide con el mapa")).to_be_visible()
        else:
            expect(sheet.get_by_text(re.compile("No coincide: el mapa la da como"))).to_be_visible()
            expect(sheet).to_contain_text("mejor de lo que dice")
        sheet.get_by_role("button", name="Cancelar la prueba").click()
        page.wait_for_function("() => window.__vereaMap && window.__vereaMap.loaded()", timeout=30000)
        # the dots, filtered by «¿llegó el dato?»
        def dots(n):
            page.wait_for_function(f"""() => window.__vereaMap.getSource('field-tests').getData()
                .then((d) => {{ window.__dots = d.features.length; return true }}) && window.__dots === {n}""", timeout=10000)
        dots(2)
        filt = page.get_by_role("group", name="Mostrar pruebas")
        filt.get_by_role("button", name=re.compile("^No llegó")).click()
        dots(1)
        filt.get_by_role("button", name=re.compile("^Todas")).click()
        dots(2)
        # the summary: signal × arrived, a cell filters the map; the CSV has every test
        page.locator("button.field-today").click()
        summ = page.get_by_role("dialog", name="Resumen de pruebas")
        summ.get_by_role("radio", name="Todas").click()
        page.screenshot(path=f"{OUT}/field-summary.png")
        with page.expect_download() as dl:
            summ.get_by_role("button", name="Descargar pruebas (CSV)").click()
        csv = Path(dl.value.path()).read_bytes().decode("utf-8-sig")
        assert csv.count("\r\n") == 2 and "llego_el_dato" in csv and "No llegó" in csv and "Beto's edit" in csv, csv
        summ.locator("tbody tr").nth(2).get_by_role("button").nth(1).click()          # «Sin señal» × «No llegó»
        expect(summ).to_have_count(0)
        dots(1)
        filt.get_by_role("button", name=re.compile("^Sin señal · No llegó")).click()
        dots(2)
        # each test repaints a square of the coverage at least 200 m each way, on the coverage grid
        ring = page.evaluate("() => window.__vereaMap.getSource('field-areas').getData().then((d) => d.features[0].geometry.coordinates[0])")
        (w, s_), (e, n) = ring[0], ring[2]
        lat = (s_ + n) / 2
        assert (e - w) * 111320 * math.cos(math.radians(lat)) >= 399 and (n - s_) * 111320 >= 399, ring
        assert page.evaluate("() => window.__vereaMap.getLayoutProperty('field-areas', 'visibility')") == "visible"
        # the ruler measures here too
        page.get_by_role("button", name="Regla: medir distancias").click()
        box = page.locator(".field-map canvas").bounding_box()
        page.mouse.click(box["x"] + box["width"] * 0.3, box["y"] + box["height"] * 0.4)
        page.mouse.click(box["x"] + box["width"] * 0.6, box["y"] + box["height"] * 0.4)
        ruler = page.get_by_role("region", name="Regla")
        expect(ruler.get_by_test_id("ruler-total")).to_have_text(re.compile(r"\d.*(m|km)$"))
        ruler.get_by_role("button", name="Borrar").click()
        expect(ruler).to_have_count(0)
        # my own test: its dot opens a card with «Borrar»
        pt = page.evaluate("""() => { const m = window.__vereaMap; const p = m.project([-102.3, 21.2]);
            const r = m.getCanvas().getBoundingClientRect(); return [r.left + p.x, r.top + p.y] }""")
        page.mouse.click(pt[0], pt[1])
        card = page.get_by_role("dialog", name="Prueba de campo")
        expect(card).to_contain_text("Sin señal")
        card.get_by_role("button", name="Borrar esta prueba").click()
        ask = page.get_by_role("alertdialog", name="Confirmar")
        expect(ask).to_contain_text("¿Borrar esta prueba de campo?")             # Verea's dialog, not the browser's
        ask.get_by_role("button", name="Borrar prueba").click()
        expect(card).to_have_count(0)
        assert len(FIELD_TESTS) == 1 and t1["client_id"] not in FIELD_TESTS
        # back in the editor, the 4G sensor next to the test shows what was measured
        page.get_by_role("button", name="Volver al editor").click()
        expect(page.get_by_label("Nombre del proyecto")).to_have_value("Beto's edit", timeout=20000)
        side.get_by_role("region", name="Lista de sensores").get_by_role("button", name=re.compile("^4G-1")).click()
        expect(page.get_by_role("complementary", name="Dispositivo")).to_contain_text("Verificado en campo")
        expect(side.get_by_role("region", name="Lista de sensores")).to_contain_text("Señal estable (en campo)")
        page.get_by_role("complementary", name="Dispositivo").get_by_role("button", name="Cerrar").click()
        # the editor shows only the repainted coverage (no dots), with a switch to compare without the tests
        page.wait_for_function("() => window.__vereaMap && window.__vereaMap.loaded()", timeout=30000)
        assert page.evaluate("() => window.__vereaMap.getSource('field-tests').getData().then((d) => d.features.length)") == 0
        page.get_by_test_id("map").get_by_role("button", name="Cobertura 4G").click()
        field_btn = page.get_by_test_id("map").get_by_role("button", name=re.compile(r"^Pruebas de campo \(1\)"))
        expect(field_btn).to_have_attribute("aria-pressed", "true")
        page.evaluate("() => window.__vereaMap.jumpTo({ center: [-102.3945, 21.3099], zoom: 15 })")
        page.wait_for_timeout(2500)
        page.screenshot(path=f"{OUT}/editor-field-areas.png")
        assert page.evaluate("() => window.__vereaMap.getLayoutProperty('field-areas', 'visibility')") == "visible"
        field_btn.click()
        expect(field_btn).to_have_attribute("aria-pressed", "false")
        assert page.evaluate("() => window.__vereaMap.getLayoutProperty('field-areas', 'visibility')") == "none"
        expect(side.get_by_role("region", name="Lista de sensores")).not_to_contain_text("(en campo)")
        field_btn.click()
        expect(side.get_by_role("region", name="Lista de sensores")).to_contain_text("Señal estable (en campo)")
        print("field tests: recorded, offline one uploaded later, strict agreement, own test deleted, sensor verified; "
              "filters, summary, CSV, 200 m squares, ruler; editor: areas only, switch")

        # ── share a link ──
        side.get_by_role("button", name="Compartir", exact=True).click()
        share = page.get_by_role("dialog", name="Compartir")
        share.get_by_role("button", name="Crear link").click()
        link = share.get_by_label("Link para compartir")
        expect(link).to_have_value(re.compile(r"/v/[0-9a-f]{32}$"), timeout=10000)
        url = link.input_value()
        assert len(SHARES) == 1 and not next(iter(SHARES.values()))["show_owner_info"]
        page.screenshot(path=f"{OUT}/share.png")
        share.get_by_role("button", name="Cerrar").click()
        print("link created:", url)
        # the team's PDF carries the same link (owners hidden: the link already made is reused)
        side.get_by_role("button", name="Reporte", exact=True).click()
        pdf = pdf_from(page, downloads)
        assert f"/URI ({url})".encode() in pdf and len(SHARES) == 1, "the PDF links to the shared project"
        assert b"Cobertura corregida con pruebas de campo" in pdf_text(pdf), "the PDF's coverage shows the field tests"
        print("team PDF: link and QR")
        sign_out(page)
        expect(page.get_by_role("button", name="Continuar con Google")).to_be_visible(timeout=10000)

        # ── a viewer opens the link ──
        page.goto(url)
        expect(page.get_by_text("Te compartieron un proyecto")).to_be_visible(timeout=20000)
        assert urlparse(page.url).path == "/", page.url
        team_login(page, VERA["email"])
        expect(side.get_by_text("Modo lector")).to_be_visible(timeout=20000)
        expect(side.get_by_role("heading", name="Beto's edit")).to_be_visible()
        for name in ("Archivo", "Gateway", "Cambiar modelo…", "Compartir", "Proyectos…"):
            assert side.get_by_role("button", name=name, exact=True).count() == 0, name
        assert page.get_by_label("Nombre del proyecto").count() == 0
        assert (pid, VERA["id"]) in VIEWERS
        # the map fills its panel and frames the project (it used to stay a few pixels wide)
        page.wait_for_function("() => { const c = document.querySelector('.maplibregl-canvas');"
                               " return c && c.clientWidth > 600 && c.clientHeight > 300 }", timeout=10000)
        page.screenshot(path=f"{OUT}/viewer.png")
        side.get_by_role("button", name=re.compile(r"^N-1\b")).click()
        panel = page.get_by_role("complementary", name="Dispositivo")
        expect(panel.get_by_label("Nombre")).to_be_disabled()
        expect(panel.get_by_label("Latitud")).to_be_disabled()
        assert panel.get_by_label("Titular").count() == 0, "owners hidden by the link"
        height = panel.get_by_label("Altura sobre el suelo (m)")
        expect(height).to_be_enabled()
        original = PROJECTS[pid]["data"]["nodes"][0]["height"]
        height.fill("3")
        height.press("Enter")
        expect(side.get_by_text("Restaurar valores originales (1)")).to_be_visible(timeout=5000)
        for _ in range(50):
            if VIEWERS[(pid, VERA["id"])]["overrides"]:
                break
            page.wait_for_timeout(100)
        assert VIEWERS[(pid, VERA["id"])]["overrides"] == {"nodes": {"N-1": {"height": 3}}}, VIEWERS[(pid, VERA["id"])]
        assert PROJECTS[pid]["data"]["nodes"][0]["height"] == original, "the team's project never changes"
        print("viewer: read-only, owners hidden, own height change saved apart")
        page.reload()
        expect(side.get_by_text("Modo lector")).to_be_visible(timeout=20000)
        side.get_by_role("button", name=re.compile(r"^N-1\b")).click()
        expect(panel.get_by_label("Altura sobre el suelo (m)")).to_have_value("3")
        print("viewer: change kept on reload")
        side.get_by_role("button", name="Reporte", exact=True).click()
        assert page.get_by_text("El link muestra titulares").count() == 0      # the team's choice
        pdf = pdf_from(page, downloads)
        assert f"/URI ({url})".encode() in pdf
        print("viewer PDF: same link")
        # their files and profile
        side.get_by_role("button", name="Mis archivos").click()
        expect(page.get_by_role("heading", name="Mis archivos")).to_be_visible(timeout=10000)
        expect(page.get_by_role("button", name="Abrir Beto's edit")).to_be_visible()
        page.screenshot(path=f"{OUT}/files.png")
        page.get_by_role("button", name="Configuración").click()
        prof = page.get_by_role("dialog", name="Configuración")
        expect(prof.get_by_role("tab", name="Cuenta")).to_have_attribute("aria-selected", "true")
        assert prof.get_by_role("tab", name="Administración").count() == 0          # viewers: no admin tab
        prof.get_by_label("Teléfono (opcional)").fill("33 1234 5678")
        prof.get_by_label("Empresa (opcional)").fill("Agrícola Vera")
        prof.get_by_role("button", name="Guardar").click()
        expect(prof.get_by_role("status")).to_have_text("Guardado", timeout=5000)
        assert VERA["phone"] == "33 1234 5678" and VERA["company"] == "Agrícola Vera" and VERA["role"] == "viewer"
        prof.get_by_role("button", name="Cerrar", exact=True).click()
        print("profile saved")
        # the team removes their access
        VIEWERS.pop((pid, VERA["id"]))
        page.get_by_role("button", name="Abrir Beto's edit").click()
        expect(page.get_by_text("Ya no tienes acceso a ese proyecto")).to_be_visible(timeout=10000)
        print("access removed: back to the files with a notice")
        sign_out(page)

        # ── an admin turns the viewer into an editor ──
        team_login(page, JEFA["email"])
        expect(side.get_by_role("button", name="Configuración")).to_be_visible(timeout=20000)
        side.get_by_role("button", name="Configuración").click()
        conf = page.get_by_role("dialog", name="Configuración")
        conf.get_by_role("tab", name="Administración").click()
        conf.get_by_role("button", name="Usuarios y roles…").click()
        users = page.get_by_role("dialog", name="Usuarios")
        expect(users).to_contain_text("Agrícola Vera")
        users.get_by_label(f"Rol de {VERA['email']}").select_option("member")
        page.get_by_role("alertdialog", name="Confirmar").get_by_role("button", name="Dar acceso").click()
        for _ in range(50):
            if VERA["role"] == "member":
                break
            page.wait_for_timeout(100)
        assert VERA["role"] == "member"
        page.screenshot(path=f"{OUT}/users.png")
        print("admin: viewer promoted to editor")
        # ── an admin creates an account (the API's admin endpoint is answered here: no service key in tests) ──
        created = []

        def create(route, request):
            body = request.post_data_json
            created.append(body)
            new = person(body["email"], body["full_name"], body["role"])
            PROFILES[new["id"]] = new
            route.fulfill(json={"id": new["id"], "email": body["email"], "role": body["role"]})
        page.route("**/api/admin/users", create)
        users.get_by_role("button", name="Crear usuario").click()
        form = users.get_by_role("form", name="Crear usuario")
        form.get_by_label("Correo").fill("tecnico@agricola.mx")
        form.get_by_label("Nombre").fill("Técnico de campo")
        temp = form.get_by_label("Contraseña temporal").input_value()
        assert len(temp) >= 10, temp
        form.get_by_role("button", name="Crear cuenta").click()
        expect(form.get_by_role("status")).to_contain_text(temp)
        assert created == [{"email": "tecnico@agricola.mx", "full_name": "Técnico de campo", "role": "member", "password": temp}]
        expect(users).to_contain_text("tecnico@agricola.mx")
        new_id = next(k for k, v in PROFILES.items() if v["email"] == "tecnico@agricola.mx")
        users.get_by_role("button", name="Eliminar tecnico@agricola.mx").click()
        page.get_by_role("alertdialog", name="Confirmar").get_by_role("button", name="Eliminar cuenta").click()
        expect(users.locator("table")).not_to_contain_text("tecnico@agricola.mx")
        assert new_id not in PROFILES
        assert users.get_by_role("button", name=f"Eliminar {JEFA['email']}").count() == 0      # not yourself
        print("admin: account created with a temporary password, then deleted")
        b.close()
    print("page errors:", errors)
    print("screenshots in", OUT)
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
