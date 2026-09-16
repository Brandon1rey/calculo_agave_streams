'use strict';
/* Pruebas unitarias del motor de negocio (engine.js).
   No necesitan servidor ni base de datos:  node tests/engine.test.js
   Código de salida = número de fallos (0 = todo pasa). */
const assert = require('assert');
const path = require('path');
const engine = require(path.join(__dirname, '..', 'engine.js'));

let pass = 0, fail = 0;
const filas = [];
function test(nombre, fn){
  try { fn(); pass++; filas.push(['PASS', nombre, '']); }
  catch (e){ fail++; filas.push(['FAIL', nombre, String(e.message || e).split('\n')[0]]); }
}
const TZ_ORIGINAL = process.env.AGAVE_TZ;

/* ------------------------------------------------------------------ */
/* [B] "Hoy" del negocio: no puede depender de la zona del servidor.   */
/* Vercel corre en UTC; la operación es en México (UTC-6).             */
/* ------------------------------------------------------------------ */
test('[B] a las 20:30 de México (02:30 UTC del día siguiente) el hoy es el 15', () => {
  process.env.AGAVE_TZ = 'America/Mexico_City';
  assert.strictEqual(engine.todayStr(new Date('2026-09-16T02:30:00Z')), '2026-09-15');
});
test('[B] el mismo instante en UTC daría el 16 (el bug que se corrigió)', () => {
  process.env.AGAVE_TZ = 'UTC';
  assert.strictEqual(engine.todayStr(new Date('2026-09-16T02:30:00Z')), '2026-09-16');
});
test('[B] sin AGAVE_TZ se usa la zona por defecto de la operación (México)', () => {
  delete process.env.AGAVE_TZ;
  assert.strictEqual(engine.todayStr(new Date('2026-09-16T02:30:00Z')), '2026-09-15');
  process.env.AGAVE_TZ = 'America/Mexico_City';
});
test('[B] una zona inválida no rompe: cae al reloj local', () => {
  process.env.AGAVE_TZ = 'Zona/QueNoExiste';
  const ymd = engine.todayStr(new Date('2026-09-16T02:30:00Z'));
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(ymd), 'debe devolver YYYY-MM-DD, devolvió ' + ymd);
  process.env.AGAVE_TZ = 'America/Mexico_City';
});
test('[B] meta.hoy de un documento hidratado usa esa zona', () => {
  process.env.AGAVE_TZ = 'America/Mexico_City';
  const db = engine.hydrate({});
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(db.meta.hoy));
});

/* ------------------------------------------------------------------ */
/* [C] recibirCamion: coherencia de pesaje (familia del arreglo H7).   */
/* ------------------------------------------------------------------ */
function docConCamion(){
  const db = engine.emptyDb();
  engine.addRazonSocial(db, { nombre: 'RS', corto: 'RS' });
  engine.addStream(db, { nombre: 'S', zona: 'Z', rsId: db.razonesSociales[0].id, objetivoT: 100 });
  engine.addCamion(db, { streamId: db.streams[0].id, pesoBruto: 30000, pesoTara: 12000, fechaPlaneada: '2026-09-10' });
  return db;
}
test('[C] recibir con pesoBruto menor que pesoTara se rechaza con mensaje del motor', () => {
  const db = docConCamion();
  assert.throws(
    () => engine.recibirCamion(db, db.camiones[0].id, { fechaReal: '2026-09-11', pesoBruto: 1000, pesoTara: 12000 }),
    e => e.status === 400 && /pesoBruto debe ser mayor que pesoTara/.test(e.message)
  );
});
test('[C] recibir con solo pesoBruto incoherente respecto a la tara guardada se rechaza', () => {
  const db = docConCamion();
  assert.throws(
    () => engine.recibirCamion(db, db.camiones[0].id, { fechaReal: '2026-09-11', pesoBruto: 1000 }),
    e => e.status === 400 && /pesoBruto debe ser mayor que pesoTara/.test(e.message)
  );
});
test('[C] recibir con pesaje coherente funciona y no altera el neto', () => {
  const db = docConCamion();
  engine.recibirCamion(db, db.camiones[0].id, { fechaReal: '2026-09-11', pesoBruto: 31000, pesoTara: 12000 });
  assert.strictEqual(db.camiones[0].fechaReal, '2026-09-11');
  assert.strictEqual(db.camiones[0].pesoBruto, 31000);
  assert.strictEqual(db.camiones[0].kg, 18000);
});

/* ------------------------------------------------------------------ */
/* [D] deleteRazonSocial: no puede dejar órdenes huérfanas.            */
/* ------------------------------------------------------------------ */
test('[D] borrar una razón social usada por una orden -> 409 con mensaje del motor', () => {
  const db = engine.emptyDb();
  engine.addRazonSocial(db, { nombre: 'Solo ordenes', corto: 'SO' });
  engine.addOrden(db, { nombre: 'Lote', rsId: db.razonesSociales[0].id, agaveKg: 5000 });
  assert.throws(
    () => engine.deleteRazonSocial(db, db.razonesSociales[0].id),
    e => e.status === 409 && /órdenes de producción/.test(e.message)
  );
  assert.strictEqual(db.razonesSociales.length, 1, 'no debe borrarse');
});
test('[D] borrar una razón social sin referencias sí funciona', () => {
  const db = engine.emptyDb();
  engine.addRazonSocial(db, { nombre: 'Libre', corto: 'LB' });
  engine.deleteRazonSocial(db, db.razonesSociales[0].id);
  assert.strictEqual(db.razonesSociales.length, 0);
});

/* ------------------------------------------------------------------ */
/* Invariantes del motor (red de seguridad del refactor)               */
/* ------------------------------------------------------------------ */
test('un documento vacío se calcula sin romperse', () => {
  const st = engine.computeState(engine.emptyDb());
  assert.strictEqual(st.resumen.recibidoT, 0);
  assert.strictEqual(st.razonesSociales.length, 0);
  assert.strictEqual(st.meta.hoy.length, 10);
});
test('rendimiento del preset base a 40° ABV = 151.5 L/t (el README dice ~151)', () => {
  assert.strictEqual(engine.cascadeLPerTon(engine.PRESETS.base, 40), 151.5);
});
test('a 38° ABV el mismo preset rinde 159.4 L/t', () => {
  assert.strictEqual(engine.cascadeLPerTon(engine.PRESETS.base, 38), 159.4);
});
test('una orden de 20 t a 40° ABV espera 3029.4 L', () => {
  const db = engine.emptyDb();
  engine.addRazonSocial(db, { nombre: 'RS', corto: 'RS' });
  engine.updateParametrosCalculo(db, { gradosTequila: 40 });
  engine.addOrden(db, { nombre: 'Lote', rsId: db.razonesSociales[0].id, agaveKg: 20000 });
  const st = engine.computeState(db);
  assert.strictEqual(st.ordenes[0].tequilaEsperadoL, 3029.4);
});
test('la eficiencia compara el tequila real contra el esperado', () => {
  const db = engine.emptyDb();
  engine.addRazonSocial(db, { nombre: 'RS', corto: 'RS' });
  engine.updateParametrosCalculo(db, { gradosTequila: 40 });
  engine.addOrden(db, { nombre: 'Lote', rsId: db.razonesSociales[0].id, agaveKg: 20000, tequilaRealL: 1200 });
  const st = engine.computeState(db);
  assert.strictEqual(st.ordenes[0].rendimientoRealLt, 60);
  assert.strictEqual(st.ordenes[0].eficiencia, 39.6);
});
test('la merma por causa debe sumar 100%', () => {
  const db = engine.emptyDb();
  assert.throws(() => engine.updateParametrosCalculo(db, { mermaCausas: { hojas: 10, danado: 10, fibra: 10, cortes: 10, otros: 10 } }),
    e => e.status === 400);
});

/* ------------------------------------------------------------------ */
if (TZ_ORIGINAL === undefined) delete process.env.AGAVE_TZ; else process.env.AGAVE_TZ = TZ_ORIGINAL;

filas.forEach(f => console.log(f[0].padEnd(5) + ' ' + f[1] + (f[2] ? '\n      -> ' + f[2] : '')));
console.log('\n' + '-'.repeat(70));
console.log(`${pass} PASS / ${fail} FAIL  (total ${pass + fail})`);
process.exit(fail);
