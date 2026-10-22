"""
End-to-end check of the web frontend in Chromium (Playwright), local mode (no login).

Needs a development API and a dev server in local mode, e.g.:

    VEREA_DEV=1 VEREA_CORS_ORIGINS=http://127.0.0.1:5174 .venv/bin/uvicorn backend.main:app --port 8001
    cd frontend && VITE_API_URL=http://127.0.0.1:8001 VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= \\
        npx vite --host 127.0.0.1 --port 5174
    .venv/bin/python frontend/e2e/run.py [screenshot dir]

Covers: opening the sample project (N-1 = 28.8 dB, same as Streamlit), map labels with km/dB,
selecting a node on the map, the Elevation Profile (zoom, reset, hover linked to the map, pins,
image), resizable/collapsible panels, ruler, shortcuts, place search, dark map image, PDF + HTML
reports, Spanish texts, reload and phone width.
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
        expect(page.get_by_role("button", name="Abrir…")).to_be_visible(timeout=30000)

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
        cov_btn = page.get_by_role("button", name="Cobertura 4G")
        vis = lambda: page.evaluate("() => window.__vereaMap.getLayoutProperty('coverage', 'visibility')")
        assert vis() == "none"
        cov_btn.click()
        expect(cov_btn).to_have_attribute("aria-pressed", "true")
        assert vis() == "visible"
        expect(page.locator(".verea-coverage-legend")).to_contain_text("Posible (LTE-M)")
        page.wait_for_timeout(2500)
        page.screenshot(path=f"{OUT}/3_coverage.png")
        cov_btn.click()
        assert vis() == "none"
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

        # ── report: PDF + interactive HTML ──
        side.get_by_role("button", name="📄 Reporte").click()
        dialog = page.get_by_role("dialog", name="Reporte")
        dialog.get_by_role("button", name="Generar y descargar").click()
        expect(dialog.get_by_role("button", name="Cancelar")).to_be_visible()
        page.wait_for_timeout(800)
        dialog.get_by_role("button", name="Cancelar").click()
        expect(dialog.get_by_role("button", name="Generar y descargar")).to_be_enabled(timeout=20000)
        expect(dialog.get_by_role("alert")).to_have_count(0)
        print("report: Cancelar stops the generation")
        downloads = []
        page.on("download", lambda d: downloads.append(d))
        dialog.get_by_role("button", name="Generar y descargar").click()
        expect(dialog.get_by_text("Listo", exact=True)).to_be_visible(timeout=120000)
        page.wait_for_timeout(500)
        names = [d.suggested_filename for d in downloads]
        assert names[0].endswith(".pdf") and names[1].endswith(".html"), names    # the PDF first, not waiting for the HTML
        pdf = next(d for d in downloads if d.suggested_filename.endswith(".pdf"))
        html = next(d for d in downloads if d.suggested_filename.endswith(".html"))
        pdf_bytes = Path(pdf.path()).read_bytes()
        pages = len(re.findall(rb"/Type\s*/Page[^s]", pdf_bytes))
        assert pdf_bytes[:5] == b"%PDF-" and pages >= 1, pages
        assert len(pdf_bytes) < 5_000_000, f"PDF too big: {len(pdf_bytes) / 1e6:.1f} MB"
        pdf.save_as(OUT / pdf.suggested_filename)
        html.save_as(OUT / html.suggested_filename)
        n_nodes = len(labels) - 1 + 1        # sample nodes + the one added with N (minus the gateway)
        assert pages <= 2, pages             # summary: map and the LoRa and 4G tables, no node cards
        print("report:", names, f"PDF {len(pdf_bytes) / 1024:.0f} KB, {pages} pages (summary)")
        dialog.get_by_role("button", name="Cerrar").last.click()
        rep = ctx.new_page()
        rep_errors = []
        rep.on("pageerror", lambda e: rep_errors.append(str(e)))
        rep.goto((OUT / html.suggested_filename).as_uri())
        expect(rep.locator(".chart .main-svg").first).to_be_visible(timeout=60000)
        rep.wait_for_timeout(2000)
        charts = rep.locator(".chart").count()
        snaps = rep.locator("img.snap")
        assert snaps.count() == n_nodes, snaps.count()
        expect(rep.locator("header .logo svg")).to_be_visible()
        legend = rep.locator("main > .symbology").inner_text()
        for k in ("Gateway", "Sensor LoRa", "Sensor 4G", "Estación meteorológica", "Enlace viable", "4G garantizado"):
            assert k in legend, (k, legend)
        assert rep.locator(".card .symbology").count() == n_nodes
        titles = rep.locator(".card h3").all_inner_texts()
        assert titles[0].startswith("N-1 · Ana Torres") and any(x.startswith("4G-1 · Beto Ruiz") for x in titles), titles
        heads = rep.locator("main h2").all_inner_texts()
        assert "Nodos LoRa" in heads and any(h.startswith("Sensores 4G") for h in heads), heads
        body = rep.locator("main").inner_text()
        assert "Señal declarada" not in body and "3.25 ha" in body and "5.06 ha" in body
        assert rep.locator("td .dt").count() == n_nodes
        print("HTML: LoRa and 4G tables (owner, area, status dot), cards 'node · owner' in alphabetical order")
        first = Image.open(io.BytesIO(__import__("base64").b64decode(snaps.first.get_attribute("src").split(",", 1)[1]))).convert("RGB")
        white = sum(1 for px in first.getdata() if min(px) > 235)
        assert white > 400, f"highlighted link (white rings and casing) not visible: {white}"
        first.save(OUT / "node_card_map.jpg")
        rep.screenshot(path=f"{OUT}/5_report_html.png", full_page=False)
        rep_cov = rep.get_by_role("button", name="Cobertura 4G")
        rep_cov.click()
        expect(rep_cov).to_have_attribute("aria-pressed", "true")
        rep.wait_for_timeout(3000)
        rep.screenshot(path=f"{OUT}/5_report_coverage.png")
        assert rep.evaluate("() => window.vereaMap.getLayoutProperty('coverage', 'visibility')") == "visible"
        print("HTML report: coverage switch")
        assert not rep_errors, rep_errors
        print("HTML report opens:", charts, "interactive profiles,", snaps.count(), "node maps, no errors")
        rep.close()

        # ── import plots: KML (pins + polygons) then a CSV that updates one and adds one ──
        page.bring_to_front()
        side.get_by_role("button", name="Importar parcelas…").click()
        imp = page.get_by_role("dialog", name="Importar parcelas")
        imp.get_by_label("Archivo a importar").set_input_files(str(HERE / "import_sample.kml"))
        expect(imp.get_by_role("status")).to_contain_text("4 filas")
        expect(imp).to_contain_text("parcela sin pin: sensor propuesto en el centro de la parcela")
        expect(imp).to_contain_text("la parcela no tiene folio; se tomó el de su pin")
        imp.get_by_role("button", name="Agregar 4 al proyecto").click()
        expect(imp).to_have_count(0)
        expect(page.get_by_role("status").first).to_contain_text("Importado: 4 nodos nuevos")
        page.wait_for_timeout(800)
        got = page.evaluate("async () => (await window.__vereaMap.getSource('devices').getData()).features.map(f => f.properties.name)")
        assert {"TST-D0001", "TST-D0002", "TST-D0003", "TST-D0004"} <= set(got), got
        n_plots = page.evaluate("async () => (await window.__vereaMap.getSource('plots').getData()).features.length")
        assert n_plots == 3, n_plots
        side.get_by_role("button", name="Importar parcelas…").click()
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
