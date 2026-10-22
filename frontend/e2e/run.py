"""
End-to-end check of the web frontend in Chromium (Playwright).

Needs the API and the dev server running (see CLAUDE.md), then:

    .venv/bin/python frontend/e2e/run.py [screenshot dir]

Opens the sample project (same as the Streamlit parity check: N-1 = 28.8 dB), checks
links, the device panel and terrain chart, drags a node, adds and renames a gateway,
shows the 4G layer, reloads, and checks phone width.
"""
import re
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

HERE = Path(__file__).resolve().parent
SAMPLE = HERE / "sample.verea.json"
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix="verea-e2e-"))
URL = "http://127.0.0.1:5173/"
errors = []
with sync_playwright() as pw:
    b = pw.chromium.launch(args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
    page = b.new_page(viewport={"width": 1400, "height": 860})
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    expect(page.get_by_role("button", name="Open…")).to_be_visible(timeout=30000)
    # import the parity project (same as the Streamlit check: N-1 28.774 dB)
    page.locator("input[type=file]").set_input_files(str(SAMPLE))
    expect(page.get_by_role("status")).to_contain_text("Links up to date", timeout=60000)
    side = page.get_by_label("Project")
    expect(side.get_by_role("button", name=re.compile(r"N-1"))).to_contain_text("28.8 dB")
    print("N-1 in list:", side.get_by_role("button", name=re.compile(r"N-1")).inner_text().replace("\n", " "))
    expect(side.get_by_role("button", name=re.compile(r"4G-1"))).to_contain_text("4G", timeout=30000)
    page.wait_for_timeout(2500)
    page.screenshot(path=f"{OUT}/1_project.png")
    # node panel + terrain chart
    side.get_by_role("button", name=re.compile(r"N-1")).click()
    panel = page.get_by_label("Device")
    expect(panel).to_contain_text("Link margin")
    expect(panel.get_by_role("img", name="Terrain profile")).to_be_visible(timeout=30000)
    print("panel:", panel.locator(".verdict").inner_text())
    page.wait_for_timeout(1500)
    page.screenshot(path=f"{OUT}/2_panel.png")
    # drag N-1 on the map: the map is centred on it after the click (flyTo)
    page.wait_for_timeout(2000)
    box = page.get_by_test_id("map").bounding_box()
    pt = page.evaluate("() => { const m = window.__vereaMap; return m.project([-102.2952, 21.2519]) }")
    cx, cy = box["x"] + pt["x"], box["y"] + pt["y"]
    print("N-1 on screen at", round(cx), round(cy), "map centre", round(box["x"] + box["width"] / 2), round(box["y"] + box["height"] / 2))
    lat_before = panel.get_by_label("Latitude").input_value()
    page.mouse.move(cx, cy); page.mouse.down(); page.mouse.move(cx + 60, cy + 80, steps=8); page.mouse.up()
    expect(panel.get_by_label("Latitude")).not_to_have_value(lat_before, timeout=5000)
    print("dragged: lat", lat_before, "->", panel.get_by_label("Latitude").input_value())
    expect(page.get_by_role("status")).to_contain_text("Links up to date", timeout=60000)
    # add a gateway by clicking the map
    page.get_by_role("button", name="+ Gateway").click()
    expect(page.locator(".mode-banner")).to_be_visible()
    page.mouse.click(cx - 200, cy - 150)
    expect(side.get_by_role("button", name=re.compile(r"GW-2"))).to_be_visible()
    expect(page.get_by_role("status")).to_contain_text("Links up to date", timeout=60000)
    # rename with validation
    name = panel.get_by_label("Name")
    name.fill("N-2"); name.press("Enter")
    expect(side.get_by_role("button", name=re.compile(r"GW-2"))).to_be_visible()   # refused: duplicate
    name.fill("Tower North"); name.press("Enter")
    expect(side.get_by_role("button", name=re.compile(r"Tower North"))).to_be_visible()
    # 4G coverage layer
    page.get_by_label("Operator").select_option("Telcel")
    page.get_by_label("Show on map").check()
    side.get_by_role("button", name=re.compile(r"4G-1")).click()
    expect(panel).to_contain_text("Covered around", timeout=30000)
    page.wait_for_timeout(4000)
    page.screenshot(path=f"{OUT}/3_coverage.png")
    # persists across reload (local copy)
    page.reload()
    expect(side.get_by_role("button", name=re.compile(r"Tower North"))).to_be_visible(timeout=30000)
    print("reload keeps project: ok")
    # phone width
    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(1500)
    page.screenshot(path=f"{OUT}/4_phone.png")
    sw = page.evaluate("document.documentElement.scrollWidth")
    print("phone scrollWidth", sw)
    b.close()
print("console errors:", errors)
print("screenshots in", OUT)
sys.exit(1 if errors else 0)
