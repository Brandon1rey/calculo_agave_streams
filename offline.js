/* Agave Cía · cliente offline (offline COMPATIBLE, no offline-first).
 *
 * Permite que el dashboard ABRA y se muestre en solo lectura sin internet.
 * NO hay cola de escrituras ni sincronización diferida: si no hay red, las
 * escrituras fallan con un error marcado (err.offline === true).
 *
 * UMD: en el navegador expone window.AgaveOffline; en Node, module.exports
 * (para poder probarlo con require). Sin import/export.
 *
 * Todos los accesos a localStorage / navigator / fetch / window son PEREZOSOS
 * y con guardas: si el global no existe o el acceso lanza, se degrada sin romper.
 */
(function(root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgaveOffline = factory();
})(typeof self !== 'undefined' ? self : this, function(){
  'use strict';

  /* Clave de localStorage donde vive el último estado bueno. */
  var KEY = 'agave.state.v1';
  var OFFLINE_MSG = 'Sin conexión: se necesita internet para guardar cambios';

  /* ---------- accesos perezosos y con guardas ---------- */
  function getStorage(){
    try {
      var s = (typeof localStorage !== 'undefined') ? localStorage : null;
      if (!s || typeof s.getItem !== 'function' || typeof s.setItem !== 'function') return null;
      return s;
    } catch (e) { return null; }            // modo privado / acceso bloqueado por el navegador
  }
  function getNavigator(){
    try { return (typeof navigator !== 'undefined') ? navigator : null; } catch (e) { return null; }
  }
  function getWindow(){
    try { return (typeof window !== 'undefined') ? window : null; } catch (e) { return null; }
  }
  function getLocation(){
    try { return (typeof location !== 'undefined') ? location : null; } catch (e) { return null; }
  }
  function baseHref(){
    var loc = getLocation();
    try { if (loc && loc.href) return loc.href; } catch (e) {}
    return 'http://localhost/';
  }
  function pathOf(input){
    var raw = '';
    try {
      if (typeof input === 'string') raw = input;
      else if (input && typeof input.url === 'string') raw = input.url;
    } catch (e) { raw = ''; }
    try {
      if (raw && typeof URL === 'function') return new URL(raw, baseHref()).pathname;
    } catch (e) {}
    return String(raw).split('?')[0].split('#')[0];
  }
  function methodOf(input, opts){
    try {
      if (opts && opts.method) return String(opts.method).toUpperCase();
      if (input && typeof input === 'object' && input.method) return String(input.method).toUpperCase();
    } catch (e) {}
    return 'GET';
  }
  function pad(n){ return n < 10 ? '0' + n : '' + n; }

  /* ---------- caché del último estado bueno ---------- */
  function saveState(state){
    try {
      var s = getStorage();
      if (!s) return false;
      s.setItem(KEY, JSON.stringify({ state: state, savedAt: Date.now() }));
      return true;
    } catch (e) {
      return false;                          // cuota llena, JSON circular, modo privado…: nunca revienta
    }
  }
  function loadState(){
    try {
      var s = getStorage();
      if (!s) return null;
      var raw = s.getItem(KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.state) return null;
      return {
        state: parsed.state,
        savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0
      };
    } catch (e) {
      return null;                           // JSON corrupto: se ignora
    }
  }
  function clearState(){
    try {
      var s = getStorage();
      if (!s || typeof s.removeItem !== 'function') return false;
      s.removeItem(KEY);
      return true;
    } catch (e) { return false; }
  }

  /* ---------- estado de red ---------- */
  function isOffline(){
    var nav = getNavigator();
    return !!(nav && nav.onLine === false);
  }
  function lastSyncLabel(){
    var saved = loadState();
    if (!saved || !saved.savedAt) return '';
    try {
      var d = new Date(saved.savedAt);
      if (isNaN(d.getTime())) return '';
      return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    } catch (e) { return ''; }
  }

  /* ---------- service worker ---------- */
  function isSecureOrigin(){
    var loc = getLocation();
    var proto = '', host = '';
    try { proto = loc ? String(loc.protocol || '') : ''; } catch (e) { proto = ''; }
    try { host = loc ? String(loc.hostname || '') : ''; } catch (e) { host = ''; }
    if (proto === 'https:') return true;
    return proto === 'http:' && (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]');
  }
  function register(){
    function attempt(){
      var nav = getNavigator();
      if (!nav || !nav.serviceWorker || typeof nav.serviceWorker.register !== 'function') return null;
      if (!isSecureOrigin()) return null;
      return nav.serviceWorker.register('/sw.js');
    }
    try {
      return Promise.resolve(attempt()).then(
        function(reg){ return reg || null; },
        function(){ return null; }
      );
    } catch (e) {
      return Promise.resolve(null);          // nunca rechaza
    }
  }

  /* ---------- respuestas marcadas como "venían de caché" ---------- */
  function tagResponse(res, cachedAt){
    var stamp = (typeof cachedAt === 'number' && cachedAt > 0) ? cachedAt : 0;
    try {
      res.offline = true;
      if (stamp) res.cachedAt = stamp;
      return res;
    } catch (e) {
      // Response no extensible: se devuelve un objeto compatible con lo que usa api()
      return {
        ok: !!res.ok,
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
        offline: true,
        cachedAt: stamp || undefined,
        json: function(){ return res.json(); },
        text: function(){ return res.text(); }
      };
    }
  }
  function offlineResponse(saved){
    var body = JSON.stringify(saved.state);
    var res = null;
    try {
      if (typeof Response === 'function'){
        res = new Response(body, {
          status: 200,
          statusText: 'OK',
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Agave-Cache': 'hit' }
        });
      }
    } catch (e) { res = null; }
    if (!res){
      res = {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: function(k){ return String(k).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null; } },
        json: function(){ return Promise.resolve(saved.state); },
        text: function(){ return Promise.resolve(body); }
      };
    }
    return tagResponse(res, saved.savedAt);
  }
  function servedFromCache(res){
    try {
      return !!(res && res.headers && typeof res.headers.get === 'function' && res.headers.get('X-Agave-Cache') === 'hit');
    } catch (e) { return false; }
  }
  function cachedAtFromStore(){
    var saved = loadState();
    return (saved && saved.savedAt) ? saved.savedAt : 0;
  }

  /* ---------- fetch envuelto ---------- */
  function wrapFetch(fetchImpl){
    var base = fetchImpl;
    return function(input, opts){
      var method = methodOf(input, opts);
      var pathname = pathOf(input);

      var run;
      try {
        if (typeof base !== 'function') throw new Error('fetch no disponible');
        run = Promise.resolve(base(input, opts));
      } catch (e) {
        run = Promise.reject(e);
      }

      return run.then(function(res){
        // El service worker marca con X-Agave-Cache: hit lo que sirvió de caché.
        if (servedFromCache(res)) return tagResponse(res, cachedAtFromStore());
        return res;
      }).catch(function(err){
        if (method !== 'GET'){
          var off = new Error(OFFLINE_MSG);
          off.offline = true;
          off.cause = err;
          throw off;
        }
        if (pathname === '/api/state'){
          var saved = loadState();
          if (saved) return offlineResponse(saved);
        }
        throw err;                            // sin respaldo: se propaga el error real
      });
    };
  }

  /* ---------- eventos online/offline ---------- */
  function onChange(cb){
    if (typeof cb !== 'function') return function(){};
    var win = getWindow();
    if (!win || typeof win.addEventListener !== 'function') return function(){};
    function makeHandler(kind){
      return function(){ try { cb(kind === 'online'); } catch (e) {} };
    }
    var onOnline = makeHandler('online');
    var onOffline = makeHandler('offline');
    try {
      win.addEventListener('online', onOnline);
      win.addEventListener('offline', onOffline);
    } catch (e) {
      return function(){};
    }
    return function unsubscribe(){
      try {
        if (typeof win.removeEventListener === 'function'){
          win.removeEventListener('online', onOnline);
          win.removeEventListener('offline', onOffline);
        }
      } catch (e) {}
    };
  }

  return {
    KEY: KEY,
    saveState: saveState,
    loadState: loadState,
    clearState: clearState,
    isOffline: isOffline,
    register: register,
    wrapFetch: wrapFetch,
    onChange: onChange,
    lastSyncLabel: lastSyncLabel
  };
});
