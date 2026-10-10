// Punta a punta: el server.js real hablando con el Code.gs real sobre una hoja
// de Sheets simulada. Ningun modulo esta simulado; lo unico falso es Google.
//
// Este test es el que faltaba: hasta ahora server.js se probaba con las hojas
// inyectadas y Code.gs se probaba con llamadas directas, asi que el contrato
// entre los dos (nombres de campos, tipos de las filas, forma de la respuesta)
// no lo cubria nadie. Es justo lo que se rompe cuando se conecta el script de
// verdad.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const falsa = require('./hoja-falsa.js');

const CLAVE_DUENO = 'clave-del-dueno-en-prueba';

// El servidor fecha la venta con la hora actual; el cierre se prueba sobre ese dia.
const HOY = new Date().toISOString().slice(0, 10);

// 1. Primero el web app falso, porque su URL es una variable de entorno que
// server.js lee al cargarse.
const entorno = falsa.crearEntorno();
const webApp = falsa.servidorWebApp(entorno);

let cookieTienda = '';
let cookieDueno = '';

const listo = webApp.listo.then(function (url) {
  process.env.SHEETS_WEBAPP_URL = url;
  process.env.SHEETS_API_KEY = falsa.CLAVE;
  process.env.SESSION_SECRET = 'secreto-de-prueba-e2e-suficientemente-largo';
  const auth = require('../src/auth.js');
  process.env.DUENO_PIN_HASH = auth.hashearClave(CLAVE_DUENO);
  delete process.env.NODE_ENV;
});

let servidorApp = null;
let puertoApp = 0;

function pedir(ruta, opciones) {
  const config = Object.assign({ headers: { Accept: 'application/json' } }, opciones || {});
  if (config.guardarCookie) {
    // Set-Cookie trae atributos (Path, HttpOnly, Max-Age) que NO van en el
    // header Cookie: al reenviarla solo se manda el primer par nombre=valor.
    config.headers.Cookie = String(config.guardarCookie).split(';')[0];
  }
  delete config.guardarCookie;
  if (config.body !== undefined) {
    config.method = config.method || 'POST';
    config.headers['Content-Type'] = 'application/json';
    config.body = JSON.stringify(config.body);
  }
  return fetch('http://127.0.0.1:' + puertoApp + ruta, config).then(function (r) {
    return r.text().then(function (texto) {
      let cuerpo = null;
      if (texto) { try { cuerpo = JSON.parse(texto); } catch (e) { cuerpo = null; } }
      return { estado: r.status, cuerpo: cuerpo, encabezados: r.headers };
    });
  });
}

test.before(async function () {
  await listo;
  const app = require('../server.js').app;
  // listen() devuelve el Server; app es la app de Express y no tiene address().
  await new Promise(function (resolver) {
    servidorApp = app.listen(0, '127.0.0.1', function () {
      puertoApp = servidorApp.address().port;
      resolver();
    });
  });
});

test.after(async function () {
  await webApp.cerrar();
  if (servidorApp && servidorApp.listening) {
    await new Promise(function (c) {
      if (servidorApp.closeAllConnections) servidorApp.closeAllConnections();
      servidorApp.close(c);
    });
  }
});

const CUERPO_VENTA = {
  idEmpleado: 'E1',
  moneda: 'USD',
  tipoCambio: '7,25',
  lineas: [{ idProducto: 'P1', modelo: 'Samsung Galaxy A54 5G', cantidad: 1, precio: 340, costo: 300, origen: 'catalogo' }],
  ajuste: 5,
  notas: 'le regalé un vidrio',
  claveIdempotencia: 'e2eclave0001'
};

let idVenta = '';

test('el dueno da de alta la tienda y su empleado', async function () {
  const hash = require('../src/auth.js').hashearClave('1234');

  const login = await pedir('/api/auth/login', { body: { dueno: true, clave: CLAVE_DUENO } });
  assert.equal(login.estado, 200, 'el dueno no pudo entrar: ' + JSON.stringify(login.cuerpo));
  cookieDueno = login.encabezados.get('set-cookie');

  const altaTienda = await pedir('/api/ajustes/tienda/T1', {
    method: 'POST',
    guardarCookie: cookieDueno,
    body: { nombre: 'Tienda Camila', pctComision: 30, claveHash: hash, activa: true }
  });
  assert.equal(altaTienda.estado, 200, JSON.stringify(altaTienda.cuerpo));

  const empleados = await pedir('/api/ajustes/empleados', {
    method: 'POST',
    guardarCookie: cookieDueno,
    body: { empleados: [{ idEmpleado: 'E1', nombre: 'Camila', idTienda: 'T1', activo: true }] }
  });
  assert.equal(empleados.estado, 200, JSON.stringify(empleados.cuerpo));
});

test('el dueno ve las tiendas por GET, no por POST', async function () {
  const r = await pedir('/api/tiendas');
  assert.equal(r.estado, 200, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.tiendas.length, 1);
  assert.equal(r.cuerpo.tiendas[0].idTienda, 'T1');
  assert.equal(r.cuerpo.tiendas[0].claveHash, undefined, 'se filtro la claveHash');
});

test('la tienda entra con su clave compartida', async function () {
  const mala = await pedir('/api/auth/login', { body: { idTienda: 'T1', clave: '9999' } });
  assert.equal(mala.estado, 401);

  const buena = await pedir('/api/auth/login', { body: { idTienda: 'T1', clave: '1234' } });
  assert.equal(buena.estado, 200, JSON.stringify(buena.cuerpo));
  cookieTienda = buena.encabezados.get('set-cookie');
  assert.ok(cookieTienda && cookieTienda.indexOf('jh_sesion=') === 0, 'no vino Set-Cookie');
});

test('la tienda ve sus empleados y el TC de hoy', async function () {
  const empleados = await pedir('/api/empleados', { guardarCookie: cookieTienda });
  assert.equal(empleados.estado, 200, JSON.stringify(empleados.cuerpo));
  assert.equal(empleados.cuerpo.empleados.length, 1);
  assert.equal(empleados.cuerpo.empleados[0].nombre, 'Camila');

  const tc = await pedir('/api/tc-hoy', { guardarCookie: cookieTienda });
  assert.equal(tc.estado, 200, JSON.stringify(tc.cuerpo));
});

test('el preview del encargado da los totales en Bs y oculta los costos', async function () {
  const r = await pedir('/api/ventas/preview', { guardarCookie: cookieTienda, body: CUERPO_VENTA });
  assert.equal(r.estado, 200, JSON.stringify(r.cuerpo));
  const t = r.cuerpo.venta;
  assert.equal(t.gananciaBsCents, 25375);
  assert.equal(t.comisionBsCents, 7613);
  assert.equal(t.netoDuenoBsCents, 17762);
  // El encargado no ve cuanto costo el equipo: es informacion del dueno.
  assert.equal(t.gananciaBrutaUsdCents, undefined, 'el preview filtro mal: llego la ganancia en USD');
  assert.equal(t.costoTotalUsdCents, undefined, 'el preview filtro mal: llego el costo');
});

test('el preview del dueno si ve los totales en USD', async function () {
  const r = await pedir('/api/ventas/preview', {
    guardarCookie: cookieDueno,
    body: Object.assign({}, CUERPO_VENTA, { idTienda: 'T1' })
  });
  assert.equal(r.estado, 200, JSON.stringify(r.cuerpo));
  const t = r.cuerpo.venta;
  assert.equal(t.gananciaBrutaUsdCents, 4000);
  assert.equal(t.ajustesUsdCents, 500);
  assert.equal(t.gananciaNetaUsdCents, 3500);
  assert.equal(t.gananciaBsCents, 25375);
  assert.equal(t.comisionBsCents, 7613);
  assert.equal(t.netoDuenoBsCents, 17762);
});

test('guardar la venta escribe en la hoja y devuelve el id', async function () {
  const r = await pedir('/api/ventas', { guardarCookie: cookieTienda, body: CUERPO_VENTA });
  assert.equal(r.estado, 200, JSON.stringify(r.cuerpo));
  idVenta = r.cuerpo.venta.idVenta;
  assert.ok(idVenta, 'no vino idVenta: ' + JSON.stringify(r.cuerpo));

  const ventas = entorno.hojas.Ventas.datos;
  assert.equal(ventas.length, 2, 'la hoja deberia tener encabezado + 1 venta');
  const cab = ventas[0];
  const fila = ventas[1];
  const leer = function (nombre) { return fila[cab.indexOf(nombre)]; };
  assert.equal(leer('IdVenta'), idVenta);
  assert.equal(leer('TcDecimas'), 725, 'TcDecimas deberia ser 725');
  assert.equal(leer('IdTienda'), 'T1');
  assert.equal(leer('ComisionBsCents'), 7613);
  assert.equal(leer('NetoDuenoBsCents'), 17762);
  assert.equal(leer('Notas'), 'le regalé un vidrio');

  assert.ok(entorno.hojas.VentaLineas.datos.length >= 2, 'no se escribieron las lineas');
  assert.ok(entorno.hojas.TcDia.datos.length >= 2, 'no se escribio el TcDia');
});

test('reintentar con la misma clave no crea una segunda venta', async function () {
  const r = await pedir('/api/ventas', { guardarCookie: cookieTienda, body: CUERPO_VENTA });
  assert.equal(r.estado, 200);
  assert.equal(entorno.hojas.Ventas.datos.length, 2, 'se duplico la venta en la hoja');
});

test('el idTienda del cuerpo se ignora: manda el de la sesion', async function () {
  const r = await pedir('/api/ventas/preview', {
    guardarCookie: cookieTienda,
    body: Object.assign({}, CUERPO_VENTA, { idTienda: 'T9' })
  });
  assert.equal(r.estado, 200);
  assert.equal(r.cuerpo.venta.comisionBsCents, 7613, 'la comision cambio al mandar otra tienda');
});

test('listar ventas funciona con GET y trae la venta', async function () {
  const r = await pedir('/api/ventas?desde=2020-01-01&hasta=2099-01-01', { guardarCookie: cookieTienda });
  assert.equal(r.estado, 200, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.ventas.length, 1);
  assert.equal(r.cuerpo.ventas[0].idVenta, idVenta);
  assert.equal(r.cuerpo.ventas[0].netoDuenoBsCents, 17762);
});

test('un encargado no ve el costo de la venta en sus lineas', async function () {
  const r = await pedir('/api/ventas/' + idVenta + '/lineas', { guardarCookie: cookieTienda });
  assert.equal(r.estado, 200, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.lineas.length, 1);
  assert.equal(r.cuerpo.lineas[0].costoUnitarioUsdCents, undefined, 'se filtro el costo al encargado');
});

test('el dueno si ve el costo', async function () {
  const r = await pedir('/api/ventas/' + idVenta + '/lineas', { guardarCookie: cookieDueno });
  assert.equal(r.estado, 200, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.lineas[0].costoUnitarioUsdCents, 30000);
});

test('el encargado confirma su venta', async function () {
  const r = await pedir('/api/ventas/' + idVenta + '/estado', {
    guardarCookie: cookieTienda,
    body: { hasta: 'CONFIRMADA' }
  });
  assert.equal(r.estado, 200, JSON.stringify(r.cuerpo));
  const ventas = entorno.hojas.Ventas.datos;
  assert.equal(ventas[1][15], 'CONFIRMADA', 'el estado en la hoja quedo: ' + ventas[1][15]);
});

test('el dueno previsualiza y cierra el dia', async function () {
  const preview = await pedir('/api/cierres/preview', {
    method: 'POST',
    guardarCookie: cookieDueno,
    body: { idTienda: 'T1', dia: HOY }
  });
  assert.equal(preview.estado, 200, JSON.stringify(preview.cuerpo));
  assert.ok(preview.cuerpo.vista, 'la respuesta no vino en {vista}: ' + JSON.stringify(preview.cuerpo));
  assert.equal(preview.cuerpo.vista.pendientes, 1, 'no vio la venta confirmada como pendiente');

  const cierre = await pedir('/api/cierres', {
    method: 'POST',
    guardarCookie: cookieDueno,
    body: { idTienda: 'T1', dia: HOY, pagadoBsCents: 17762 }
  });
  assert.equal(cierre.estado, 200, JSON.stringify(cierre.cuerpo));

  const ventas = entorno.hojas.Ventas.datos;
  assert.equal(ventas[1][15], 'CERRADA', 'la venta no quedo CERRADA: ' + ventas[1][15]);
  assert.ok(entorno.hojas.Cierres.datos.length >= 2, 'no se escribio el recibo');
});

test('tras el cierre no quedan ventas pendientes', async function () {
  const r = await pedir('/api/cierres/preview', {
    method: 'POST',
    guardarCookie: cookieDueno,
    body: { idTienda: 'T1', dia: HOY }
  });
  assert.equal(r.cuerpo.vista.pendientes, 0);
});

test('el consolidado del dueno ve la tienda con el neto correcto', async function () {
  const r = await pedir('/api/resumen?desde=2020-01-01&hasta=2099-01-01', { guardarCookie: cookieDueno });
  assert.equal(r.estado, 200, JSON.stringify(r.cuerpo));
  const s = r.cuerpo.resumen;
  assert.ok(s, 'no vino resumen: ' + JSON.stringify(r.cuerpo));
  assert.equal(s.totalNetoDuenoBsCents, 17762);
  assert.ok(s.porTienda && s.porTienda.length >= 1, 'no vino porTienda');
});

test('un encargado no puede cerrar el dia', async function () {
  const r = await pedir('/api/cierres', {
    method: 'POST',
    guardarCookie: cookieTienda,
    body: { idTienda: 'T1', dia: HOY, pagadoBsCents: 0 }
  });
  assert.equal(r.estado, 404, 'un encargado cerro el dia: ' + r.estado);
});

test('el diagnostico dice que todo esta en su sitio', async function () {
  const r = await pedir('/api/diagnostico');
  assert.equal(r.estado, 200, JSON.stringify(r.cuerpo));
  const pasos = r.cuerpo.pasos || [];
  assert.equal(pasos.length, 4);
  for (const paso of pasos) {
    assert.equal(paso.ok, true, 'paso ' + paso.paso + ' fallo: ' + paso.detalle);
  }
});

test('el web app responde el puerto de salud sin clave', async function () {
  const url = process.env.SHEETS_WEBAPP_URL + '?action=SALUD';
  const r = await fetch(url);
  assert.equal(r.status, 200);
  const cuerpo = await r.json();
  assert.equal(cuerpo.ok, true, 'el script no respondio al puerto de salud');
});