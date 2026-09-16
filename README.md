# Agave Cía — Recepción + Producción E2E + Calculadora de rendimiento

Aplicación **full-stack** (Node.js sin dependencias + dashboard) que reemplaza las
**tablas macro de Excel** del encargado de recepción de materia prima y de
producción de bebidas alcohólicas (tequila). **Sin datos mock**: la base arranca
vacía y todo lo ingresa el usuario.

**Generalización:** los datos se registran con lo esencial; los **detalles finos**
(pesaje, inspección de calidad, parámetros de rendimiento, control por etapa) son
**opcionales** y la app usa valores por defecto cuando se omiten.

## Cómo abrirlo

Doble clic en **Agave Dashboard.bat** (escritorio) o `node server.js` →
<http://localhost:3053> (diagrama: <http://localhost:3053/flujo.html>).

## Módulos

### 1 · Recepción de materia prima (encargado)
- **Camiones** planeados vs reales con calendario (clic en un día para planear).
- **Pesaje**: peso bruto / tara → neto (opcional).
- **Inspección de calidad**: resultado (aceptado/parcial/rechazado), **% de piña útil**
- **Destino por ingreso**: en cada camión (y consumo) hay un dropdown **"Razón social destino"**
  para derivar esa carga a cualquier razón social, aunque el stream sea de otra. Todos los
  cálculos (recibido, merma, tequila esperado/producido) siguen al destino elegido; el stream
  conserva su ingreso físico y muestra el desglose por destino.
  y nota. Si se registra el % de piña, la merma real de esa entrega se calcula con él
  (si no, usa la merma del stream).
- **Destino por ingreso**: en cada camión (y consumo) hay un dropdown **"Razón social
  destino"** para derivar esa carga a cualquier razón social, aunque el stream sea de
  otra. Todos los cálculos (recibido, merma, tequila esperado/producido) siguen al
  destino elegido; el stream conserva su ingreso físico y muestra el desglose por destino.
- **Remisión de recepción (ticket)**: botón *Ticket* → documento imprimible con
  folio, proveedor, placa, pesaje, inspección y firmas.

### 2 · Calculadora de rendimiento (fine tuning, reemplaza las macros)
- Cascada de rendimiento por etapas (por tonelada de agave aprovechado):
  cocción → molienda → fermentación → destilación → dilución → añejamiento.
- Coeficientes **editables en vivo** por razón social (se guardan al salir del campo).
- **Presets**: Base (~151 L/t) · Optimista (~184 L/t) · Conservador (~115 L/t).
- **Merma por causa** editable (debe sumar 100 %) y **grado de tequila** (ABV).
- El tequila esperado/producido usa este motor en toda la app.

### 3 · Producción E2E
- **Órdenes de producción (lotes)**: razón social, agave asignado, estado
  (planeada / en proceso / terminada) y fechas.
- **Control de rendimiento**: tequila esperado (calculadora) vs **tequila real**,
  rendimiento real L/t y **eficiencia %**.
- **Resultados por etapa** opcionales (cocción, molienda, fermentación, destilación).

## API REST (resumen)

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/api/state` | Snapshot con todo calculado + `parametrosCalculo` y `ordenes`. |
| POST/PATCH/DELETE | `/api/razones` | CRUD de razones sociales (parametros opcionales). |
| POST | `/api/razones/:id/presets/:nombre` | Aplica preset base/optimista/conservador. |
| POST/PATCH/DELETE | `/api/streams` | CRUD (mermaRate opcional, default 10 %). |
| POST/PATCH/DELETE | `/api/camiones` | CRUD con placa/pesaje/inspección opcionales y `rsDestinoId` (dropdown de destino). |
| POST | `/api/camiones/:id/recibir` | Recibir (fechaReal + inspección opcional). |
| GET | `/api/camiones/:id/ticket` | Remisión de recepción imprimible (HTML). |
| POST/DELETE | `/api/streams/:id/consumo` · `/api/consumos/:id` | Consumo de agave (con `rsDestinoId` opcional). |
| POST/PATCH/DELETE | `/api/ordenes` | Órdenes de producción (etapas opcionales). |
| PATCH | `/api/parametros` | mermaCausas (%) y gradosTequila (global). |
| POST/GET/… | `/api/backup` · `/api/backups` · restore · delete | Respaldos/restauración. |
| POST | `/api/reset` · GET `/api/export.csv` | Vaciar · Exportar completo (8 hojas). |

## Export CSV (GET /api/export.csv)

Un solo archivo UTF-8 (BOM) compatible con Excel con **8 hojas** separadas por líneas
en blanco y tituladas `### HOJA: ...`:

1. **META** — fecha de exportación, hoy del sistema, versión y totales por entidad.
2. **RESUMEN GENERAL** — objetivo, recibido, aprovechado, merma (t y %), consumido,
   tequila esperado/producido, % recepción y % consumo.
3. **RAZONES SOCIALES** — parámetros de cálculo por etapa (cocción, molienda,
   conversión, destilación, añejamiento), rendimiento efectivo L/t, preset y todos
   los totales de campaña + estado.
4. **STREAMS** — ingreso físico, merma efectiva, tequila, camiones recibidos/planeados
   y **desglose de destinos** (a qué razón social fue cada parte del agave).
5. **CAMIONES** — stream, razón social default vs **destino**, derivado SI/NO, placa,
   peso neto/bruto/tara, fechas, retraso, estado, inspección (resultado, % piña, nota).
6. **CONSUMOS** — fecha, stream, destino, kg y **tequila equivalente** (por destino).
7. **ÓRDENES** — esperado vs real, rendimiento real L/t, eficiencia % y **resultados
   por etapa** (cocción/molienda/fermentación/destilación).
8. **PARÁMETROS** — grado de tequila ABV y distribución de merma por causa (%).

## Arquitectura

| Archivo | Rol |
| --- | --- |
| `server.js` | Capa HTTP: router REST + estáticos + ticket. Sin dependencias. |
| `lib/model.js` | Datos y negocio: store JSON, validaciones, CRUD, **cascada de rendimiento**, presets, respaldos. |
| `data/db.json` + `data/backups/` | Persistencia. |
| `index.html` | Dashboard API-first (delegación de eventos, estados vacíos/carga/error). |
| `flujo.html` + `flujo.dataflow.json` | Diagrama de flujo (Archify, showcase). |

## Fórmulas (motor en lib/model.js)

- `recibidoT` = Σ kg de camiones recibidos / 1000.
- `aprovechadoT` = Σ por camión: kg × (pctPina/100 si hay inspección, si no (1 − mermaRate)).
- `mermaT` = recibidoT − aprovechadoT.
- Cascada (por tonelada aprovechada): piña cocida = 1000 × (1 − coccion%); mosto = cocida × molienda%;
  alcohol L = mosto × conversión; tequila 100% = alcohol × destilación%; dilución a grados ABV;
  final = diluido × (1 − añejamiento%).
- `tequilaEsperado` = aprovechadoT × rendimientoEfectivo (L/t); `tequilaProducido` = consumidoT × rendimientoEfectivo.
- `restanteT` = máx(0, objetivoT − recibidoT) → "cuánto va quedando de la campaña".
