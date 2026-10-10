// Los botones de "Ajustes" del modo dueno. Estos botones son la unica via para
// dar de alta las cuatro tiendas y los cinco empleados sin tocar la hoja a mano,
// asi que si guardan algo que el servidor no sabe leer, las tiendas quedan sin
// clave y nadie puede entrar. Por eso se prueba el dato exacto que sale del
// servidor hacia la hoja.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'secreto-de-prueba-suficientemente-largo';
process.env.DUENO_PIN_HASH = require('../src/auth.js').hashearClave('clave-dueno');
delete process.env.SHEETS_WEBAPP_URL;
delete process.env.SHEETS_API_KEY;

const sheets = require('../src/sheets.js');
const app = require('../server.js').app;

// Cada escritura que llega a la hoja queda anotada para revisarla.
const escritas = [];
const original = sheets.escribir;
sheets.escribir = function (carga) {
  escritas.push(carga);
  return Promise.resolve({ ok: true, id: 'x' });
};

let servidor = null;
let puerto = 0;
const listo = new Promise(function (resolver) {
  servidor = app.listen(0, '127.0.0.1', function () {
    puerto = servidor.address().port;
    resolver(puerto);
  });
});

test.after(function () {
  sheets.escribir = original;
  if (servidor) { servidor.closeAllConnections(); servidor.close(); }
});

let cookie = '';

function pedir(ruta, opciones) {
  const config = Object.assign({ headers: {} }, opciones || {});
  if (config.cuerpo !== undefined) {
    config.method = config.method || 'POST';
    config.headers['Content-Type'] = 'application/json';
    config.body = JSON.stringify(config.cuerpo);
  }
  if (cookie) config.headers.Cookie = cookie;
  return listo.then(function () {
    return fetch('http://127.0.0.1:' + puerto + ruta, config);
  }).then(function (r) {
    const pegada = r.headers.get('set-cookie');
    if (pegada) cookie = pegada.split(';')[0];
    return r.text().then(function (texto) {
      let cuerpo = null;
      if (texto) { try { cuerpo = JSON.parse(texto); } catch (e) { cuerpo = null; } }
      return { estado: r.status, cuerpo: cuerpo };
    });
  });
}

test('el dueno entra y queda con sesion', async () => {
  const r = await pedir('/api/auth/login', { cuerpo: { dueno: true, clave: 'clave-dueno' } });
  assert.equal(r.estado, 200);
  assert.match(cookie, /^jh_sesion=/);
});

test('guardar precio de referencia: lo que teclea el dueno es en dolares', async () => {
  escritas.length = 0;
  // El dueno teclea 340,00 dólares. La columna guarda centavos.
  const r = await pedir('/api/catalogo/P1/precio', { cuerpo: { precio: '340,00' } });
  assert.equal(r.estado, 200);
  assert.equal(escritas.length, 1);
  assert.equal(escritas[0].tipoOperacion, 'GUARDAR_PRECIO');
  assert.equal(escritas[0].precioUsdCents, 34000, 'tiene que guardar 34000 centavos, no 340 ni 0');
});

test('guardar precio acepta los centavos si viene ese campo', async () => {
  escritas.length = 0;
  await pedir('/api/catalogo/P1/precio', { cuerpo: { precioUsdCents: 1999 } });
  assert.equal(escritas[0].precioUsdCents, 1999);
});

test('guardar precio con algo que no es numero no guarda basura', async () => {
  escritas.length = 0;
  await pedir('/api/catalogo/P1/precio', { cuerpo: { precio: 'treinta' } });
  assert.equal(escritas.length, 1);
  assert.equal(escritas[0].precioUsdCents, 0);
});

test('dar de alta una tienda guarda la clave que el dueno escribio, hasheada', async () => {
  escritas.length = 0;
  const r = await pedir('/api/ajustes/tienda/T1', {
    cuerpo: { nombre: 'Tienda Camila', pctComision: 30, clave: 'clave-camila' }
  });
  assert.equal(r.estado, 200);
  const carga = escritas[0];
  assert.equal(carga.tipoOperacion, 'GUARDAR_TIENDA');
  assert.equal(carga.tienda.idTienda, 'T1');
  assert.equal(carga.tienda.pctComision, 30);
  // La clave nunca viaja en claro: sale como hash scrypt, verificable con
  // src/auth.js.
  const auth = require('../src/auth.js');
  assert.equal(auth.verificarClave('clave-camila', carga.tienda.claveHash), true);
  assert.equal(auth.verificarClave('otra-cosa', carga.tienda.claveHash), false);
  assert.doesNotMatch(String(carga.tienda.claveHash), /clave-camila/);
});

test('dar de alta un empleado lo deja activo y sin clave propia', async () => {
  // La clave es de la tienda, no del empleado: cuatro de las tiendas comparten
  // la misma entre dos personas. El empleado solo queda anotado como quien
  // hizo la venta, asi que no debe llevar hash.
  escritas.length = 0;
  const r = await pedir('/api/ajustes/empleados', {
    cuerpo: { empleados: [{ nombre: 'Camila', idTienda: 'T1' }] }
  });
  assert.equal(r.estado, 200);
  const carga = escritas[0];
  assert.equal(carga.tipoOperacion, 'GUARDAR_EMPLEADOS');
  const e = carga.empleados[0];
  assert.equal(e.nombre, 'Camila');
  assert.equal(e.idTienda, 'T1');
  assert.equal(e.activo, true);
  assert.equal(e.claveHash, undefined);
});

test('si el dueno no escribe clave, la tienda se guarda sin hash y no se inventa', async () => {
  escritas.length = 0;
  await pedir('/api/ajustes/tienda/T9', { cuerpo: { nombre: 'Sin clave', pctComision: 30 } });
  assert.equal(escritas[0].tienda.claveHash, undefined);
});

test('el dueño no puede tocar ajustes sin sesion de dueno', async () => {
  const antes = cookie;
  cookie = '';
  const tienda = await pedir('/api/ajustes/tienda/T1', { cuerpo: { nombre: 'x', pctComision: 30 } });
  assert.equal(tienda.estado, 401);
  const precio = await pedir('/api/catalogo/P1/precio', { cuerpo: { precio: '10' } });
  // El precio si lo puede tocar un encargado, pero sin sesion no.
  assert.equal(precio.estado, 401);
  cookie = antes;
});