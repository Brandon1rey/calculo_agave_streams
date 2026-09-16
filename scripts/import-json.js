'use strict';
/* Migra los datos del almacén antiguo (data/db.json) a PostgreSQL.
   Uso: npm run db:import
   No borra el archivo original: lo deja intacto como respaldo. */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ORIGEN = path.join(ROOT, 'data', 'db.json');

for (const nombre of ['.env.local', '.env']){
  const p = path.join(ROOT, nombre);
  if (!fs.existsSync(p)) continue;
  fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach(linea => {
    const s = linea.trim();
    if (!s || s.startsWith('#')) return;
    const i = s.indexOf('=');
    if (i < 1) return;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  });
}

const engine = require('../engine.js');
const dbmod = require('../api/_lib/db.js');

(async () => {
  try {
    if (!fs.existsSync(ORIGEN)){ console.error('No existe ' + ORIGEN + ': nada que importar.'); process.exit(0); }
    const bruto = JSON.parse(fs.readFileSync(ORIGEN, 'utf8'));
    const doc = engine.hydrate(bruto);
    const resumen = {
      razonesSociales: doc.razonesSociales.length, streams: doc.streams.length, camiones: doc.camiones.length,
      consumos: doc.consumos.length, ordenes: doc.ordenes.length
    };
    console.log('Documento leído de data/db.json:', JSON.stringify(resumen));
    if (!resumen.razonesSociales && !resumen.streams && !resumen.camiones && !resumen.consumos && !resumen.ordenes){
      console.log('El archivo está vacío: no hay nada que importar (no se toca la base).');
      await dbmod.cerrar(); process.exit(0);
    }
    const guardado = await dbmod.saveDb(doc);
    console.log('Importado. Revisión nueva: ' + guardado.rev + '  (' + guardado.updatedAt + ')');
    await dbmod.cerrar();
    process.exit(0);
  } catch (e) {
    console.error('FALLÓ: ' + (e && e.message ? e.message : e));
    await dbmod.cerrar().catch(() => {});
    process.exit(1);
  }
})();
