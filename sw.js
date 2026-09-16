/* Agave Cía · Service Worker (offline COMPATIBLE, no offline-first).
 *
 * - Las escrituras (POST/PATCH/DELETE) NUNCA se cachean ni se reintentan.
 * - Navegaciones: red primero; si falla, /index.html de caché (así la app ABRE sin internet).
 * - /api/state: red primero; si falla, la copia cacheada + cabecera X-Agave-Cache: hit.
 * - Resto de GET del mismo origen: stale-while-revalidate.
 */
'use strict';

var CACHE = 'agave-v2';
var CACHE_PREFIX = 'agave-';
var PRECACHE = ['/', '/index.html', '/offline.js', '/engine.js', '/manifest.webmanifest'];
var OFFLINE_INDEX = '/index.html';
var STATE_URL = '/api/state';

self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE).then(function(cache){
      // Tolerante a fallos: un 404 (p. ej. /engine.js todavía no existe) no rompe la instalación.
      return Promise.all(PRECACHE.map(function(url){
        return cache.add(url).catch(function(){ return null; });
      }));
    }).catch(function(){}).then(function(){
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(name){
        if (name !== CACHE && name.indexOf(CACHE_PREFIX) === 0) return caches.delete(name);
        return null;
      }));
    }).catch(function(){}).then(function(){
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(event){
  var request = event.request;
  var method = (request.method || 'GET').toUpperCase();

  // 1) Escrituras: directo a la red, jamás cacheadas.
  if (method !== 'GET'){
    event.respondWith(fetch(request));
    return;
  }

  var url;
  try { url = new URL(request.url); } catch (e) { return; }

  // 2) Navegaciones: la app debe ABRIR sin internet.
  if (request.mode === 'navigate'){
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  // 3) Estado del dashboard: red primero, copia cacheada como respaldo.
  if (url.pathname === STATE_URL){
    event.respondWith(networkFirstState(request));
    return;
  }

  // 4) Resto de GET del mismo origen.
  if (url.origin === self.location.origin){
    event.respondWith(staleWhileRevalidate(event, request));
  }
  // Otro origen: sin intervención.
});

function networkFirstNavigation(request){
  return fetch(request).then(function(res){
    if (res && res.ok && res.status === 200 && res.type !== 'opaque'){
      var copy = res.clone();
      caches.open(CACHE).then(function(cache){
        return cache.put(OFFLINE_INDEX, copy);
      }).catch(function(){});
    }
    return res;
  }).catch(function(){
    return caches.open(CACHE).then(function(cache){
      return cache.match(OFFLINE_INDEX).then(function(hit){
        if (hit) return hit;
        return cache.match('/').then(function(root){
          if (root) return root;
          throw new Error('Sin conexión y sin copia local de la app');
        });
      });
    });
  });
}

function networkFirstState(request){
  return fetch(request).then(function(res){
    if (res && res.ok && res.status === 200 && res.type !== 'opaque'){
      var copy = res.clone();
      caches.open(CACHE).then(function(cache){
        return cache.put(STATE_URL, copy);
      }).catch(function(){});
    }
    return res;
  }).catch(function(err){
    return caches.open(CACHE).then(function(cache){
      return cache.match(STATE_URL).then(function(hit){
        if (!hit) throw err;                 // sin copia: el cliente usará su respaldo en localStorage
        return withCacheHeader(hit);
      });
    });
  });
}

// Clona la respuesta añadiéndole X-Agave-Cache: hit (el cliente la marca como offline).
function withCacheHeader(res){
  try {
    var headers = new Headers(res.headers);
    headers.set('X-Agave-Cache', 'hit');
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: headers
    });
  } catch (e) {
    return res;
  }
}

function staleWhileRevalidate(event, request){
  return caches.open(CACHE).then(function(cache){
    return cache.match(request).then(function(cached){
      var network = fetch(request).then(function(res){
        if (res && res.ok && res.status === 200 && res.type !== 'opaque'){
          cache.put(request, res.clone()).catch(function(){});
        }
        return res;
      }).catch(function(){ return null; });

      if (cached){
        event.waitUntil(network);            // refresca en segundo plano
        return cached;
      }
      return network.then(function(res){
        if (res) return res;
        throw new Error('Sin conexión');
      });
    });
  });
}
