"""
Screenshots of the main screens for design reviews (before / after), light and dark, desktop and phone.

Needs the two dev servers of run.py (local mode, 5174) and cloud.py (fake Supabase, 5175; only the
login screen is shot there, no session needed) and a development API on 8001:

    .venv/bin/python frontend/e2e/shots.py <output dir>
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

LOCAL = "http://127.0.0.1:5174/"
CLOUD = "http://127.0.0.1:5175/"
SAMPLE = Path(__file__).resolve().parent / "sample.verea.json"
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "shots")
SIZES = {"desktop": (1440, 900), "phone": (390, 844)}


def context(b, theme, size):
    w, h = SIZES[size]
    ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=2 if size == "phone" else 1,
                        is_mobile=size == "phone", has_touch=size == "phone")
    ctx.add_init_script(f"try {{ localStorage.setItem('verea.theme', '{theme}') }} catch (e) {{}}")
    return ctx


def workspace(b, theme, size):
    ctx = context(b, theme, size)
    page = ctx.new_page()
    page.goto(LOCAL)
    page.locator("input[type=file]").first.set_input_files(str(SAMPLE))
    page.get_by_text("N-1").first.wait_for(timeout=20000)
    page.wait_for_timeout(4000)                     # links and map tiles
    page.screenshot(path=OUT / f"workspace-{size}-{theme}.png", full_page=size == "phone")
    if size == "desktop":
        page.get_by_role("button", name="N-1", exact=False).first.click()
        page.wait_for_timeout(3500)                 # profile chart
        page.screenshot(path=OUT / f"node-{size}-{theme}.png")
        page.get_by_role("button", name="Configuración").click()
        page.wait_for_timeout(500)
        page.screenshot(path=OUT / f"settings-{size}-{theme}.png")
    ctx.close()


def login(b, theme, size):
    ctx = context(b, theme, size)
    page = ctx.new_page()
    page.route("https://fake.supabase.co/**", lambda r: r.fulfill(status=401, json={}))
    page.goto(CLOUD)
    page.get_by_role("button", name="Continuar con Google").wait_for(timeout=20000)
    page.wait_for_timeout(800)
    page.screenshot(path=OUT / f"login-{size}-{theme}.png")
    ctx.close()


def team_workspace(b, theme):
    """The team's view (Guardar, Proyectos, Compartir) against cloud.py's fake Supabase."""
    import json
    import cloud
    if not cloud.PROJECTS:
        sample = json.load(open(SAMPLE))
        cloud.add_project("Huerta de Beto", cloud.BETO["id"], {**sample, "name": "Huerta de Beto"})
    ctx = context(b, theme, "desktop")
    page = ctx.new_page()
    page.route(f"{cloud.SUPA}/rest/v1/**", cloud.rest)
    page.route(f"{cloud.SUPA}/auth/v1/**", cloud.auth)
    page.goto(CLOUD)
    cloud.team_login(page, cloud.ANA["email"])
    page.get_by_label("Nombre del proyecto").wait_for(timeout=20000)
    page.wait_for_timeout(4000)
    page.screenshot(path=OUT / f"team-desktop-{theme}.png")
    page.get_by_label("Nombre del proyecto").fill("Huerta de Beto (editado)")
    page.get_by_role("button", name="Archivo", exact=True).click()
    page.wait_for_timeout(400)
    page.screenshot(path=OUT / f"team-menu-desktop-{theme}.png")
    ctx.close()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        for theme in ("light", "dark"):
            for size in SIZES:
                workspace(b, theme, size)
                login(b, theme, size)
            team_workspace(b, theme)
        b.close()
    print("screenshots in", OUT)


if __name__ == "__main__":
    main()
