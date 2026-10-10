'use strict';

// Pruebas de ventas.js: validacion de entrada, calculo autoritativo,
// idempotencia de dos capas y transiciones de estado.
// La hoja esta mockeada: sheets.escribir cuenta llamadas y ledger devuelve
// empleados, tiendas y ventas controladas por cada prueba.

const assert = require('node:assert/strict');
const test = require('node:test');

const sheets = require('../src/sheets');
const ledger = require('../src/ledger');
const ventas = require('../src/ventas');

const EMPLEADOS = [
  { idEmpleado: 'E1', nombre: 'Camila', idTienda: 'T1', activo: true },
  { idEmpleado: 'E2', nombre: 'Andre', idTienda: 'T2', activo: true }
];

const TIENDAS = [
  { idTienda: 'T1', nombre: 'Tienda Camila', pctComision: 30, claveHash: 'x', activa: true },
  { idTienda: 'T2', nombre: 'Tienda Andre', pctComision: 25, claveHash: 'y', activa: true }
];

const SESION = { rol: 'TIENDA', idTienda: 'T1', idEmpleado: 'E1', nombre: 'Camila' };
const SESION_DUENO = { rol: 'DUENO', idTienda: '', idEmpleado: '', nombre: 'Dueño' };

const CUERPO = {
  idEmpleado: 'E1',
  idTienda: 'T2', // intenta colarse en otra tienda
  moneda: 'USD',
  tipoCambio: '7,25',
  lineas: [{ modelo: 'Galaxy A54', cantidad: 1, precio: '340', costo: '300' }],
  ajuste: '5',
  notas: 'le regalé un vidrio',
  claveIdempotencia: 'abc123def456'
};

// Reemplaza la hoja por un stub y devuelve el restaurador.
function conHoja(opciones) {
  const op = opciones || {};
  const anteriores = {
    escribir: sheets.escribir,
    listarVentas: ledger.listarVentas,
    listarEmpleados: ledger.listarEmpleados,
    listarTiendas: ledger.listarTiendas
  };
  const escrituras = [];
  sheets.escribir = async function (payload) {
    escrituras.push(payload);
    return { status: 'OK', id: op.idDevuelto || 'V1', duplicada: op.duplicada === true };
  };
  ledger.listarVentas = async () => (op.ventas || []).slice();
  ledger.listarEmpleados = async () => EMPLEADOS.slice();
  ledger.listarTiendas = async () => TIENDAS.slice();
  ventas.limpiarOperaciones();
  const restaurar = function () {
    sheets.escribir = anteriores.escribir;
    ledger.listarVentas = anteriores.listarVentas;
    ledger.listarEmpleados = anteriores.listarEmpleados;
    ledger.listarTiendas = anteriores.listarTiendas;
    ventas.limpiarOperaciones();
  };
  return { escrituras, restaurar };
}

// --- 1) calculo autoritativo ---------------------------------------------

test('preparar ignora el idTienda del cuerpo y usa el de la sesion', function () {
  const hoja = conHoja();
  return ventas.preparar({ sesion: SESION, cuerpo: CUERPO })
    .then(function (p) {
      assert.equal(p.venta.idTienda, 'T1');
      assert.equal(p.venta.tcDecimas, 725);
      assert.equal(p.venta.gananciaBrutaUsdCents, 4000);
      assert.equal(p.venta.ajusteUsdCents, 500);
      assert.equal(p.venta.ajustesUsdCents, 500);
      assert.equal(p.venta.gananciaNetaUsdCents, 3500);
      assert.equal(p.venta.gananciaBsCents, 25375);
      // 25.375 x 30% = 7.612,5 -> 7.613
      assert.equal(p.venta.comisionBsCents, 7613);
      assert.equal(p.venta.netoDuenoBsCents, 17762);
      assert.equal(p.venta.estado, 'BORRADOR');
      assert.equal(p.venta.vendedor, 'Camila');
      assert.equal(p.venta.pctComisionBp, 3000);
      assert.equal(p.venta.notas, 'le regalé un vidrio');
      assert.equal(p.lineas.length, 1);
      assert.equal(p.lineas[0].precioUsdCents, 34000);
      assert.equal(p.lineas[0].costoUnitarioUsdCents, 30000);
    })
    .finally(hoja.restaurar);
});

test('preparar convierte el precio tecleado en Bs a USD con el TC de la venta', function () {
  const hoja = conHoja();
  const cuerpo = {
    idEmpleado: 'E1',
    moneda: 'BS',
    tipoCambio: '7,25',
    lineas: [{ modelo: 'Galaxy A54', cantidad: 2, precio: '2465', costo: '300' }],
    ajuste: '0',
    claveIdempotencia: 'precioBs01'
  };
  return ventas.preparar({ sesion: SESION, cuerpo: cuerpo })
    .then(function (p) {
      // 2465 Bs -> round(246500 * 100 / 725) = 34000 centavos de dolar
      assert.equal(p.lineas[0].precioUsdCents, 34000);
      assert.equal(p.venta.gananciaBrutaUsdCents, 8000);
      assert.equal(p.venta.gananciaBsCents, 58000);
    })
    .finally(hoja.restaurar);
});

// --- 2) validaciones -------------------------------------------------------

test('preparar rechaza un tipo de cambio cero', function () {
  const hoja = conHoja();
  return assert.rejects(
    () => ventas.preparar({ sesion: SESION, cuerpo: Object.assign({}, CUERPO, { tipoCambio: '0' }) }),
    function (e) { return e.codigo === 400 && /tipo de cambio/i.test(e.message); }
  ).finally(hoja.restaurar);
});

test('preparar rechaza una venta sin lineas', function () {
  const hoja = conHoja();
  return assert.rejects(
    () => ventas.preparar({ sesion: SESION, cuerpo: Object.assign({}, CUERPO, { lineas: [] }) }),
    function (e) { return e.codigo === 400; }
  ).finally(hoja.restaurar);
});

test('preparar rechaza una linea con cantidad cero', function () {
  const hoja = conHoja();
  const cuerpo = Object.assign({}, CUERPO, {
    lineas: [{ modelo: 'X', cantidad: 0, precio: '1', costo: '1' }]
  });
  return assert.rejects(
    () => ventas.preparar({ sesion: SESION, cuerpo: cuerpo }),
    function (e) { return e.codigo === 400; }
  ).finally(hoja.restaurar);
});

test('preparar rechaza un empleado de otra tienda', function () {
  const hoja = conHoja();
  return assert.rejects(
    () => ventas.preparar({ sesion: SESION, cuerpo: Object.assign({}, CUERPO, { idEmpleado: 'E2' }) }),
    function (e) { return e.codigo === 400 && /empleado/i.test(e.message); }
  ).finally(hoja.restaurar);
});

test('preparar rechaza una moneda desconocida', function () {
  const hoja = conHoja();
  return assert.rejects(
    () => ventas.preparar({ sesion: SESION, cuerpo: Object.assign({}, CUERPO, { moneda: 'YUAN' }) }),
    function (e) { return e.codigo === 400 && /moneda/i.test(e.message); }
  ).finally(hoja.restaurar);
});

test('preparar nunca acepta un porcentaje de comision inventado por el cliente', function () {
  const hoja = conHoja();
  const cuerpo = Object.assign({}, CUERPO, { pctComision: '90' });
  return ventas.preparar({ sesion: SESION, cuerpo: cuerpo })
    .then(function (p) {
      assert.equal(p.venta.pctComisionBp, 3000); // el de la tienda T1, no el 90 del cuerpo
    })
    .finally(hoja.restaurar);
});

test('preparar sanea las notas y les corta a 500 caracteres', function () {
  const hoja = conHoja();
  const cuerpo = Object.assign({}, CUERPO, { notas: '=2+2 lmgs\n' + 'x'.repeat(600) });
  return ventas.preparar({ sesion: SESION, cuerpo: cuerpo })
    .then(function (p) {
      assert.ok(p.venta.notas.indexOf('\n') === -1, 'sin salto de linea');
      assert.ok(p.venta.notas.indexOf('=') !== 0, 'no empieza con = (inyeccion de formula)');
      assert.ok(p.venta.notas.length <= 501, 'cortada a 500');
    })
    .finally(hoja.restaurar);
});

// --- 3) idempotencia de dos capas -----------------------------------------

test('la misma clave dos veces produce una sola escritura', function () {
  const hoja = conHoja();
  return ventas.guardar({ sesion: SESION, cuerpo: CUERPO })
    .then(function (a) {
      return ventas.guardar({ sesion: SESION, cuerpo: CUERPO }).then(function (b) {
        assert.equal(b.repetida, true);
        assert.equal(b.venta.idVenta, a.venta.idVenta);
        assert.equal(hoja.escrituras.length, 1); // UNA sola ida a la hoja
        assert.equal(hoja.escrituras[0].tipoOperacion, 'GUARDAR_VENTA');
        assert.equal(hoja.escrituras[0].venta.claveIdempotencia, 'abc123def456');
        assert.equal(hoja.escrituras[0].venta.idTienda, 'T1');
        assert.ok(hoja.escrituras[0].lineas.length === 1, 'las lineas van en la misma llamada');
        assert.equal(hoja.escrituras[0].tcDia.tcDecimas, 725);
      });
    })
    .finally(hoja.restaurar);
});

test('la hoja tambien deduplica: duplicada:true no se vuelve a escribir', function () {
  const hoja = conHoja({ idDevuelto: 'V9', duplicada: true });
  return ventas.guardar({ sesion: SESION, cuerpo: CUERPO })
    .then(function (c) {
      assert.equal(c.repetida, true);
      assert.equal(c.venta.idVenta, 'V9');
      assert.equal(hoja.escrituras.length, 1);
    })
    .finally(hoja.restaurar);
});

test('un reintento con el cuerpo corrupto devuelve la respuesta previa, no un 400', function () {
  const hoja = conHoja();
  return ventas.guardar({ sesion: SESION, cuerpo: CUERPO })
    .then(function (a) {
      const roto = Object.assign({}, CUERPO, { lineas: [], claveIdempotencia: 'abc123def456' });
      return ventas.guardar({ sesion: SESION, cuerpo: roto }).then(function (b) {
        assert.equal(b.repetida, true);
        assert.equal(b.venta.idVenta, a.venta.idVenta);
        assert.equal(hoja.escrituras.length, 1);
      });
    })
    .finally(hoja.restaurar);
});

test('una clave vacia o corta se genera sola y no colisiona', function () {
  const hoja = conHoja();
  const a = Object.assign({}, CUERPO, { claveIdempotencia: 'corta' });
  const b = Object.assign({}, CUERPO, { claveIdempotencia: undefined });
  return ventas.guardar({ sesion: SESION, cuerpo: a })
    .then(function (r1) {
      return ventas.guardar({ sesion: SESION, cuerpo: b }).then(function (r2) {
        assert.equal(r1.repetida, false);
        assert.equal(r2.repetida, false);
        assert.notEqual(
          hoja.escrituras[0].venta.claveIdempotencia,
          hoja.escrituras[1].venta.claveIdempotencia
        );
        assert.equal(hoja.escrituras.length, 2);
      });
    })
    .finally(hoja.restaurar);
});

test('una venta con perdida no genera comision', function () {
  const hoja = conHoja();
  const cuerpo = Object.assign({}, CUERPO, {
    lineas: [{ modelo: 'X', cantidad: 1, precio: '100', costo: '400' }],
    ajuste: '0',
    claveIdempotencia: 'perdida0001'
  });
  return ventas.guardar({ sesion: SESION, cuerpo: cuerpo })
    .then(function (r) {
      // -300 USD x 7,25 = -2175 Bs
      assert.equal(r.venta.gananciaBsCents, -217500);
      assert.equal(r.venta.comisionBsCents, 0);
      assert.equal(r.venta.netoDuenoBsCents, -217500);
    })
    .finally(hoja.restaurar);
});

// --- 4) estados ------------------------------------------------------------

const VENTA_CERRADA = {
  idVenta: 'V1',
  estado: 'CERRADA',
  idTienda: 'T1',
  idEmpleado: 'E1',
  vendedor: 'Camila',
  dia: '2026-10-09',
  lineaCount: 0,
  lineas: []
};

test('cambiarEstado respeta la tabla de transiciones y responde 404 al rechazar', function () {
  const hoja = conHoja({ ventas: [VENTA_CERRADA] });
  return assert.rejects(
    () => ventas.cambiarEstado({ sesion: SESION, idVenta: 'V1', hasta: 'CONFIRMADA' }),
    function (e) { return e.codigo === 404; }
  ).finally(hoja.restaurar);
});

test('reabrir una venta cerrada exige un motivo de 10 caracteres', function () {
  const hoja = conHoja({ ventas: [VENTA_CERRADA] });
  return assert.rejects(
    () => ventas.cambiarEstado({ sesion: SESION_DUENO, idVenta: 'V1', hasta: 'CONFIRMADA', motivo: 'mal' }),
    function (e) { return e.codigo === 400 && /motivo/i.test(e.message); }
  ).finally(hoja.restaurar);
});

test('el dueno reabre una cerrada con motivo y escribe CAMBIAR_ESTADO', function () {
  const hoja = conHoja({ ventas: [VENTA_CERRADA] });
  return ventas.cambiarEstado({
    sesion: SESION_DUENO,
    idVenta: 'V1',
    hasta: 'CONFIRMADA',
    motivo: 'falta玻璃 del cliente'
  })
    .then(function (r) {
      assert.equal(r.venta.estado, 'CONFIRMADA');
      assert.equal(hoja.escrituras.length, 1);
      assert.equal(hoja.escrituras[0].tipoOperacion, 'CAMBIAR_ESTADO');
      assert.equal(hoja.escrituras[0].idVenta, 'V1');
      assert.equal(hoja.escrituras[0].hasta, 'CONFIRMADA');
    })
    .finally(hoja.restaurar);
});

test('cambiarEstado responde 404 si la venta no existe', function () {
  const hoja = conHoja({ ventas: [] });
  return assert.rejects(
    () => ventas.cambiarEstado({ sesion: SESION_DUENO, idVenta: 'V404', hasta: 'CERRADA' }),
    function (e) { return e.codigo === 404; }
  ).finally(hoja.restaurar);
});

test('un encargado no puede tocar el costo de una venta ya confirmada', function () {
  const confirmada = Object.assign({}, VENTA_CERRADA, { estado: 'CONFIRMADA' });
  const hoja = conHoja({ ventas: [confirmada] });
  return assert.rejects(
    () => ventas.actualizarVenta({
      sesion: SESION,
      idVenta: 'V1',
      cuerpo: Object.assign({}, CUERPO, { claveIdempotencia: 'edicion001' })
    }),
    function (e) { return e.codigo === 404; }
  ).finally(hoja.restaurar);
});

test('el dueno si puede corregir el costo de una venta confirmada', function () {
  const confirmada = Object.assign({}, VENTA_CERRADA, { estado: 'CONFIRMADA' });
  const hoja = conHoja({ ventas: [confirmada] });
  return ventas.actualizarVenta({
    sesion: SESION_DUENO,
    idVenta: 'V1',
    cuerpo: Object.assign({}, CUERPO, { claveIdempotencia: 'edicion002' })
  })
    .then(function (r) {
      assert.equal(r.venta.idVenta, 'V1');
      assert.equal(hoja.escrituras.length, 1);
      assert.equal(hoja.escrituras[0].tipoOperacion, 'ACTUALIZAR_VENTA');
      assert.equal(hoja.escrituras[0].idVenta, 'V1');
    })
    .finally(hoja.restaurar);
});

test('eliminarVenta borra un borrador y se niega en cualquier otro estado', function () {
  const borrador = Object.assign({}, VENTA_CERRADA, { estado: 'BORRADOR' });
  const hoja = conHoja({ ventas: [borrador] });
  return ventas.eliminarVenta({ sesion: SESION, idVenta: 'V1' })
    .then(function (r) {
      assert.equal(r.eliminada, true);
      assert.equal(hoja.escrituras[0].tipoOperacion, 'ELIMINAR_VENTA');
      assert.equal(hoja.escrituras[0].idVenta, 'V1');
      const hoja2 = conHoja({ ventas: [Object.assign({}, VENTA_CERRADA, { estado: 'CONFIRMADA' })] });
      return assert.rejects(
        () => ventas.eliminarVenta({ sesion: SESION, idVenta: 'V1' }),
        function (e) { return e.codigo === 404; }
      ).finally(hoja2.restaurar);
    })
    .finally(hoja.restaurar);
});

test('listarLineasDe expone el detalle de una venta', function () {
  const anterior = ledger.listarLineasDe;
  ledger.listarLineasDe = async () => [{ idProducto: 'P1', modelo: 'Galaxy A54', cantidad: 1 }];
  return ventas.listarLineasDe('V1')
    .then(function (lineas) {
      assert.equal(lineas.length, 1);
      assert.equal(lineas[0].modelo, 'Galaxy A54');
    })
    .finally(function () { ledger.listarLineasDe = anterior; });
});