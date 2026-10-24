# Verea

Network planning tool for agricultural IoT: LoRaWAN link budgets over real
terrain (gateways, Dragino / SenseCAP nodes) and 4G coverage for cellular
sensors (Dragino SE0X-CS) from the operators' declared coverage maps.
Streamlit prototype; a web version (Python backend keeping `core/`, JS
frontend, DB with users) is planned.

## Run and test
- App: `.venv/bin/streamlit run app.py` (port 8501). Windows: `python -m streamlit run app.py`.
- Tests: `.venv/bin/python -m pytest -q` (139 tests; `supabase/tests` needs requirements-dev.txt).
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

- Live since 2026-10-23 (phase 4): https://verea.app (Cloudflare Pages project `verea`), API https://api.verea.app
  (Fly.io app `verea-api`, Dallas `dfw` — Querétaro was retired — shared-cpu-1x 1 GB, stops when idle, ≈6 s cold
  start), tiles https://tiles.verea.app (R2 bucket `verea-tiles`); domain verea.app on Cloudflare (user's own
  account). `deploy/README.md` and `deploy/deploy.sh tiles|api|web`. Volume /data filled by
  `scripts/server_data.py`: DEM from AWS, GeoPackage + relief from the release, national 4G tile cache
  (14,812 tiles, 2.4 GB) via `scripts/prebuild_coverage_cache.py`. Tokens only in `~/.config/verea/deploy.env`
  (outside the repo; FLY_API_TOKEN quoted: it has a space). flyctl is in `~/.fly/bin`, wrangler in frontend devDeps.

## Layout
- `app.py` — the whole Streamlit UI (sidebar, map, panels, report, projects, autosave).
- `core/network.py` — device dicts → Gateway/EndNode, `RFSettings`, `analyze_link`, `best_link`,
  `cell_state`: the calculations shared by Streamlit and the API (results must stay identical).
- `frontend/` — React + MapLibre web app: `App.tsx` (state, recalculation, saving, shortcuts,
  resizable/collapsible panels via react-resizable-panels), `MapView.tsx` (map, drag, add, ruler,
  labels "name / km · dB", profile cursor and pins), `ProfilePanel.tsx` + `profilePlot.ts`
  ("Perfil de Elevación", Plotly loaded on demand from `plotly.ts`, same traces as
  `ui/profile_interactive.py`), `mapStyle.ts` (map style + device/link GeoJSON shared by the map
  and the report; `highlight` rings one link and dims the rest), `Sidebar.tsx` (folding sections with line icons from `icons.tsx`, remembered in
  localStorage, "Archivo ▾" menu, sensors grouped by technology — LoRa / 4G / stations, each folding — in natural
  alphabetical order, one environment for every LoRa node at once = `bulkEnvironment`, viewers too),
  `DevicePanel.tsx`,
  Design (2026-10-24): Inter self-hosted (`@fontsource-variable/inter`), tokens in `index.css` (surface, field,
  line-strong, ring, shadow-sm/-/-lg, radii, --ease/--dur; dark twins in both dark blocks), soft motion
  (folding sections = `.fold` grid-rows 0fr→1fr, kept mounted but inert + visibility hidden once closed —
  never name a class `collapse`, it is a Tailwind utility; dialogs pop in, menus drop in, device panel slides;
  all off for prefers-reduced-motion), no emoji: line icons in `icons.tsx` plus `CloseButton` and `Alert`;
  side panel top = project card (name, Proyectos button, description on demand, counts) + action rows;
  split-screen login over `LoginArt.tsx` (SVG illustration): email + password first, then Google with Google's
  own button (`google.ts`: Identity Services + `signInWithIdToken`, so Google shows verea.app, not the Supabase
  address; needs `VITE_GOOGLE_CLIENT_ID` and the site in the OAuth client's "Authorized JavaScript origins";
  without the variable it falls back to the redirect). Ver / Editar toggle beside Configuración (not for
  viewers): in Ver the map cannot drag/add and panels are locked (`locked`); phones start in Ver, desktops in
  Editar (`verea.editing`). Phones (< 900 px, `Phone.tsx`): the map stays free; a pill button opens the
  project panel full screen (centred, ✕); a picked device = a card at the bottom (state, «Ver detalle», ✕),
  its detail full screen with the profile first. `frontend/e2e/shots.py`
  takes review screenshots (light/dark, desktop/phone, team view via cloud.py's fake Supabase).
  Addresses: team projects at `/p/<id>` (`route.ts`, History API; back/forward switch projects with the
  unsaved-changes guard; Google returns to the same address; the empty `#` is cleaned).
  `autosave.ts` (since 2026-10-24 team projects save with the Guardar button / Ctrl+S; autosave is opt-in in
  Configuración → Guardado, off by default, per browser; unsaved edits are kept as a browser draft
  `verea.draft.<id>` offered back on reopen; opening / creating / importing another project with unsaved
  changes asks Guardar / Descartar / Cancelar; viewers' own changes still save by themselves),
  `counts.ts` (devices per kind / model and per status colour) feeds the map counter
  (`NetworkCounter.tsx`) and the report's three summary tables (gateways, LoRa, 4G),
  `report/` (built in the browser; PDF only, with jsPDF = summary: whole-project map — from a
  hidden map in `snapshots.ts` — + gateway table, then LoRa and 4G nodes grouped by state (coloured
  title + count, natural order by name, owner/area columns, same widths per section); in cloud mode a box "Ver este proyecto a detalle en verea.app" (the link's host) with the shared link and
  a QR code (`qrcode-generator`). The HTML report with one card per node was dropped on
  2026-10-23: the app itself is the detailed viewer. Cancelar / ✕ / Esc abort; no e-mail),
  nodes may carry optional `owner` (titular) and `area_ha` (in `core/project.py` `_NODE_KEYS`),
  `import/` ("Importar parcelas…", 2026-10-22): KML / KMZ (`@tmcw/togeojson` + JSZip) or XLSX
  (own reader that keeps cell formats) / CSV → `rules.ts` (column roles, coordinates without the
  decimal point, areas Excel turned into dates, pin ↔ plot join by location, conflicts flagged,
  no AI) → reviewed in `ImportDialog.tsx` → `apply.ts` (adds, or updates by name / plot);
  projects may carry `plots` (GeoJSON polygons, validated in `core/project.py`), drawn on the map
  and in the reports; nodes link to theirs with `plot`, panel borders (`Edge` in `App.tsx`) show an open/close arrow on hover,
  theme light / dark / automatic (`theme.ts`, button in `Logo.tsx`), undo / redo of the project
  (`reduceHistory` in `project.ts`: 'open' starts a new history; Ctrl+Z / Ctrl+Y), node list
  filters and "Cambiar modelo…" in bulk (`nodeStatus.ts`, `BulkModelDialog.tsx`), gateway range on
  the map with one click (`/api/coverage`, layers `range-*`), "Sugerir gateways 4G"
  (`SuggestGatewaysDialog.tsx` → `/api/suggest-gateways` → `core/gateway_siting.py`: high points of
  the local DEM with 4G, link budget per pair, greedy; only for gateways with `backhaul: '4g'`),
  ruler is a map control (and R), 4G coverage on/off is a map control beside the attribution
  (`CoverageControl`, also in the HTML report, which reads the PMTiles from the app's server — the
  dev server sends CORS headers for that), `shortcuts.ts` (G/Ctrl+G, N = LSE01, R, Ctrl+S;
  Ctrl+N cannot be captured in Chrome), `project.ts` (pure reducer), `api.ts`.
  maplibre-gl.css forces `.maplibregl-map` to position: relative: size the map container inline.
  Map updates apply after the map's own 'load' (a late `once('load')` never fires).
  Brand (2026-10-22): `brand.ts` (logo paths from the team's Verea.svg + `BRAND` colours: navy
  #193352, teal #3da3bc and derived tones; CSS variables in `index.css`), `Logo.tsx` (logo and
  `DeviceIcon`). Map symbology: `deviceIcons.ts` (white glyph per type — gateway, LoRa sensor,
  4G sensor, weather station — inside the status-coloured circle; MapLibre images via
  `registerDeviceIcons`), `legend.ts` (types + status colours, used by exported images, PDF and HTML).
- `supabase/` — database: `migrations/*.sql` (profiles, projects, RLS: all active members read
  and edit, owner/admin delete, optimistic locking on `updated_at`), `tests/` (RLS on a
  real PostgreSQL via pgserver + `supabase_shim.sql`). `scripts/supabase_setup.py` applies it and
  configures auth through the Management API (Google from `GOOGLE_CLIENT_ID` / `_SECRET` env vars).
  Frontend `cloud.ts` / `Login.tsx` / `ProjectsDialog.tsx`; without `VITE_SUPABASE_*` the app runs
  in local mode (no login).
- Viewers and shared links (2026-10-23): roles admin / member (= the team, `is_member()`) / viewer.
  Anyone may sign in with Google and becomes a **viewer** (invited accounts become members; an admin
  promotes in `UsersDialog.tsx`). A member shares a project (`ShareDialog.tsx` → `project_shares`,
  server-made token, `show_owner_info` false by default) as `/v/<token>` (`share.ts` keeps the token
  across the Google redirect); `claim_share()` gives the viewer access (`project_viewers`). Viewers
  never read `projects`: `viewer_project()` returns the data, without owners / areas / plots (and the
  owner cut out of node names, `node_short_name` = `nodeShortName`) unless the link shows them.
  The viewer's workspace is the normal one with `viewer` set (`App.tsx`): read-only except node
  height / environment and gateway height (`viewer.ts`: `viewerAllows`, `overridesOf`,
  `applyOverrides`), kept in `project_viewers.overrides`, never in the project; `MyFiles.tsx` lists
  their links; `SettingsDialog.tsx` = the gear button «Configuración» (tabs Cuenta: name, phone, company, sign out,
  viewers may delete their account · Apariencia: theme · Administración: admins → `UsersDialog.tsx`);
  `public/privacidad.html` (privacy notice draft with placeholders for the company's data).
  Team-only API endpoints use `require_team` (`backend/auth.py`, reads the caller's role through
  Supabase REST with `SUPABASE_ANON_KEY`): `/api/suggest-gateways`; admin-only `require_admin`:
  `/api/admin/users` (`backend/users.py`: «Crear usuario» in `UsersDialog.tsx` — email, name, role, temporary
  password — through Supabase's admin API with the secret `SUPABASE_SERVICE_ROLE_KEY`, server only; the account
  carries `must_change_password` in its metadata and the app asks for a new password at the first sign-in). The PDF uses the address it was
  generated from (verea.app in production).
  Browser tests (docstrings say how to start them): `frontend/e2e/run.py` (local mode, 5174 + dev
  API 8001), `cloud.py` (fake Supabase with team, viewer and admin accounts, links, RPCs; 5175), `live.py` (real Supabase; works only in its own
  project — on 2026-10-22 an earlier version renamed the team's newest project).
- `backend/` — FastAPI web API (`main.py`), request limits (`schemas.py`), per-client rate limit in memory
  (`ratelimit.py`: 240/min, heavy endpoints lower, 429 + Retry-After, inside CORS), Supabase JWT check
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
  125 m steep → 250 m flat; small holes < `SMALL_GAP_M2` (0.1 km²) 50 m; 125 m without relief),
  and outside it `possible` (within `reach_for_relief` 100 m steep → 300 m flat, or in a small
  hole): since 2026-10-22 the band straddles the declared edge because LTE-M / NB-IoT sensors
  have +15–20 dB over a phone, partly lost under a grown sugar-cane crop (user's decision;
  uncalibrated until field RSSI). States: ok / edge / differentiated / possible / none.
- `core/towers.py` — OpenCelliD LTE cells → approximate sites (cells grouped by eNodeB, median
  position) in `data/coverage/towers_mx.csv` (`scripts/get_towers.py`; token, or `--from-file`).
- `core/cell_signal.py` — 4G estimate from the nearest sites: ITM radial, probit fit (offset, σ)
  to the declared map along it; P(service) for LTE / LTE-M (+15 dB) / NB-IoT (+20 dB).
  NOT used by the app: see `scripts/validate_cell_signal.py` (it does not beat the map's own
  neighbourhood). `core/dem.py` — local GLO-90 elevations (`fetch_elevations` like ElevationAPI).
- `scripts/build_relief.py` — Copernicus GLO-90 DEM (→ `data/dem/`, ≈1 GB) → national relief grid
  `data/coverage/relief_mx.npz` (max−min within 500 m, 0.0025° cells, uint8 per 1° tile).
- `scripts/build_coverage_tiles.py` — GeoPackage → PMTiles of PNG tiles z5–13 with classes
  certain / edge (within the margin) / possible (outside, within reach) / none, drawn green / light
  yellow / orange / red (nearer red = less signal; `PALETTE` here, `COLORS` in `colors.ts`); after changing
  only colours run `--recolor <pmtiles>` (≈4 min, no GeoPackage). Raster pipeline: rasterize 0.2° tiles on a
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
- CSP (`frontend/public/_headers`): only self, the API, tiles, Esri, MapLibre glyphs and Supabase. A new external
  host must be added there; never fetch() a data: URL (`dataUrlToBlob`). Check it by serving a `VITE_E2E=1`
  production build with the header and running `e2e/run.py` against it (VEREA_E2E_URL). The field-test mode
  (`docs/modo-campo.md`, not built) needs `geolocation=(self)` in Permissions-Policy.
- Deploy (2026-10-23): `wrangler pages project create` needs `--force` (else wrangler 4.149+ turns the app
  into a Worker, rewriting vite.config.ts / package.json); `flyctl deploy` uses `--depot=false` (Depot hung on
  the org token); a deploy resets the VM to fly.toml's size. rasterio's wheel needs `libexpat1` in the image,
  else LocalDEM.open() quietly falls back to the online APIs (check `/api/health` → "elevation"). The 4G
  prebuild peaks at ~4–8 GB per 5×5 block in dense areas: use `--block 2`, one worker per ~4.5 GB. Tiles are
  fsynced before the rename (a restart left 0-byte tiles). Over `flyctl ssh` there is no pgrep/free, and a
  check whose own command line contains the pattern always matches itself; /tmp is wiped when the machine stops.
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
`core/project.py`, Row Level Security). Domain verea.app. Phases: 1 API (done) → 2 frontend MVP (done) →
3 accounts/cloud (done) → 4 deploy (done 2026-10-23) → 5 PDF report + parity, retire Streamlit.
- Deploy note: a cold 4G lookup reads the 1.2 GB GeoPackage (1.36 GB RAM peak, 7–10 s). On the
  server, pre-build the national 0.2° tile cache instead (≈3–5 GB) and skip the GeoPackage.
- Open-Meteo has an hourly request limit (hit on 2026-10-21): the API must use the local DEM.

## Conventions
- UI text in Spanish (since 2026-10-22), keeping technical terms (gateway, dB, SF, RSSI, LoRa…);
  keys stored in projects (e.g. environment names) stay as they are, with Spanish `label`s.
  The user writes in Spanish.
- Commit messages: imperative subject + body explaining why; push to `master`.
- Keep comments short; match the surrounding style.
