// Contrato de las rutas HTTP. Estos tests arrancan el app real de server.js en
// un puerto efimero y hablan HTTP de verdad, sin hoja de Sheets: por eso las
// rutas que dependen de la hoja responden 503, no 200.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'secreto-de-prueba-suficientemente-largo';
delete process.env.SHEETS_WEBAPP_URL;
delete process.env.SHEETS_API_KEY;
delete process.env.DUENO_PIN_HASH;

const app = require('../server.js').app;
let servidor = null;
let puerto = 0;
const listo = new Promise(function (resolver) {
  servidor = app.listen(0, '127.0.0.1', function () {
    puerto = servidor.address().port;
    resolver(puerto);
  });
});

function pedir(ruta, opciones) {
  const config = Object.assign({ headers: { Accept: 'application/json' } }, opciones || {});
  if (config.body !== undefined && typeof config.body !== 'string') {
    config.method = config.method || 'POST';
    config.headers['Content-Type'] = 'application/json';
    config.body = JSON.stringify(config.body);
  }
  return listo.then(function () {
    return fetch('http://127.0.0.1:' + puerto + ruta, config);
  }).then(function (respuesta) {
    return respuesta.text().then(function (texto) {
      let cuerpo = null;
      if (texto) { try { cuerpo = JSON.parse(texto); } catch (e) { cuerpo = null; } }
      return { estado: respuesta.status, cuerpo: cuerpo, allow: respuesta.headers.get('allow') };
    });
  });
}

test('el servidor queda escuchando solo para estos tests', async () => {
  await listo;
  assert.ok(puerto > 0);
});

test('POST a una ruta de solo lectura responde 405 diciendo que use GET', async () => {
  const r = await pedir('/api/tiendas', { method: 'POST', body: {} });
  assert.equal(r.estado, 405);
  assert.equal(r.allow, 'GET');
  assert.equal(r.cuerpo.metodoEsperado, 'GET');
  assert.match(r.cuerpo.error, /solo acepta GET, no POST/);
});

test('POST a /api/health y a /api/auth/session tambien es 405, no 401', async () => {
  const salud = await pedir('/api/health', { method: 'POST', body: {} });
  assert.equal(salud.estado, 405);
  assert.equal(salud.allow, 'GET');
  const sesion = await pedir('/api/auth/session', { method: 'POST', body: {} });
  assert.equal(sesion.estado, 405);
  assert.equal(sesion.allow, 'GET');
});

test('GET a una ruta de solo lectura NO es 405 (sigue siendo 503 sin hoja)', async () => {
  const salud = await pedir('/api/health');
  assert.equal(salud.estado, 200);
  assert.equal(salud.cuerpo.ok, true);
  const tiendas = await pedir('/api/tiendas');
  assert.equal(tiendas.estado, 503);
  assert.match(tiendas.cuerpo.error, /SHEETS_WEBAPP_URL/);
});

test('una ruta de escritura sigue exigiendo sesion, no 405', async () => {
  const crear = await pedir('/api/ventas', { method: 'POST', body: { lineas: [] } });
  assert.equal(crear.estado, 401);
  const lista = await pedir('/api/ventas?desde=2026-10-08&hasta=2026-10-08');
  assert.equal(lista.estado, 401);
});

test('logout es publico e idempotente: sin sesion responde 200, no 401 ni 405', async () => {
  const r = await pedir('/api/auth/logout', { method: 'POST', body: {} });
  assert.equal(r.estado, 200);
});

test('con sesion de dueno, una ruta inexistente da 404 y una de escritura llega al 503', async () => {
  const auth = require('../src/auth.js');
  const cookie = auth.crearCookie(auth.crearToken({ rol: 'dueno', idTienda: '', nombre: 'Dueno' }));
  const cabecera = { Cookie: cookie.split(';')[0] };

  const inexistente = await pedir('/api/no-existe', { method: 'POST', body: {}, headers: cabecera });
  assert.equal(inexistente.estado, 404);

  const crear = await pedir('/api/ventas', { method: 'POST', body: { lineas: [] }, headers: cabecera });
  assert.equal(crear.estado, 400);

  const lista = await pedir('/api/ventas', { headers: cabecera });
  assert.equal(lista.estado, 503);
  assert.match(lista.cuerpo.error, /SHEETS_WEBAPP_URL/);
});

test('GET a /api/ventas/:id/lineas con POST es 405 aunque exija sesion', async () => {
  const r = await pedir('/api/ventas/ABC123/lineas', { method: 'POST', body: {} });
  assert.equal(r.estado, 405);
  assert.equal(r.allow, 'GET');
});

test.after(function () { return new Promise(function (cerrar) { servidor.close(cerrar); }); });