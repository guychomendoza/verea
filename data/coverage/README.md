# 4G coverage maps

Verea checks 4G sensors against the mobile coverage each operator declares to
Mexico's telecom regulator (Comisión Reguladora de Telecomunicaciones, CRT),
published quarterly as open data on datos.gob.mx under **CC BY 4.0**
(commercial use allowed with attribution).

Put the GeoPackage files in this folder with their original names, e.g.
`RADIOMOVIL_4G_GARANTIZADA_2T_2026.gpkg`. The app recognises operator, technology,
coverage type and quarter from the name. They are not in git (≈1.2 GB each).

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

Download them from a browser (the server blocks scripted downloads). The first
look-up in a new area reads the big file (a few seconds) and caches 0.2° tiles in
`cache/`; later look-ups are instant. Delete `cache/` after replacing a file.

Attribution: "Mapas de cobertura del servicio móvil, Comisión Reguladora de
Telecomunicaciones, datos.gob.mx, CC BY 4.0."
