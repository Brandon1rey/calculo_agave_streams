'use strict';
/* ============================================================================
 * Agave Cía · Motor de cálculo y reglas de negocio (PURO, sin I/O).
 * ----------------------------------------------------------------------------
 * Este archivo es la ÚNICA fuente de verdad del negocio y se usa en dos
 * entornos:
 *   - Node (servidor local y funciones de Vercel) vía require('./engine.js')
 *   - Navegador (modo sin conexión) vía <script src="/engine.js">
 * Por eso no puede usar fs/path ni APIs exclusivas de Node.
 *
 * Cubre: recepción de materia prima (pesaje, inspección), producción E2E
 * (órdenes con control de rendimiento por etapa) y la calculadora
 * fine-tunable (cascada de rendimiento, presets, merma por causa).
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgaveEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const SCHEMA_VERSION = 4;

  /* ================= utilidades ================= */
  function round1(x){ return Math.round(x * 10) / 10; }
  function round2(x){ return Math.round(x * 100) / 100; }
  function pad(n){ return n < 10 ? '0' + n : '' + n; }
  function todayStr(d){ const x = d || new Date(); return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate()); }
  function isDate(s){ return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
  function uid(p){ return p + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }
  function parseNum(v){ const n = Number(v); return isFinite(n) ? n : NaN; }
  function err(msg, status){ const e = new Error(msg); e.status = status || 400; return e; }
  function clone(o){ return JSON.parse(JSON.stringify(o)); }

  /* ================= Parámetros de cálculo (fine-tuning) ================= */
  const DEFAULT_CALC = { gradosTequila: 40, mermaCausas: { hojas: 51, danado: 20.5, fibra: 12, cortes: 9.1, otros: 7.4 } };

  const PRESETS = {
    base:        { coccionPerdida: 8,  moliendaRendimiento: 60, conversionMostoAlcohol: 0.16, destilacionRendimiento: 70, anejamientoPerdida: 2 },
    optimista:   { coccionPerdida: 7,  moliendaRendimiento: 64, conversionMostoAlcohol: 0.17, destilacionRendimiento: 74, anejamientoPerdida: 1.5 },
    conservador: { coccionPerdida: 10, moliendaRendimiento: 55, conversionMostoAlcohol: 0.15, destilacionRendimiento: 64, anejamientoPerdida: 3 }
  };

  const MERMA_CLAVES = ['hojas', 'danado', 'fibra', 'cortes', 'otros'];
  const CLAVES_ETAPA = ['coccion', 'molienda', 'fermentacion', 'destilacion'];

  function defaultCalc(){ return clone(DEFAULT_CALC); }

  function validarParametros(p){
    const out = {};
    const num = (v, def, min, max, msg) => {
      const n = v === undefined ? def : parseNum(v);
      if (!(n >= min && n <= max)) throw err(msg || ('valor fuera de rango: ' + v));
      return n;
    };
    out.coccionPerdida = num(p.coccionPerdida, 8, 0, 50, 'coccionPerdida debe estar entre 0 y 50 (%)');
    out.moliendaRendimiento = num(p.moliendaRendimiento, 60, 0, 100, 'moliendaRendimiento debe estar entre 0 y 100 (%)');
    out.conversionMostoAlcohol = num(p.conversionMostoAlcohol, 0.16, 0, 1, 'conversionMostoAlcohol debe estar entre 0 y 1 (L de alcohol 100% por kg de mosto)');
    out.destilacionRendimiento = num(p.destilacionRendimiento, 70, 0, 100, 'destilacionRendimiento debe estar entre 0 y 100 (%)');
    out.anejamientoPerdida = num(p.anejamientoPerdida, 2, 0, 30, 'anejamientoPerdida debe estar entre 0 y 30 (%)');
    return out;
  }

  function cascadeBreakdown(p, grados, toneladas){
    const k = toneladas * 1000; // kg de agave aprovechado
    const cocida = k * (1 - p.coccionPerdida / 100);
    const mosto = cocida * (p.moliendaRendimiento / 100);
    const alcohol = mosto * p.conversionMostoAlcohol;           // L de alcohol 100%
    const teq100 = alcohol * (p.destilacionRendimiento / 100);  // L tequila 100% (después de cortes)
    const diluido = teq100 / (grados / 100);                    // dilución a grado comercial
    const final = diluido * (1 - p.anejamientoPerdida / 100);
    return [
      { clave: 'aprovechado',  label: 'Agave aprovechado',              valor: round1(k),        unidad: 'kg' },
      { clave: 'coccion',      label: 'Piña cocida (cocción)',          valor: round1(cocida),   unidad: 'kg', parametro: p.coccionPerdida,      paramLabel: 'pérdida %' },
      { clave: 'molienda',     label: 'Jugo extraído (molienda)',       valor: round1(mosto),    unidad: 'kg', parametro: p.moliendaRendimiento,   paramLabel: 'eficiencia %' },
      { clave: 'fermentacion', label: 'Alcohol fermentado',             valor: round2(alcohol),  unidad: 'L 100%', parametro: p.conversionMostoAlcohol, paramLabel: 'L/kg' },
      { clave: 'destilacion',  label: 'Tequila 100% (cortes)',          valor: round2(teq100),   unidad: 'L 100%', parametro: p.destilacionRendimiento, paramLabel: 'rendimiento %' },
      { clave: 'dilucion',     label: 'Dilución a ' + grados + '°',     valor: round1(diluido),  unidad: 'L' },
      { clave: 'anejamiento',  label: 'Tequila final',                  valor: round1(final),    unidad: 'L', parametro: p.anejamientoPerdida,   paramLabel: 'pérdida %' }
    ];
  }
  function cascadeLPerTon(p, grados){ return round2(cascadeBreakdown(p, grados, 1)[6].valor); }

  function emptyDb(){
    return {
      version: SCHEMA_VERSION,
      meta: { hoy: todayStr() },
      parametrosCalculo: defaultCalc(),
      razonesSociales: [], streams: [], camiones: [], consumos: [], ordenes: []
    };
  }

  /* Normaliza un documento venido de la base de datos: rellena lo que falte.
     Equivale a la migración que hacía Store.load() sobre data/db.json. */
  function hydrate(db){
    const d = db && typeof db === 'object' ? db : {};
    d.version = SCHEMA_VERSION;
    d.meta = d.meta || {};
    d.meta.hoy = todayStr();
    const calc = d.parametrosCalculo || {};
    d.parametrosCalculo = {
      gradosTequila: calc.gradosTequila === undefined ? DEFAULT_CALC.gradosTequila : Number(calc.gradosTequila),
      mermaCausas: Object.assign(clone(DEFAULT_CALC.mermaCausas), calc.mermaCausas || {})
    };
    d.razonesSociales = (d.razonesSociales || []).map(r => Object.assign({}, r, {
      parametros: Object.assign({}, PRESETS.base, r.parametros || {}),
      preset: r.preset || 'custom'
    }));
    d.streams = d.streams || [];
    d.camiones = d.camiones || [];
    d.consumos = d.consumos || [];
    d.ordenes = d.ordenes || [];
    return d;
  }

  /* ================= CRUD (lanza Error con .status) ================= */

  // --- Parámetros globales ---
  function updateParametrosCalculo(db, body){
    if (body.gradosTequila !== undefined){ const v = parseNum(body.gradosTequila); if (!(v >= 20 && v <= 60)) throw err('gradosTequila debe estar entre 20 y 60'); db.parametrosCalculo.gradosTequila = v; }
    if (body.mermaCausas !== undefined){
      const mc = body.mermaCausas;
      const out = {};
      let suma = 0;
      MERMA_CLAVES.forEach(c => { const v = parseNum(mc[c]); if (!(v >= 0 && v <= 100)) throw err('mermaCausas.' + c + ' debe estar entre 0 y 100'); out[c] = v; suma += v; });
      if (suma <= 0 || Math.abs(suma - 100) > 0.5) throw err('las causas de merma deben sumar 100% (suma actual: ' + Math.round(suma) + '%)');
      db.parametrosCalculo.mermaCausas = out;
    }
    return db;
  }

  // --- Razones sociales ---
  function addRazonSocial(db, body){
    const nombre = String(body.nombre || '').trim();
    const corto = String(body.corto || '').trim();
    if (!nombre) throw err('nombre es requerido');
    if (!corto) throw err('nombre corto es requerido');
    const parametros = validarParametros(body.parametros || {});
    db.razonesSociales.push({ id: uid('rs'), nombre, corto, parametros, preset: 'custom' });
    return db;
  }
  function updateRazonSocial(db, id, body){
    const r = db.razonesSociales.find(x => x.id === id);
    if (!r) throw err('Razón social no encontrada', 404);
    if (body.nombre !== undefined){ const v = String(body.nombre).trim(); if (!v) throw err('nombre es requerido'); r.nombre = v; }
    if (body.corto !== undefined){ const v = String(body.corto).trim(); if (!v) throw err('nombre corto es requerido'); r.corto = v; }
    if (body.parametros !== undefined){ r.parametros = validarParametros(Object.assign({}, r.parametros, body.parametros)); r.preset = body.preset || 'custom'; }
    return db;
  }
  function deleteRazonSocial(db, id){
    const idx = db.razonesSociales.findIndex(x => x.id === id);
    if (idx < 0) throw err('Razón social no encontrada', 404);
    if (db.streams.some(s => s.rsId === id)) throw err('No se puede eliminar: hay streams asignados a esta razón social', 409);
    if (db.camiones.some(c => c.rsDestinoId === id)) throw err('No se puede eliminar: hay camiones que tienen esta razón social como destino', 409);
    if (db.consumos.some(c => c.rsDestinoId === id)) throw err('No se puede eliminar: hay consumos que tienen esta razón social como destino', 409);
    db.razonesSociales.splice(idx, 1);
    return db;
  }
  function applyPreset(db, id, nombre){
    if (!PRESETS[nombre]) throw err('Preset no encontrado: ' + nombre, 404);
    const r = db.razonesSociales.find(x => x.id === id);
    if (!r) throw err('Razón social no encontrada', 404);
    r.parametros = clone(PRESETS[nombre]);
    r.preset = nombre;
    return db;
  }

  // --- Streams ---
  function addStream(db, body){
    const nombre = String(body.nombre || '').trim();
    const zona = String(body.zona || '').trim();
    const rsId = String(body.rsId || '');
    const objetivoT = parseNum(body.objetivoT);
    const mermaRate = body.mermaRate === undefined ? 0.10 : parseNum(body.mermaRate);
    if (!nombre) throw err('nombre es requerido');
    if (!db.razonesSociales.some(r => r.id === rsId)) throw err('razón social inválida');
    if (!(objetivoT > 0)) throw err('objetivo de la campaña debe ser mayor a 0 (t)');
    if (!(mermaRate >= 0 && mermaRate < 1)) throw err('tasa de merma debe estar entre 0 y 0.99');
    db.streams.push({ id: uid('s'), nombre, rsId, zona: zona || '—', objetivoT: round1(objetivoT), mermaRate: Math.round(mermaRate * 1000) / 1000 });
    return db;
  }
  function updateStream(db, id, body){
    const s = db.streams.find(x => x.id === id);
    if (!s) throw err('Stream no encontrado', 404);
    if (body.nombre !== undefined){ const v = String(body.nombre).trim(); if (!v) throw err('nombre es requerido'); s.nombre = v; }
    if (body.zona !== undefined) s.zona = String(body.zona).trim() || '—';
    if (body.rsId !== undefined){ if (!db.razonesSociales.some(r => r.id === body.rsId)) throw err('razón social inválida'); s.rsId = body.rsId; }
    if (body.objetivoT !== undefined){ const v = parseNum(body.objetivoT); if (!(v > 0)) throw err('objetivo debe ser mayor a 0'); s.objetivoT = round1(v); }
    if (body.mermaRate !== undefined){ const v = parseNum(body.mermaRate); if (!(v >= 0 && v < 1)) throw err('tasa de merma entre 0 y 0.99'); s.mermaRate = Math.round(v * 1000) / 1000; }
    return db;
  }
  function deleteStream(db, id){
    const idx = db.streams.findIndex(x => x.id === id);
    if (idx < 0) throw err('Stream no encontrado', 404);
    db.camiones = db.camiones.filter(c => c.streamId !== id);
    db.consumos = db.consumos.filter(c => c.streamId !== id);
    db.streams.splice(idx, 1);
    return db;
  }

  // --- Camiones (recepción: pesaje + inspección de calidad) ---
  function validarInspeccion(ins){
    if (ins === undefined || ins === null) return null;
    const out = {};
    if (ins.resultado !== undefined){ if (['aceptado', 'rechazado', 'parcial'].indexOf(ins.resultado) < 0) throw err('resultado de inspección inválido'); out.resultado = ins.resultado; }
    if (ins.pctPina !== undefined){ const v = parseNum(ins.pctPina); if (!(v >= 0 && v <= 100)) throw err('pctPina debe estar entre 0 y 100'); out.pctPina = v; }
    if (ins.nota !== undefined) out.nota = String(ins.nota).trim();
    return out;
  }
  function addCamion(db, body){
    const streamId = String(body.streamId || '');
    const kg = parseNum(body.kg);
    const fechaPlaneada = String(body.fechaPlaneada || '');
    const fechaReal = body.fechaReal ? String(body.fechaReal) : null;
    if (!db.streams.some(s => s.id === streamId)) throw err('stream inválido');
    if (!isDate(fechaPlaneada)) throw err('fechaPlaneada requerida (YYYY-MM-DD)');
    if (fechaReal && !isDate(fechaReal)) throw err('fechaReal inválida (YYYY-MM-DD)');
    let neto = kg;
    if (body.pesoBruto !== undefined || body.pesoTara !== undefined){
      const bruto = parseNum(body.pesoBruto), tara = parseNum(body.pesoTara);
      if (!(bruto > 0) || !(tara >= 0) || bruto <= tara) throw err('pesoBruto debe ser mayor que pesoTara');
      neto = bruto - tara;
    }
    if (!(neto >= 100)) throw err('peso neto debe ser >= 100 kg');
    if (body.rsDestinoId !== undefined && body.rsDestinoId !== null && !db.razonesSociales.some(r => r.id === body.rsDestinoId)) throw err('razón social destino inválida');
    db.camiones.push({
      id: uid('t'), streamId,
      rsDestinoId: body.rsDestinoId || null,
      placa: String(body.placa || '').toUpperCase().trim() || null,
      pesoBruto: body.pesoBruto !== undefined ? Math.round(parseNum(body.pesoBruto)) : null,
      pesoTara: body.pesoTara !== undefined ? Math.round(parseNum(body.pesoTara)) : null,
      kg: Math.round(neto),
      fechaPlaneada, fechaReal,
      inspeccion: validarInspeccion(body.inspeccion)
    });
    return db;
  }
  function updateCamion(db, id, body){
    const t = db.camiones.find(x => x.id === id);
    if (!t) throw err('Camión no encontrado', 404);
    if (body.streamId !== undefined){ if (!db.streams.some(s => s.id === body.streamId)) throw err('stream inválido'); t.streamId = body.streamId; }
    if (body.rsDestinoId !== undefined){ if (body.rsDestinoId !== null && !db.razonesSociales.some(r => r.id === body.rsDestinoId)) throw err('razón social destino inválida'); t.rsDestinoId = body.rsDestinoId || null; }
    if (body.placa !== undefined) t.placa = String(body.placa).toUpperCase().trim() || null;
    if (body.kg !== undefined){ const v = parseNum(body.kg); if (!(v >= 100)) throw err('kg debe ser >= 100'); t.kg = Math.round(v); }
    if (body.pesoBruto !== undefined) t.pesoBruto = Math.round(parseNum(body.pesoBruto)) || null;
    if (body.pesoTara !== undefined) t.pesoTara = Math.round(parseNum(body.pesoTara)) || null;
    if (body.fechaPlaneada !== undefined){ if (!isDate(body.fechaPlaneada)) throw err('fechaPlaneada inválida'); t.fechaPlaneada = body.fechaPlaneada; }
    if (body.fechaReal !== undefined){ if (body.fechaReal !== null && !isDate(body.fechaReal)) throw err('fechaReal inválida'); t.fechaReal = body.fechaReal || null; }
    if (body.inspeccion !== undefined) t.inspeccion = validarInspeccion(body.inspeccion);
    return db;
  }
  function deleteCamion(db, id){
    const idx = db.camiones.findIndex(x => x.id === id);
    if (idx < 0) throw err('Camión no encontrado', 404);
    db.camiones.splice(idx, 1);
    return db;
  }
  function recibirCamion(db, id, body){
    const t = db.camiones.find(x => x.id === id);
    if (!t) throw err('Camión no encontrado', 404);
    const fechaReal = String(body.fechaReal || '');
    if (!isDate(fechaReal)) throw err('fechaReal requerida (YYYY-MM-DD)');
    t.fechaReal = fechaReal;
    if (body.rsDestinoId !== undefined){ if (body.rsDestinoId !== null && !db.razonesSociales.some(r => r.id === body.rsDestinoId)) throw err('razón social destino inválida'); t.rsDestinoId = body.rsDestinoId || null; }
    if (body.kg !== undefined){ const v = parseNum(body.kg); if (v >= 100) t.kg = Math.round(v); }
    if (body.pesoBruto !== undefined) t.pesoBruto = Math.round(parseNum(body.pesoBruto)) || null;
    if (body.pesoTara !== undefined) t.pesoTara = Math.round(parseNum(body.pesoTara)) || null;
    if (body.inspeccion !== undefined) t.inspeccion = validarInspeccion(body.inspeccion);
    return db;
  }

  // --- Consumos ---
  function addConsumo(db, streamId, body){
    if (!db.streams.some(s => s.id === streamId)) throw err('stream inválido', 404);
    const kg = parseNum(body.kg);
    const fecha = String(body.fecha || '');
    if (!(kg >= 100)) throw err('kg debe ser >= 100');
    if (!isDate(fecha)) throw err('fecha requerida (YYYY-MM-DD)');
    if (body.rsDestinoId !== undefined && body.rsDestinoId !== null && !db.razonesSociales.some(r => r.id === body.rsDestinoId)) throw err('razón social destino inválida');
    db.consumos.push({ id: uid('c'), streamId, rsDestinoId: body.rsDestinoId || null, fecha, kg: Math.round(kg) });
    return db;
  }
  function deleteConsumo(db, id){
    const idx = db.consumos.findIndex(x => x.id === id);
    if (idx < 0) throw err('Consumo no encontrado', 404);
    db.consumos.splice(idx, 1);
    return db;
  }

  // --- Órdenes de producción (E2E) ---
  function validarEtapas(etapas){
    if (!Array.isArray(etapas)) return [];
    return etapas.map(e => {
      const out = { clave: String(e.clave || '') };
      if (CLAVES_ETAPA.indexOf(out.clave) < 0) throw err('etapa inválida: ' + out.clave);
      if (e.fecha !== undefined && e.fecha !== null && !isDate(e.fecha)) throw err('fecha de etapa inválida');
      out.fecha = e.fecha || null;
      if (e.salidaKg !== undefined && e.salidaKg !== null){ const v = parseNum(e.salidaKg); if (v < 0) throw err('salidaKg inválida'); out.salidaKg = v; }
      if (e.salidaL !== undefined && e.salidaL !== null){ const v = parseNum(e.salidaL); if (v < 0) throw err('salidaL inválida'); out.salidaL = v; }
      if (e.nota !== undefined) out.nota = String(e.nota).trim();
      return out;
    });
  }
  function addOrden(db, body){
    const nombre = String(body.nombre || '').trim();
    const rsId = String(body.rsId || '');
    const agaveKg = parseNum(body.agaveKg);
    if (!nombre) throw err('nombre es requerido');
    if (!db.razonesSociales.some(r => r.id === rsId)) throw err('razón social inválida');
    if (!(agaveKg >= 100)) throw err('agaveKg debe ser >= 100');
    db.ordenes.push({
      id: uid('o'), nombre, rsId,
      estado: ['planeada', 'en_proceso', 'terminada'].indexOf(body.estado) >= 0 ? body.estado : 'planeada',
      fechaInicio: isDate(body.fechaInicio) ? body.fechaInicio : todayStr(),
      fechaFin: isDate(body.fechaFin) ? body.fechaFin : null,
      agaveKg: Math.round(agaveKg),
      etapas: validarEtapas(body.etapas),
      tequilaRealL: body.tequilaRealL !== undefined && body.tequilaRealL !== null ? parseNum(body.tequilaRealL) : null
    });
    return db;
  }
  function updateOrden(db, id, body){
    const o = db.ordenes.find(x => x.id === id);
    if (!o) throw err('Orden no encontrada', 404);
    if (body.nombre !== undefined){ const v = String(body.nombre).trim(); if (!v) throw err('nombre es requerido'); o.nombre = v; }
    if (body.rsId !== undefined){ if (!db.razonesSociales.some(r => r.id === body.rsId)) throw err('razón social inválida'); o.rsId = body.rsId; }
    if (body.estado !== undefined){ if (['planeada', 'en_proceso', 'terminada'].indexOf(body.estado) < 0) throw err('estado inválido'); o.estado = body.estado; }
    if (body.fechaInicio !== undefined){ if (!isDate(body.fechaInicio)) throw err('fechaInicio inválida'); o.fechaInicio = body.fechaInicio; }
    if (body.fechaFin !== undefined){ if (body.fechaFin !== null && !isDate(body.fechaFin)) throw err('fechaFin inválida'); o.fechaFin = body.fechaFin || null; }
    if (body.agaveKg !== undefined){ const v = parseNum(body.agaveKg); if (!(v >= 100)) throw err('agaveKg debe ser >= 100'); o.agaveKg = Math.round(v); }
    if (body.etapas !== undefined) o.etapas = validarEtapas(body.etapas);
    if (body.tequilaRealL !== undefined){ o.tequilaRealL = (body.tequilaRealL === null || body.tequilaRealL === '') ? null : parseNum(body.tequilaRealL); }
    return db;
  }
  function deleteOrden(db, id){
    const idx = db.ordenes.findIndex(x => x.id === id);
    if (idx < 0) throw err('Orden no encontrada', 404);
    db.ordenes.splice(idx, 1);
    return db;
  }

  /* ================= Estado derivado ================= */
  function estadoCamion(t, hoy){ if (t.fechaReal) return 'recibido'; return t.fechaPlaneada < hoy ? 'atrasado' : 'planeado'; }
  function diasRetraso(t){
    if (!t.fechaReal || !t.fechaPlaneada) return 0;
    return Math.max(0, Math.round((new Date(t.fechaReal + 'T00:00:00') - new Date(t.fechaPlaneada + 'T00:00:00')) / 86400000));
  }

  function computeStream(s, camiones, consumos, rsById, grados){
    const recs = camiones.filter(c => c.streamId === s.id && c.fechaReal);
    const recibidoT = recs.reduce((a, c) => a + c.kg, 0) / 1000;
    let aprovechadoKg = 0, tequilaEsperado = 0;
    const destinos = {};
    recs.forEach(c => {
      const pct = (c.inspeccion && c.inspeccion.pctPina !== undefined && c.inspeccion.pctPina !== null) ? c.inspeccion.pctPina / 100 : (1 - s.mermaRate);
      const apKg = c.kg * pct;
      aprovechadoKg += apKg;
      const did = c.rsDestinoId || s.rsId;
      const dest = rsById[did] || { parametros: PRESETS.base };
      destinos[did] = (destinos[did] || 0) + c.kg;
      tequilaEsperado += (apKg / 1000) * cascadeLPerTon(dest.parametros, grados);
    });
    const aprovechadoT = aprovechadoKg / 1000;
    const mermaT = Math.max(0, recibidoT - aprovechadoT);
    const cs = consumos.filter(c => c.streamId === s.id);
    const consumidoT = cs.reduce((a, c) => a + c.kg, 0) / 1000;
    let tequilaProducido = 0;
    cs.forEach(c => {
      const did = c.rsDestinoId || s.rsId;
      const dest = rsById[did] || { parametros: PRESETS.base };
      tequilaProducido += (c.kg / 1000) * cascadeLPerTon(dest.parametros, grados);
    });
    const restanteT = Math.max(0, s.objetivoT - recibidoT);
    const defRs = rsById[s.rsId];
    const lt = defRs && defRs.parametros ? cascadeLPerTon(defRs.parametros, grados) : 0;
    return Object.assign({}, s, {
      recibidoT: round1(recibidoT),
      mermaT: round1(mermaT),
      aprovechadoT: round1(aprovechadoT),
      mermaEfectivaPct: recibidoT > 0 ? round1(mermaT / recibidoT * 100) : 0,
      consumidoT: round1(consumidoT),
      restanteT: round1(restanteT),
      rendimientoLt: lt,
      tequilaEsperado: Math.round(tequilaEsperado),
      tequilaProducido: Math.round(tequilaProducido),
      pctRecep: s.objetivoT > 0 ? round1(recibidoT / s.objetivoT * 100) : 0,
      pctConsumo: aprovechadoT > 0 ? round1(Math.min(100, consumidoT / aprovechadoT * 100)) : 0,
      camionesRecibidos: recs.length,
      camionesPlaneados: camiones.filter(c => c.streamId === s.id && !c.fechaReal).length,
      destinos: destinos
    });
  }

  function statusCampana(t){
    if (t.aprovechadoT > 0 && t.consumidoT >= t.aprovechadoT * 0.999) return { label: 'Lista', text: 'Campaña completa · agave consumido', cls: 'ok' };
    if (t.recibidoT >= t.objetivoT) return { label: 'En producción', text: 'Todo recibido · produciendo', cls: 'mid' };
    if (t.consumidoT > 0) return { label: 'Recibiendo + produciendo', text: 'Asíncrono', cls: 'mid' };
    return { label: 'Recibiendo', text: 'En recepción', cls: 'info' };
  }

  function computeOrden(o, rs, grados){
    const p = (rs && rs.parametros) ? rs.parametros : PRESETS.base;
    const toneladas = o.agaveKg / 1000;
    const esperado = cascadeBreakdown(p, grados, toneladas);
    const tequilaEsperadoL = esperado[6].valor;
    const real = {};
    (o.etapas || []).forEach(e => { real[e.clave] = e; });
    const tequilaRealL = o.tequilaRealL;
    const rendimientoRealLt = tequilaRealL !== null && tequilaRealL !== undefined && toneladas > 0 ? round2(tequilaRealL / toneladas) : null;
    return Object.assign({}, o, {
      rsNombre: rs ? rs.corto : '—',
      esperado: esperado,
      tequilaEsperadoL: round1(tequilaEsperadoL),
      real: real,
      tequilaRealL: tequilaRealL,
      rendimientoRealLt: rendimientoRealLt,
      eficiencia: tequilaEsperadoL > 0 && tequilaRealL !== null && tequilaRealL !== undefined ? round1(tequilaRealL / tequilaEsperadoL * 100) : null
    });
  }

  function computeState(db){
    const rsById = {};
    db.razonesSociales.forEach(r => { rsById[r.id] = r; });
    const hoy = db.meta.hoy;
    const grados = db.parametrosCalculo.gradosTequila;

    const streamByIdx = {};
    db.streams.forEach(s => { streamByIdx[s.id] = s; });
    const streams = db.streams.map(s => computeStream(s, db.camiones, db.consumos, rsById, grados));

    const razonesSociales = db.razonesSociales.map(r => {
      const ss = streams.filter(s => s.rsId === r.id);
      const objetivoT = round1(ss.reduce((a, s) => a + s.objetivoT, 0));
      // Recepción atribuida por DESTINO: cada ingreso puede derivarse a otra razón social
      let recibidoKg = 0, aprovechadoKg = 0;
      db.camiones.forEach(c => {
        if (!c.fechaReal) return;
        const s = streamByIdx[c.streamId];
        const did = c.rsDestinoId || (s ? s.rsId : null);
        if (did !== r.id) return;
        const mermaRate = s ? s.mermaRate : 0.10;
        const pct = (c.inspeccion && c.inspeccion.pctPina !== undefined && c.inspeccion.pctPina !== null) ? c.inspeccion.pctPina / 100 : (1 - mermaRate);
        recibidoKg += c.kg;
        aprovechadoKg += c.kg * pct;
      });
      const recibidoT = recibidoKg / 1000;
      const aprovechadoT = aprovechadoKg / 1000;
      const mermaT = Math.max(0, recibidoT - aprovechadoT);
      // Consumo atribuido por DESTINO
      const consumidoT = db.consumos.filter(c => (c.rsDestinoId || (streamByIdx[c.streamId] ? streamByIdx[c.streamId].rsId : null)) === r.id).reduce((a, c) => a + c.kg, 0) / 1000;
      const lt = cascadeLPerTon(r.parametros, grados);
      const t = {
        objetivoT: objetivoT,
        recibidoT: round1(recibidoT),
        mermaT: round1(mermaT),
        aprovechadoT: round1(aprovechadoT),
        consumidoT: round1(consumidoT),
        restanteT: round1(Math.max(0, objetivoT - recibidoT)),
        tequilaEsperado: Math.round(aprovechadoT * lt),
        tequilaProducido: Math.round(consumidoT * lt),
        streams: ss.length
      };
      return Object.assign({}, r, {
        rendimientoEfectivo: lt,
        cascade: cascadeBreakdown(r.parametros, grados, 1),
        totales: t,
        status: statusCampana(t)
      });
    });

    const camiones = db.camiones.map(t => Object.assign({}, t, {
      estado: estadoCamion(t, hoy),
      diasRetraso: diasRetraso(t)
    })).sort((a, b) => (b.fechaPlaneada < a.fechaPlaneada ? -1 : 1));

    const ordenes = db.ordenes.map(o => computeOrden(o, rsById[o.rsId], grados)).sort((a, b) => (a.fechaInicio < b.fechaInicio ? 1 : -1));

    const resumen = {
      objetivoT: round1(streams.reduce((a, s) => a + s.objetivoT, 0)),
      recibidoT: round1(streams.reduce((a, s) => a + s.recibidoT, 0)),
      mermaT: round1(streams.reduce((a, s) => a + s.mermaT, 0)),
      aprovechadoT: round1(streams.reduce((a, s) => a + s.aprovechadoT, 0)),
      consumidoT: round1(streams.reduce((a, s) => a + s.consumidoT, 0)),
      tequilaEsperado: streams.reduce((a, s) => a + s.tequilaEsperado, 0),
      tequilaProducido: streams.reduce((a, s) => a + s.tequilaProducido, 0)
    };

    return { meta: db.meta, parametrosCalculo: db.parametrosCalculo, razonesSociales, streams, camiones,
      consumos: db.consumos.slice().sort((a, b) => (b.fecha < a.fecha ? -1 : 1)), ordenes, resumen };
  }

  /* ================= Respaldos (helpers puros) ================= */
  function safeBackupId(id){ return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id); }

  return {
    SCHEMA_VERSION,
    // utilidades
    round1, round2, todayStr, isDate, uid, parseNum, err: err, clone,
    // parámetros y presets
    DEFAULT_CALC, PRESETS, MERMA_CLAVES, CLAVES_ETAPA, defaultCalc, validarParametros,
    cascadeBreakdown, cascadeLPerTon,
    // documento
    emptyDb, hydrate,
    // CRUD
    updateParametrosCalculo,
    addRazonSocial, updateRazonSocial, deleteRazonSocial, applyPreset,
    addStream, updateStream, deleteStream,
    validarInspeccion, addCamion, updateCamion, deleteCamion, recibirCamion,
    addConsumo, deleteConsumo,
    validarEtapas, addOrden, updateOrden, deleteOrden,
    // derivados
    estadoCamion, diasRetraso, computeStream, statusCampana, computeOrden, computeState,
    // respaldos
    safeBackupId
  };
});
