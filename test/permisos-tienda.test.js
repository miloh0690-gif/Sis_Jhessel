'use strict';

// Aislamiento por tienda. El spec dice: "Los encargados solo ven y editan su
// propia tienda. No pueden ver otras tiendas." Y el costo de un equipo es
// informacion del dueno: un encargado no debe verlo.
//
// Estos tests fijan tres cosas:
//   1) una venta de otra tienda responde 404 (nunca 403) al cambiar estado,
//      al borrar y al leer sus lineas;
//   2) las lineas propias de un encargado llegan sin costoUnitarioUsdCents,
//      y las del dueno llegan con el costo;
//   3) el dueno si puede pedir una tienda concreta con ?tienda=T2.

const test = require('node:test');
const assert = require('node:assert/strict');

const sheets = require('../src/sheets');
const ledger = require('../src/ledger');
const ventas = require('../src/ventas');
const server = require('../server');

// --- fixtures ---------------------------------------------------------------

function venta(extra) {
  return Object.assign({
    idVenta: 'V1',
    fecha: '2026-10-08',
    dia: '2026-10-08',
    idTienda: 'T1',
    tienda: 'Tienda Camila',
    idEmpleado: 'E1',
    vendedor: 'Camila',
    moneda: 'USD',
    tcDecimas: 725,
    gananciaUsdCents: 3500,
    ajusteUsdCents: 500,
    gananciaBsCents: 25375,
    comisionBsCents: 7613,
    netoDuenoBsCents: 17762,
    totalCobradoUsdCents: 4000,
    estado: 'BORRADOR',
    notas: '',
    idCierre: '',
    unidades: 1,
    lineas: []
  }, extra || {});
}

const VENTA_T1 = venta();
const VENTA_T2 = venta({
  idVenta: 'V2', idTienda: 'T2', tienda: 'Tienda Andre', idEmpleado: 'E2',
  vendedor: 'Andre', estado: 'BORRADOR'
});

const LINEAS = [
  { idVenta: 'V1', idProducto: 'P1', modelo: 'Galaxy A54', cantidad: 1, precioUsdCents: 34000, costoUnitarioUsdCents: 30000, origen: '' },
  { idVenta: 'V2', idProducto: 'P2', modelo: 'Redmi Note 13', cantidad: 1, precioUsdCents: 18500, costoUnitarioUsdCents: 17000, origen: '' }
];

const SESION_TIENDA = { rol: 'tienda', idTienda: 'T1', idEmpleado: 'E1', nombre: 'Tienda Camila' };
const SESION_DUENO = { rol: 'dueno', idTienda: '', idEmpleado: '', nombre: 'Dueño' };

// Arnés: sustituye las lecturas del ledger y anota las escrituras.
function conHoja() {
  const anteriores = {
    escribir: sheets.escribir,
    listarVentas: ledger.listarVentas,
    listarEmpleados: ledger.listarEmpleados,
    listarTiendas: ledger.listarTiendas,
    listarLineasDe: ledger.listarLineasDe
  };
  const escrituras = [];
  sheets.escribir = async function (payload) {
    escrituras.push(payload);
    return { status: 'OK', id: 'V1', duplicada: false };
  };
  ledger.listarVentas = async () => [VENTA_T1, VENTA_T2];
  ledger.listarEmpleados = async () => [{ idEmpleado: 'E1', nombre: 'Camila', idTienda: 'T1', activo: true }];
  ledger.listarTiendas = async () => [
    { idTienda: 'T1', nombre: 'Tienda Camila', pctComision: 30, claveHash: 'x', activa: true },
    { idTienda: 'T2', nombre: 'Tienda Andre', pctComision: 25, claveHash: 'y', activa: true }
  ];
  ledger.listarLineasDe = async function (idVenta) {
    return LINEAS.filter(function (f) { return f.idVenta === idVenta; });
  };
  ventas.limpiarOperaciones();
  const restaurar = function () {
    sheets.escribir = anteriores.escribir;
    ledger.listarVentas = anteriores.listarVentas;
    ledger.listarEmpleados = anteriores.listarEmpleados;
    ledger.listarTiendas = anteriores.listarTiendas;
    ledger.listarLineasDe = anteriores.listarLineasDe;
    ventas.limpiarOperaciones();
  };
  return { escrituras, restaurar };
}

// --- 1) leer las lineas -----------------------------------------------------

test('un encargado NO puede leer las lineas de una venta de otra tienda', function () {
  const hoja = conHoja();
  return assert.rejects(
    function () { return ventas.lineasDeLaSesion({ sesion: SESION_TIENDA, idVenta: 'V2' }); },
    function (e) { return e.codigo === 404; }
  ).finally(hoja.restaurar);
});

test('un encargado NO recibe el costo de las lineas de su propia venta', function () {
  const hoja = conHoja();
  return ventas.lineasDeLaSesion({ sesion: SESION_TIENDA, idVenta: 'V1' })
    .then(function (lineas) {
      assert.equal(lineas.length, 1);
      assert.equal(lineas[0].modelo, 'Galaxy A54');
      assert.equal(lineas[0].costoUnitarioUsdCents, undefined);
    })
    .finally(hoja.restaurar);
});

test('el dueno SI recibe el costo y SI puede leer otra tienda', function () {
  const hoja = conHoja();
  return ventas.lineasDeLaSesion({ sesion: SESION_DUENO, idVenta: 'V2' })
    .then(function (lineas) {
      assert.equal(lineas.length, 1);
      assert.equal(lineas[0].modelo, 'Redmi Note 13');
      assert.equal(lineas[0].costoUnitarioUsdCents, 17000);
    })
    .finally(hoja.restaurar);
});

test('pedir lineas de una venta que no existe responde 404', function () {
  const hoja = conHoja();
  return assert.rejects(
    function () { return ventas.lineasDeLaSesion({ sesion: SESION_DUENO, idVenta: 'V9' }); },
    function (e) { return e.codigo === 404; }
  ).finally(hoja.restaurar);
});

// --- 2) cambiar el estado ---------------------------------------------------

test('un encargado NO confirma una venta de otra tienda', function () {
  const hoja = conHoja();
  return assert.rejects(
    function () {
      return ventas.cambiarEstado({ sesion: SESION_TIENDA, idVenta: 'V2', hasta: 'CONFIRMADA' });
    },
    function (e) { return e.codigo === 404; }
  ).then(function () {
    assert.deepEqual(hoja.escrituras, []);
  }).finally(hoja.restaurar);
});

test('un encargado SI confirma una venta de su propia tienda', function () {
  const hoja = conHoja();
  return ventas.cambiarEstado({ sesion: SESION_TIENDA, idVenta: 'V1', hasta: 'CONFIRMADA' })
    .then(function () {
      assert.equal(hoja.escrituras.length, 1);
      assert.equal(hoja.escrituras[0].tipoOperacion, 'CAMBIAR_ESTADO');
      assert.equal(hoja.escrituras[0].idVenta, 'V1');
    })
    .finally(hoja.restaurar);
});

test('un encargado NO borra un borrador de otra tienda', function () {
  const hoja = conHoja();
  return assert.rejects(
    function () { return ventas.eliminarVenta({ sesion: SESION_TIENDA, idVenta: 'V2' }); },
    function (e) { return e.codigo === 404; }
  ).then(function () {
    assert.deepEqual(hoja.escrituras, []);
  }).finally(hoja.restaurar);
});

test('un encargado SI borra un borrador de su propia tienda', function () {
  const hoja = conHoja();
  return ventas.eliminarVenta({ sesion: SESION_TIENDA, idVenta: 'V1' })
    .then(function () {
      assert.equal(hoja.escrituras.length, 1);
      assert.equal(hoja.escrituras[0].tipoOperacion, 'ELIMINAR_VENTA');
      assert.equal(hoja.escrituras[0].idTienda, 'T1');
    })
    .finally(hoja.restaurar);
});

// --- 3) el filtro por tienda del dueno -------------------------------------

test('el dueno si puede pedir una tienda concreta con ?tienda', function () {
  assert.equal(
    server.tiendaDeLaPeticion({ query: { tienda: 'T2' }, sesion: SESION_DUENO }),
    'T2'
  );
});

test('el dueno ve todas las tiendas si no pide ninguna', function () {
  assert.equal(server.tiendaDeLaPeticion({ query: {}, sesion: SESION_DUENO }), '');
});

test('un encargado no puede salirse de su tienda con ?tienda', function () {
  assert.equal(
    server.tiendaDeLaPeticion({ query: { tienda: 'T2' }, sesion: SESION_TIENDA }),
    'T1'
  );
});