"""
End-to-end check of the web frontend in Chromium (Playwright), local mode (no login).

Needs a development API and a dev server in local mode, e.g.:

    VEREA_DEV=1 VEREA_CORS_ORIGINS=http://127.0.0.1:5174 .venv/bin/uvicorn backend.main:app --port 8001
    cd frontend && VITE_API_URL=http://127.0.0.1:8001 VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= \\
        npx vite --host 127.0.0.1 --port 5174
    .venv/bin/python frontend/e2e/run.py [screenshot dir]

Covers: opening the sample project (N-1 = 28.8 dB, same as Streamlit), map labels with km/dB,
selecting a node on the map, the Elevation Profile (zoom, reset, hover linked to the map, pins,
image), resizable/collapsible panels, ruler, shortcuts, place search, dark map image, PDF report,
Spanish texts, reload and phone width.
"""
import io
import math
import os
import re
import sys
import tempfile
from pathlib import Path

from PIL import Image
from playwright.sync_api import expect, sync_playwright

HERE = Path(__file__).resolve().parent
SAMPLE = HERE / "sample.verea.json"
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix="verea-e2e-"))
URL = os.environ.get("VEREA_E2E_URL", "http://127.0.0.1:5174/")
# Visible English that must not appear (technical terms such as gateway, dB, SF are fine)
ENGLISH = ["Save", "Open…", "Project", "Nodes", "Loading", "Search", "Delete", "Height", "Frequency",
           "Coverage", "Show on map", "Links up to date", "Viable via", "Sign out", "Add to the map",
           "Map image", "Safety margin", "Default environment", "Terrain profile", "Distance"]


def png(path: Path) -> Image.Image:
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    return Image.open(io.BytesIO(data)).convert("RGB")


def haversine(a, b):
    r = math.pi / 180
    h = (math.sin((b[0] - a[0]) * r / 2) ** 2
         + math.cos(a[0] * r) * math.cos(b[0] * r) * math.sin((b[1] - a[1]) * r / 2) ** 2)
    return 2 * 6_371_000 * math.asin(math.sqrt(h))


def english_on_screen(page) -> list[str]:
    text = page.inner_text("body")
    return [w for w in ENGLISH if re.search(rf"(?<![\w-]){re.escape(w)}(?![\w-])", text)]


def main():
    errors = []
    with sync_playwright() as pw:
        b = pw.chromium.launch(args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        ctx = b.new_context(viewport={"width": 1500, "height": 900}, accept_downloads=True)
        page = ctx.new_page()
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(URL)
        expect(page.get_by_role("button", name="Archivo ▾")).to_be_visible(timeout=30000)

        # ── open the sample project ──
        page.locator("input[type=file]").set_input_files(str(SAMPLE))
        expect(page.get_by_role("status").first).to_contain_text("Enlaces al día", timeout=60000)
        side = page.get_by_role("complementary", name="Proyecto", exact=True)
        expect(side.get_by_role("button", name=re.compile(r"N-1"))).to_contain_text("28.8 dB")
        print("N-1 in list:", side.get_by_role("button", name=re.compile(r"N-1")).inner_text().replace("\n", " "))

        # ── map labels carry distance and margin ──
        page.wait_for_function("() => window.__vereaMap && window.__vereaMap.loaded()", timeout=30000)
        labels = page.evaluate("async () => (await window.__vereaMap.getSource('devices').getData()).features.map(f => f.properties.label)")
        n1 = next(l for l in labels if l.startswith("N-1"))
        assert re.search(r"1\.23 km · 28\.8 dB", n1), labels
        print("map labels:", [l.replace("\n", " | ") for l in labels])

        # ── brand and symbology: logo on the page, one symbol per device type ──
        expect(side.locator(".brand-bar .logo svg")).to_be_visible()
        icons = page.evaluate("async () => Object.fromEntries((await window.__vereaMap.getSource('devices').getData())"
                              ".features.map(f => [f.properties.name, f.properties.icon]))")
        assert icons == {"GW-1": "icon-gateway", "N-1": "icon-lora", "N-2": "icon-lora", "4G-1": "icon-cellular",
                         "WX-1": "icon-station"}, icons
        page.wait_for_timeout(800)
        missing = page.evaluate("() => ['gateway','lora','cellular','station'].filter(k => !window.__vereaMap.hasImage('icon-' + k))")
        assert not missing, missing
        assert side.locator(".device-list .device-icon").count() == 5
        print("logo in the side panel; map symbols:", icons)
        counter = page.get_by_role("region", name="Resumen de la red")
        expect(counter).to_contain_text("Red: 1 GW · 4 sensores")
        expect(counter).to_contain_text("3 LoRa")
        expect(counter).to_contain_text("1 4G")
        print("map counter:", counter.inner_text().replace("\n", " | "))

        # ── bug: a click on a node in the map opens the device panel and keeps it open ──
        pt = page.evaluate("() => window.__vereaMap.project([-102.2952, 21.2519])")
        box = page.get_by_test_id("map").bounding_box()
        page.mouse.click(box["x"] + pt["x"], box["y"] + pt["y"])
        panel = page.get_by_role("complementary", name="Dispositivo")
        expect(panel).to_be_visible()
        page.wait_for_timeout(1500)
        expect(panel).to_be_visible()
        expect(panel.get_by_label("Nombre")).to_have_value("N-1")
        print("click on map node: panel stays open")
        expect(panel.get_by_label("Titular")).to_have_value("Ana Torres")
        panel.get_by_label("Superficie (ha)").fill("3.25")
        panel.get_by_label("Superficie (ha)").press("Enter")
        expect(panel.get_by_label("Superficie (ha)")).to_have_value("3.25")
        print("owner and area shown and editable in the node panel")

        # ── elevation profile ──
        chart = page.get_by_test_id("profile-chart")
        expect(chart.locator(".main-svg").first).to_be_visible(timeout=30000)
        expect(page.get_by_role("region", name="Perfil de Elevación")).to_contain_text("Perfil de Elevación")
        title = page.evaluate("() => document.querySelector('[data-testid=profile-chart]').layout.title.text")
        assert title.startswith("GW-1 → N-1 | 1.23 km | SF10 | 915 MHz"), title
        xr = lambda: page.evaluate("() => document.querySelector('[data-testid=profile-chart]')._fullLayout.xaxis.range.slice()")
        full = xr()
        chart.locator('a[data-title="Acercar"]').click()
        page.wait_for_timeout(500)
        zoomed = xr()
        assert zoomed[1] - zoomed[0] < (full[1] - full[0]) * 0.8, (full, zoomed)
        chart.locator('a[data-title="Restablecer ejes"]').click()
        page.wait_for_timeout(500)
        assert all(abs(a - b) < 1e-6 for a, b in zip(xr(), full)), (xr(), full)
        print("profile zoom in / reset axes:", [round(v, 3) for v in zoomed], "->", [round(v, 3) for v in full])
        cb = chart.locator(".nsewdrag").first.bounding_box()
        page.mouse.move(cb["x"] + cb["width"] * 0.4, cb["y"] + cb["height"] * 0.5)
        page.wait_for_timeout(400)
        cur = page.evaluate("async () => (await window.__vereaMap.getSource('cursor').getData()).features.length")
        assert cur == 1, "hover in the profile should mark the point on the map"
        page.mouse.click(cb["x"] + cb["width"] * 0.4, cb["y"] + cb["height"] * 0.5)
        expect(page.get_by_role("button", name=re.compile(r"Borrar puntos \(1\)"))).to_be_visible()
        pins = page.evaluate("async () => (await window.__vereaMap.getSource('profile-pins').getData()).features.length")
        assert pins == 1
        print("profile hover -> map cursor, click -> pin on chart and map")
        page.screenshot(path=f"{OUT}/1_profile.png")
        with page.expect_download() as dl:
            page.get_by_role("button", name="📈 Descargar imagen").click()
        img = png(Path(dl.value.path()))
        assert img.getpixel((5, 5))[0] < 40, "profile image background should be dark"
        print("profile image:", img.size, dl.value.suggested_filename)

        # ── panels: arrows on the borders, shown only nearby; collapse / expand and resize ──
        left = page.locator('[data-panel-id="left"]')
        width = lambda: left.bounding_box()["width"]
        w0 = width()
        arrow = page.locator(".edge-left .edge-toggle")
        assert float(arrow.evaluate("e => getComputedStyle(e).opacity")) == 0, "hidden until the pointer is near"
        page.locator(".edge-left").hover()
        page.wait_for_timeout(250)
        assert float(arrow.evaluate("e => getComputedStyle(e).opacity")) == 1
        expect(arrow).to_have_attribute("aria-label", "Cerrar Proyecto")
        arrow.click()
        page.wait_for_timeout(300)
        assert width() < 5, width()
        page.locator(".edge-left").hover()
        expect(arrow).to_have_attribute("aria-label", "Abrir Proyecto")
        arrow.click()
        page.wait_for_timeout(300)
        assert abs(width() - w0) < 5
        prof_region = page.get_by_role("region", name="Perfil de Elevación")
        h0 = prof_region.bounding_box()["height"]
        handle = page.locator(".resize-y").bounding_box()
        page.mouse.move(handle["x"] + 40, handle["y"] + 2)
        page.mouse.down()
        page.mouse.move(handle["x"] + 40, handle["y"] - 120, steps=6)
        page.mouse.up()
        h1 = prof_region.bounding_box()["height"]
        assert h1 > h0 + 80, (h0, h1)
        page.locator(".edge-bottom").hover()
        page.locator(".edge-bottom .edge-toggle").click()
        page.wait_for_timeout(300)
        assert page.locator('[data-panel-id="profile"]').bounding_box()["height"] < 5
        page.locator(".edge-bottom").hover()
        expect(page.locator(".edge-bottom .edge-toggle")).to_have_attribute("aria-label", "Abrir Perfil de Elevación")
        page.locator(".edge-bottom .edge-toggle").click()
        page.wait_for_timeout(300)
        page.locator(".edge-right").hover()
        page.locator(".edge-right .edge-toggle").click()
        page.wait_for_timeout(300)
        assert page.locator('[data-panel-id="right"]').bounding_box()["width"] < 5
        page.locator(".edge-right").hover()
        page.locator(".edge-right .edge-toggle").click()
        page.wait_for_timeout(300)
        assert page.locator('[data-panel-id="right"]').bounding_box()["width"] > 100
        page.screenshot(path=f"{OUT}/2_edges.png")
        print(f"panels: border arrows hidden until hover; left/right/profile close and reopen; profile {h0:.0f}->{h1:.0f}px")

        # ── ruler: button on the map, two clicks, compare with haversine ──
        page.get_by_role("complementary", name="Dispositivo").get_by_role("button", name="Cerrar").click()
        page.get_by_role("button", name="Regla: medir distancias").click()
        expect(page.get_by_role("button", name="Regla: medir distancias")).to_have_attribute("aria-pressed", "true")
        box = page.get_by_test_id("map").bounding_box()
        p1, p2 = (box["x"] + 300, box["y"] + 250), (box["x"] + 600, box["y"] + 120)
        page.mouse.click(*p1)
        page.mouse.click(*p2)
        page.screenshot(path=f"{OUT}/2_ruler.png")
        ll = page.evaluate(f"""() => [window.__vereaMap.unproject([300, 250]), window.__vereaMap.unproject([600, 120])]
                               .map(p => [p.lat, p.lng])""")
        expected = haversine(*ll)
        shown = page.get_by_test_id("ruler-total").inner_text()
        val = float(shown.split()[0].replace(",", "")) * (1000 if "km" in shown else 1)
        assert abs(val - expected) / expected < 0.01, (shown, expected)
        page.keyboard.press("Escape")
        print(f"ruler: {shown} (haversine {expected:.0f} m)")
        n1_now = page.evaluate("async () => (await window.__vereaMap.getSource('devices').getData()).features.find(f => f.properties.name === 'N-1').geometry.coordinates")
        assert abs(n1_now[0] + 102.2952) < 1e-6 and abs(n1_now[1] - 21.2519) < 1e-6, f"N-1 moved: {n1_now}"   # stale drag bug
        page.get_by_role("region", name="Regla").get_by_role("button", name="Borrar").click()

        # ── shortcuts ──
        page.keyboard.press("g")
        expect(page.locator(".mode-banner")).to_contain_text("gateway")
        page.keyboard.press("Escape")
        expect(page.locator(".mode-banner")).to_have_count(0)
        page.keyboard.press("n")
        expect(page.locator(".mode-banner")).to_contain_text("sensor")
        page.mouse.click(box["x"] + 450, box["y"] + 200)
        expect(page.get_by_role("complementary", name="Dispositivo").get_by_label("Modelo")).to_have_value("dragino_lse01")
        new_name = page.get_by_role("complementary", name="Dispositivo").get_by_label("Nombre").input_value()
        page.get_by_role("complementary", name="Dispositivo").get_by_label("Nombre").press("g")   # typing: no shortcut
        expect(page.locator(".mode-banner")).to_have_count(0)
        page.locator("body").click(position={"x": 5, "y": 880})
        page.keyboard.press("Control+s")
        expect(page.get_by_role("status").first).to_contain_text("Guardado en este navegador")
        print("shortcuts: G gateway, N ->", new_name, "(LSE01), typing ignored, Ctrl+S saved")

        # ── search + labels ──
        search = page.get_by_label("Buscar ubicación")
        search.fill("21.8818, -102.2916")
        search.press("Enter")
        page.wait_for_function("() => { const c = window.__vereaMap.getCenter();"
                               " return Math.abs(c.lat - 21.8818) < 1e-3 && Math.abs(c.lng + 102.2916) < 1e-3 }",
                               timeout=15000)
        print("search by coordinates: ok")

        # ── 4G coverage switch on the map (bottom right) ──
        cov_btn = page.get_by_test_id("map").get_by_role("button", name="Cobertura 4G")
        vis = lambda: page.evaluate("() => window.__vereaMap.getLayoutProperty('coverage', 'visibility')")
        assert vis() == "none"
        cov_btn.click()
        expect(cov_btn).to_have_attribute("aria-pressed", "true")
        page.wait_for_function("() => window.__vereaMap.getLayoutProperty('coverage', 'visibility') === 'visible'", timeout=5000)
        expect(page.locator(".verea-coverage-legend")).to_contain_text("Posible (LTE-M)")
        page.wait_for_timeout(2500)
        page.screenshot(path=f"{OUT}/3_coverage.png")
        cov_btn.click()
        page.wait_for_function("() => window.__vereaMap.getLayoutProperty('coverage', 'visibility') === 'none'", timeout=5000)
        print("coverage switch on the map: on/off with its legend")

        # ── map image with dark frame ──
        side.get_by_role("button", name=re.compile(r"N-1")).click()
        page.wait_for_timeout(2500)
        with page.expect_download() as dl:
            page.get_by_role("button", name="📷 Imagen del mapa").click()
        img = png(Path(dl.value.path()))
        bg = img.getpixel((3, 3))
        assert bg == (15, 34, 54), bg      # brand navy
        print("map image:", img.size, "frame", bg, dl.value.suggested_filename)

        # ── Spanish ──
        found = english_on_screen(page)
        assert not found, found
        assert page.get_by_role("button", name="Acercar").count() == 1, "map controls in Spanish"
        assert page.get_by_role("button", name="Zoom in").count() == 0
        print("no English left on the main screen")

        # ── report: PDF (the detail of each node is the app itself, through a shared link) ──
        side.get_by_role("button", name="📄 Reporte").click()
        dialog = page.get_by_role("dialog", name="Reporte")
        assert dialog.get_by_text("HTML").count() == 0, "no HTML report any more"
        assert dialog.get_by_text("Ver este proyecto a detalle").count() == 0, "local mode: no link to share"
        dialog.get_by_role("button", name="Generar PDF").click()
        expect(dialog.get_by_role("button", name="Cancelar")).to_be_visible()
        dialog.get_by_role("button", name="Cancelar").click()
        expect(dialog.get_by_role("button", name="Generar PDF")).to_be_enabled(timeout=20000)
        expect(dialog.get_by_role("alert")).to_have_count(0)
        print("report: Cancelar stops the generation")
        downloads = []
        page.on("download", lambda d: downloads.append(d))
        dialog.get_by_role("button", name="Generar PDF").click()
        expect(dialog).to_have_count(0, timeout=120000)          # closes by itself once downloaded
        page.wait_for_timeout(500)
        names = [d.suggested_filename for d in downloads]
        assert len(names) == 1 and names[0].endswith(".pdf"), names
        pdf = downloads[0]
        pdf_bytes = Path(pdf.path()).read_bytes()
        pages = len(re.findall(rb"/Type\s*/Page[^s]", pdf_bytes))
        assert pdf_bytes[:5] == b"%PDF-" and pages >= 1, pages
        assert len(pdf_bytes) < 5_000_000, f"PDF too big: {len(pdf_bytes) / 1e6:.1f} MB"
        assert b"/URI" not in pdf_bytes, "local mode: no online link"
        pdf.save_as(OUT / pdf.suggested_filename)
        assert pages <= 3, pages             # summary: map, gateway / LoRa / 4G tables
        expect(side.get_by_role("status")).to_contain_text("Reporte descargado")
        print("report:", names, f"PDF {len(pdf_bytes) / 1024:.0f} KB, {pages} pages (summary)")

        # ── Configuración → Apariencia: light / dark, remembered (local mode: no account tab) ──
        side.get_by_role("button", name="Configuración").click()
        conf = page.get_by_role("dialog", name="Configuración")
        assert conf.get_by_role("tab", name="Cuenta").count() == 0
        conf.get_by_role("radio", name="Claro").click()
        assert page.evaluate("document.documentElement.dataset.theme") == "light"
        light_bg = page.evaluate("getComputedStyle(document.body).backgroundColor")
        conf.get_by_role("radio", name="Oscuro").click()
        expect(conf.get_by_role("radio", name="Oscuro")).to_have_attribute("aria-checked", "true")
        assert page.evaluate("document.documentElement.dataset.theme") == "dark"
        page.screenshot(path=f"{OUT}/9_settings.png")
        conf.get_by_role("button", name="Cerrar").click()
        dark_bg = page.evaluate("getComputedStyle(document.body).backgroundColor")
        assert light_bg != dark_bg, (light_bg, dark_bg)
        page.screenshot(path=f"{OUT}/9_dark.png")
        print(f"theme: light {light_bg} / dark {dark_bg}")

        # ── filters, bulk model change, undo / redo ──
        side.get_by_label("Buscar nodo").fill("Beto")
        sensors = side.get_by_role("region", name="Lista de sensores")
        expect(sensors.locator("li")).to_have_count(1)
        side.get_by_label("Buscar nodo").fill("")
        groups = sensors.locator(".section-toggle h3").all_inner_texts()
        assert groups == ["Sensores LoRa", "Sensores 4G", "Estaciones meteorológicas"], groups
        lora_tab = sensors.get_by_role("button", name=re.compile("Sensores LoRa"))
        total = sensors.locator("li").count()
        lora_tab.click()                                                       # each kind folds on its own
        expect(lora_tab).to_have_attribute("aria-expanded", "false")
        expect(sensors.locator("li")).to_have_count(2)                         # the 4G sensor and the station
        lora_tab.click()
        expect(sensors.locator("li")).to_have_count(total)
        side.get_by_role("button", name=re.compile(r"^4G incierto")).click()
        expect(sensors.locator("li")).to_have_count(1)
        side.get_by_role("button", name=re.compile(r"^Todos")).click()
        side.get_by_role("button", name="Cambiar modelo…").click()
        bulk = page.get_by_role("dialog", name="Cambiar modelo de sensores")
        bulk.get_by_role("checkbox", name=re.compile("4G incierto")).check()
        bulk.get_by_label("Modelo nuevo").select_option("dragino_se0x_lb")
        bulk.get_by_role("button", name=re.compile(r"^Cambiar 1 a")).click()
        icon_of = lambda name: page.evaluate(f"async () => (await window.__vereaMap.getSource('devices').getData()).features.find(f => f.properties.name === {name!r}).properties.icon")
        page.wait_for_timeout(500)
        assert icon_of("4G-1") == "icon-lora"
        page.locator("body").click(position={"x": 5, "y": 880})
        page.keyboard.press("Control+z")
        page.wait_for_timeout(400)
        assert icon_of("4G-1") == "icon-cellular"
        page.keyboard.press("Control+y")
        page.wait_for_timeout(400)
        assert icon_of("4G-1") == "icon-lora"
        side.get_by_role("button", name="Deshacer").click()
        page.wait_for_timeout(400)
        assert icon_of("4G-1") == "icon-cellular"
        print("filters (search, state chip); bulk 4G → SE0X-LB keeps the name; Ctrl+Z / Ctrl+Y / undo button")
        # every LoRa node in one environment (crop stage) at once, one undo step
        n1 = side.get_by_role("button", name=re.compile(r"^N-1\b"))
        side.get_by_label("Entorno de todos los nodos LoRa").select_option("Cultivo alto / Milpa")
        expect(n1).to_contain_text("13.8 dB", timeout=30000)                 # low crop 5 dB -> tall crop 20 dB
        side.get_by_role("button", name="Deshacer").click()
        expect(n1).to_contain_text("28.8 dB", timeout=30000)
        print("environment of every LoRa node at once: 28.8 → 13.8 dB, undone")
        # a real drag still moves a node, and Ctrl+Z puts it back
        page.evaluate("() => window.__vereaMap.jumpTo({center: [-102.294, 21.258], zoom: 15})")
        page.wait_for_timeout(800)
        mbox = page.get_by_test_id("map").bounding_box()
        wx = page.evaluate("() => window.__vereaMap.project([-102.294, 21.258])")
        page.mouse.move(mbox["x"] + wx["x"], mbox["y"] + wx["y"])
        page.mouse.down()
        page.mouse.move(mbox["x"] + wx["x"] + 60, mbox["y"] + wx["y"] + 40, steps=8)
        page.mouse.up()
        page.wait_for_timeout(400)
        pos = lambda: page.evaluate("JSON.parse(localStorage.getItem('verea.project')).nodes.find(n => n.name === 'WX-1')")
        moved = pos()
        assert abs(moved["lon"] + 102.294) > 1e-4, moved
        page.locator("body").click(position={"x": 5, "y": 880})
        page.keyboard.press("Control+z")
        page.wait_for_timeout(400)
        back = pos()
        assert abs(back["lon"] + 102.294) < 1e-6 and abs(back["lat"] - 21.258) < 1e-6, back
        print("drag a node: moves; Ctrl+Z puts it back")

        # ── gateway range (one click) ──
        side.get_by_role("button", name=re.compile(r"GW-1")).click()
        dev = page.get_by_role("complementary", name="Dispositivo")
        dev.get_by_role("button", name="📡 Ver alcance de la señal").click()
        expect(dev.get_by_role("button", name="Ocultar alcance")).to_be_visible(timeout=60000)
        n_range = page.evaluate("async () => (await window.__vereaMap.getSource('range').getData()).features.length")
        assert n_range > 24, n_range
        page.wait_for_timeout(1500)
        page.screenshot(path=f"{OUT}/10_range.png")
        dev.get_by_role("button", name="Ocultar alcance").click()
        print(f"gateway range: {n_range} features (area + rays)")

        # ── suggest 4G gateways ──
        side.get_by_role("button", name="Sugerir gateways 4G…").click()
        sug = page.get_by_role("dialog", name="Sugerir gateways 4G")
        sug.get_by_label("Nodos a cubrir").select_option("all")
        sug.get_by_role("button", name="Buscar ubicaciones").click()
        expect(sug.get_by_role("status")).to_contain_text("gateways propuestos", timeout=120000)
        print("suggestion:", sug.get_by_role("status").inner_text())
        sug.screenshot(path=f"{OUT}/11_suggest.png")
        n_gw = len(page.evaluate("async () => (await window.__vereaMap.getSource('devices').getData()).features.filter(f => f.properties.kind === 'gateway')"))
        sug.get_by_role("button", name=re.compile(r"^Agregar \d+ gateways")).click()
        page.wait_for_timeout(600)
        n_gw2 = len(page.evaluate("async () => (await window.__vereaMap.getSource('devices').getData()).features.filter(f => f.properties.kind === 'gateway')"))
        assert n_gw2 > n_gw, (n_gw, n_gw2)
        page.locator("body").click(position={"x": 5, "y": 880})
        page.keyboard.press("Control+z")
        page.wait_for_timeout(500)
        print(f"suggested gateways added ({n_gw} → {n_gw2}) and undone")

        # ── import plots: KML (pins + polygons) then a CSV that updates one and adds one ──
        page.bring_to_front()
        side.get_by_role("button", name="Archivo ▾").click()
        page.get_by_role("menuitem", name="Importar parcelas…").click()
        imp = page.get_by_role("dialog", name="Importar parcelas")
        imp.get_by_label("Archivo a importar").set_input_files(str(HERE / "import_sample.kml"))
        expect(imp.get_by_role("status")).to_contain_text("4 filas")
        expect(imp).to_contain_text("parcela sin pin: sensor propuesto en el centro de la parcela")
        expect(imp).to_contain_text("la parcela no tiene folio; se tomó el de su pin")
        imp.get_by_role("button", name="Agregar 4 al proyecto").click()
        expect(imp).to_have_count(0)
        expect(side.get_by_role("button", name=re.compile(r"TST-D0004"))).to_be_visible()   # (the status line may already say "Calculando enlaces…")
        page.wait_for_timeout(800)
        got = page.evaluate("async () => (await window.__vereaMap.getSource('devices').getData()).features.map(f => f.properties.name)")
        assert {"TST-D0001", "TST-D0002", "TST-D0003", "TST-D0004"} <= set(got), got
        n_plots = page.evaluate("async () => (await window.__vereaMap.getSource('plots').getData()).features.length")
        assert n_plots == 3, n_plots
        side.get_by_role("button", name="Archivo ▾").click()
        page.get_by_role("menuitem", name="Importar parcelas…").click()
        imp.get_by_label("Archivo a importar").set_input_files(str(HERE / "import_sample.csv"))
        expect(imp.get_by_role("status")).to_contain_text("2 filas")
        expect(imp).to_contain_text("coordenada sin punto decimal (corregida)")
        imp.get_by_role("button", name="Agregar 1 y actualizar 1").click()
        side.get_by_role("button", name=re.compile(r"TST-D0001")).click()
        dev = page.get_by_role("complementary", name="Dispositivo")
        expect(dev.get_by_label("Titular")).to_have_value("Ana Prueba Uno")
        expect(dev.get_by_label("Superficie (ha)")).to_have_value("1.5")
        page.screenshot(path=f"{OUT}/8_import.png")
        print("import: KML 4 sensors + 3 plots (joined by location), CSV repaired coordinates, updated 1, added 1")

        # ── reload, phone ──
        page.reload()
        expect(side.get_by_role("button", name=re.compile(re.escape(new_name)))).to_be_visible(timeout=30000)
        page.screenshot(path=f"{OUT}/6_desktop.png")
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(1500)
        page.screenshot(path=f"{OUT}/7_phone.png")
        sw = page.evaluate("document.documentElement.scrollWidth")
        assert sw <= 390, sw
        print("reload keeps project; phone scrollWidth", sw)
        b.close()
    print("console errors:", errors)
    print("screenshots in", OUT)
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
