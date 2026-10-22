# Verea web frontend

React + TypeScript + Vite, map with MapLibre GL (satellite imagery, 4G coverage from
PMTiles, draggable devices, labels that never overlap). All calculations come from the
API in `../backend` (same engine as the Streamlit app).

Development (Node 22; on this WSL machine it lives in `~/.local/node/bin`):

    # API, from the repository root
    VEREA_DEV=1 .venv/bin/uvicorn backend.main:app --port 8000
    # frontend
    cd frontend && npm install && npm run dev        # http://localhost:5173

The dev server proxies `/api` to port 8000 and serves `../data/coverage/*.pmtiles`
under `/coverage` (with HTTP Range). In production set `VITE_API_URL` and
`VITE_COVERAGE_URL` (PMTiles on Cloudflare R2).

Checks: `npm run lint`, `npx tsc -b`, `npm test` (Vitest), and the browser test
`../.venv/bin/python e2e/run.py` with both servers running.

Projects are kept in the browser (localStorage) until accounts and cloud storage
arrive (phase 3); "Save file" / "Open…" use the same `.verea.json` as Streamlit.
