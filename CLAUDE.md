# Verea

Network planning tool for agricultural IoT: LoRaWAN link budgets over real
terrain (gateways, Dragino / SenseCAP nodes) and 4G coverage for cellular
sensors (Dragino SE0X-CS) from the operators' declared coverage maps.
Streamlit prototype; a web version (Python backend keeping `core/`, JS
frontend, DB with users) is planned.

## Run and test
- App: `.venv/bin/streamlit run app.py` (port 8501). Windows: `python -m streamlit run app.py`.
- Tests: `.venv/bin/python -m pytest -q` (105 tests; `supabase/tests` needs requirements-dev.txt).
- Web API: `VEREA_DEV=1 .venv/bin/uvicorn backend.main:app --port 8000` (docs at /docs).
  `pip install -r backend/requirements.txt` first.
- Web frontend: `cd frontend && npm run dev` (port 5173; proxies /api to 8000, serves the PMTiles).
  Node 22 is in `~/.local/node/bin` (the `npm` on PATH is the Windows one: don't use it).
  Checks: `npm run lint`, `npx tsc -b`, `npm test`; browser test `frontend/e2e/run.py`. Headless app tests use
  `streamlit.testing.v1.AppTest`; set `VEREA_AUTOSAVE=<tmp file>` so they do not
  overwrite the user's autosave (`~/.verea/autosave.verea.json`).
- Browser tests: Playwright with Chromium; in WSL run with
  `LD_LIBRARY_PATH=~/.cache/verea-chromium-libs/root/usr/lib/x86_64-linux-gnu`.
  Use a second instance on port 8502 so the user's app on 8501 is untouched.
- 4G data: `python scripts/get_coverage.py` (downloads the GitHub release
  `coverage-2026Q2`: operator GeoPackage 1.2 GB + map tiles ≈130 MB + relief grid 22 MB
  into `data/coverage/`).

## Layout
- `app.py` — the whole Streamlit UI (sidebar, map, panels, report, projects, autosave).
- `core/network.py` — device dicts → Gateway/EndNode, `RFSettings`, `analyze_link`, `best_link`,
  `cell_state`: the calculations shared by Streamlit and the API (results must stay identical).
- `frontend/` — React + MapLibre web app: `App.tsx` (state, recalculation, import/export),
  `MapView.tsx` (map, drag, add), `Sidebar.tsx`, `DevicePanel.tsx`, `project.ts` (pure reducer,
  device naming like the app), `api.ts`. maplibre-gl.css forces `.maplibregl-map` to
  position: relative: size the map container with an inline style.
- `supabase/` — database: `migrations/*.sql` (profiles, projects, RLS: all active members read
  and edit, owner/admin delete, invite-only, optimistic locking on `updated_at`), `tests/` (RLS on a
  real PostgreSQL via pgserver + `supabase_shim.sql`). `scripts/supabase_setup.py` applies it and
  configures auth through the Management API. Frontend `cloud.ts` / `Login.tsx` /
  `ProjectsDialog.tsx`; without `VITE_SUPABASE_*` the app runs in local mode (no login).
  Cloud-mode browser test with a fake Supabase: `frontend/e2e/cloud.py` (dev server on 5174).
- `backend/` — FastAPI web API (`main.py`), request limits (`schemas.py`), Supabase JWT check
  (`auth.py`: no `SUPABASE_URL` and no `VEREA_DEV=1` → every protected request is refused).
  Elevations from the local DEM (`core/dem.py`), sampled like Open-Meteo (cell containing the
  point, whole metres) so margins match the app exactly.
- `config.py` — radio constants, SX1276/SX1302 sensitivity, US915 SF7–10, environments, safety margin.
- `core/link_budget.py` — LoRa link budget. Terrain loss: the larger of ITM
  (`core/propagation.itm_path_loss`, ≥ 1 km) and delta-Bullington / ITU-R P.526 (any length).
  Since 2026-10-21: with low sensor antennas ITM swings 8–15 dB with profile sampling and can be
  ~12 dB below P.526, so the envelope avoids its optimistic artefacts. Profiles use one point per
  90 m DEM cell up to 400 points (`MAX_PROFILE_POINTS`), fetched 100 per request. ITM stays at
  median (50 %): the safety margin is the reserve; calibrate with field RSSI before changing it.
- `core/terrain.py` — elevation profiles (Open-Meteo, fallback OpenTopoData; both accept
  max 100 points per request → `link_samples()`).
- `core/coverage.py` — range along a direction and gateway coverage radials.
- `core/profiles.py` — device presets (SenseCAP M2, Milesight UG63/SG50, Dragino LSE01,
  SE0X-LB, SE0X-CS, SenseCAP S2120); estimated values are flagged.
- `core/project.py` — project JSON (versioned) save/load.
- `core/cellular.py` — 4G coverage per point from the CRT GeoPackage (0.2° tile cache on
  disk): covered, declared level, share covered within 300 m, nearest coverage,
  `margin_ok` (no coverage edge within its terrain-adaptive margin: `margin_for_relief`,
  250 m steep → 500 m flat (raised 2026-10-21: green looked optimistic); small holes
  < `SMALL_GAP_M2` (0.1 km²) 100 m;
  fixed `EDGE_MARGIN_M` = 100 m without relief data).
- `core/towers.py` — OpenCelliD LTE cells → approximate sites (cells grouped by eNodeB, median
  position) in `data/coverage/towers_mx.csv` (`scripts/get_towers.py`; token, or `--from-file`).
- `core/cell_signal.py` — 4G estimate from the nearest sites: ITM radial, probit fit (offset, σ)
  to the declared map along it; P(service) for LTE / LTE-M (+15 dB) / NB-IoT (+20 dB).
  NOT used by the app: see `scripts/validate_cell_signal.py` (it does not beat the map's own
  neighbourhood). `core/dem.py` — local GLO-90 elevations (`fetch_elevations` like ElevationAPI).
- `scripts/build_relief.py` — Copernicus GLO-90 DEM (→ `data/dem/`, ≈1 GB) → national relief grid
  `data/coverage/relief_mx.npz` (max−min within 500 m, 0.0025° cells, uint8 per 1° tile).
- `scripts/build_coverage_tiles.py` — GeoPackage → PMTiles of PNG tiles z5–13 with classes
  certain / edge (within the margin) / none. Raster pipeline: rasterize 0.2° tiles on a
  0.0004° grid, margin per gap cell from the relief (one distance transform per
  `MARGIN_LEVELS_M` step), render Web-Mercator tiles (Mexico ≈ 23 min).
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
- Copernicus GLO-90 is a surface model (buildings, canopy): cities and forests read a bit
  rougher than bare ground, so their margin comes out somewhat smaller.
- Worker processes must not share an open `np.load` npz from the parent (corrupt reads):
  `Relief` reopens the file per PID.

## Current work: realistic 4G uncertainty margin (decided 2026-10-21)
1. **Terrain-adaptive margin** (done 2026-10-21) — use a national DEM (download once) to measure relief at
   each coverage edge: sharp terrain-shadow edges get a small margin (~30–50 m),
   flat/open distance-limited edges a wide one (~200–500 m). Integrate into
   `build_coverage_tiles.py` (per-tile grids) and `core/cellular.py` (sensor status).
2. **Towers + propagation** (tried 2026-10-21, shelved) — approximate tower locations (OpenCelliD, CC BY-SA) and the
   existing terrain engine to estimate signal and its gradient near edges:
   margin ≈ model uncertainty (~8 dB) / gradient (dB per m). Also estimate how far
   NB-IoT / LTE-M (≈15–20 dB more link budget than phone LTE) can reach into the red.
   Result: with OpenCelliD sites (opencellid.org was down; data from the CC BY-SA mirror
   github.com/NorthveilSystems/treadstone-celldata, release 2026-10) the terrain model explains the
   declared map better than distance alone but worse than the map's own neighbourhood (leave-out
   Brier 0.14–0.16 vs 0.09–0.15), fitted σ ≈ 20 dB. Approximate site positions without sectors
   cannot add to the operator's map, so no per-sensor probabilities are shown. The relief
   margins of step 1 are also unvalidated: only field RSSI can calibrate them.
Field calibration with sensor RSSI comes later (no 4G sensors installed yet; they will
report to the company's own server).

Other pending items (web migration): drag nodes on the map, overlapping labels when nodes
are close, real PDF report, cloud projects with users, LoRa calibration with ChirpStack RSSI.

## Web migration (plan approved 2026-10-21; team only, invite-only accounts)
React + TypeScript + Vite + MapLibre (PMTiles from Cloudflare R2) on Cloudflare Pages; FastAPI on
Fly.io with a volume for data; Supabase for Auth + Postgres (projects as the JSON of
`core/project.py`, Row Level Security). No own domain yet. Phases: 1 API (done) → 2 frontend MVP (done) →
3 accounts/cloud (code done, needs the Supabase project) → 4 deploy → 5 PDF report + parity, retire Streamlit.
- Deploy note: a cold 4G lookup reads the 1.2 GB GeoPackage (1.36 GB RAM peak, 7–10 s). On the
  server, pre-build the national 0.2° tile cache instead (≈3–5 GB) and skip the GeoPackage.
- Open-Meteo has an hourly request limit (hit on 2026-10-21): the API must use the local DEM.

## Conventions
- UI text in English; the user writes in Spanish.
- Commit messages: imperative subject + body explaining why; push to `master`.
- Keep comments short; match the surrounding style.
