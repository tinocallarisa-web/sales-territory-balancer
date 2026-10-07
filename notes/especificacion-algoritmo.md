# Especificación técnica del cálculo en producción

Extraída del código el 07-10-2026 (commit a8b491b), con referencias `file:line` a ese commit. Es la base
factual de `docs/methodology.html`. Si el código cambia, se rehace; no se edita a mano.
Marcado **[ejecutado]** = comprobado ejecutando el código, no solo leyéndolo.

## 1. Entradas

- Roles (`capabilities.json`): customer_id, latitude, longitude, visits, minutes, speed (Pro), postal,
  area (Pro), tooltips. Tabla con `dataReductionAlgorithm.window.count = 30000` y `fetchMoreData(true)`
  (`visual.ts:536-546`): se piden bloques hasta tener todas las filas.
- Fila → punto (`visual.ts:737-801`): se descarta si lat/lon no son finitas o fuera de rango; visits,
  minutes y speed solo si son finitos y > 0. Los puntos se **ordenan por customer_id** (determinismo).
- No existe rol `value`: `value ≡ 1` (`visual.ts:742, 786`).
- Carga por defecto (`clustering.ts:309-311`): `v = visits>0 ? visits : 1`; `m = minutes>0 ? minutes : 60/v`.
  Sin visitas ni minutos: 1 h/mes por cliente.
- Outliers (`clustering.ts:1701-1724`): tercer vecino a más de `outlierKm` (línea recta). Por defecto
  `outlierKm = 0` → desactivado. Se sacan antes de todo y no suman horas.
- Parámetros: barra = horas/comercial (140, 1–10000), km/h (45, 1–200), Road × (1,3, 1–3), Áreas (0, 0–500);
  panel = días laborables (20, 1–31), outlier km (0, 0–5000). `tolerance` es código muerto (forzada a 0).
- Pro sin licencia en lectura: Area y Speed se ignoran (`visual.ts:577-600`); espera de licencia ≤ 5 s.

## 2. Opciones que pasa el visual (`visual.ts:659-733`)

`{ capacityHours, tolerance: 0, speedKmh, detour, growthOnly: true, outlierKm: 1e6, workDays, rounds: 12 }`.
Sin áreas (ni campo ni número) no se calcula. Siempre se llama `buildAreas` → `clusterByArea`; la rama
`clusterPoints(work)` directa es inalcanzable. Con `tolerance 0` la capacidad es un **tope duro** exacto.

## 3. Carga y desplazamiento (`clustering.ts:292-361`)

- Proyección equirectangular en la latitud media.
- `minPerKm_i = detour / s_i · 60` (s_i = Speed del punto o km/h de la barra).
- Salto: `hop_i = minPerKm_i · media(dist a los 3 vecinos más cercanos)`.
- Visitas/día: `dayMin = capMin / workDays`; `visitaMedia_i` = media ponderada de `m_j + hop_j` en i y sus
  30 vecinos; `perDay_i = max(1, dayMin / visitaMedia_i)` (sin el propio viaje → algo optimista).
- `travelPerKm_i = 2 · minPerKm_i / perDay_i`; el salto se suma a los minutos de visita.
- Carga mensual del cliente i con base c: `v_i · (m_i + hop_i + d(i,c) · travelPerKm_i)` minutos.

## 4. Territorios (camino de producción, `growthOnly`)

1. Orden por densidad (rejilla `max(0,5, 4·√(área/n))` km).
2. **Pueblos (regla A)**: unión de vecinos (10-NN) a ≤ `2 × mediana(dist al 5º vecino)`. Un pueblo con
   carga ≥ 0,5·capacidad es semilla; si no cabe en `0,97·capacidad`, se parte con un diagrama de potencia
   (subllamada) y las partes que superan la capacidad se bisecan por el eje principal.
3. Clientes de campo a las semillas de pueblo más cercanas con hueco (8 candidatas, de cerca a lejos).
4. Lo que sobra (≥ 2 clientes) → subllamada de diagrama de potencia (6 rondas de Lloyd + ascenso dual de
   pesos, semillas por crecimiento con radio 100 km, `repairBand` sin pasadas de flips pero con fusión de
   cortas y búsqueda local `drain` por voto de 10 vecinos).
5. Posproceso: reclamación (cliente a un centro más cercano con hueco, o cadena de hasta 6 desalojos),
   seguridad de tope, fusión de zonas cortas, restos de ≤ 6 clientes reubicados; **restos de ≤ 3 clientes
   que no caben quedan SIN ASIGNAR** [ejecutado].
6. La base de cada territorio es el centroide de su semilla y **no se recentra** al final.
7. Determinista: mulberry32, semilla `20260928 ^ (a·2654435761) ^ (parte·40503)`.

## 5. Áreas (`areas.ts`)

- Pesos = tiempo de visita puro (sin desplazamiento).
- Coherencia del código postal: fracción de clientes cuyo vecino más cercano (Delaunay) comparte código,
  con ≥ 20 clientes evaluables; < 0,5 → se ignora.
- Unidades: código postal (si abarca > 25 km se parte por pueblos); sin código en modo automático,
  "pueblos" (≤ 2 km o misma coordenada; > 25 km → celdas de 5 km); con campo Area sin código, cliente a cliente.
- Campo Area: cada unidad al área con **más peso de visita** (no más clientes, como decía un comentario).
- Automático: estado de cada unidad; grupos de tierra (`landGroup`); islas con peso 0 en el k-medias y un
  área propia cada una; k-medias++ ponderado con 24 arranques (coste Σ w·d²); adyacencia Delaunay solo entre
  estados que se tocan; `reparar` (trozos al área con más frontera; sin aristas: unidad más cercana de estado
  vecino, si no del mismo grupo de tierra); voto de rezagados (unidades ≤ 30 clientes, 10 vecinos desde el
  centro, 1/(d+0,5), > 60 %, enlaces ≤ 10 km cuentan como adyacencia); orden norte→sur, islas al final con
  su nombre.
- Las áreas **no equilibran horas**.

## 6. `clusterByArea`

Por área y por masa de tierra (`geo.land`), una llamada a `clusterPoints`. "Comerciales necesarios" =
`areaHours / capacidad`, fraccionario. **No hay cifra "recomendada" ni se muestra el número de territorios.**
`areaHours` excluye outliers y **clientes sin asignar** [ejecutado: un área de 2 clientes da 0 h].

## 7. Regiones

Natural Earth, países 1:110m y admin-1 1:10m simplificado (~2 km en EE. UU., España, India y México;
~5 km el resto). Punto en polígono por paridad; los que caen fuera toman estado y masa de tierra del punto
más cercano. `statesTouch`: −1 no restringe.

## 8. Salidas

Puntos coloreados **por área** (el territorio solo en tooltip y CSV). Leyenda y círculos = comerciales
necesarios por área. CSV (Pro): customer_id, area, territory, load_hours_month. PDF (Pro): composición ×2 →
JPEG → PDF de una página, `exportVisualsContent(base64, "territories.pdf", "base64")`. Filtro de área: columna
Area; si no, Postal code IN (si `postalFilterOk`); si no, selección de filas. Marcadores: `jsonFilters` y
`registerOnSelectCallback`.

## 9. Discrepancias encontradas (07-10-2026)

1. La cabecera de `clustering.ts` presenta el diagrama de potencia ±10 % como *el* método; en producción
   es crecimiento + pueblos + posproceso, con el diagrama solo en subllamadas y tolerancia 0.
2. El "crecimiento desde los focos" de `visual.ts:669-673` no es el mecanismo de nivel superior.
3. "TODO cliente entra en un territorio" es falso: restos de ≤ 3 clientes quedan sin asignar y **no cuentan
   en los comerciales necesarios**.
4. "Una isla pequeña da un territorio parcial": solo si tiene > 3 clientes o llena un comercial.
5. Radio por defecto: el comentario dice "media jornada"; el código usa 100 km (subllamadas) y 1e6 arriba.
6. `drain()` sí se ejecuta aunque un comentario dice que no.
7. El código postal no siempre se mantiene entero (> 25 km se parte; incoherente se ignora).
8. Campo Area: mayoría por peso de visita, no por número de clientes.
9. `tolerance` en settings es código muerto.
10. Rol `value` inexistente.
11. `rounds: 12` sin efecto.
12. `withinTolerance` / `outOfBand` sin sentido con banda 0; `routeFactor` obsoleto.
