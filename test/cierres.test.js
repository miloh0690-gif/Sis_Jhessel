'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sheets = require('../src/sheets');
const ledger = require('../src/ledger');
const cierres = require('../src/cierres');

const VENTAS = [
  { idVenta: 'V1', idTienda: 'T1', tienda: 'Tienda Uno', dia: '2026-10-08', estado: 'CONFIRMADA',
    netoDuenoBsCents: 17_762, comisionBsCents: 7_613, gananciaBsCents: 25_375, totalCobradoBsCents: 0 },
  { idVenta: 'V2', idTienda: 'T1', tienda: 'Tienda Uno', dia: '2026-10-08', estado: 'BORRADOR',
    netoDuenoBsCents: 90_000, comisionBsCents: 30_000, gananciaBsCents: 120_000, totalCobradoBsCents: 0 },
  { idVenta: 'V3', idTienda: 'T1', tienda: 'Tienda Uno', dia: '2026-10-08', estado: 'CERRADA',
    netoDuenoBsCents: 5_000, comisionBsCents: 2_000, gananciaBsCents: 7_000, totalCobradoBsCents: 0 },
];

const SESION_DUENO = { rol: 'DUENO', idTienda: null, nombre: 'Dueño' };
const SESION_TIENDA = { rol: 'TIENDA', idTienda: 'T1', nombre: 'Camila' };

function conHoja(ventas, fn) {
  const aListar = ledger.listarVentas;
  const aTiendas = ledger.listarTiendas;
  const aEscribir = sheets.escribir;
  const escritas = [];
  const copia = ventas.map((v) => Object.assign({}, v));
  ledger.listarVentas = async () => copia;
  ledger.listarTiendas = async () => [{ idTienda: 'T1', nombre: 'Tienda Uno', pctComision: 30, activa: true }];
  sheets.escribir = async (payload) => {
    escritas.push(payload);
    return { status: 'OK', id: 'C1' };
  };
  return Promise.resolve()
    .then(() => fn(escritas))
    .finally(() => {
      ledger.listarVentas = aListar;
      ledger.listarTiendas = aTiendas;
      sheets.escribir = aEscribir;
    });
}

test('previsualizar cuenta las ventas del dia y separa las pendientes de cierre', async () => {
  await conHoja(VENTAS, async () => {
    const p = await cierres.previsualizar({ idTienda: 'T1', dia: '2026-10-08' });
    assert.equal(p.tienda, 'Tienda Uno');
    assert.equal(p.dia, '2026-10-08');
    assert.equal(p.cantidadVentas, 3);
    assert.equal(p.pendientes, 1);
    assert.equal(p.saldoPendienteBsCents, 17_762);
    assert.deepEqual(p.idsPendientes, ['V1']);
    assert.equal(p.totalComisionBsCents, 7_613);
    assert.equal(p.totalGananciaBsCents, 25_375);
    assert.equal(p.totalNetoDuenoBsCents, 17_762);
    assert.equal(p.totalCobradoBsCents, 0);
    assert.equal(p.totalesDelDia.cantidadVentas, 3);
    assert.equal(p.totalesDelDia.totalComisionBsCents, 7_613 + 30_000 + 2_000);
    assert.equal(p.totalesDelDia.totalNetoDuenoBsCents, 17_762 + 90_000 + 5_000);
  });
});

test('previsualizar ignora las ventas de otra tienda o de otro dia', async () => {
  const mezcla = VENTAS.concat([
    { idVenta: 'V4', idTienda: 'T2', dia: '2026-10-08', estado: 'CONFIRMADA', netoDuenoBsCents: 999, comisionBsCents: 1, gananciaBsCents: 2 },
    { idVenta: 'V5', idTienda: 'T1', dia: '2026-10-09', estado: 'CONFIRMADA', netoDuenoBsCents: 888, comisionBsCents: 1, gananciaBsCents: 2 },
  ]);
  await conHoja(mezcla, async () => {
    const p = await cierres.previsualizar({ idTienda: 'T1', dia: '2026-10-08' });
    assert.equal(p.cantidadVentas, 3);
    assert.equal(p.pendientes, 1);
    assert.equal(p.saldoPendienteBsCents, 17_762);
  });
});

test('un encargado no puede cerrar: 404 y no escribe nada', async () => {
  await conHoja(VENTAS, async (escritas) => {
    await assert.rejects(
      () => cierres.cerrar({ sesion: SESION_TIENDA, idTienda: 'T1', dia: '2026-10-08', pagadoBsCents: 17_762 }),
      (e) => e.codigo === 404
    );
    assert.equal(escritas.length, 0);
  });
});

test('sin sesion no se puede cerrar: 404 y no escribe nada', async () => {
  await conHoja(VENTAS, async (escritas) => {
    await assert.rejects(
      () => cierres.cerrar({ sesion: {}, idTienda: 'T1', dia: '2026-10-08', pagadoBsCents: 17_762 }),
      (e) => e.codigo === 404
    );
    assert.equal(escritas.length, 0);
  });
});

test('el recibo lleva el nombre de la tienda aunque las ventas no lo traigan', async () => {
  const sinNombre = VENTAS.map((v) => Object.assign({}, v, { tienda: '' }));
  await conHoja(sinNombre, async (escritas) => {
    const r = await cierres.cerrar({
      sesion: SESION_DUENO,
      idTienda: 'T1',
      dia: '2026-10-08',
      pagadoBsCents: 17_762,
    });
    assert.equal(r.cierre.tienda, 'Tienda Uno');
    assert.equal(escritas[0].cierre.tienda, 'Tienda Uno');
  });
});

test('el dueno cierra: una sola escritura con el recibo y las ventas confirmadas', async () => {
  await conHoja(VENTAS, async (escritas) => {
    const r = await cierres.cerrar({
      sesion: SESION_DUENO,
      idTienda: 'T1',
      dia: '2026-10-08',
      pagadoBsCents: 17_762,
    });
    assert.equal(escritas.length, 1);
    assert.equal(escritas[0].tipoOperacion, 'CERRAR_TIENDA');
    assert.deepEqual(escritas[0].idsVentas, ['V1']);
    assert.equal(escritas[0].cierre.idTienda, 'T1');
    assert.equal(escritas[0].cierre.tienda, 'Tienda Uno');
    assert.equal(escritas[0].cierre.dia, '2026-10-08');
    assert.equal(escritas[0].cierre.totalNetoDuenoBsCents, 17_762);
    assert.equal(escritas[0].cierre.pagadoBsCents, 17_762);
    assert.equal(escritas[0].cierre.saldoBsCents, 0);
    assert.equal(escritas[0].cierre.totalComisionBsCents, 7_613);
    assert.equal(r.ventasCerradas, 1);
    assert.equal(r.cierre.saldoBsCents, 0);
  });
});

test('pagar menos que el neto deja el saldo pendiente a favor del dueno', async () => {
  await conHoja(VENTAS, async (escritas) => {
    const r = await cierres.cerrar({
      sesion: SESION_DUENO,
      idTienda: 'T1',
      dia: '2026-10-08',
      pagadoBsCents: 15_000,
    });
    assert.equal(escritas[0].cierre.saldoBsCents, 2_762);
    assert.equal(r.cierre.saldoBsCents, 2_762);
  });
});

test('no hay ventas confirmadas: 400 y no se genera un recibo en blanco', async () => {
  const soloBorrador = [
    { idVenta: 'V9', idTienda: 'T1', tienda: 'Tienda Uno', dia: '2026-10-08', estado: 'BORRADOR',
      netoDuenoBsCents: 1, comisionBsCents: 0, gananciaBsCents: 1, totalCobradoBsCents: 0 },
  ];
  await conHoja(soloBorrador, async (escritas) => {
    await assert.rejects(
      () => cierres.cerrar({ sesion: SESION_DUENO, idTienda: 'T1', dia: '2026-10-08', pagadoBsCents: 0 }),
      (e) => e.codigo === 400 && /confirmadas/.test(e.message)
    );
    assert.equal(escritas.length, 0);
  });
});

test('falta el tipo de cambio o la tienda: 400 antes de escribir', async () => {
  await conHoja(VENTAS, async (escritas) => {
    await assert.rejects(
      () => cierres.cerrar({ sesion: SESION_DUENO, idTienda: '', dia: '2026-10-08', pagadoBsCents: 0 }),
      (e) => e.codigo === 400
    );
    await assert.rejects(
      () => cierres.cerrar({ sesion: SESION_DUENO, idTienda: 'T1', dia: '08-10-2026', pagadoBsCents: 0 }),
      (e) => e.codigo === 400
    );
    assert.equal(escritas.length, 0);
  });
});

test('el pago no puede ser negativo: 400 antes de escribir', async () => {
  await conHoja(VENTAS, async (escritas) => {
    await assert.rejects(
      () => cierres.cerrar({ sesion: SESION_DUENO, idTienda: 'T1', dia: '2026-10-08', pagadoBsCents: -5 }),
      (e) => e.codigo === 400
    );
    assert.equal(escritas.length, 0);
  });
});