# Verea

Network planning tool for agricultural IoT: LoRaWAN link budgets over real
terrain (gateways, Dragino / SenseCAP nodes) and 4G coverage for cellular
sensors (Dragino SE0X-CS) from the operators' declared coverage maps.
Streamlit prototype; a web version (Python backend keeping `core/`, JS
frontend, DB with users) is planned.

## Run and test
- App: `.venv/bin/streamlit run app.py` (port 8501). Windows: `python -m streamlit run app.py`.
- Tests: `.venv/bin/python -m pytest -q` (70 tests). Headless app tests use
  `streamlit.testing.v1.AppTest`; set `VEREA_AUTOSAVE=<tmp file>` so they do not
  overwrite the user's autosave (`~/.verea/autosave.verea.json`).
- Browser tests: Playwright with Chromium; in WSL run with
  `LD_LIBRARY_PATH=~/.cache/verea-chromium-libs/root/usr/lib/x86_64-linux-gnu`.
  Use a second instance on port 8502 so the user's app on 8501 is untouched.
- 4G data: `python scripts/get_coverage.py` (downloads the GitHub release
  `coverage-2026Q2`: operator GeoPackage 1.2 GB + map tiles 134 MB into `data/coverage/`).

## Layout
- `app.py` — the whole Streamlit UI (sidebar, map, panels, report, projects, autosave).
- `config.py` — radio constants, SX1276/SX1302 sensitivity, US915 SF7–10, environments, safety margin.
- `core/link_budget.py` — LoRa link budget. Terrain loss: ITM (`core/propagation.itm_path_loss`)
  for paths ≥ ~1 km, delta-Bullington short-path model (ITU-R P.526) below.
- `core/terrain.py` — elevation profiles (Open-Meteo, fallback OpenTopoData; both accept
  max 100 points per request → `link_samples()`).
- `core/coverage.py` — range along a direction and gateway coverage radials.
- `core/profiles.py` — device presets (SenseCAP M2, Milesight UG63/SG50, Dragino LSE01,
  SE0X-LB, SE0X-CS, SenseCAP S2120); estimated values are flagged.
- `core/project.py` — project JSON (versioned) save/load.
- `core/cellular.py` — 4G coverage per point from the CRT GeoPackage (0.2° tile cache on
  disk): covered, declared level, share covered within 300 m, nearest coverage,
  `margin_ok` (no gap within `EDGE_MARGIN_M` = 100 m).
- `scripts/build_coverage_tiles.py` — GeoPackage → PMTiles of PNG tiles z5–13 with classes
  certain / edge (within the margin) / none. Raster pipeline: rasterize 0.2° tiles on a
  0.0004° grid, erode by the margin, render Web-Mercator tiles (Mexico ≈ 23 min).
  Needs `requirements-build.txt`.
- `ui/map_base.py` — stable base map + capture, ruler and coverage-layer JS controls.
- `ui/tile_server.py` — local Range-capable server for the PMTiles (127.0.0.1 only).
- `ui/report.py` — HTML report. `ui/profile_interactive.py` — terrain chart linked to the map.

## Gotchas (learned the hard way)
- Streamlit hot-reloads `app.py` but NOT already-imported modules: after editing `core/`,
  `ui/` or `config.py`, restart the server (check the autosave first; the user loses the
  browser session otherwise).
- Never stop processes with `pkill -f <pattern>`: it matches and kills the calling shell.
  Find the PID with `ps -eo pid,args | awk '/[s]treamlit .../ {print $1}'` and `kill` it.
- Main map: the base map must stay identical between reruns (streamlit-folium keys the
  component by its JS); everything dynamic goes in the FeatureGroup passed as
  `feature_group_to_add`, and the view moves only through `center`/`zoom` (see `focus_map`).
- Recalculation is resumable: call `request_recalc()`; the pending flag is cleared only
  after every node is done (interrupted runs used to leave nodes without results).
- Functions used by the sidebar must be defined above `with st.sidebar:`.
- Widget state: keys that include a signature/`rev` so switching items or opening a
  project renders fresh widgets; checkboxes are `chk_<node name>`.
- datos.gob.mx / repodatos block scripted downloads (403); download in a browser.
  The 4G "Diferenciada" files returned server errors in Oct 2026.
- Elevation APIs reject > 100 points (falls back to flat terrain silently).

## Current work: realistic 4G uncertainty margin (decided 2026-10-21)
Today the yellow band is a fixed 100 m next to any area without coverage. Planned:
1. **Terrain-adaptive margin** — use a national DEM (download once) to measure relief at
   each coverage edge: sharp terrain-shadow edges get a small margin (~30–50 m),
   flat/open distance-limited edges a wide one (~200–500 m). Integrate into
   `build_coverage_tiles.py` (per-tile grids) and `core/cellular.py` (sensor status).
2. **Towers + propagation** — approximate tower locations (OpenCelliD, CC BY-SA) and the
   existing terrain engine to estimate signal and its gradient near edges:
   margin ≈ model uncertainty (~8 dB) / gradient (dB per m). Also estimate how far
   NB-IoT / LTE-M (≈15–20 dB more link budget than phone LTE) can reach into the red.
Field calibration with sensor RSSI comes later (no 4G sensors installed yet; they will
report to the company's own server).

Other pending items (web migration): drag nodes on the map, overlapping labels when nodes
are close, real PDF report, cloud projects with users, LoRa calibration with ChirpStack RSSI.

## Conventions
- UI text in English; the user writes in Spanish.
- Commit messages: imperative subject + body explaining why; push to `master`.
- Keep comments short; match the surrounding style.
