'use strict';
/* Función serverless de Vercel para /api/*
 *
 * OJO: en un proyecto "Other" (sin framework) Vercel NO soporta el catch-all
 * `api/[...path].js` — solo enruta un segmento —, así que las rutas anidadas
 * (/api/razones/:id, /api/camiones/:id/recibir, ...) devolvían el 404 del
 * hosting en vez de llegar aquí. vercel.json las reescribe a /api/index y la
 * ruta lógica viaja en ?__p=... (ver resolverRuta en api/_lib/app.js).
 */
const { handleRequest } = require('./_lib/app.js');

module.exports = handleRequest;
