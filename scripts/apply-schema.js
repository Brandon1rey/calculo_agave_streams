'use strict';
/* Aplica supabase/schema.sql a la base configurada en DATABASE_URL.
   Uso: npm run db:schema     (idempotente) */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
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

const dbmod = require('../api/_lib/db.js');

(async () => {
  try {
    console.log('Aplicando supabase/schema.sql …');
    await dbmod.applySchema();
    const h = await dbmod.health();
    console.log('OK. Esquema aplicado y verificado.');
    console.log('  revisión actual : ' + h.rev);
    console.log('  razones/streams/camiones : ' + h.counts.razones + ' / ' + h.counts.streams + ' / ' + h.counts.camiones);
    await dbmod.cerrar();
    process.exit(0);
  } catch (e) {
    console.error('FALLÓ: ' + (e && e.message ? e.message : e));
    if (e && e.code) console.error('  código Postgres: ' + e.code + (e.constraint ? ' (' + e.constraint + ')' : ''));
    await dbmod.cerrar().catch(() => {});
    process.exit(1);
  }
})();
