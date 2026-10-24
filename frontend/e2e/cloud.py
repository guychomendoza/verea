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
        VITE_SUPABASE_ANON_KEY=x npx vite --host 127.0.0.1 --port 5175
    .venv/bin/python frontend/e2e/cloud.py
"""
import json
import os
import re
import sys
import tempfile
import time
import uuid
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
    src = {"profiles": PROFILES, "projects": PROJECTS, "project_shares": SHARES, "project_viewers": VIEWERS}[table]
    # What the database's row level security lets this caller see
    visible = {
        "profiles": lambda r: team(me) or r["id"] == me["id"],
        "projects": lambda r: team(me),
        "project_shares": lambda r: team(me),
        "project_viewers": lambda r: team(me) or r["user_id"] == me["id"],
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
        if table == "projects":
            rows = [r for r in rows if r["owner_id"] == me["id"] or me["role"] == "admin"]
        for r in rows:
            src.pop(r["id"] if table != "project_viewers" else (r["project_id"], r["user_id"]))
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
    page.get_by_role("button", name=re.compile("Soy del equipo")).click()
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


def main():
    errors = []
    sample = json.load(open("frontend/e2e/sample.verea.json"))
    add_project("Ana's field", ANA["id"], {**sample, "name": "Ana's field"})
    add_project("Beto's orchard", BETO["id"], {**sample, "name": "Beto's orchard"})
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        page = b.new_page(viewport={"width": 1400, "height": 860}, accept_downloads=True)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("dialog", lambda d: d.accept())
        downloads = []
        page.on("download", lambda d: downloads.append(d))
        page.route(f"{SUPA}/rest/v1/**", rest)
        page.route(f"{SUPA}/auth/v1/**", auth)
        page.goto(URL)
        expect(page.get_by_role("button", name="Continuar con Google")).to_be_visible(timeout=20000)
        page.screenshot(path=f"{OUT}/login.png")
        # team login
        page.get_by_role("button", name=re.compile("Soy del equipo")).click()
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
        page.get_by_role("dialog", name="Proyectos del equipo").get_by_role("button", name=re.compile("^Ana's field")).click()
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
        settings.get_by_label(re.compile("Autoguardado")).check()
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
        dialog = page.get_by_role("dialog", name="Proyectos del equipo")
        expect(dialog).to_contain_text("Beto's edit")
        assert dialog.get_by_role("button", name="Eliminar Beto's edit").count() == 0
        dialog.get_by_role("button", name=re.compile("Eliminar Ana's late edit")).click()
        expect(dialog).not_to_contain_text("Ana's late edit (mi copia)", timeout=10000)
        dialog.get_by_role("button", name=re.compile("Beto's edit")).click()
        expect(page.get_by_label("Nombre del proyecto")).to_have_value("Beto's edit", timeout=10000)
        page.reload()
        expect(page.get_by_label("Nombre del proyecto")).to_have_value("Beto's edit", timeout=20000)
        print("reload keeps session and project: ok")

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
        for _ in range(50):
            if VERA["role"] == "member":
                break
            page.wait_for_timeout(100)
        assert VERA["role"] == "member"
        page.screenshot(path=f"{OUT}/users.png")
        print("admin: viewer promoted to editor")
        b.close()
    print("page errors:", errors)
    print("screenshots in", OUT)
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
