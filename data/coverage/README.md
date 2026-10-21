# 4G coverage maps

Verea checks 4G sensors against the mobile coverage each operator declares to
Mexico's telecom regulator (Comisión Reguladora de Telecomunicaciones, CRT),
published quarterly as open data on datos.gob.mx under **CC BY 4.0**
(commercial use allowed with attribution).

**Get them with one command** (from the project folder, once per computer):

    python scripts/get_coverage.py

It downloads the files from this repo's GitHub release (`coverage-2026Q2`) into
this folder and checks them (SHA-256). They are not in git (≈1.2 GB each).

The app recognises operator, technology, coverage type and quarter from the file
name, e.g. `RADIOMOVIL_4G_GARANTIZADA_2T_2026.gpkg`.

Two kinds of file:
- `RADIOMOVIL_4G_GARANTIZADA_2T_2026.gpkg` — the operator map as published; used
  to check each 4G sensor.
- `telcel_4g_2026q2.pmtiles` — map tiles for the whole country (green = certain,
  yellow = covered but within 100 m of an area without signal, red = no coverage),
  read by the browser piece by piece. Made from the GeoPackage with
  `scripts/build_coverage_tiles.py` (≈25 min, needs `pip install -r requirements-build.txt`).

**New quarter:** download the new GeoPackage from datos.gob.mx (below), build the
tiles, publish both as a new release (`gh release create coverage-YYYYQn <files>`),
and update `RELEASE_TAG` and `FILES` (name, size, sha256) in `scripts/get_coverage.py`.

    python scripts/build_coverage_tiles.py data/coverage/RADIOMOVIL_4G_GARANTIZADA_3T_2026.gpkg \
        data/coverage/telcel_4g_2026q3.pmtiles

| Operator | Dataset |
|---|---|
| Telcel (Radiomóvil Dipsa) | https://www.datos.gob.mx/dataset/mapas_cobertura_servicio_movil_radiomovil_dipsa |
| AT&T | https://www.datos.gob.mx/dataset/mapas_cobertura_servicio_movil_att_comunicaciones_digitales |
| Movistar (Pegaso PCS) | https://www.datos.gob.mx/dataset/mapas_cobertura_servicio_movil_pegaso_pcs |
| Altán | https://www.datos.gob.mx/dataset/mapas_cobertura_servicio_movil_atlan_redes |

Telcel 4G, 2nd quarter 2026:
- Guaranteed: https://repodatos.atdt.gob.mx/api_update/crt/mapas_cobertura_servicio_movil_radiomovil_dipsa/RADIOMOVIL_4G_GARANTIZADA_2T_2026.gpkg
- Differentiated: https://repodatos.atdt.gob.mx/api_update/crt/mapas_cobertura_servicio_movil_radiomovil_dipsa/RADIOMOVIL_4G_DIFERENCIADA_2T_2026.gpkg
  (in Oct 2026 the server returned an error for the differentiated files)

From datos.gob.mx, download them with a browser (the server blocks scripted
downloads). The first
look-up in a new area reads the big file (a few seconds) and caches 0.2° tiles in
`cache/`; later look-ups are instant. Delete `cache/` after replacing a file.

The app serves the tiles from a small local server (`ui/tile_server.py`, 127.0.0.1
only), because Streamlit's static serving refuses files over 200 MB.

Attribution: "Mapas de cobertura del servicio móvil, Comisión Reguladora de
Telecomunicaciones, datos.gob.mx, CC BY 4.0."
