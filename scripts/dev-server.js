'use strict';
/* Servidor local de desarrollo: mismo router que la función de Vercel, más el
   servido de estáticos (en producción eso lo hace la CDN de Vercel).
   Uso: npm run dev        (lee .env.local si existe) */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { exec } = require('child_process');

const ROOT = path.join(__dirname, '..');

/* Carga .env.local / .env sin dependencias (no sobreescribe lo ya definido). */
function cargarEnv(){
  let cargado = [];
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
    cargado.push(nombre);
  }
  return cargado;
}

const archivosEnv = cargarEnv();
const { handleRequest } = require('../api/_lib/app.js');
const dbmod = require('../api/_lib/db.js');

const PORT = Number(process.env.PORT) || 3053;
const HOST = process.env.HOST || '127.0.0.1';

function openBrowser(url){
  const cmd = process.platform === 'win32' ? 'start "" "' + url + '"' : process.platform === 'darwin' ? 'open "' + url + '"' : 'xdg-open "' + url + '"';
  exec(cmd, () => {});
}

const server = http.createServer((req, res) => {
  Promise.resolve(handleRequest(req, res)).catch(e => {
    console.error('[dev] error no controlado:', e && e.stack ? e.stack : e);
    if (!res.writableEnded){ res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'Error interno del servidor local' })); }
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE'){
    console.log('El dashboard ya está corriendo en el puerto ' + PORT + '.');
    if (!process.env.NO_BROWSER) openBrowser('http://localhost:' + PORT + '/');
  } else { console.error(e); process.exit(1); }
});

server.listen(PORT, HOST, () => {
  const url = 'http://localhost:' + PORT + '/';
  console.log('');
  console.log('  Agave Cía · Recepción + Producción E2E + Calculadora');
  console.log('  Almacén:  PostgreSQL (Supabase) — ' + (process.env.DATABASE_URL ? 'DATABASE_URL configurada' : 'FALTA DATABASE_URL'));
  console.log('  Entorno:  ' + (archivosEnv.length ? archivosEnv.join(', ') : 'sin archivo .env (usando variables del sistema)'));
  console.log('  API:      ' + url + 'api/state');
  console.log('  UI:       ' + url);
  console.log('  Escucha:  ' + HOST + ':' + PORT + (HOST === '127.0.0.1' ? '  (solo esta máquina; usa HOST=0.0.0.0 para exponer en la red local)' : '  (expuesto en la red local)'));
  console.log('  Detener:  Ctrl+C');
  console.log('');
  if (!process.env.NO_BROWSER) openBrowser(url);
});

['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => {
  console.log('\nCerrando…');
  server.close(() => dbmod.cerrar().then(() => process.exit(0)).catch(() => process.exit(0)));
  setTimeout(() => process.exit(0), 3000);
}));
