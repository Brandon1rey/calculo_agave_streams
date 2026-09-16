'use strict';
/* Función serverless de Vercel: catch-all de /api/*
 * Todo el enrutado vive en api/_lib/app.js, compartido con el servidor local. */
const { handleRequest } = require('./_lib/app.js');

module.exports = handleRequest;
