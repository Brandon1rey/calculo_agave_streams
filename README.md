# Agave Cía — Recepción + Producción E2E + Calculadora de rendimiento

Aplicación full-stack que reemplaza las **tablas macro de Excel** del encargado de
recepción de materia prima y de producción de tequila. **Sin datos mock**: la base
arranca vacía y todo lo ingresa el usuario.

- **Front-end**: un solo `index.html` (dashboard API-first, sin build step).
- **Back-end**: función serverless en Vercel (`api/[...path].js`) con un router REST.
- **Base de datos**: PostgreSQL gestionado en **Supabase** (`supabase/schema.sql`).
- **Sin conexión**: la app **abre y muestra el dashboard en solo lectura** con los
  últimos datos vistos; los cambios requieren internet (no hay cola de escrituras).

> **Generalización:** los datos se registran con lo esencial; los detalles finos
> (pesaje, inspección de calidad, parámetros de rendimiento, control por etapa) son
> **opcionales** y la app usa valores por defecto cuando se omiten.

---

## 1 · Arrancarlo en local

```bash
npm install
cp .env.local.example .env.local     # y pega tu DATABASE_URL
npm run db:schema                    # crea las tablas (idempotente)
npm run dev                          # http://localhost:3053
```

Sin Supabase a mano puedes usar un Postgres cualquiera (incluido uno de Docker):

```bash
docker run -d --name agave-pg -e POSTGRES_PASSWORD=agave -e POSTGRES_DB=agave -p 55432:5432 postgres:16-alpine
# .env.local →  DATABASE_URL=postgresql://postgres:agave@127.0.0.1:55432/agave
#                PGSSLMODE=disable
```

Si venías de la versión anterior (que guardaba en `data/db.json`), importa esos datos:

```bash
npm run db:import                    # no borra el archivo original
```

---

## 2 · Desplegarlo (Supabase + Vercel)

**a) Base de datos**

1. Crea un proyecto en Supabase.
2. SQL Editor → pega el contenido de `supabase/schema.sql` → **Run**
   (o en local: `npm run db:schema` apuntando a la cadena de Supabase).
3. Project Settings → Database → **Connection string → URI (Pooler, puerto 6543)**.
   Esa cadena —con tu contraseña— es tu `DATABASE_URL`.

**b) Vercel**

1. Sube el repositorio a GitHub/GitLab e impórtalo en Vercel (o `npx vercel`).
2. No hace falta configurar framework: la raíz es estática y `api/[...path].js` es la
   función. `vercel.json` ya bloquea el acceso público a `api/_lib/`, `scripts/`,
   `supabase/`, `tests/` y a los archivos de configuración.
3. En **Settings → Environment Variables** define:
   - `DATABASE_URL` (obligatoria) — la cadena del pooler.
   - `APP_PASSWORD` (muy recomendada) — protege la app publicada.
   - `AUTH_SECRET` — cadena larga y aleatoria para firmar la cookie.
4. Deploy. Para entrar la primera vez: `https://TU-APP.vercel.app/?k=TU_CONTRASEÑA`
   (deja una cookie firmada de 90 días; después ya puedes entrar normal).

> `APP_PASSWORD` es opcional: **si no la defines, la app queda abierta a quien tenga
> la URL**. En local no la necesitas.

---

## 3 · Modo sin conexión (offline compatible)

No es offline-first: **no hay cola de escrituras ni sincronización diferida**. Lo que
sí hace:

| Situación | Comportamiento |
| --- | --- |
| Abres la app sin internet | El **service worker** sirve el shell desde caché y el dashboard se pinta con el **último estado guardado** en el dispositivo, en **solo lectura**, con aviso `Sin conexión · mostrando datos guardados de las HH:MM`. |
| Intentas guardar sin conexión | Se bloquea con un aviso: *"Sin conexión: los cambios necesitan internet"*. El modal no se cierra y no se pierde lo capturado. |
| Vuelve la conexión | Se detecta automáticamente (`online`) y recarga el estado desde el servidor; el chip de la barra superior pasa de ámbar a verde. |
| Hay internet pero el backend no responde | Igual que sin conexión: solo lectura + aviso + botón **Reintentar**. |

Piezas: `sw.js` (caché del shell y de `GET /api/state`), `offline.js` (caché local,
detección de red y `wrapFetch`) y el chip `#netPill` en la barra superior.

**Cómo comprobarlo en el navegador** (requiere `https` o `localhost`):

1. Abre la app y espera a que cargue; en DevTools → Application → Service Workers debe
   aparecer `sw.js` **activated**.
2. DevTools → Network → marca **Offline** y recarga: la app debe abrir con los datos
   del último sync y el chip en ámbar.
3. Desmarca Offline: el chip vuelve a verde y los datos se refrescan solos.

---

## 4 · Módulos

### Recepción de materia prima (encargado)
- **Camiones** planeados vs reales con calendario (clic en un día para planear).
- **Pesaje**: peso bruto / tara → neto (opcional).
- **Inspección de calidad**: resultado (aceptado/parcial/rechazado), **% de piña útil** y
  nota. Si se registra el % de piña, la merma real de esa entrega se calcula con él
  (si no, usa la merma del stream).
- **Destino por ingreso**: en cada camión (y consumo) hay un dropdown **"Razón social
  destino"** para derivar esa carga a cualquier razón social, aunque el stream sea de
  otra. Todos los cálculos (recibido, merma, tequila esperado/producido) siguen al
  destino elegido; el stream conserva su ingreso físico y muestra el desglose.
- **Remisión de recepción (ticket)**: botón *Ticket* → documento imprimible con folio,
  proveedor, placa, pesaje, inspección y firmas.

### Calculadora de rendimiento (fine tuning, reemplaza las macros)
- Cascada por etapas (por tonelada de agave aprovechado): cocción → molienda →
  fermentación → destilación → dilución → añejamiento.
- Coeficientes **editables en vivo** por razón social (se guardan al salir del campo).
- **Presets**: Base (~151 L/t) · Optimista (~184 L/t) · Conservador (~115 L/t).
- **Merma por causa** editable (debe sumar 100 %) y **grado de tequila** (ABV).
- El tequila esperado/producido usa este motor en toda la app.

### Producción E2E
- **Órdenes de producción (lotes)**: razón social, agave asignado, estado y fechas.
- **Control de rendimiento**: tequila esperado vs **real**, rendimiento real L/t y
  **eficiencia %**.
- **Resultados por etapa** opcionales (cocción, molienda, fermentación, destilación).

---

## 5 · API REST

Todas las escrituras responden con el **estado completo ya calculado**, más `rev`
(número de revisión, sube en cada escritura) y `updatedAt`.

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/api/health` | Estado del servicio y de la base (`rev`, `updatedAt`, conteos). |
| GET | `/api/state` | Snapshot con todo calculado + `parametrosCalculo`, `ordenes`, `rev`. |
| GET | `/api/db` | Documento crudo (diagnóstico / respaldo manual). |
| POST/PATCH/DELETE | `/api/razones` · `/api/razones/:id` | CRUD de razones sociales. |
| POST | `/api/razones/:id/presets/:nombre` | Aplica preset base/optimista/conservador. |
| POST/PATCH/DELETE | `/api/streams` · `/api/streams/:id` | CRUD (mermaRate opcional, default 10 %). |
| POST/PATCH/DELETE | `/api/camiones` · `/api/camiones/:id` | CRUD con placa/pesaje/inspección y `rsDestinoId`. |
| GET | `/api/camiones?estado=&stream=` | Filtros de camiones. |
| POST | `/api/camiones/:id/recibir` | Recibir (fechaReal + inspección opcional). |
| GET | `/api/camiones/:id/ticket` | Remisión de recepción imprimible (HTML). |
| POST/DELETE | `/api/streams/:id/consumo` · `/api/consumos/:id` | Consumo de agave. |
| POST/PATCH/DELETE | `/api/ordenes` · `/api/ordenes/:id` | Órdenes de producción (etapas opcionales). |
| PATCH | `/api/parametros` | mermaCausas (%) y gradosTequila (global). |
| POST/GET | `/api/backup` · `/api/backups` | Crear y listar respaldos. |
| POST/DELETE | `/api/backups/:id/restore` · `/api/backups/:id` | Restaurar / borrar. |
| POST | `/api/reset` | Vaciar **creando antes un respaldo automático**. |
| GET | `/api/export.csv` | Exportación completa (8 hojas). |

Códigos: `400` validación, `404` no encontrado, `405` método no permitido,
`409` conflicto (p. ej. borrar una razón social en uso), `401` sin autorización
(solo si defines `APP_PASSWORD`), `500` error inesperado.

---

## 6 · Base de datos

`supabase/schema.sql` (idempotente) define:

| Tabla | Contenido |
| --- | --- |
| `settings` | Fila única: grados ABV, las 5 causas de merma, `rev` y `updated_at`. |
| `razones_sociales` | Nombre, corto, los 5 parámetros de cálculo, preset. |
| `streams` | Nombre, zona, razón social, objetivo (t), tasa de merma. |
| `camiones` | Stream, destino, placa, bruto/tara/neto, fechas, inspección. |
| `consumos` | Stream, destino, fecha, kg. |
| `ordenes` + `orden_etapas` | Lote, estado, fechas, agave, tequila real y resultados por etapa. |
| `backups` | Respaldos en `jsonb` (antes eran archivos: en Vercel no hay disco). |

Los números se guardan como `double precision`/`integer` —nunca `numeric`, que
devolvería strings— y las fechas como `date` con parser a texto `YYYY-MM-DD`, para que
la API conserve exactamente el mismo contrato que la versión anterior.

**Seguridad:** las tablas tienen RLS activado sin políticas y los roles `anon` /
`authenticated` quedan sin permisos: solo entra el servidor (dueño de las tablas). Toda
la API pasa por la función de Vercel.

---

## 7 · Export CSV (`GET /api/export.csv`)

Un archivo UTF-8 (con BOM) compatible con Excel con **8 hojas** separadas por líneas en
blanco y tituladas `### HOJA: ...`:

1. **META** — fecha de exportación, hoy del sistema, versión, **revisión** y totales.
2. **RESUMEN GENERAL** — objetivo, recibido, aprovechado, merma (t y %), consumido,
   tequila esperado/producido, % recepción y % consumo.
3. **RAZONES SOCIALES** — parámetros por etapa, rendimiento efectivo L/t, preset,
   totales de campaña y estado.
4. **STREAMS** — ingreso físico, merma efectiva, tequila y **desglose de destinos**.
5. **CAMIONES** — stream, razón social default vs **destino**, derivado SI/NO, placa,
   pesos, fechas, retraso, estado e inspección.
6. **CONSUMOS** — fecha, stream, destino, kg y **tequila equivalente**.
7. **ORDENES** — esperado vs real, rendimiento real L/t, eficiencia y resultados por etapa.
8. **PARAMETROS** — grado ABV y distribución de merma por causa.

---

## 8 · Arquitectura de archivos

| Archivo | Rol |
| --- | --- |
| `index.html` | Dashboard completo (CSS + cliente API-first + glue offline). |
| `engine.js` | **Motor de negocio puro** (sin I/O): validaciones, CRUD sobre el documento, cascada de rendimiento, `computeState`. Se usa en Node **y** en el navegador (modo sin conexión). |
| `api/_lib/app.js` | Router HTTP + API REST + ticket + CSV + puerta opcional. Compartido por Vercel y el servidor local. |
| `api/_lib/db.js` | Capa PostgreSQL: mapeo documento ↔ tablas, transacciones, respaldos, `rev`. |
| `api/[...path].js` | Función serverless de Vercel (catch-all de `/api/*`). |
| `scripts/dev-server.js` | Servidor local (mismo router + estáticos + carga de `.env.local`). |
| `scripts/apply-schema.js` | Aplica `supabase/schema.sql`. |
| `scripts/import-json.js` | Importa el antiguo `data/db.json`. |
| `sw.js` · `offline.js` · `manifest.webmanifest` | Service worker, caché local/detección de red y manifiesto PWA. |
| `tests/api-verify.ps1` | 124 comprobaciones de la API. |
| `tests/offline-client.test.js` | 23 comprobaciones de la capa sin conexión. |
| `flujo.html` | Diagrama de flujo (showcase). |

Flujo de una escritura: `loadDb()` → `engine.<mutación>()` (valida y muta) →
`saveDb()` (una transacción: borra lo que sobra + upsert de lo que hay) →
`computeState()` → respuesta con el estado completo.

---

## 9 · Fórmulas (motor en `engine.js`)

- `recibidoT` = Σ kg de camiones recibidos / 1000.
- `aprovechadoT` = Σ por camión: kg × (pctPina/100 si hay inspección, si no (1 − mermaRate)).
- `mermaT` = recibidoT − aprovechadoT.
- Cascada (por tonelada aprovechada): piña cocida = 1000 × (1 − coccion%); mosto = cocida ×
  molienda%; alcohol L = mosto × conversión; tequila 100% = alcohol × destilación%;
  dilución a grados ABV; final = diluido × (1 − añejamiento%).
- `tequilaEsperado` = aprovechadoT × rendimientoEfectivo (L/t);
  `tequilaProducido` = consumidoT × rendimientoEfectivo.
- `restanteT` = máx(0, objetivoT − recibidoT).

---

## 10 · Pruebas

```bash
# Suite de API (124 checks). USA UNA BASE DE PRUEBAS: termina con /api/reset.
$env:DATABASE_URL='postgresql://postgres:agave@127.0.0.1:55432/agave_test'
$env:PORT='3099'; $env:NO_BROWSER='1'; node scripts/dev-server.js
pwsh -File tests/api-verify.ps1 -Base http://127.0.0.1:3099

# Capa sin conexión (23 checks, sin servidor ni navegador)
npm run test:offline
```

---

## 11 · Correcciones incluidas en esta versión (2.0)

| # | Problema de la 1.0 | Estado |
| --- | --- | --- |
| 1 | **Nada se guardaba en disco**: `run()`/`created()` hacían `if (db !== store.data) store.save()`, condición que nunca se cumplía → todo el CRUD vivía en RAM y se perdía al reiniciar. | **Corregido**: cada escritura va a Postgres en una transacción. |
| 2 | `/api/backups/:id/restore` y `DELETE /api/backups/:id` devolvían **500 en vez de 404**. | **Corregido**: el `catch` respeta `e.status`. |
| 3 | `/api/reset` borraba datos y parámetros sin confirmación ni respaldo. | **Corregido**: crea un respaldo automático antes de vaciar. |
| 4 | Escuchaba en todas las interfaces, sin autenticación, y servía `data/db.json` por HTTP. | **Corregido**: en local escucha en `127.0.0.1`, la app publicada admite `APP_PASSWORD`, y `data/`, `scripts/`, `supabase/`, `tests/` y `api/_lib/` no se sirven. |
| 5 | Una `db.json` corrupta se sobrescribía con una vacía, sin aviso. | **Obsoleto**: ya no hay archivo único; Postgres garantiza la integridad. |
| 6 | Borrar una razón social usada solo como **destino derivado** dejaba referencias colgantes y descuadraba los totales. | **Corregido**: bloquea con 409 (y la clave foránea lo refuerza). |
| 7 | `updateCamion` permitía dejar `pesoBruto <= pesoTara`; orden inestable con fechas iguales. | **Corregido** con validación de coherencia y `CHECK` en la tabla. |
