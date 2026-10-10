'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const e = require('../src/estados');
const T = e.ROLES.TIENDA;
const D = e.ROLES.DUENO;

test('normalizarEstado acepta las 4 y rechaza lo demas', function () {
  assert.equal(e.normalizarEstado('BORRADOR'), 'BORRADOR');
  assert.equal(e.normalizarEstado('confirmada'), 'CONFIRMADA');
  assert.equal(e.normalizarEstado('  cerrada '), 'CERRADA');
  assert.equal(e.normalizarEstado('anulada'), 'ANULADA');
  assert.equal(e.normalizarEstado('inventado'), null);
  assert.equal(e.normalizarEstado(''), null);
  assert.equal(e.normalizarEstado(null), null);
  assert.equal(e.normalizarEstado(undefined), null);
  assert.equal(e.esEstadoValido('CERRADA'), true);
  assert.equal(e.esEstadoValido('xxx'), false);
});

test('TABLA COMPLETA del spec: 7 filas x 4 destinos', function () {
  const esperado = {
    'BORRADOR/TIENDA': { CONFIRMADA: true, BORRADOR: false, CERRADA: false, ANULADA: false },
    'BORRADOR/DUENO': { CONFIRMADA: true, BORRADOR: false, CERRADA: true, ANULADA: true },
    'CONFIRMADA/TIENDA': { BORRADOR: true, CONFIRMADA: false, CERRADA: false, ANULADA: false },
    'CONFIRMADA/DUENO': { BORRADOR: true, CONFIRMADA: false, CERRADA: true, ANULADA: true },
    'CERRADA/TIENDA': { BORRADOR: false, CONFIRMADA: false, CERRADA: false, ANULADA: false },
    'CERRADA/DUENO': { BORRADOR: false, CONFIRMADA: true, CERRADA: false, ANULADA: true },
    'ANULADA/TIENDA': { BORRADOR: false, CONFIRMADA: false, CERRADA: false, ANULADA: false },
    'ANULADA/DUENO': { BORRADOR: false, CONFIRMADA: false, CERRADA: false, ANULADA: false }
  };
  for (const clave of Object.keys(esperado)) {
    const partes = clave.split('/');
    const desde = partes[0];
    const rol = partes[1];
    for (const hasta of Object.keys(esperado[clave])) {
      assert.equal(e.puedeTransicionar(desde, hasta, rol), esperado[clave][hasta],
        clave + ' -> ' + hasta);
    }
  }
});

test('un rol desconocido nunca vale mas que TIENDA', function () {
  assert.equal(e.normalizarRol('root'), T);
  assert.equal(e.normalizarRol(''), T);
  assert.equal(e.normalizarRol(undefined), T);
  assert.equal(e.puedeTransicionar('BORRADOR', 'CERRADA', 'root'), false);
  assert.equal(e.puedeTransicionar('CERRADA', 'CONFIRMADA', 'admin'), false);
});

test('destinosPermitidos dice exactamente a donde puede ir cada rol', function () {
  assert.deepEqual(e.destinosPermitidos('BORRADOR', T), ['CONFIRMADA']);
  assert.deepEqual(e.destinosPermitidos('BORRADOR', D), ['CONFIRMADA', 'CERRADA', 'ANULADA']);
  assert.deepEqual(e.destinosPermitidos('CONFIRMADA', T), ['BORRADOR']);
  assert.deepEqual(e.destinosPermitidos('CONFIRMADA', D), ['BORRADOR', 'CERRADA', 'ANULADA']);
  assert.deepEqual(e.destinosPermitidos('CERRADA', T), []);
  assert.deepEqual(e.destinosPermitidos('CERRADA', D), ['CONFIRMADA', 'ANULADA']);
  assert.deepEqual(e.destinosPermitidos('ANULADA', T), []);
  assert.deepEqual(e.destinosPermitidos('ANULADA', D), []);
  assert.deepEqual(e.destinosPermitidos('inventado', D), []);
});

test('ANULADA es terminal para siempre', function () {
  assert.equal(e.esTerminal('ANULADA'), true);
  assert.equal(e.esTerminal('anulada'), true);
  assert.equal(e.esTerminal('CERRADA'), false);
  assert.equal(e.esTerminal('BORRADOR'), false);
  for (const rol of [T, D]) {
    for (const destino of e.LISTA_ESTADOS) {
      assert.equal(e.puedeTransicionar('ANULADA', destino, rol), false);
    }
  }
});

test('pendiente = la que todavia no le dio el dinero al dueño', function () {
  assert.equal(e.estaPendiente('BORRADOR'), true);
  assert.equal(e.estaPendiente('CONFIRMADA'), true);
  assert.equal(e.estaPendiente('CERRADA'), false);
  assert.equal(e.estaPendiente('ANULADA'), false);
  assert.equal(e.estaCerrada('CERRADA'), true);
  assert.equal(e.estaCerrada('BORRADOR'), false);
});

test('CONFIRMADA: el encargado no puede tocar costo ni ajuste, si el precio', function () {
  assert.equal(e.puedeEditarContenido('BORRADOR', T, { costo: true, precio: true }), true);
  assert.equal(e.puedeEditarContenido('CONFIRMADA', T, { precio: true, cantidad: true }), true);
  assert.equal(e.puedeEditarContenido('CONFIRMADA', T, { costo: true }), false);
  assert.equal(e.puedeEditarContenido('CONFIRMADA', T, { ajustes: true }), false);
  assert.equal(e.puedeEditarContenido('CONFIRMADA', T, { precio: true, costo: true }), false);
  assert.equal(e.puedeEditarContenido('CONFIRMADA', T, {}), true);
  assert.equal(e.puedeEditarContenido('CONFIRMADA', T, null), true);
});

test('CERRADA: solo el dueño; ANULADA: nadie', function () {
  assert.equal(e.puedeEditarContenido('CERRADA', T, { precio: true }), false);
  assert.equal(e.puedeEditarContenido('CERRADA', D, { costo: true }), true);
  assert.equal(e.puedeEditarContenido('ANULADA', D, { costo: true }), false);
  assert.equal(e.puedeEditarContenido('ANULADA', T, { precio: true }), false);
  assert.equal(e.puedeEditarContenido('inventado', D, {}), false);
});

test('borrar: solo BORRADOR, y el dueño tambien', function () {
  assert.equal(e.puedeBorrar('BORRADOR', T), true);
  assert.equal(e.puedeBorrar('BORRADOR', D), true);
  assert.equal(e.puedeBorrar('CONFIRMADA', T), false);
  assert.equal(e.puedeBorrar('CONFIRMADA', D), false);
  assert.equal(e.puedeBorrar('CERRADA', D), false);
  assert.equal(e.puedeBorrar('ANULADA', D), false);
  assert.equal(e.puedeBorrar('inventado', D), false);
});

test('puedeEditarCosto y puedeVerCosto siguen la regla del dueno', function () {
  assert.equal(e.puedeEditarCosto(D, 'BORRADOR'), true);
  assert.equal(e.puedeEditarCosto(T, 'BORRADOR'), true);
  assert.equal(e.puedeEditarCosto(T, 'CONFIRMADA'), false);
  assert.equal(e.puedeEditarCosto(D, 'CONFIRMADA'), true);
  assert.equal(e.puedeEditarCosto(D, 'CERRADA'), false);
  // Un rol raro nunca sube de privilegios: vale como tienda, no mas.
  assert.equal(e.puedeEditarCosto('inventado', 'BORRADOR'), e.puedeEditarCosto(T, 'BORRADOR'));
  assert.equal(e.puedeVerCosto(D), true);
  assert.equal(e.puedeVerCosto(T), false);
  assert.equal(e.puedeVerCosto('inventado'), false);
});

test('explicarTransicion devuelve vacio si se permite y un motivo si se rechaza', function () {
  assert.equal(e.explicarTransicion({ rol: D, desde: 'BORRADOR', hasta: 'CONFIRMADA' }), '');
  assert.equal(e.explicarTransicion({ rol: T, desde: 'BORRADOR', hasta: 'CONFIRMADA' }), '');
  const motivo = e.explicarTransicion({ rol: T, desde: 'BORRADOR', hasta: 'CERRADA' });
  assert.ok(typeof motivo === 'string' && motivo.length > 10, 'debe explicar el rechazo');
  assert.ok(e.explicarTransicion({ rol: T, desde: 'CERRADA', hasta: 'BORRADOR' }).length > 10);
  assert.ok(e.explicarTransicion({ rol: D, desde: 'inventado', hasta: 'BORRADOR' }).length > 10);
});
