# Modo «Pruebas de campo 4G» — diseño (sin programar todavía)

Estado (25/10/2026): programado en la rama `rediseno` (pasos 1–4 de abajo, sin el script de calibración).
La tabla `field_tests` está en `supabase/migrations/20261025000000_field_tests.sql`, pero **no se ha aplicado
a Supabase**: hay que correr `scripts/supabase_setup.py` cuando se apruebe.

Decisiones (24/10/2026): registra todo el equipo; sin fotos por ahora; el servidor de los sensores no se puede
consultar, así que «¿llegó el dato?» se contesta a mano. Cambios frente a este diseño: en vez de «¿coincide?» +
estado real, se pregunta directo qué pasó (estable / intermitente / sin señal) y la app dice si coincide; la
corrección de la predicción se aplica en el navegador (`fieldTests.ts` `withFieldTests`: mapa, listas, ficha y PDF),
no en la API. Una sola prueba repinta la cobertura 200 m a su alrededor (capa sobre los mosaicos) y corrige los
sensores dentro de ese radio; recalibrar los márgenes de todo el mapa sigue esperando a tener muchas pruebas.

## Para qué

Ir con un sensor Dragino SE0X-CS a las zonas que el mapa marca en naranja (posible) o rojo
(sin cobertura). En cada punto se registra si el sensor logra mandar datos, y con eso:

1. Se corrige la predicción en el momento, al menos alrededor de los puntos probados.
2. Con el tiempo, se calibran los márgenes del mapa, que hoy no tienen calibración
   (`margin_for_relief` y `reach_for_relief` en `core/cellular.py`).

## Pantalla `/campo` (pensada primero para el celular)

1. **Elegir proyecto.** La lista de proyectos del equipo. El proyecto se abre en modo solo lectura,
   con sus sensores y la capa 4G encendida.
2. **Mapa a pantalla completa:**
   - Punto azul con tu ubicación en tiempo real (`navigator.geolocation.watchPosition`), con su
     círculo de precisión y un botón para centrar el mapa en ti.
   - Las pruebas ya hechas aparecen como puntos de color sobre la cobertura.
3. **Botón grande «Registrar prueba aquí».** Toma tu ubicación actual; también puedes mantener
   presionado el mapa para elegir otro punto. Se abre una hoja inferior:
   - Lo que dice el mapa en ese punto (consulta a `/api/cell-status`): garantizada / borde /
     posible / sin cobertura.
   - **¿Coincide con lo que ves?** Botones grandes: *Sí* / *No*.
   - Si respondes *No*, eliges el estado real: **Señal estable** (llegan todos los datos) /
     **Intermitente** (llegan algunos) / **Sin señal** (no llega nada).
   - Opcionales: RSSI o RSRP que muestre el sensor, si el dato llegó al servidor (sí / no / no
     sé), el modelo del sensor y notas.
   - Guardar.
4. **Sin señal en el teléfono:** justo en las zonas rojas no habrá internet.
   - Cada prueba se guarda primero en el teléfono (IndexedDB), con un contador de «pendientes por
     subir».
   - Se sube sola al volver la conexión (evento `online` y un reintento periódico).
   - Nada se pierde si se cierra la app.
5. **Terminar sesión de prueba:** un resumen (n puntos, cuántos coincidieron) y se sube lo que
   falte.

## Datos (borrador de migración; no se ha aplicado)

```sql
create table public.field_tests (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references public.projects (id) on delete set null,
  author_id   uuid not null references public.profiles (id) default auth.uid(),
  taken_at    timestamptz not null,                 -- en el teléfono (puede subirse horas después)
  lat         double precision not null check (lat between -90 and 90),
  lon         double precision not null check (lon between -180 and 180),
  accuracy_m  real check (accuracy_m >= 0),
  operator    text not null default 'Telcel',
  predicted   text not null check (predicted in ('ok', 'edge', 'differentiated', 'possible', 'none')),
  observed    text not null check (observed in ('stable', 'intermittent', 'none')),
  rssi_dbm    real,
  delivered   boolean,                              -- ¿llegó el dato al servidor?
  device      text not null default 'dragino_se0x_cs',
  notes       text not null default '' check (char_length(notes) <= 1000),
  client_id   uuid not null unique                  -- para que un reintento no duplique la prueba
);
alter table public.field_tests enable row level security;
-- El equipo (is_member()) lee y crea; cada quien borra o corrige solo lo suyo; los lectores no ven nada.
```

Habría que agregar pruebas en `supabase/tests`, igual que las de proyectos.

## Cómo «actualiza el mapa» sin rehacer el archivo de 186 MB

- **Inmediato:**
  - Las pruebas se dibujan como una capa propia (GeoJSON desde Supabase) encima de la cobertura,
    en `/campo` y también en el editor.
  - En la API, `cell_state` (`core/network.py`) consulta las pruebas recientes cercanas (por
    ejemplo, a 300 m o menos) y usa el estado medido. La ficha del sensor y el PDF dirían
    «verificado en campo (fecha)».
  - Así, al volver al editor, la topología ya refleja lo medido.
  - Hace falta un endpoint `/api/field-tests` o que la API lea Supabase con la clave del
    servicio. Recomiendo que la API lea las pruebas de un área con la sesión del usuario, igual
    que `require_team` lee el perfil.
- **Periódico (trimestral o al juntar unas 50 pruebas):**
  - Un script compara predicho contra observado por tipo de borde (terreno abrupto, ondulado o
    plano) y ajusta los márgenes.
  - Después se regeneran los mosaicos (`scripts/build_coverage_tiles.py --recolor` si solo cambian
    colores, o completo si cambian márgenes) y se suben con `deploy/deploy.sh tiles`.

## Cambios necesarios fuera del código

- `frontend/public/_headers`: `Permissions-Policy` debe permitir `geolocation=(self)`; hoy está
  bloqueada.
- La geolocalización del navegador exige HTTPS. verea.app ya lo tiene.

## Pasos propuestos

1. Migración, sus pruebas y la API que lee y escribe pruebas, con `cell_state` usando las
   cercanas.
2. Pantalla `/campo`: ubicación, registrar y la capa de pruebas (sin modo sin conexión todavía).
3. Modo sin conexión (cola local y sincronización) y el resumen de la sesión.
4. Capa de pruebas en el editor y en el PDF.
5. Script de calibración, cuando haya datos.

## Preguntas para decidir

- ¿Quién puede registrar pruebas: todo el equipo, o también un técnico con rol de lector?
- ¿El servidor de la empresa, adonde reportan los sensores, puede consultarse? Si sí, «¿llegó el
  dato?» podría contestarse solo, comparando la hora de la prueba con los mensajes recibidos y su
  RSSI.
- ¿Hace falta una foto por prueba? Requiere guardar archivos (Supabase Storage).
