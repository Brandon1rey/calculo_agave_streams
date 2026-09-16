# ============================================================================
# Verificacion funcional de la API de agave-dashboard  ·  arquitectura Vercel + Supabase (Postgres)
# ----------------------------------------------------------------------------
#   ATENCION: la suite TERMINA llamando a POST /api/reset, que VACIA la base.
#   Ejecutala SOLO contra una base de datos de pruebas, NUNCA contra produccion.
#
# Uso (instancia de pruebas en el puerto 3099 contra la base agave_test):
#   $env:DATABASE_URL='postgresql://postgres:agave@127.0.0.1:55432/agave_test'
#   $env:PORT='3099'; $env:NO_BROWSER='1'
#   node scripts/dev-server.js
#   pwsh -File tests/api-verify.ps1 -Base http://127.0.0.1:3099
#
# Codigo de salida = numero de fallos (0 = todo pasa).
# ============================================================================
param([string]$Base = 'http://127.0.0.1:3099')

Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
$http = New-Object System.Net.Http.HttpClient
$http.Timeout = [TimeSpan]::FromSeconds(20)
$script:pass = 0; $script:fail = 0; $script:rows = @()

function Req([string]$method, [string]$path, $body = $null) {
  $msg = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($method), "$Base$path")
  if ($null -ne $body) {
    $json = if ($body -is [string]) { $body } else { $body | ConvertTo-Json -Depth 8 -Compress }
    $msg.Content = [System.Net.Http.StringContent]::new($json, [System.Text.Encoding]::UTF8, 'application/json')
  }
  $resp = $http.SendAsync($msg).GetAwaiter().GetResult()
  $text = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  [PSCustomObject]@{ Status = [int]$resp.StatusCode; Text = $text }
}
function J($r) { try { $r.Text | ConvertFrom-Json } catch { $null } }
function Check([string]$name, $expected, $actual, [string]$nota = '') {
  if ($expected -is [array]) { $ok = $expected -contains $actual } else { $ok = ($expected -eq $actual) }
  if ($ok) { $script:pass++ } else { $script:fail++ }
  if ($ok) { $tag = 'PASS' } else { $tag = 'FAIL' }
  $script:rows += [PSCustomObject]@{ Test = $tag; Caso = $name; Esperado = ($expected -join '|'); Obtenido = $actual; Nota = $nota }
}

Write-Host "== Verificacion funcional contra $Base ==" -ForegroundColor Cyan

# ---------- 0. Limpieza inicial: la suite asume una base vacia ----------
$rz0 = Req POST '/api/reset'
Check 'POST /api/reset de limpieza inicial -> 200' 200 $rz0.Status
$st0 = J $rz0
Check 'la base de pruebas arranca vacia' 0 ($st0.razonesSociales.Count + $st0.streams.Count + $st0.camiones.Count + $st0.consumos.Count + $st0.ordenes.Count)
Check 'el reset de limpieza deja respaldo automatico' $true ([bool]$st0.autoBackup.id)

# ---------- 1. Salud, revision y documento crudo ----------
$h = Req GET '/api/health'; $hj = J $h
Check 'GET /api/health responde 200' 200 $h.Status
Check 'health.ok = true' $true $hj.ok
Check 'health.version = 4' 4 $hj.version
Check 'health.almacen = postgres' 'postgres' $hj.almacen
Check 'health expone revision' $true ($hj.rev -ge 1) "rev=$($hj.rev)"

$db0 = Req GET '/api/db'; $dbj = J $db0
Check 'GET /api/db -> 200 (documento crudo)' 200 $db0.Status
Check '/api/db trae rev y updatedAt' $true ([bool]$dbj.rev -and [bool]$dbj.updatedAt)
Check '/api/db trae las 5 colecciones' 'camiones,consumos,ordenes,razonesSociales,streams' (($dbj.db.PSObject.Properties.Name | Where-Object { @('razonesSociales','streams','camiones','consumos','ordenes') -contains $_ } | Sort-Object) -join ',')
Check '/api/db NO expone metadatos de revision dentro del documento' $null $dbj.db.rev

$rev0 = (J (Req GET '/api/state')).rev
$estado0 = Req GET '/api/state'
Check 'GET /api/state expone rev' $true ((J $estado0).rev -ge 1)
Check 'GET /api/state no cachea (no-cache)' $true ($estado0.Text.Length -gt 0)

# ---------- 2. Razones sociales ----------
$before = @((J (Req GET '/api/state')).razonesSociales.id)
$r = Req POST '/api/razones' @{ nombre = 'Tequilera Prueba SA de CV'; corto = 'TPR' }
Check 'POST /api/razones crea (201)' 201 $r.Status
$st = J $r
$rsId = @($st.razonesSociales.id | Where-Object { $before -notcontains $_ })[0]
Check 'razon social aparece en el estado' $true ([bool]$rsId) "id=$rsId"
$rs = $st.razonesSociales | Where-Object { $_.id -eq $rsId }
Check 'preset inicial = custom' 'custom' $rs.preset
Check 'parametros por defecto aplicados' 8 $rs.parametros.coccionPerdida
Check 'rendimiento efectivo calculado (>0)' $true ($rs.rendimientoEfectivo -gt 0) "$($rs.rendimientoEfectivo) L/t"
Check 'cascada de 7 etapas' 7 $rs.cascade.Count
Check 'la escritura incrementa la revision' ($rev0 + 1) $st.rev "rev $rev0 -> $($st.rev)"
Check 'la escritura actualiza updatedAt' $true ([bool]$st.updatedAt)

$revAntes = (J (Req GET '/api/state')).rev
$bad = Req POST '/api/razones' @{ corto = 'X' }
Check 'POST /api/razones sin nombre -> 400' 400 $bad.Status
Check 'una escritura rechazada NO incrementa la revision' $revAntes (J (Req GET '/api/state')).rev
Check 'PATCH razon inexistente -> 404' 404 (Req PATCH '/api/razones/NO_EXISTE' @{ nombre = 'x' }).Status

# ---------- 3. Validaciones de parametros ----------
Check 'grados fuera de rango -> 400' 400 (Req PATCH '/api/parametros' @{ gradosTequila = 99 }).Status
Check 'causas de merma que no suman 100 -> 400' 400 (Req PATCH '/api/parametros' @{ mermaCausas = @{ hojas = 10; danado = 10; fibra = 10; cortes = 10; otros = 10 } }).Status
$p3 = Req PATCH '/api/parametros' @{ gradosTequila = 38; mermaCausas = @{ hojas = 50; danado = 20; fibra = 12; cortes = 10; otros = 8 } }
Check 'PATCH /api/parametros valido -> 200' 200 $p3.Status
Check 'grados persistidos' 38 (J $p3).parametrosCalculo.gradosTequila
Check 'parametros sobreviven a una relectura desde Postgres' 38 (J (Req GET '/api/state')).parametrosCalculo.gradosTequila

# ---------- 4. Streams ----------
$sBefore = @((J (Req GET '/api/state')).streams.id)
$s = Req POST '/api/streams' @{ nombre = 'Rancho El Aguila'; zona = 'Los Altos'; rsId = $rsId; objetivoT = 1000; mermaRate = 0.1 }
Check 'POST /api/streams crea (201)' 201 $s.Status
$st = J $s
$streamId = @($st.streams.id | Where-Object { $sBefore -notcontains $_ })[0]
Check 'stream con objetivo 1000 t' 1000 ($st.streams | Where-Object { $_.id -eq $streamId }).objetivoT
Check 'POST stream con rs invalida -> 400' 400 (Req POST '/api/streams' @{ nombre = 'X'; rsId = 'no-existe'; objetivoT = 10 }).Status
Check 'POST stream objetivo 0 -> 400' 400 (Req POST '/api/streams' @{ nombre = 'X'; rsId = $rsId; objetivoT = 0 }).Status

# ---------- 5. Camiones ----------
$cBefore = @((J (Req GET '/api/state')).camiones.id)
$c = Req POST '/api/camiones' @{ streamId = $streamId; placa = 'abc-123'; pesoBruto = 30000; pesoTara = 12000; fechaPlaneada = '2026-09-14'; inspeccion = @{ resultado = 'aceptado'; pctPina = 72 } }
Check 'POST /api/camiones con pesos (201)' 201 $c.Status
$st = J $c
$camionId = @($st.camiones.id | Where-Object { $cBefore -notcontains $_ })[0]
$cam = $st.camiones | Where-Object { $_.id -eq $camionId }
Check 'peso neto = bruto - tara' 18000 $cam.kg
Check 'placa normalizada a mayusculas' 'ABC-123' $cam.placa
Check 'estado derivado = atrasado' 'atrasado' $cam.estado "planeado 2026-09-14 < hoy"
Check 'inspeccion anidada reconstruida' 72 $cam.inspeccion.pctPina
Check 'camion pesado <= tara -> 400' 400 (Req POST '/api/camiones' @{ streamId = $streamId; pesoBruto = 10000; pesoTara = 12000; fechaPlaneada = '2026-09-15' }).Status
Check 'camion con 50 kg -> 400 (minimo 100)' 400 (Req POST '/api/camiones' @{ streamId = $streamId; kg = 50; fechaPlaneada = '2026-09-15' }).Status
Check 'fecha mal formada -> 400' 400 (Req POST '/api/camiones' @{ streamId = $streamId; kg = 5000; fechaPlaneada = '15/09/2026' }).Status
Check 'inspeccion invalida -> 400' 400 (Req POST '/api/camiones' @{ streamId = $streamId; kg = 5000; fechaPlaneada = '2026-09-15'; inspeccion = @{ resultado = 'quizas' } }).Status
Check 'PATCH camion con solo pesoBruto incoherente -> 400' 400 (Req PATCH "/api/camiones/$camionId" @{ pesoBruto = 1000 }).Status

$rec = Req POST "/api/camiones/$camionId/recibir" @{ fechaReal = '2026-09-15' }
Check 'POST /camiones/:id/recibir -> 200' 200 $rec.Status
$st = J $rec
$cam = $st.camiones | Where-Object { $_.id -eq $camionId }
Check 'estado pasa a recibido' 'recibido' $cam.estado
Check 'dias de retraso calculados' 1 $cam.diasRetraso "planeado 14, real 15"
Check 'recepcion sin fechaReal -> 400' 400 (Req POST "/api/camiones/$camionId/recibir" @{}).Status
Check 'recibir camion inexistente -> 404' 404 (Req POST '/api/camiones/t-nope/recibir' @{ fechaReal = '2026-09-15' }).Status
Check 'la fecha sigue siendo string YYYY-MM-DD (no Date de JS)' '2026-09-15' $cam.fechaReal

$tk = Req GET "/api/camiones/$camionId/ticket"
Check 'GET /camiones/:id/ticket -> 200' 200 $tk.Status
Check 'ticket trae el folio' $true ($tk.Text -like "*$camionId*")
Check 'ticket trae peso neto formateado' $true ($tk.Text -like '*18,000 kg*')
Check 'ticket inexistente -> 404' 404 (Req GET '/api/camiones/t-nope/ticket').Status
Check 'GET /api/camiones?estado=recibido filtra' 1 (J (Req GET '/api/camiones?estado=recibido')).total

# ---------- 6. Consumos ----------
Check 'POST /streams/:id/consumo (201)' 201 (Req POST "/api/streams/$streamId/consumo" @{ kg = 8000; fecha = '2026-09-15' }).Status
Check 'consumo con kg 10 -> 400' 400 (Req POST "/api/streams/$streamId/consumo" @{ kg = 10; fecha = '2026-09-15' }).Status
Check 'consumo sin fecha -> 400' 400 (Req POST "/api/streams/$streamId/consumo" @{ kg = 500 }).Status

# ---------- 7. Ordenes ----------
$oBefore = @((J (Req GET '/api/state')).ordenes.id)
$o = Req POST '/api/ordenes' @{ nombre = 'Lote 001'; rsId = $rsId; agaveKg = 20000; etapas = @(@{ clave = 'coccion'; salidaKg = 18400 }, @{ clave = 'molienda'; salidaKg = 11040 }, @{ clave = 'fermentacion'; salidaL = 1766 }, @{ clave = 'destilacion'; salidaL = 1236 }) }
Check 'POST /api/ordenes (201)' 201 $o.Status
$st = J $o
$ordenId = @($st.ordenes.id | Where-Object { $oBefore -notcontains $_ })[0]
$ord = $st.ordenes | Where-Object { $_.id -eq $ordenId }
Check 'orden genera tequila esperado (>0)' $true ($ord.tequilaEsperadoL -gt 0) "$($ord.tequilaEsperadoL) L"
Check 'orden calcula 7 etapas esperadas' 7 $ord.esperado.Count
Check 'orden guarda las 4 etapas reales' 4 $ord.etapas.Count
Check 'etapas reconstruidas en orden canonico' 'coccion' $ord.etapas[0].clave
Check 'etapa conserva salidaKg' 18400 $ord.etapas[0].salidaKg
Check 'orden con etapa invalida -> 400' 400 (Req POST '/api/ordenes' @{ nombre = 'X'; rsId = $rsId; agaveKg = 5000; etapas = @(@{ clave = 'magia' }) }).Status
Check 'orden con agaveKg 10 -> 400' 400 (Req POST '/api/ordenes' @{ nombre = 'X'; rsId = $rsId; agaveKg = 10 }).Status

$op = Req PATCH "/api/ordenes/$ordenId" @{ estado = 'terminada'; fechaFin = '2026-09-16'; tequilaRealL = 1200 }
Check 'PATCH orden con resultado real -> 200' 200 $op.Status
$ord = (J $op).ordenes | Where-Object { $_.id -eq $ordenId }
Check 'rendimiento real L/t calculado' $true ($ord.rendimientoRealLt -gt 0) "$($ord.rendimientoRealLt) L/t"
Check 'eficiencia % calculada' $true ($ord.eficiencia -gt 0) "$($ord.eficiencia) %"
Check 'PATCH estado invalido -> 400' 400 (Req PATCH "/api/ordenes/$ordenId" @{ estado = 'inventado' }).Status

# ---------- 8. Presets ----------
$pr = Req POST "/api/razones/$rsId/presets/optimista"
Check 'POST /razones/:id/presets/optimista -> 200' 200 $pr.Status
$rsNow = (J $pr).razonesSociales | Where-Object { $_.id -eq $rsId }
Check 'preset aplicado = optimista' 'optimista' $rsNow.preset
Check 'parametros del preset optimista' 64 $rsNow.parametros.moliendaRendimiento
Check 'preset optimista mejora el rendimiento' $true ($rsNow.rendimientoEfectivo -gt $rs.rendimientoEfectivo) "optimista $($rsNow.rendimientoEfectivo) L/t vs base $($rs.rendimientoEfectivo) L/t"
Check 'preset inexistente -> 404' 404 (Req POST "/api/razones/$rsId/presets/inexistente").Status

# ---------- 9. Integridad referencial ----------
Check 'DELETE razon con streams -> 409' 409 (Req DELETE "/api/razones/$rsId").Status
Check 'DELETE stream inexistente -> 404' 404 (Req DELETE '/api/streams/s-nope').Status
$rsDest = @((J (Req POST '/api/razones' @{ nombre = 'Destino Derivado'; corto = 'DD' })).razonesSociales | Where-Object { $_.corto -eq 'DD' })[0]
$c2 = Req POST '/api/camiones' @{ streamId = $streamId; kg = 5000; fechaPlaneada = '2026-09-16'; fechaReal = '2026-09-16'; rsDestinoId = $rsDest.id }
Check 'camion con razon social destino derivada (201)' 201 $c2.Status
Check 'DELETE razon usada solo como destino -> 409 (antes se permitia y descuadraba)' 409 (Req DELETE "/api/razones/$($rsDest.id)").Status
$tot = J (Req GET '/api/state')
Check 'totales por razon social cuadran con el resumen' $tot.resumen.recibidoT (($tot.razonesSociales | ForEach-Object { $_.totales.recibidoT } | Measure-Object -Sum).Sum) "suma por razon social vs resumen de streams"

# ---------- 10. Export CSV ----------
$csv = Req GET '/api/export.csv'
Check 'GET /api/export.csv -> 200' 200 $csv.Status
Check 'CSV lleva BOM UTF-8' $true ($csv.Text.StartsWith([char]0xFEFF))
foreach ($hoja in @('META', 'RESUMEN GENERAL', 'RAZONES SOCIALES', 'STREAMS', 'CAMIONES', 'CONSUMOS', 'ORDENES', 'PARAMETROS')) {
  Check "CSV incluye hoja $hoja" $true ($csv.Text -like "*### HOJA: $hoja*")
}
Check 'CSV escapa comillas dobles' $true ($csv.Text -like '*"Tequilera Prueba SA de CV"*')
Check 'CSV incluye la revision en META' $true ($csv.Text -like '*"revision"*')

# ---------- 11. Respaldos (ahora en la base de datos) ----------
$bk = Req POST '/api/backup'
Check 'POST /api/backup (201)' 201 $bk.Status
$bkpId = (J $bk).backup.id
Check 'backup listado' $true ((J (Req GET '/api/backups')).backups.id -contains $bkpId) "id=$bkpId"
Check 'backup cuenta los registros' $true ((J (Req GET '/api/backups')).backups[0].counts.razones -ge 1)
$nStreams = (J (Req GET '/api/state')).streams.Count
Req DELETE "/api/streams/$streamId" | Out-Null
Check 'DELETE stream borra en cascada camiones y consumos' 0 (J (Req GET '/api/state')).camiones.Count
Check 'DELETE stream inexistente tras la cascada -> 404 (los consumos tambien se fueron)' 404 (Req DELETE '/api/consumos/c-nope').Status
$rs2 = Req POST "/api/backups/$bkpId/restore"
Check 'POST /backups/:id/restore -> 200' 200 $rs2.Status
Check 'restore recupera el stream' $nStreams (J $rs2).streams.Count
Check 'restore recupera los camiones' 2 (J $rs2).camiones.Count
Check 'restore recupera las etapas de la orden' 4 ((J $rs2).ordenes | Where-Object { $_.id -eq $ordenId }).etapas.Count
Check 'restore de backup inexistente -> 404 (antes daba 500)' 404 (Req POST '/api/backups/bkp-nope/restore').Status
Check 'DELETE backup inexistente -> 404 (antes daba 500)' 404 (Req DELETE '/api/backups/bkp-nope').Status
Check 'restore con id malicioso -> rechazado (400/404)' @(400, 404) (Req POST '/api/backups/..%2F..%2Fetc%2Fpasswd/restore').Status

# ---------- 12. Errores HTTP y seguridad ----------
Check 'ruta de API inexistente -> 404' 404 (Req GET '/api/no-existe').Status
Check 'JSON invalido en el cuerpo -> 400' 400 (Req POST '/api/razones' '{esto no es json').Status
Check 'metodo no permitido en estatico -> 405' 405 (Req POST '/index.html' @{}).Status
Check 'ruta absoluta C:/... -> 404 (no escapa)' 404 (Req GET '/C:/Windows/win.ini').Status
Check 'traversal ../../../.. -> 404 (no escapa)' 404 (Req GET '/../../../../Windows/win.ini').Status
Check 'no se sirve el codigo de servidor (/api/_lib/db.js)' 404 (Req GET '/api/_lib/db.js').Status
Check 'no se sirven las utilidades (/scripts/dev-server.js)' 404 (Req GET '/scripts/dev-server.js').Status
Check 'no se sirve el esquema (/supabase/schema.sql)' 404 (Req GET '/supabase/schema.sql').Status
Check 'no se sirve package.json' 404 (Req GET '/package.json').Status
Check 'no se sirve .env.local' @(404, 403) (Req GET '/.env.local').Status

# ---------- 13. Reset con respaldo automatico ----------
$revPre = (J (Req GET '/api/state')).rev
$antesReset = (J (Req GET '/api/state')).razonesSociales.Count
$rz = Req POST '/api/reset'
Check 'POST /api/reset -> 200' 200 $rz.Status
$st = J $rz
Check 'reset deja todo vacio' 0 ($st.razonesSociales.Count + $st.streams.Count + $st.camiones.Count + $st.consumos.Count + $st.ordenes.Count)
Check 'reset restaura parametros a defaults (40 grados)' 40 $st.parametrosCalculo.gradosTequila "reset NO conserva parametros: vuelve a DEFAULT_CALC"
Check 'reset crea un respaldo automatico antes de vaciar' $true ([bool]$st.autoBackup.id) "id=$($st.autoBackup.id)"
Check 'el respaldo automatico esta marcado como auto' $true ((J (Req GET '/api/backups')).backups | Where-Object { $_.id -eq $st.autoBackup.id }).auto
Check 'el respaldo automatico conserva los datos previos' $antesReset ((J (Req GET '/api/backups')).backups | Where-Object { $_.id -eq $st.autoBackup.id }).counts.razones "razones antes del reset: $antesReset"

# ---------- 14. Aislamiento entre peticiones (persistencia real) ----------
$r2 = Req POST '/api/razones' @{ nombre = 'Persistencia SA'; corto = 'PST' }
Check 'escritura tras el reset (201)' 201 $r2.Status
Check 'el dato se lee de nuevo desde Postgres' 1 (J (Req GET '/api/state')).razonesSociales.Count
$db2 = J (Req GET '/api/db')
Check 'el documento crudo tambien lo tiene' 1 $db2.db.razonesSociales.Count
Check 'la revision avanzo con el reset y la escritura' $true ($db2.rev -gt $revPre) "rev $revPre -> $($db2.rev)"

# ---------- Reporte ----------
Write-Host ''
$script:rows | Format-Table -AutoSize -Wrap
Write-Host ("RESULTADO: {0} PASS / {1} FAIL  (total {2})" -f $script:pass, $script:fail, ($script:pass + $script:fail)) -ForegroundColor $(if ($script:fail) { 'Red' } else { 'Green' })
if ($script:fail) { Write-Host 'FALLOS:' -ForegroundColor Red; $script:rows | Where-Object Test -eq 'FAIL' | Format-List }
exit $script:fail
