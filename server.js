'use strict';
// Servidor: API REST CRUD + estáticos. Sin dependencias. Puerto 3053.
// Módulos: recepción (camiones, pesaje, inspección, ticket), producción
// (órdenes), calculadora fine-tunable (parametros, presets), respaldos.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const model = require('./lib/model');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3053;

const store = new model.Store();
store.load();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.csv': 'text/csv; charset=utf-8'
};

function sendJson(res, code, obj){ res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function sendErr(res, code, msg){ sendJson(res, code, { error: msg }); }

function readBody(req){
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6){ req.destroy(); reject(new Error('Cuerpo demasiado grande')); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch(e){ reject(new Error('JSON inválido en el cuerpo')); } });
    req.on('error', reject);
  });
}
function state(){ return model.computeState(store.data); }
function run(res, fn){
  try { const db = fn(store.data); if (db !== store.data) store.save(); sendJson(res, 200, state()); }
  catch (e){ sendErr(res, e.status || 400, e.message || String(e)); }
}
function created(res, fn){
  try { const db = fn(store.data); if (db !== store.data) store.save(); sendJson(res, 201, state()); }
  catch (e){ sendErr(res, e.status || 400, e.message || String(e)); }
}

function csvQ(s){ return '"' + String(s).replace(/"/g, '""') + '"'; }
function exportCsv(res){
  const st = state();
  const rows = [];
  const q = csvQ;
  const n = v => (v === null || v === undefined || v === '') ? '' : (typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : String(v));
  // Sección = línea de título + cabecera + filas + línea en blanco (compatible con Excel)
  const sheet = (title, headers, dataRows) => {
    rows.push('### HOJA: ' + title);
    rows.push(headers.map(q).join(','));
    dataRows.forEach(r => rows.push(r.map(q).join(',')));
    rows.push('');
  };
  const rsById = {};
  st.razonesSociales.forEach(r => { rsById[r.id] = r; });

  // 1) META
  const counts = { razones: st.razonesSociales.length, streams: st.streams.length, camiones: st.camiones.length, consumos: st.consumos.length, ordenes: st.ordenes.length };
  sheet('META', ['clave', 'valor'], [
    ['exportado_en', new Date().toISOString()],
    ['hoy_sistema', st.meta.hoy],
    ['version_base', store.data.version],
    ['total_razones_sociales', counts.razones],
    ['total_streams', counts.streams],
    ['total_camiones', counts.camiones],
    ['total_consumos', counts.consumos],
    ['total_ordenes', counts.ordenes]
  ].map(r => [n(r[0]), n(r[1])]));

  // 2) RESUMEN GENERAL
  const R = st.resumen;
  sheet('RESUMEN GENERAL', ['indicador', 'valor', 'unidad'], [
    ['objetivo_campana', R.objetivoT, 't'],
    ['agave_recibido', R.recibidoT, 't'],
    ['agave_aprovechado', R.aprovechadoT, 't'],
    ['merma', R.mermaT, 't'],
    ['merma_pct_de_recibido', R.recibidoT > 0 ? Math.round(R.mermaT / R.recibidoT * 100) : 0, '%'],
    ['agave_consumido', R.consumidoT, 't'],
    ['tequila_esperado', R.tequilaEsperado, 'L'],
    ['tequila_producido', R.tequilaProducido, 'L'],
    ['pct_recepcion', R.objetivoT > 0 ? Math.round(R.recibidoT / R.objetivoT * 100) : 0, '%'],
    ['pct_consumo', R.aprovechadoT > 0 ? Math.round(R.consumidoT / R.aprovechadoT * 100) : 0, '%']
  ].map(r => [r[0], n(r[1]), r[2]]));

  // 3) RAZONES SOCIALES (con parámetros de cálculo y totales de campaña)
  sheet('RAZONES SOCIALES', [
    'id', 'corto', 'nombre', 'rendimiento_efectivo_Lt', 'preset',
    'param_coccion_pct', 'param_molienda_pct', 'param_conversion_Lkg', 'param_destilacion_pct', 'param_anejamiento_pct',
    'objetivo_t', 'recibido_t', 'merma_t', 'aprovechado_t', 'consumido_t', 'restante_t',
    'tequila_esperado_L', 'tequila_producido_L', 'pct_recepcion', 'pct_consumo', 'status'
  ], st.razonesSociales.map(r => [
    r.id, r.corto, r.nombre, r.rendimientoEfectivo, r.preset,
    r.parametros.coccionPerdida, r.parametros.moliendaRendimiento, r.parametros.conversionMostoAlcohol, r.parametros.destilacionRendimiento, r.parametros.anejamientoPerdida,
    r.totales.objetivoT, r.totales.recibidoT, r.totales.mermaT, r.totales.aprovechadoT, r.totales.consumidoT, r.totales.restanteT,
    r.totales.tequilaEsperado, r.totales.tequilaProducido,
    r.totales.objetivoT > 0 ? Math.round(r.totales.recibidoT / r.totales.objetivoT * 100) : 0,
    r.totales.aprovechadoT > 0 ? Math.round(r.totales.consumidoT / r.totales.aprovechadoT * 100) : 0,
    r.status.text
  ].map(n)));

  // 4) STREAMS (ingreso físico + cálculo + destinos)
  sheet('STREAMS', [
    'id', 'nombre', 'zona', 'razon_social', 'objetivo_t', 'merma_rate', 'recibido_t', 'merma_t', 'merma_efectiva_pct',
    'aprovechado_t', 'consumido_t', 'restante_t', 'rendimiento_Lt', 'tequila_esperado_L', 'tequila_producido_L',
    'camiones_recibidos', 'camiones_planeados', 'destinos'
  ], st.streams.map(s => {
    const rs = rsById[s.rsId];
    const dest = Object.keys(s.destinos || {}).map(k => (k + ':' + Math.round((s.destinos[k] || 0) / 1000) + 't')).join('; ') || '';
    return [
      s.id, s.nombre, s.zona, rs ? rs.corto : '', s.objetivoT, s.mermaRate, s.recibidoT, s.mermaT, s.mermaEfectivaPct,
      s.aprovechadoT, s.consumidoT, s.restanteT, s.rendimientoLt, s.tequilaEsperado, s.tequilaProducido,
      s.camionesRecibidos, s.camionesPlaneados, dest
    ].map(n);
  }));

  // 5) CAMIONES (recepción: pesaje, inspección, destino)
  sheet('CAMIONES', [
    'id', 'stream', 'zona', 'razon_social_default', 'razon_social_destino', 'derivado',
    'placa', 'peso_neto_kg', 'peso_bruto_kg', 'peso_tara_kg',
    'fecha_planeada', 'fecha_real', 'dias_retraso', 'estado', 'inspeccion_resultado', 'pct_pina', 'nota'
  ], st.camiones.map(t => {
    const s = st.streams.find(x => x.id === t.streamId);
    const dflt = s ? rsById[s.rsId] : null;
    const destRs = rsById[t.rsDestinoId || (s ? s.rsId : '')];
    const ins = t.inspeccion || {};
    return [
      t.id, s ? s.nombre : '', s ? s.zona : '', dflt ? dflt.corto : '', destRs ? destRs.corto : '', t.rsDestinoId && t.rsDestinoId !== s.rsId ? 'SI' : 'NO',
      t.placa || '', t.kg, t.pesoBruto, t.pesoTara,
      t.fechaPlaneada, t.fechaReal || '', t.diasRetraso, t.estado, ins.resultado || '', ins.pctPina, ins.nota || ''
    ].map(n);
  }));

  // 6) CONSUMOS (agave a producción)
  sheet('CONSUMOS', ['id', 'fecha', 'stream', 'razon_social_destino', 'kg', 'tequila_equivalente_L'], st.consumos.map(c => {
    const s = st.streams.find(x => x.id === c.streamId);
    const destRs = rsById[c.rsDestinoId || (s ? s.rsId : '')];
    const litros = destRs ? Math.round((c.kg / 1000) * destRs.rendimientoEfectivo) : '';
    return [c.id, c.fecha, s ? s.nombre : '', destRs ? destRs.corto : '', c.kg, litros].map(n);
  }));

  // 7) ÓRDENES DE PRODUCCIÓN (con resultados reales por etapa)
  sheet('ORDENES', [
    'id', 'nombre', 'razon_social', 'estado', 'fecha_inicio', 'fecha_fin', 'agave_kg',
    'tequila_esperado_L', 'tequila_real_L', 'rendimiento_real_Lt', 'eficiencia_pct',
    'etapa_coccion_kg', 'etapa_molienda_kg', 'etapa_fermentacion_L', 'etapa_destilacion_L'
  ], st.ordenes.map(o => {
    const get = k => { const e = (o.etapas || []).find(x => x.clave === k); return e ? (e.salidaL !== undefined ? e.salidaL : e.salidaKg) : ''; };
    return [
      o.id, o.nombre, o.rsNombre, o.estado, o.fechaInicio, o.fechaFin || '', o.agaveKg,
      o.tequilaEsperadoL, o.tequilaRealL, o.rendimientoRealLt, o.eficiencia,
      get('coccion'), get('molienda'), get('fermentacion'), get('destilacion')
    ].map(n);
  }));

  // 8) PARÁMETROS GLOBALES DE CÁLCULO
  const mc = st.parametrosCalculo.mermaCausas;
  sheet('PARAMETROS', ['clave', 'valor', 'unidad'], [
    ['grados_tequila_abv', st.parametrosCalculo.gradosTequila, '% ABV'],
    ['merma_causa_hojas', mc.hojas, '%'],
    ['merma_causa_corazon_danado', mc.danado, '%'],
    ['merma_causa_fibra', mc.fibra, '%'],
    ['merma_causa_cortes', mc.cortes, '%'],
    ['merma_causa_otros', mc.otros, '%']
  ].map(r => [r[0], n(r[1]), r[2]]));

  const csv = '\ufeff' + rows.join('\r\n');
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="agave-export-completo.csv"' });
  res.end(csv);
}

function escHtml(s){ return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function(ch){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]; }); }
function ticketHtml(id){
  const st = state();
  const t = st.camiones.find(x => x.id === id);
  if (!t) return null;
  const s = st.streams.find(x => x.id === t.streamId);
  const rs = s ? st.razonesSociales.find(x => x.id === s.rsId) : null;
  const fecha = t.fechaReal ? new Date(t.fechaReal + 'T00:00:00').toLocaleDateString('es-MX', { weekday:'long', day:'numeric', month:'long', year:'numeric' }) : '—';
  const ins = t.inspeccion || {};
  const insLabel = ins.resultado === 'rechazado' ? 'RECHAZADO' : (ins.resultado === 'parcial' ? 'PARCIAL' : (ins.resultado === 'aceptado' ? 'ACEPTADO' : 'SIN INSPECCIÓN'));
  const pct = ins.pctPina !== undefined && ins.pctPina !== null ? ins.pctPina + ' %' : '—';
  return '<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Remisión de recepción ' + escHtml(t.id) + '</title>' +
    '<style>body{font-family:system-ui,Arial,sans-serif;color:#1c2820;margin:32px;max-width:720px;margin-inline:auto}.h{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #1F6A44;padding-bottom:12px}.h h1{margin:0;font-size:22px}.h .f{font-size:13px;color:#46544A}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:20px}.b{background:#F4F1E8;border:1px solid #DED7C6;border-radius:10px;padding:12px 14px}.b small{display:block;color:#6B766D;font-size:11px;text-transform:uppercase;letter-spacing:.05em}.b b{font-size:16px}.big{font-size:26px}.warn{color:#B84A2E}.ok{color:#1F6A44}table{width:100%;border-collapse:collapse;margin-top:24px;font-size:14px}th,td{border:1px solid #DED7C6;padding:8px 10px;text-align:left}th{background:#EDE8DA}.firmas{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:60px}.firma{border-top:1px solid #1c2820;padding-top:6px;font-size:12px;color:#46544A}button{position:fixed;right:20px;top:20px;padding:10px 16px;border:0;border-radius:8px;background:#1F6A44;color:#fff;font-size:14px;cursor:pointer}@media print{button{display:none}}</style></head><body>' +
    '<button onclick="window.print()">Imprimir</button>' +
    '<div class="h"><div><h1>Agave Cía · Remisión de recepción</h1><div class="f">Folio: <b>' + escHtml(t.id) + '</b></div></div><div class="f">Fecha de recepción:<br><b>' + escHtml(fecha) + '</b></div></div>' +
    '<table>' +
      '<tr><th>Proveedor / Stream</th><td>' + escHtml(s ? s.nombre : '—') + ' · ' + escHtml(s ? s.zona : '') + '</td></tr>' +
      '<tr><th>Razón social (destino)</th><td>' + escHtml((t.rsDestinoId ? st.razonesSociales.find(function(x){ return x.id === t.rsDestinoId; }) : rs) ? ((t.rsDestinoId ? st.razonesSociales.find(function(x){ return x.id === t.rsDestinoId; }) : rs).nombre) : '—') + (rs && t.rsDestinoId && t.rsDestinoId !== s.rsId ? ' <small>(stream → ' + escHtml(rs.corto) + ')</small>' : '') + '</td></tr>' +
      '<tr><th>Placa</th><td>' + escHtml(t.placa || '—') + '</td></tr>' +
      '<tr><th>Fecha planeada</th><td>' + escHtml(t.fechaPlaneada || '—') + '</td></tr>' +
      '<tr><th>Inspección de calidad</th><td class="' + (ins.resultado === 'rechazado' ? 'warn' : 'ok') + '"><b>' + escHtml(insLabel) + '</b> · Piña útil: ' + escHtml(pct) + (ins.nota ? ' · Nota: ' + escHtml(ins.nota) : '') + '</td></tr>' +
    '</table>' +
    '<div class="grid">' +
      '<div class="b"><small>Peso bruto</small><b>' + (t.pesoBruto !== null && t.pesoBruto !== undefined ? escHtml(t.pesoBruto.toLocaleString('es-MX')) + ' kg' : '—') + '</b></div>' +
      '<div class="b"><small>Peso tara</small><b>' + (t.pesoTara !== null && t.pesoTara !== undefined ? escHtml(t.pesoTara.toLocaleString('es-MX')) + ' kg' : '—') + '</b></div>' +
      '<div class="b" style="grid-column:1/-1"><small>Peso neto (agave recibido)</small><b class="big">' + escHtml(t.kg.toLocaleString('es-MX')) + ' kg</b></div>' +
    '</div>' +
    '<div class="firmas"><div class="firma">Recibió (recepción de materia prima)</div><div class="firma">Entregó (transportista)</div></div>' +
    '</body></html>';
}

async function handleApi(req, res, method, pathname, params){
  try {
    if (pathname === '/api/health' && method === 'GET') return sendJson(res, 200, { ok: true, servicio: 'agave-dashboard-backend', version: store.data.version, hoy: store.data.meta.hoy });
    if (pathname === '/api/state' && method === 'GET') return sendJson(res, 200, state());
    if (pathname === '/api/camiones' && method === 'GET'){
      let list = state().camiones;
      const est = params.get('estado'); if (est) list = list.filter(t => t.estado === est);
      const stream = params.get('stream'); if (stream) list = list.filter(t => t.streamId === stream);
      return sendJson(res, 200, { camiones: list, total: list.length });
    }

    // PATCH /api/parametros  (parámetros globales: grados, merma por causa)
    if (pathname === '/api/parametros' && method === 'PATCH'){
      const body = await readBody(req);
      return run(res, db => model.updateParametrosCalculo(db, body));
    }

    // Razones sociales
    if (pathname === '/api/razones' && method === 'POST'){ const body = await readBody(req); return created(res, db => model.addRazonSocial(db, body)); }
    let m = pathname.match(/^\/api\/razones\/([A-Za-z0-9_-]+)$/);
    if (m && method === 'PATCH'){ const body = await readBody(req); return run(res, db => model.updateRazonSocial(db, m[1], body)); }
    if (m && method === 'DELETE') return run(res, db => model.deleteRazonSocial(db, m[1]));
    // POST /api/razones/:id/presets/:nombre
    m = pathname.match(/^\/api\/razones\/([A-Za-z0-9_-]+)\/presets\/([A-Za-z0-9_-]+)$/);
    if (m && method === 'POST') return run(res, db => model.applyPreset(db, m[1], m[2]));

    // Streams
    if (pathname === '/api/streams' && method === 'POST'){ const body = await readBody(req); return created(res, db => model.addStream(db, body)); }
    m = pathname.match(/^\/api\/streams\/([A-Za-z0-9_-]+)$/);
    if (m && method === 'PATCH'){ const body = await readBody(req); return run(res, db => model.updateStream(db, m[1], body)); }
    if (m && method === 'DELETE') return run(res, db => model.deleteStream(db, m[1]));
    m = pathname.match(/^\/api\/streams\/([A-Za-z0-9_-]+)\/consumo$/);
    if (m && method === 'POST'){ const body = await readBody(req); return created(res, db => model.addConsumo(db, m[1], body)); }

    // Camiones
    if (pathname === '/api/camiones' && method === 'POST'){ const body = await readBody(req); return created(res, db => model.addCamion(db, body)); }
    m = pathname.match(/^\/api\/camiones\/([A-Za-z0-9_-]+)\/recibir$/);
    if (m && method === 'POST'){ const body = await readBody(req); return run(res, db => model.recibirCamion(db, m[1], body)); }
    // GET /api/camiones/:id/ticket
    m = pathname.match(/^\/api\/camiones\/([A-Za-z0-9_-]+)\/ticket$/);
    if (m && method === 'GET'){
      const html = ticketHtml(m[1]);
      if (!html){ sendErr(res, 404, 'Camión no encontrado'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    m = pathname.match(/^\/api\/camiones\/([A-Za-z0-9_-]+)$/);
    if (m && method === 'PATCH'){ const body = await readBody(req); return run(res, db => model.updateCamion(db, m[1], body)); }
    if (m && method === 'DELETE') return run(res, db => model.deleteCamion(db, m[1]));

    // Consumos
    m = pathname.match(/^\/api\/consumos\/([A-Za-z0-9_-]+)$/);
    if (m && method === 'DELETE') return run(res, db => model.deleteConsumo(db, m[1]));

    // Órdenes de producción
    if (pathname === '/api/ordenes' && method === 'POST'){ const body = await readBody(req); return created(res, db => model.addOrden(db, body)); }
    m = pathname.match(/^\/api\/ordenes\/([A-Za-z0-9_-]+)$/);
    if (m && method === 'PATCH'){ const body = await readBody(req); return run(res, db => model.updateOrden(db, m[1], body)); }
    if (m && method === 'DELETE') return run(res, db => model.deleteOrden(db, m[1]));

    // Respaldos
    if (pathname === '/api/backup' && method === 'POST'){ const b = model.createBackup(store.data); return sendJson(res, 201, { backup: b, backups: model.listBackups() }); }
    if (pathname === '/api/backups' && method === 'GET') return sendJson(res, 200, { backups: model.listBackups() });
    let bm = pathname.match(/^\/api\/backups\/([A-Za-z0-9_-]+)\/restore$/);
    if (bm && method === 'POST'){ store.data = model.restoreBackup(bm[1]); store.save(); return sendJson(res, 200, state()); }
    bm = pathname.match(/^\/api\/backups\/([A-Za-z0-9_-]+)$/);
    if (bm && method === 'DELETE'){ model.deleteBackup(bm[1]); return sendJson(res, 200, { ok: true, backups: model.listBackups() }); }

    if (pathname === '/api/reset' && method === 'POST'){ store.reset(); return sendJson(res, 200, state()); }
    if (pathname === '/api/export.csv' && method === 'GET') return exportCsv(res);

    return sendErr(res, 404, 'Ruta de API no encontrada: ' + method + ' ' + pathname);
  } catch (e){
    if (e && e.message && /JSON/.test(e.message)) return sendErr(res, 400, e.message);
    return sendErr(res, 500, 'Error interno: ' + (e && e.message ? e.message : String(e)));
  }
}

/* ---------- Estáticos ---------- */
function serveStatic(pathname, res){
  let urlPath = decodeURIComponent(pathname || '/');
  if (urlPath === '/') urlPath = '/index.html';
  const safe = path.normalize(urlPath).replace(/^([./\\])+/, '');
  const filePath = path.join(ROOT, safe);
  if (!filePath.startsWith(ROOT)){ res.writeHead(403); res.end('403'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err){ res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<h1>404</h1><p>No encontrado: ' + urlPath + '</p>'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const method = (req.method || 'GET').toUpperCase();
  if (u.pathname.startsWith('/api/')){ handleApi(req, res, method, u.pathname, u.searchParams).catch(e => sendErr(res, 500, 'Error interno')); return; }
  if (method !== 'GET' && method !== 'HEAD'){ sendErr(res, 405, 'Método no permitido'); return; }
  serveStatic(u.pathname, res);
});

function openBrowser(url){
  const cmd = process.platform === 'win32' ? 'start "" "' + url + '"' : process.platform === 'darwin' ? 'open "' + url + '"' : 'xdg-open "' + url + '"';
  exec(cmd, () => {});
}
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE'){ console.log('El dashboard ya está corriendo en el puerto ' + PORT + '.'); if (!process.env.NO_BROWSER) openBrowser('http://localhost:' + PORT + '/'); }
  else { console.error(e); process.exit(1); }
});
server.listen(PORT, () => {
  const url = 'http://localhost:' + PORT + '/';
  console.log('');
  console.log('  Agave Cia - Recepción + Producción E2E + Calculadora');
  console.log('  API: ' + url + 'api/state');
  console.log('  UI:  ' + url);
  console.log('  Datos: ' + model.DB_FILE);
  console.log('  Detener: Ctrl+C');
  console.log('');
  if (!process.env.NO_BROWSER) openBrowser(url);
});
