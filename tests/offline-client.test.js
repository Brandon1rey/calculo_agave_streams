'use strict';
/* Pruebas del cliente offline del dashboard de agave.
 *
 *   Ejecutar:  node tests/offline-client.test.js
 *   Sin dependencias ni framework (solo assert de Node).
 *   Código de salida = número de fallos.
 *
 * Carga offline.js con require e inyecta globals falsos: localStorage en
 * memoria, navigator.onLine, window con eventos y un fetch que falla o responde.
 */
const assert = require('assert');

const OFFLINE_MSG = 'Sin conexión: se necesita internet para guardar cambios';
const OFFLINE_JS = require.resolve('../offline.js');

/* ---------- globals falsos ---------- */
function setGlobal(name, value){
  try {
    Object.defineProperty(globalThis, name, { value: value, configurable: true, writable: true });
  } catch (e) {
    try { globalThis[name] = value; } catch (e2) {}
  }
}

function makeStorage(opts){
  const map = new Map();
  const o = opts || {};
  return {
    _map: map,
    getItem(k){ return map.has(k) ? map.get(k) : null; },
    setItem(k, v){
      if (o.failOnSet) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
      map.set(k, String(v));
    },
    removeItem(k){ map.delete(k); },
    clear(){ map.clear(); },
    get length(){ return map.size; }
  };
}

function makeWindow(){
  const listeners = {};
  return {
    _listeners: listeners,
    addEventListener(type, fn){ (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn){
      if (listeners[type]) listeners[type] = listeners[type].filter(function(f){ return f !== fn; });
    },
    fire(type){ (listeners[type] || []).slice().forEach(function(f){ f(); }); },
    count(type){ return (listeners[type] || []).length; }
  };
}

function freshOffline(){
  delete require.cache[OFFLINE_JS];
  return require(OFFLINE_JS);
}

function failingFetch(){
  return Promise.reject(new TypeError('Failed to fetch'));
}

function jsonFetch(body, headers){
  return function(){
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: 200,
      headers: headers || { 'Content-Type': 'application/json' }
    }));
  };
}

async function rejectsWith(promise){
  try { await promise; return null; } catch (e) { return e; }
}

/* ---------- mini runner ---------- */
const results = [];
async function t(name, fn){
  try { await fn(); results.push({ name: name, ok: true }); }
  catch (e) { results.push({ name: name, ok: false, err: e }); }
}

(async function run(){

  /* ===== (a) saveState / loadState ===== */
  await t('KEY es agave.state.v1', function(){
    setGlobal('localStorage', makeStorage());
    const off = freshOffline();
    assert.strictEqual(off.KEY, 'agave.state.v1');
  });

  await t('saveState/loadState hacen round-trip (estado + savedAt)', function(){
    const ls = makeStorage();
    setGlobal('localStorage', ls);
    const off = freshOffline();
    const state = { meta: { hoy: '2026-09-16' }, razonesSociales: [{ id: 'rs-1', corto: 'RA' }], resumen: { recibidoT: 12.5 } };
    const before = Date.now();
    assert.strictEqual(off.saveState(state), true);
    const saved = off.loadState();
    assert.deepStrictEqual(saved.state, state);
    assert.strictEqual(typeof saved.savedAt, 'number');
    assert.ok(saved.savedAt >= before && saved.savedAt <= Date.now(), 'savedAt debe ser un timestamp actual');
    const raw = JSON.parse(ls.getItem('agave.state.v1'));
    assert.deepStrictEqual(raw.state, state);
    assert.strictEqual(typeof raw.savedAt, 'number');
  });

  await t('loadState devuelve null sin caché, con JSON corrupto y sin localStorage', function(){
    setGlobal('localStorage', makeStorage());
    let off = freshOffline();
    assert.strictEqual(off.loadState(), null);

    globalThis.localStorage.setItem('agave.state.v1', '{esto no es json');
    assert.strictEqual(off.loadState(), null);

    globalThis.localStorage.setItem('agave.state.v1', JSON.stringify({ savedAt: 123 }));
    assert.strictEqual(off.loadState(), null, 'sin .state debe devolver null');

    setGlobal('localStorage', undefined);
    off = freshOffline();
    assert.strictEqual(off.loadState(), null);
  });

  await t('saveState no revienta si localStorage falla por cuota (devuelve false)', function(){
    setGlobal('localStorage', makeStorage({ failOnSet: true }));
    const off = freshOffline();
    assert.strictEqual(off.saveState({ a: 1 }), false);
  });

  await t('clearState borra la caché', function(){
    setGlobal('localStorage', makeStorage());
    const off = freshOffline();
    off.saveState({ a: 1 });
    assert.ok(off.loadState());
    assert.strictEqual(off.clearState(), true);
    assert.strictEqual(off.loadState(), null);
  });

  /* ===== (d) isOffline ===== */
  await t('isOffline() refleja navigator.onLine (y es perezoso)', function(){
    setGlobal('localStorage', makeStorage());
    setGlobal('navigator', { onLine: false });
    const off = freshOffline();
    assert.strictEqual(off.isOffline(), true);

    setGlobal('navigator', { onLine: true });
    assert.strictEqual(off.isOffline(), false, 'debe leer navigator en cada llamada');

    setGlobal('navigator', {});
    assert.strictEqual(off.isOffline(), false, 'sin onLine no se considera offline');

    setGlobal('navigator', undefined);
    assert.strictEqual(off.isOffline(), false, 'sin navigator no se considera offline');
  });

  /* ===== (b) wrapFetch con red caída y método de escritura ===== */
  await t('wrapFetch: POST sin red lanza Error con offline === true', async function(){
    setGlobal('localStorage', makeStorage());
    setGlobal('navigator', { onLine: false });
    const off = freshOffline();
    const wf = off.wrapFetch(failingFetch);
    const err = await rejectsWith(wf('/api/razones', { method: 'POST', body: '{}' }));
    assert.ok(err, 'debe rechazar');
    assert.strictEqual(err.offline, true);
    assert.strictEqual(err.message, OFFLINE_MSG);
  });

  await t('wrapFetch: PATCH y DELETE sin red también se marcan offline', async function(){
    setGlobal('localStorage', makeStorage());
    const off = freshOffline();
    const wf = off.wrapFetch(failingFetch);
    for (const method of ['PATCH', 'DELETE', 'PUT']){
      const err = await rejectsWith(wf('/api/camiones/t-1', { method: method }));
      assert.ok(err, method + ' debe rechazar');
      assert.strictEqual(err.offline, true, method + ' debe traer offline === true');
      assert.strictEqual(err.message, OFFLINE_MSG);
    }
  });

  await t('wrapFetch: método tomado de un Request-like cuando no hay opts', async function(){
    setGlobal('localStorage', makeStorage());
    const off = freshOffline();
    const wf = off.wrapFetch(failingFetch);
    const err = await rejectsWith(wf({ url: '/api/streams', method: 'POST' }));
    assert.ok(err);
    assert.strictEqual(err.offline, true);
  });

  /* ===== (c) wrapFetch con red caída y GET /api/state ===== */
  await t('wrapFetch: GET /api/state sin red devuelve el estado cacheado y marcado offline', async function(){
    setGlobal('localStorage', makeStorage());
    setGlobal('navigator', { onLine: false });
    const off = freshOffline();
    const state = { meta: { hoy: '2026-09-16' }, resumen: { recibidoT: 12.5, mermaT: 1 }, camiones: [{ id: 't-1' }] };
    off.saveState(state);
    const savedAt = off.loadState().savedAt;

    const wf = off.wrapFetch(failingFetch);
    const res = await wf('/api/state');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.offline, true, 'la respuesta debe quedar marcada como offline');
    assert.strictEqual(res.cachedAt, savedAt, 'cachedAt debe ser el savedAt de la caché');
    const body = await res.json();
    assert.deepStrictEqual(body, state);
  });

  await t('wrapFetch: GET /api/state con query string también usa la caché', async function(){
    setGlobal('localStorage', makeStorage());
    const off = freshOffline();
    off.saveState({ meta: { hoy: '2026-09-16' } });
    const wf = off.wrapFetch(failingFetch);
    const res = await wf('/api/state?t=123');
    assert.strictEqual(res.offline, true);
    assert.deepStrictEqual(await res.json(), { meta: { hoy: '2026-09-16' } });
  });

  await t('wrapFetch: GET /api/state sin caché propaga el error real (sin marcar offline)', async function(){
    setGlobal('localStorage', makeStorage());
    const off = freshOffline();
    const wf = off.wrapFetch(failingFetch);
    const err = await rejectsWith(wf('/api/state'));
    assert.ok(err, 'debe rechazar si no hay respaldo');
    assert.notStrictEqual(err.offline, true);
    assert.strictEqual(err.message, 'Failed to fetch');
  });

  await t('wrapFetch: GET de otra ruta sin caché propaga el error original', async function(){
    setGlobal('localStorage', makeStorage());
    const off = freshOffline();
    const wf = off.wrapFetch(failingFetch);
    const err = await rejectsWith(wf('/api/camiones/t-1/ticket'));
    assert.ok(err);
    assert.notStrictEqual(err.offline, true);
  });

  /* ===== wrapFetch con red disponible ===== */
  await t('wrapFetch: con red OK devuelve la respuesta intacta y sin marcar offline', async function(){
    setGlobal('localStorage', makeStorage());
    const off = freshOffline();
    const payload = { resumen: { recibidoT: 3 } };
    const wf = off.wrapFetch(jsonFetch(payload));
    const req = new Request('http://localhost/api/state');
    const res = await wf('/api/state', { method: 'GET' });
    assert.strictEqual(res.status, 200);
    assert.ok(!res.offline, 'con red no debe marcarse offline');
    assert.deepStrictEqual(await res.json(), payload);
    const res2 = await wf(req);
    assert.deepStrictEqual(await res2.json(), payload);
  });

  await t('wrapFetch: una respuesta con X-Agave-Cache: hit se marca offline con cachedAt', async function(){
    setGlobal('localStorage', makeStorage());
    const off = freshOffline();
    off.saveState({ meta: { hoy: '2026-09-16' } });
    const savedAt = off.loadState().savedAt;
    const wf = off.wrapFetch(jsonFetch({ meta: { hoy: '2026-09-16' } }, { 'Content-Type': 'application/json', 'X-Agave-Cache': 'hit' }));
    const res = await wf('/api/state');
    assert.strictEqual(res.offline, true);
    assert.strictEqual(res.cachedAt, savedAt);
  });

  await t('wrapFetch: POST con red OK pasa de largo', async function(){
    setGlobal('localStorage', makeStorage());
    const off = freshOffline();
    const wf = off.wrapFetch(jsonFetch({ ok: true }));
    const res = await wf('/api/razones', { method: 'POST', body: '{}' });
    assert.strictEqual(res.status, 200);
    assert.ok(!res.offline);
  });

  /* ===== register() ===== */
  await t('register(): en https con serviceWorker llama a /sw.js', async function(){
    setGlobal('localStorage', makeStorage());
    const calls = [];
    setGlobal('location', { protocol: 'https:', hostname: 'agave.vercel.app', href: 'https://agave.vercel.app/' });
    setGlobal('navigator', { onLine: true, serviceWorker: { register: function(u){ calls.push(u); return Promise.resolve({ scope: '/' }); } } });
    const off = freshOffline();
    const reg = await off.register();
    assert.deepStrictEqual(calls, ['/sw.js']);
    assert.ok(reg);
  });

  await t('register(): en localhost (http) también registra', async function(){
    setGlobal('localStorage', makeStorage());
    const calls = [];
    setGlobal('location', { protocol: 'http:', hostname: 'localhost', href: 'http://localhost:3053/' });
    setGlobal('navigator', { serviceWorker: { register: function(u){ calls.push(u); return Promise.resolve({}); } } });
    const off = freshOffline();
    await off.register();
    assert.deepStrictEqual(calls, ['/sw.js']);
  });

  await t('register(): en http de red local NO registra y resuelve null', async function(){
    setGlobal('localStorage', makeStorage());
    const calls = [];
    setGlobal('location', { protocol: 'http:', hostname: '192.168.1.50', href: 'http://192.168.1.50:3053/' });
    setGlobal('navigator', { serviceWorker: { register: function(u){ calls.push(u); return Promise.resolve({}); } } });
    const off = freshOffline();
    const reg = await off.register();
    assert.strictEqual(reg, null);
    assert.deepStrictEqual(calls, []);
  });

  await t('register(): nunca rechaza (sin serviceWorker, sin navigator o si register lanza)', async function(){
    setGlobal('localStorage', makeStorage());
    setGlobal('location', { protocol: 'https:', hostname: 'x.app', href: 'https://x.app/' });

    setGlobal('navigator', { onLine: true });
    let off = freshOffline();
    assert.strictEqual(await off.register(), null);

    setGlobal('navigator', undefined);
    off = freshOffline();
    assert.strictEqual(await off.register(), null);

    setGlobal('navigator', { serviceWorker: { register: function(){ throw new Error('boom'); } } });
    off = freshOffline();
    assert.strictEqual(await off.register(), null);

    setGlobal('navigator', { serviceWorker: { register: function(){ return Promise.reject(new Error('nope')); } } });
    off = freshOffline();
    assert.strictEqual(await off.register(), null);
  });

  /* ===== onChange ===== */
  await t('onChange(): suscribe online/offline y devuelve unsubscribe', function(){
    setGlobal('localStorage', makeStorage());
    const win = makeWindow();
    setGlobal('window', win);
    const off = freshOffline();
    const seen = [];
    const unsub = off.onChange(function(online){ seen.push(online); });
    assert.strictEqual(win.count('online'), 1);
    assert.strictEqual(win.count('offline'), 1);

    win.fire('offline');
    win.fire('online');
    assert.deepStrictEqual(seen, [false, true], 'el callback recibe el estado del evento');

    assert.strictEqual(typeof unsub, 'function');
    unsub();
    assert.strictEqual(win.count('online'), 0);
    assert.strictEqual(win.count('offline'), 0);
    win.fire('online');
    assert.deepStrictEqual(seen, [false, true], 'tras desuscribirse no debe recibir más');
  });

  await t('onChange(): sin window devuelve un no-op sin lanzar', function(){
    setGlobal('localStorage', makeStorage());
    setGlobal('window', undefined);
    const off = freshOffline();
    const unsub = off.onChange(function(){ throw new Error('no debería llamarse'); });
    assert.strictEqual(typeof unsub, 'function');
    unsub();
  });

  /* ===== lastSyncLabel ===== */
  await t('lastSyncLabel(): formato dd/mm hh:mm y vacío sin caché', function(){
    const ls = makeStorage();
    setGlobal('localStorage', ls);
    const off = freshOffline();
    assert.strictEqual(off.lastSyncLabel(), '');

    const d = new Date(2026, 8, 16, 10, 43);            // 16/09/2026 10:43 (hora local)
    ls.setItem('agave.state.v1', JSON.stringify({ state: { a: 1 }, savedAt: d.getTime() }));
    assert.strictEqual(off.lastSyncLabel(), '16/09 10:43');

    const d2 = new Date(2026, 0, 5, 7, 4);              // relleno con ceros
    ls.setItem('agave.state.v1', JSON.stringify({ state: { a: 1 }, savedAt: d2.getTime() }));
    assert.strictEqual(off.lastSyncLabel(), '05/01 07:04');
  });

  /* ---------- resumen ---------- */
  const fallos = results.filter(function(r){ return !r.ok; });
  const ancho = results.reduce(function(m, r){ return Math.max(m, r.name.length); }, 0);
  console.log('');
  results.forEach(function(r){
    console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name.padEnd(ancho) + (r.ok ? '' : '\n      -> ' + (r.err && r.err.message)));
  });
  console.log('\n' + '-'.repeat(ancho + 8));
  console.log((results.length - fallos.length) + ' PASS / ' + fallos.length + ' FAIL  (total ' + results.length + ')');
  process.exit(fallos.length);
})();
