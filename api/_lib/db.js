'use strict';
/* ============================================================================
 * Agave Cía · Capa de datos (PostgreSQL / Supabase)
 * ----------------------------------------------------------------------------
 * Responsabilidad: convertir entre el documento de negocio (el objeto `db` que
 * entiende engine.js) y las tablas de Postgres. El motor NO sabe de SQL y esta
 * capa NO sabe de reglas de negocio.
 *
 * Estrategia de escritura: el motor ya validó y dejó el documento consistente,
 * así que cada guardado sincroniza el documento completo dentro de UNA
 * transacción (borra lo que sobra + upsert de lo que hay). Para el volumen de
 * esta app (decenas/cientos de filas) es simple, atómico y suficiente.
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');
const engine = require('../../engine.js');

// date (OID 1082) -> string 'YYYY-MM-DD'  ·  el contrato de la API usa strings,
// no objetos Date (que además se desfasarían por zona horaria).
types.setTypeParser(1082, v => v);
// int8 (OID 20) -> number (count(*), rev, etc.)
types.setTypeParser(20, v => (v === null ? null : Number(v)));

let pool = null;

function sslConfig(url){
  if (process.env.PGSSLMODE === 'disable') return false;
  if (/@(localhost|127\.0\.0\.1|\[::1\])/.test(url)) return false;
  // Supabase y casi cualquier Postgres gestionado exigen TLS.
  return { rejectUnauthorized: false };
}

function getPool(){
  if (pool) return pool;
  const url = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || process.env.POSTGRES_URL;
  if (!url) {
    throw new Error('Falta DATABASE_URL. Copia .env.local.example a .env.local y pega la cadena de conexión de Supabase (Project Settings → Database → Connection string → Pooler / URI).');
  }
  pool = new Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX || 3),
    ssl: sslConfig(url),
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000
  });
  pool.on('error', e => console.error('[pg] error en conexión inactiva:', e.message));
  return pool;
}

function pedir(text, params){ return getPool().query(text, params); }

/* Traduce errores de Postgres a errores de negocio con status HTTP. */
function traducirError(e){
  const code = e && e.code;
  if (code === '23514') return engine.err('Dato inválido: no cumple una regla de la base de datos (' + (e.constraint || '') + ')', 400);
  if (code === '23505') return engine.err('Registro duplicado (' + (e.constraint || '') + ')', 409);
  if (code === '23503') {
    if (/razon_social/i.test(e.constraint || '')) return engine.err('Esa razón social está en uso y no se puede eliminar', 409);
    return engine.err('Referencia inválida: hay registros relacionados (' + (e.constraint || '') + ')', 409);
  }
  if (code === '22P02' || code === '22007' || code === '22008') return engine.err('Formato de dato inválido', 400);
  if (code === '42P01') return engine.err('Falta aplicar el esquema: ejecuta supabase/schema.sql (o `node scripts/apply-schema.js`)', 500);
  return e;
}

/* ============================ mapeo fila -> objeto ============================ */
const n = v => (v === null || v === undefined ? null : Number(v));

function mapSettings(r){
  return {
    gradosTequila: n(r.grados_tequila),
    mermaCausas: { hojas: n(r.merma_hojas), danado: n(r.merma_danado), fibra: n(r.merma_fibra), cortes: n(r.merma_cortes), otros: n(r.merma_otros) }
  };
}
function mapRazon(r){
  return {
    id: r.id, nombre: r.nombre, corto: r.corto, preset: r.preset,
    parametros: {
      coccionPerdida: n(r.coccion_perdida),
      moliendaRendimiento: n(r.molienda_rendimiento),
      conversionMostoAlcohol: n(r.conversion_mosto_alcohol),
      destilacionRendimiento: n(r.destilacion_rendimiento),
      anejamientoPerdida: n(r.anejamiento_perdida)
    }
  };
}
function mapStream(r){
  return { id: r.id, nombre: r.nombre, zona: r.zona, rsId: r.razon_social_id, objetivoT: n(r.objetivo_t), mermaRate: n(r.merma_rate) };
}
function mapCamion(r){
  let ins = null;
  if (r.inspeccion_resultado !== null || r.inspeccion_pct_pina !== null || r.inspeccion_nota !== null){
    ins = {};
    if (r.inspeccion_resultado !== null) ins.resultado = r.inspeccion_resultado;
    if (r.inspeccion_pct_pina !== null) ins.pctPina = n(r.inspeccion_pct_pina);
    if (r.inspeccion_nota !== null) ins.nota = r.inspeccion_nota;
  }
  return {
    id: r.id, streamId: r.stream_id, rsDestinoId: r.rs_destino_id, placa: r.placa,
    pesoBruto: r.peso_bruto === null ? null : Number(r.peso_bruto),
    pesoTara: r.peso_tara === null ? null : Number(r.peso_tara),
    kg: n(r.kg),
    fechaPlaneada: r.fecha_planeada, fechaReal: r.fecha_real,
    inspeccion: ins
  };
}
function mapConsumo(r){
  return { id: r.id, streamId: r.stream_id, rsDestinoId: r.rs_destino_id, fecha: r.fecha, kg: n(r.kg) };
}
function mapEtapa(r){
  const e = { clave: r.clave, fecha: r.fecha };
  if (r.salida_kg !== null && r.salida_kg !== undefined) e.salidaKg = n(r.salida_kg);
  if (r.salida_l !== null && r.salida_l !== undefined) e.salidaL = n(r.salida_l);
  if (r.nota !== null && r.nota !== undefined) e.nota = r.nota;
  return e;
}
function mapOrden(r, etapas){
  const byClave = {};
  (etapas || []).forEach(e => { byClave[e.clave] = e; });
  // Orden canónico de etapas, igual que CLAVES_ETAPA
  const ordenadas = engine.CLAVES_ETAPA.filter(k => byClave[k]).map(k => mapEtapa(byClave[k]));
  return {
    id: r.id, nombre: r.nombre, rsId: r.razon_social_id, estado: r.estado,
    fechaInicio: r.fecha_inicio, fechaFin: r.fecha_fin, agaveKg: n(r.agave_kg),
    tequilaRealL: r.tequila_real_l === null ? null : n(r.tequila_real_l),
    etapas: ordenadas
  };
}

/* ================================== lectura ================================== */
async function loadDb(){
  const c = await getPool().connect();
  try {
    const [set, rs, st, cam, con, ord, eta] = await Promise.all([
      c.query('select * from settings where id = 1'),
      c.query('select * from razones_sociales order by created_at, id'),
      c.query('select * from streams order by created_at, id'),
      c.query('select * from camiones order by fecha_planeada, id'),
      c.query('select * from consumos order by fecha, id'),
      c.query('select * from ordenes order by fecha_inicio, id'),
      c.query('select * from orden_etapas')
    ]);
    const s = set.rows[0];
    const db = engine.hydrate({
      version: engine.SCHEMA_VERSION,
      parametrosCalculo: s ? mapSettings(s) : engine.defaultCalc(),
      razonesSociales: rs.rows.map(mapRazon),
      streams: st.rows.map(mapStream),
      camiones: cam.rows.map(mapCamion),
      consumos: con.rows.map(mapConsumo),
      ordenes: ord.rows.map(r => mapOrden(r, eta.rows.filter(e => e.orden_id === r.id)))
    });
    db.rev = s ? Number(s.rev) : 0;
    db.updatedAt = s && s.updated_at ? new Date(s.updated_at).toISOString() : null;
    return db;
  } finally {
    c.release();
  }
}

async function getRev(){
  const r = await pedir('select rev, updated_at from settings where id = 1');
  const row = r.rows[0];
  return { rev: row ? Number(row.rev) : 0, updatedAt: row && row.updated_at ? new Date(row.updated_at).toISOString() : null };
}

async function health(){
  const r = await pedir('select rev, updated_at, (select count(*) from razones_sociales) as razones, (select count(*) from streams) as streams, (select count(*) from camiones) as camiones from settings where id = 1');
  const row = r.rows[0] || {};
  return { rev: row.rev === undefined ? 0 : Number(row.rev), updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    counts: { razones: Number(row.razones || 0), streams: Number(row.streams || 0), camiones: Number(row.camiones || 0) } };
}

/* ================================== escritura ================================= */
async function prune(c, tabla, columna, ids){
  if (!ids.length) await c.query('delete from ' + tabla);
  else await c.query('delete from ' + tabla + ' where ' + columna + ' <> all($1::text[])', [ids]);
}

async function saveDb(db){
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');

    // 1) parámetros globales + incremento de revisión
    const mc = Object.assign({}, engine.DEFAULT_CALC.mermaCausas, (db.parametrosCalculo || {}).mermaCausas || {});
    const grados = (db.parametrosCalculo || {}).gradosTequila === undefined ? engine.DEFAULT_CALC.gradosTequila : Number(db.parametrosCalculo.gradosTequila);
    const sres = await c.query(
      `insert into settings (id, grados_tequila, merma_hojas, merma_danado, merma_fibra, merma_cortes, merma_otros, rev, updated_at)
       values (1,$1,$2,$3,$4,$5,$6,1, now())
       on conflict (id) do update set
         grados_tequila = excluded.grados_tequila, merma_hojas = excluded.merma_hojas,
         merma_danado = excluded.merma_danado, merma_fibra = excluded.merma_fibra,
         merma_cortes = excluded.merma_cortes, merma_otros = excluded.merma_otros,
         rev = settings.rev + 1, updated_at = now()
       returning rev, updated_at`,
      [grados, mc.hojas, mc.danado, mc.fibra, mc.cortes, mc.otros]
    );
    const rev = Number(sres.rows[0].rev);
    const updatedAt = new Date(sres.rows[0].updated_at).toISOString();

    // 2) borrado de lo que ya no existe (hijos primero, por las claves foráneas)
    const idsOrden = db.ordenes.map(o => o.id);
    const idsConsumo = db.consumos.map(o => o.id);
    const idsCamion = db.camiones.map(o => o.id);
    const idsStream = db.streams.map(o => o.id);
    const idsRazon = db.razonesSociales.map(o => o.id);
    await prune(c, 'orden_etapas', 'orden_id', idsOrden);
    await prune(c, 'ordenes', 'id', idsOrden);
    await prune(c, 'consumos', 'id', idsConsumo);
    await prune(c, 'camiones', 'id', idsCamion);
    await prune(c, 'streams', 'id', idsStream);
    await prune(c, 'razones_sociales', 'id', idsRazon);

    // 3) upsert de lo que hay (padres primero)
    for (const r of db.razonesSociales){
      const p = r.parametros || engine.PRESETS.base;
      await c.query(
        `insert into razones_sociales (id, nombre, corto, coccion_perdida, molienda_rendimiento, conversion_mosto_alcohol, destilacion_rendimiento, anejamiento_perdida, preset, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
         on conflict (id) do update set
           nombre = excluded.nombre, corto = excluded.corto, coccion_perdida = excluded.coccion_perdida,
           molienda_rendimiento = excluded.molienda_rendimiento, conversion_mosto_alcohol = excluded.conversion_mosto_alcohol,
           destilacion_rendimiento = excluded.destilacion_rendimiento, anejamiento_perdida = excluded.anejamiento_perdida,
           preset = excluded.preset, updated_at = now()`,
        [r.id, r.nombre, r.corto, p.coccionPerdida, p.moliendaRendimiento, p.conversionMostoAlcohol, p.destilacionRendimiento, p.anejamientoPerdida, r.preset || 'custom']
      );
    }
    for (const s of db.streams){
      await c.query(
        `insert into streams (id, nombre, zona, razon_social_id, objetivo_t, merma_rate, updated_at)
         values ($1,$2,$3,$4,$5,$6, now())
         on conflict (id) do update set
           nombre = excluded.nombre, zona = excluded.zona, razon_social_id = excluded.razon_social_id,
           objetivo_t = excluded.objetivo_t, merma_rate = excluded.merma_rate, updated_at = now()`,
        [s.id, s.nombre, s.zona || '—', s.rsId, s.objetivoT, s.mermaRate]
      );
    }
    for (const t of db.camiones){
      const i = t.inspeccion || {};
      await c.query(
        `insert into camiones (id, stream_id, rs_destino_id, placa, peso_bruto, peso_tara, kg, fecha_planeada, fecha_real,
                               inspeccion_resultado, inspeccion_pct_pina, inspeccion_nota, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
         on conflict (id) do update set
           stream_id = excluded.stream_id, rs_destino_id = excluded.rs_destino_id, placa = excluded.placa,
           peso_bruto = excluded.peso_bruto, peso_tara = excluded.peso_tara, kg = excluded.kg,
           fecha_planeada = excluded.fecha_planeada, fecha_real = excluded.fecha_real,
           inspeccion_resultado = excluded.inspeccion_resultado, inspeccion_pct_pina = excluded.inspeccion_pct_pina,
           inspeccion_nota = excluded.inspeccion_nota, updated_at = now()`,
        [t.id, t.streamId, t.rsDestinoId || null, t.placa || null,
         t.pesoBruto === undefined ? null : t.pesoBruto, t.pesoTara === undefined ? null : t.pesoTara,
         t.kg, t.fechaPlaneada, t.fechaReal || null,
         i.resultado === undefined ? null : i.resultado,
         i.pctPina === undefined ? null : i.pctPina,
         i.nota === undefined || i.nota === '' ? null : i.nota]
      );
    }
    for (const x of db.consumos){
      await c.query(
        `insert into consumos (id, stream_id, rs_destino_id, fecha, kg, updated_at)
         values ($1,$2,$3,$4,$5, now())
         on conflict (id) do update set
           stream_id = excluded.stream_id, rs_destino_id = excluded.rs_destino_id,
           fecha = excluded.fecha, kg = excluded.kg, updated_at = now()`,
        [x.id, x.streamId, x.rsDestinoId || null, x.fecha, x.kg]
      );
    }
    for (const o of db.ordenes){
      await c.query(
        `insert into ordenes (id, nombre, razon_social_id, estado, fecha_inicio, fecha_fin, agave_kg, tequila_real_l, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8, now())
         on conflict (id) do update set
           nombre = excluded.nombre, razon_social_id = excluded.razon_social_id, estado = excluded.estado,
           fecha_inicio = excluded.fecha_inicio, fecha_fin = excluded.fecha_fin,
           agave_kg = excluded.agave_kg, tequila_real_l = excluded.tequila_real_l, updated_at = now()`,
        [o.id, o.nombre, o.rsId, o.estado || 'planeada', o.fechaInicio, o.fechaFin || null, o.agaveKg,
         o.tequilaRealL === undefined ? null : o.tequilaRealL]
      );
      await c.query('delete from orden_etapas where orden_id = $1', [o.id]);
      for (const e of (o.etapas || [])){
        await c.query(
          `insert into orden_etapas (orden_id, clave, fecha, salida_kg, salida_l, nota)
           values ($1,$2,$3,$4,$5,$6)`,
          [o.id, e.clave, e.fecha || null,
           e.salidaKg === undefined ? null : e.salidaKg,
           e.salidaL === undefined ? null : e.salidaL,
           e.nota === undefined || e.nota === '' ? null : e.nota]
        );
      }
    }

    await c.query('COMMIT');
    return { rev: rev, updatedAt: updatedAt };
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) { /* la conexión ya murió */ }
    throw traducirError(e);
  } finally {
    c.release();
  }
}

/* ================================== respaldos ================================= */
function nuevoIdRespaldo(){
  const d = new Date();
  const p = x => (x < 10 ? '0' + x : '' + x);
  return 'bkp-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '-' + Math.random().toString(36).slice(2, 6);
}

async function createBackup(db, opciones){
  const id = nuevoIdRespaldo();
  const createdAt = new Date().toISOString();
  // El respaldo guarda el documento puro (sin los metadatos de revisión).
  const doc = Object.assign({}, db);
  delete doc.rev; delete doc.updatedAt;
  const payload = { id: id, createdAt: createdAt, auto: !!(opciones && opciones.auto), motivo: (opciones && opciones.motivo) || null, data: doc };
  await pedir('insert into backups (id, payload) values ($1, $2::jsonb)', [id, JSON.stringify(payload)]);
  return { id: id, createdAt: createdAt, auto: payload.auto, motivo: payload.motivo };
}

function contar(b){
  const d = (b && b.data) || {};
  return {
    razones: (d.razonesSociales || []).length, streams: (d.streams || []).length,
    camiones: (d.camiones || []).length, consumos: (d.consumos || []).length,
    ordenes: (d.ordenes || []).length
  };
}

async function listBackups(limite){
  const r = await pedir('select id, created_at, payload from backups order by created_at desc limit $1', [Number(limite || 200)]);
  return r.rows.map(row => {
    const p = row.payload || {};
    return {
      id: row.id,
      createdAt: p.createdAt || new Date(row.created_at).toISOString(),
      file: row.id + '.json',
      auto: !!p.auto,
      motivo: p.motivo || null,
      counts: contar(p)
    };
  });
}

async function restoreBackup(id){
  if (!engine.safeBackupId(id)) throw engine.err('id de respaldo inválido', 400);
  const r = await pedir('select payload from backups where id = $1', [id]);
  if (!r.rows.length) throw engine.err('Respaldo no encontrado', 404);
  const p = r.rows[0].payload;
  if (!p || !p.data || !Array.isArray(p.data.streams)) throw engine.err('Respaldo inválido', 400);
  return engine.hydrate(p.data);
}

async function deleteBackup(id){
  if (!engine.safeBackupId(id)) throw engine.err('id de respaldo inválido', 400);
  const r = await pedir('delete from backups where id = $1', [id]);
  if (!r.rowCount) throw engine.err('Respaldo no encontrado', 404);
}

/* ============================ utilidades de mantenimiento ============================ */
async function applySchema(){
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'schema.sql'), 'utf8');
  const c = await getPool().connect();
  try { await c.query(sql); return true; } finally { c.release(); }
}

async function cerrar(){ if (pool) { const p = pool; pool = null; await p.end(); } }

module.exports = {
  getPool, loadDb, saveDb, getRev, health, applySchema, cerrar, traducirError,
  createBackup, listBackups, restoreBackup, deleteBackup, contar
};
