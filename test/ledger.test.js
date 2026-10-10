'use strict';

// Prueba del ledger con las hojas mockeadas: interceptamos sheets.leer para
// devolver filas crudas tal como las manda el .gs, sin tocar la red.
const assert = require('node:assert/strict');

const test = require('node:test');
const sheets = require('../src/sheets');
const ledger = require('../src/ledger');

const VENTAS_CRUDAS = [
  // cabecera: IdVenta Fecha IdTienda Tienda IdEmpleado Vendedor Moneda TcDecimas
  //           GananciaUsdCents AjusteUsdCents GananciaBsCents ComisionBsCents
  //           NetoDuenoBsCents TotalCobradoUsdCents Estado Notas IdCierre
  ['V1', '2026-10-08', 'T1', 'Sucursal Uno', 'E1', 'Camila', 'BS', '725',
    '4000', '500', '25375', '7500', '17875', '34000', 'CONFIRMADA', 'le regalé un vidrio', ''],
  ['V2', '2026-10-08', 'T1', 'Sucursal Uno', 'E2', 'Andre', 'USD', '700',
    '-1000', '0', '-7000', '0', '-7000', '20000', 'CERRADA', '', ''],
  ['V3', '2026-10-07', 'T2', 'Sucursal Dos', 'E3', 'Miros', 'BS', '730',
    '90000', '0', '6570000', '1971000', '4599000', '90000', 'BORRADOR', '', '']
];

const TIENDAS_CRUDAS = [
  ['T1', 'Sucursal Uno', 'Camila|Andre', '3000', '', '1'],
  ['T2', 'Sucursal Dos', 'Miros', '2500', '', '1']
];

const EMPLEADOS_CRUDAS = [
  ['E1', 'Camila', 'T1', '1'],
  ['E2', 'Andre', 'T1', '1'],
  ['E3', 'Miros', 'T2', '1']
];

function conHojasMockeadas(fn) {
  const anterior = sheets.leer;
  sheets.leer = async function (accion) {
    if (accion === 'REPORTE_VENTAS') return { status: 'OK', ventas: VENTAS_CRUDAS };
    if (accion === 'REPORTE_TIENDAS') return { status: 'OK', filas: TIENDAS_CRUDAS };
    if (accion === 'REPORTE_EMPLEADOS') return { status: 'OK', filas: EMPLEADOS_CRUDAS };
    if (accion === 'REPORTE_LINEAS') {
      return { status: 'OK', filas: [['V1', 'P1', 'X1 Pro', '1', '30000', '21000', '']] };
    }
    return { status: 'OK', filas: [] };
  };
  return Promise.resolve()
    .then(fn)
    .then(function (r) { sheets.leer = anterior; return r; },
      function (e) { sheets.leer = anterior; throw e; });
}

test('listarVentas lee los enteros tal cual y saca el dia de la fecha', function () {
  return conHojasMockeadas(async function () {
    const ventas = await ledger.listarVentas({ desde: '2026-10-01', hasta: '2026-10-31' });
    assert.equal(ventas.length, 3);
    assert.equal(ventas[0].gananciaBsCents, 25375);
    assert.equal(ventas[0].ajusteUsdCents, 500);
    assert.equal(ventas[0].estado, 'CONFIRMADA');
    assert.equal(ventas[0].dia, '2026-10-08');
    assert.equal(ventas[0].notas, 'le regalé un vidrio');
    assert.equal(ventas[0].tcDecimas, 725);
    assert.equal(ventas[0].vendedor, 'Camila');
    assert.equal(ventas[0].tienda, 'Sucursal Uno');
    assert.equal(ventas[0].lineas.length, 0, 'las lineas se piden aparte');
  });
});

test('los negativos se conservan: la comision de una perdida es 0', function () {
  return conHojasMockeadas(async function () {
    const ventas = await ledger.listarVentas({});
    const v2 = ventas.find(function (v) { return v.idVenta === 'V2'; });
    assert.equal(v2.gananciaBsCents, -7000);
    assert.equal(v2.comisionBsCents, 0);
    assert.equal(v2.netoDuenoBsCents, -7000);
  });
});

test('listarVentas filtra por rango y por tienda', function () {
  return conHojasMockeadas(async function () {
    assert.equal((await ledger.listarVentas({ desde: '2026-10-08', hasta: '2026-10-08' })).length, 2);
    assert.equal((await ledger.listarVentas({ desde: '2026-10-07', hasta: '2026-10-07' })).length, 1);
    assert.equal((await ledger.listarVentas({ idTienda: 'T2' })).length, 1);
    assert.equal((await ledger.listarVentas({ idTienda: 'T9' })).length, 0);
  });
});

test('consolidar suma las 3 ventas y deja 1 pendiente en T1', function () {
  return conHojasMockeadas(async function () {
    const c = await ledger.consolidar({ desde: '2026-10-01', hasta: '2026-10-31' });
    assert.equal(c.resumen.cantidadVentas, 3);
    assert.equal(c.resumen.totalGananciaBsCents, 25375 - 7000 + 6570000);
    assert.equal(c.resumen.totalComisionBsCents, 7500 + 0 + 1971000);
    const t1 = c.resumen.porTienda.find(function (t) { return t.idTienda === 'T1'; });
    assert.equal(t1.pendientes, 1);
    const t2 = c.resumen.porTienda.find(function (t) { return t.idTienda === 'T2'; });
    assert.equal(t2.pendientes, 0);
    assert.equal(c.tiendas.length, 2);
    assert.equal(c.tiendas[0].pctComision, 3000);
    assert.equal(c.ventas.length, 3);
  });
});

test('consolidar de una sola tienda no mezcla las otras', function () {
  return conHojasMockeadas(async function () {
    const c = await ledger.consolidar({ idTienda: 'T2' });
    assert.equal(c.resumen.cantidadVentas, 1);
    assert.equal(c.resumen.totalGananciaBsCents, 6570000);
    assert.equal(c.resumen.porTienda.length, 1);
  });
});

test('listarTiendas y listarEmpleados normalizan las filas de la hoja', function () {
  return conHojasMockeadas(async function () {
    const tiendas = await ledger.listarTiendas();
    assert.equal(tiendas.length, 2);
    assert.equal(tiendas[0].idTienda, 'T1');
    assert.equal(tiendas[0].nombre, 'Sucursal Uno');
    assert.equal(tiendas[0].pctComision, 3000);
    assert.equal(tiendas[0].activa, true);
    assert.equal(tiendas[1].pctComision, 2500);

    const empleados = await ledger.listarEmpleados();
    assert.equal(empleados.length, 3);
    assert.equal(empleados[0].idEmpleado, 'E1');
    assert.equal(empleados[0].nombre, 'Camila');
    assert.equal(empleados[0].idTienda, 'T1');
    assert.equal(empleados[0].activo, true);
  });
});

test('listarLineasDe devuelve las lineas de una venta', function () {
  return conHojasMockeadas(async function () {
    const lineas = await ledger.listarLineasDe('V1');
    assert.equal(lineas.length, 1);
    assert.equal(lineas[0].idVenta, 'V1');
    assert.equal(lineas[0].modelo, 'X1 Pro');
    assert.equal(lineas[0].cantidad, 1);
    assert.equal(lineas[0].precioUsdCents, 30000);
    assert.equal(lineas[0].costoUnitarioUsdCents, 21000);
  });
});

test('una hoja vacia devuelve listas vacias y no revienta', function () {
  const anterior = sheets.leer;
  sheets.leer = async function () { return { status: 'OK', ventas: [], filas: [] }; };
  return Promise.resolve()
    .then(async function () {
      assert.deepEqual(await ledger.listarVentas({}), []);
      assert.deepEqual(await ledger.listarTiendas(), []);
      assert.deepEqual(await ledger.listarCierres({}), []);
      assert.deepEqual(await ledger.listarTc({}), []);
      assert.deepEqual(await ledger.listarCatalogo({}), []);
      assert.deepEqual(await ledger.listarLineasDe('V9'), []);
      const c = await ledger.consolidar({});
      assert.equal(c.resumen.cantidadVentas, 0);
    })
    .then(function () { sheets.leer = anterior; },
      function (e) { sheets.leer = anterior; throw e; });
});

test('nuevoId genera ids distintos y con el prefijo pedido', function () {
  const a = ledger.nuevoId('V');
  const b = ledger.nuevoId('V');
  assert.ok(a.indexOf('V') === 0, a);
  assert.ok(b.indexOf('V') === 0, b);
  assert.notEqual(a, b);
});

test('normalizar se reexporta desde el ledger', function () {
  assert.equal(ledger.normalizar('  Camará  Póker '), 'camara poker');
});