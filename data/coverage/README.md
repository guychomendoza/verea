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
  yellow = covered but near an area without signal, red = no coverage),
  read by the browser piece by piece. Made from the GeoPackage with
  `scripts/build_coverage_tiles.py` (≈25 min, needs `pip install -r requirements-build.txt`).
- `relief_mx.npz` — terrain relief (highest minus lowest point within 500 m, every
  ≈270 m) that sizes the yellow band: 250 m where a hill cuts the signal (sharp edge),
  up to 500 m on flat ground (the edge depends on distance to the tower, and a few dB
  of model error move it far). Made with `scripts/build_relief.py` from the Copernicus
  DEM GLO-90 (downloads ≈1 GB into `data/dem/` once). Small holes inside coverage
  (< 0.1 km²) are local obstructions, not distance limits, and get 100 m.
  Without the file the band is a fixed 250 m.

**New quarter:** download the new GeoPackage from datos.gob.mx (below), build the
tiles, publish them as a new release with the relief grid (it does not change between
quarters: `gh release create coverage-YYYYQn <files>`), and update `RELEASE_TAG` and `FILES` (name, size, sha256) in `scripts/get_coverage.py`.

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
Telecomunicaciones, datos.gob.mx, CC BY 4.0." Relief: "Copernicus DEM GLO-90,
© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under
COPERNICUS by the European Union and ESA."
