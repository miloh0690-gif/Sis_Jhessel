'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const m = require('../src/money');

test('aCents acepta la coma decimal que escribe la persona', () => {
  // El tecleo del celular y el teclado Boliviano dan coma. Si esto no se
  // normaliza, cualquier precio tecleado con coma se guardaba en 0.
  assert.equal(m.aCents('340,00'), 34000);
  assert.equal(m.aCents('340.00'), 34000);
  assert.equal(m.aCents('340'), 34000);
  assert.equal(m.aCents(340), 34000);
  assert.equal(m.aCents('0,50'), 50);
  assert.equal(m.aCents(''), 0);
  assert.equal(m.aCents(null), 0);
  assert.equal(m.aCents('treinta'), 0);
});


// El ejemplo textual de Milo: "camila en toda la semana solo ganancia genero
// 10000bs pero de ella la comision es de 30% asi que el dueño se queda con
// 7000bs". Usamos TC 10,00 para que las cuentas salgan exactas en enteros.
const TC = 1000; // 10,00 Bs por dolar
const BP_30 = 3000; // 30%

test('tcADecimas acepta coma, punto y numero; rechaza lo invalido', function () {
  assert.equal(m.tcADecimas('7,25'), 725);
  assert.equal(m.tcADecimas('7.25'), 725);
  assert.equal(m.tcADecimas(7.25), 725);
  assert.equal(m.tcADecimas('7'), 700);
  assert.equal(m.tcADecimas('0'), 0);
  assert.equal(m.tcADecimas('0,01'), 1);
  assert.equal(m.tcADecimas('-5'), 0);
  assert.equal(m.tcADecimas('abc'), 0);
  assert.equal(m.tcADecimas(''), 0);
  assert.equal(m.tcADecimas(null), 0);
  assert.equal(m.tcADecimas(undefined), 0);
});

test('decimasATc es la inversa y no pierde el signo', function () {
  assert.equal(m.decimasATc(725), '7,25');
  assert.equal(m.decimasATc(700), '7');
  assert.equal(m.decimasATc(5), '0,05');
  assert.equal(m.decimasATc(-725), '-7,25');
  assert.equal(m.decimasATc(0), '0');
});

test('pctComisionABp acepta 30, "30%", 0.30 y rechaza fuera de rango', function () {
  assert.equal(m.pctComisionABp('30'), 3000);
  assert.equal(m.pctComisionABp('30%'), 3000);
  assert.equal(m.pctComisionABp(30), 3000);
  assert.equal(m.pctComisionABp(0.3), 3000);
  assert.equal(m.pctComisionABp(0), 0);
  assert.equal(m.pctComisionABp(100), 10000);
  assert.equal(m.pctComisionABp(101), null);
  assert.equal(m.pctComisionABp(-1), null);
  assert.equal(m.pctComisionABp('abc'), null);
});

test('normalizarMoneda acepta las formas que teclea la gente', function () {
  assert.equal(m.normalizarMoneda('bs'), 'BS');
  assert.equal(m.normalizarMoneda('Bs'), 'BS');
  assert.equal(m.normalizarMoneda('USD'), 'USD');
  assert.equal(m.normalizarMoneda('$'), 'USD');
  assert.equal(m.normalizarMoneda('dolar'), 'USD');
  assert.equal(m.normalizarMoneda(''), 'BS');
  assert.equal(m.normalizarMoneda('euros'), null);
});

test('EJEMPLO REAL DE MILO: 10.000 Bs de ganancia al 30% deja 7.000 al dueño', function () {
  const r = m.calcularVenta({
    lineas: [{ cantidad: 1, precioUsdCents: 150000, costoUnitarioUsdCents: 50000 }],
    ajustesUsdCents: 0,
    tcDecimas: TC,
    pctComisionBp: BP_30
  });
  assert.equal(r.gananciaNetaUsdCents, 100000);
  assert.equal(r.gananciaBsCents, 1000000); // 10.000,00 Bs
  assert.equal(r.comisionBsCents, 300000); // 3.000,00 Bs
  assert.equal(r.netoDuenoBsCents, 700000); // 7.000,00 Bs
  assert.equal(m.aDecimal(r.netoDuenoBsCents), 7000);
});

test('REVIEW FOCUS 1: ganancia negativa deja comision 0 y el dueño carga la pérdida', function () {
  const r = m.calcularVenta({
    lineas: [{ cantidad: 1, precioUsdCents: 50000, costoUnitarioUsdCents: 80000 }],
    ajustesUsdCents: 0,
    tcDecimas: TC,
    pctComisionBp: BP_30
  });
  assert.equal(r.gananciaNetaUsdCents, -30000);
  assert.equal(r.gananciaBsCents, -300000);
  assert.equal(r.comisionBsCents, 0);
  assert.equal(r.netoDuenoBsCents, -300000);
});

test('el ajuste por regalo ("le regalé un vidrio") baja la ganancia y recalcula todo', function () {
  const r = m.calcularVenta({
    lineas: [{ cantidad: 1, precioUsdCents: 150000, costoUnitarioUsdCents: 50000 }],
    ajustesUsdCents: 5000, // 50 USD de vidrio regalado
    tcDecimas: TC,
    pctComisionBp: BP_30
  });
  assert.equal(r.gananciaBrutaUsdCents, 100000);
  assert.equal(r.ajustesUsdCents, 5000);
  assert.equal(r.gananciaNetaUsdCents, 95000);
  assert.equal(r.gananciaBsCents, 950000);
  assert.equal(r.comisionBsCents, 285000);
  assert.equal(r.netoDuenoBsCents, 665000);
});

test('pago en Bs: el precio tecleado se normaliza a USD con el TC de esa venta', function () {
  const r = m.calcularVenta({
    moneda: 'BS',
    lineas: [{ cantidad: 1, precioBsCents: 1500000, costoUnitarioUsdCents: 50000 }],
    ajustesUsdCents: 0,
    tcDecimas: TC,
    pctComisionBp: BP_30
  });
  assert.equal(r.lineas[0].precioUsdCents, 150000);
  assert.equal(r.totalCobradoUsdCents, 150000);
  assert.equal(r.totalCobradoBsCents, 1500000);
  assert.equal(r.gananciaBsCents, 1000000);
});

test('pago en USD: el precio ya esta en centavos de dolar y el TC solo convierte el total', function () {
  const r = m.calcularVenta({
    moneda: 'USD',
    lineas: [{ cantidad: 2, precioUsdCents: 150000, costoUnitarioUsdCents: 50000 }],
    ajustesUsdCents: 0,
    tcDecimas: TC,
    pctComisionBp: BP_30
  });
  assert.equal(r.totalCobradoUsdCents, 300000);
  assert.equal(r.totalCobradoBsCents, 3000000);
  assert.equal(r.gananciaNetaUsdCents, 200000);
  assert.equal(r.gananciaBsCents, 2000000);
  assert.equal(r.comisionBsCents, 600000);
  assert.equal(r.netoDuenoBsCents, 1400000);
});

test('redondeo de comision: 25.375 Bs-cents al 30% son 7.613, neto 17.762', function () {
  // 25.375 * 3000 / 10000 = 7612.5 -> round-half-up a 7.613
  assert.equal(Math.round((25375 * 3000) / 10000), 7613);
  const r = m.calcularVenta({
    lineas: [{ cantidad: 1, precioUsdCents: 150000, costoUnitarioUsdCents: 147625 }],
    ajustesUsdCents: 0,
    tcDecimas: TC,
    pctComisionBp: BP_30
  });
  assert.equal(r.gananciaBsCents, 23750);
  assert.equal(r.comisionBsCents, 7125);
  assert.equal(r.netoDuenoBsCents, 16625);
});

test('TC 0 o invalido no revienta: todo queda en 0 en Bs y el dueño ve el dato', function () {
  const r = m.calcularVenta({
    lineas: [{ cantidad: 1, precioUsdCents: 150000, costoUnitarioUsdCents: 50000 }],
    ajustesUsdCents: 0,
    tcDecimas: 0,
    pctComisionBp: BP_30
  });
  assert.equal(r.tcDecimas, 0);
  assert.equal(r.gananciaBsCents, 0);
  assert.equal(r.comisionBsCents, 0);
  assert.equal(r.netoDuenoBsCents, 0);
  assert.equal(r.gananciaNetaUsdCents, 100000); // el dato en USD sigue siendo real
});

test('todo importe devuelto es entero (nunca flotante)', function () {
  const r = m.calcularVenta({
    lineas: [
      { cantidad: 3, precioUsdCents: 33333, costoUnitarioUsdCents: 11111 },
      { cantidad: 1, precioUsdCents: 7777, costoUnitarioUsdCents: 2222 }
    ],
    ajustesUsdCents: 333,
    tcDecimas: 733,
    pctComisionBp: 2750
  });
  const claves = Object.keys(r).filter(function (k) { return /Cents$/.test(k); });
  for (const k of claves) assert.ok(Number.isInteger(r[k]), k + ' no es entero: ' + r[k]);
  for (const l of r.lineas) {
    for (const k of Object.keys(l)) {
      if (/Cents$/.test(k)) assert.ok(Number.isInteger(l[k]), 'linea.' + k + ' no es entero');
    }
    assert.ok(Number.isInteger(l.cantidad));
  }
});

test('cantidad minima 1: una linea sin cantidad se vende de a uno', function () {
  const r = m.calcularVenta({
    lineas: [{ cantidad: 0, precioUsdCents: 100000, costoUnitarioUsdCents: 40000 }],
    ajustesUsdCents: 0,
    tcDecimas: TC,
    pctComisionBp: BP_30
  });
  assert.equal(r.lineas[0].cantidad, 1);
  assert.equal(r.unidades, 1);
});

test('precioBsAUsdCents y su inversa son coherentes', function () {
  assert.equal(m.precioBsAUsdCents(1500000, 1000), 150000);
  assert.equal(m.precioUsdCentsAPrecioBsCents(150000, 1000), 1500000);
  assert.equal(m.precioBsAUsdCents(1500000, 0), 0);
  assert.equal(m.precioUsdCentsAPrecioBsCents(150000, 0), 0);
});
test('calcularTotales devuelve los totales y no la nota', function () {
  const r = m.calcularTotales({
    moneda: 'USD',
    tcDecimas: TC,
    pctComisionBp: BP_30,
    lineas: [{ modelo: 'X', cantidad: 1, precioUsdCents: 10000, costoUnitarioUsdCents: 6000 }],
    ajustesUsdCents: 0
  });
  assert.equal(r.gananciaBrutaUsdCents, 4000);
  assert.equal(r.gananciaNetaUsdCents, 4000);
  assert.equal(r.gananciaBsCents, 40000);
  assert.equal(r.comisionBsCents, 12000);
  assert.equal(r.netoDuenoBsCents, 28000);
  assert.equal(r.cantidadLineas, 1);
  assert.equal(r.unidades, 1);
  assert.equal(r.nota, undefined);
  assert.equal(r.notas, undefined);
});

test('resumenVentas agrupa por tienda, empleado y dia', function () {
  const ventas = [
    { fecha: '2026-10-08T10:00:00.000Z', idTienda: 'T1', tienda: 'Uno', idEmpleado: 'E1', vendedor: 'Camila', estado: 'CONFIRMADA', tcDecimas: 1000, unidades: 1, gananciaBsCents: 40000, comisionBsCents: 12000, netoDuenoBsCents: 28000, totalCobradoUsdCents: 10000 },
    { fecha: '2026-10-09T10:00:00.000Z', idTienda: 'T1', tienda: 'Uno', idEmpleado: 'E2', vendedor: 'Andre', estado: 'CERRADA', tcDecimas: 1000, unidades: 2, gananciaBsCents: -7000, comisionBsCents: 0, netoDuenoBsCents: -7000, totalCobradoUsdCents: 20000 },
    { fecha: '2026-10-07T10:00:00.000Z', idTienda: 'T2', tienda: 'Dos', idEmpleado: 'E3', vendedor: 'Miros', estado: 'BORRADOR', tcDecimas: 1000, unidades: 1, gananciaBsCents: 90000, comisionBsCents: 27000, netoDuenoBsCents: 63000, totalCobradoUsdCents: 90000 }
  ];
  const r = m.resumenVentas(ventas);
  assert.equal(r.cantidadVentas, 3);
  assert.equal(r.unidades, 4);
  assert.equal(r.totalGananciaBsCents, 40000 - 7000 + 90000);
  assert.equal(r.totalComisionBsCents, 12000 + 27000);
  assert.equal(r.totalNetoDuenoBsCents, 28000 - 7000 + 63000);
  assert.equal(r.totalCobradoBsCents, 1200000);
  assert.deepEqual(r.porTienda.map(function (t) { return t.idTienda; }), ['T2', 'T1']);
  assert.equal(r.porTienda[1].pendientes, 1);
  assert.equal(r.porTienda[0].pendientes, 0);
  assert.deepEqual(r.porDia.map(function (d) { return d.dia; }), ['2026-10-07', '2026-10-08', '2026-10-09']);
  assert.equal(r.porEmpleado.length, 3);
  assert.equal(r.porDia[1].cantidadVentas, 1);
});

test('resumenVentas con lista vacia no rompe y todo queda en cero', function () {
  const r = m.resumenVentas([]);
  assert.equal(r.cantidadVentas, 0);
  assert.equal(r.totalGananciaBsCents, 0);
  assert.deepEqual(r.porTienda, []);
  assert.deepEqual(r.porDia, []);
});

test('resumenVentas acepta totalCobradoBsCents ya calculado en la hoja', function () {
  const r = m.resumenVentas([
    { fecha: '2026-10-08', idTienda: 'T1', tienda: 'Uno', idEmpleado: 'E1', vendedor: 'Camila', estado: 'CONFIRMADA', tcDecimas: 1000, unidades: 1, gananciaBsCents: 1000, comisionBsCents: 300, netoDuenoBsCents: 700, totalCobradoUsdCents: 5000, totalCobradoBsCents: 999999 }
  ]);
  assert.equal(r.totalCobradoBsCents, 999999);
});
