'use strict';

// Prueba del catalogo con la hoja mockeada: interceptamos sheets.leer para
// devolver filas crudas tal como las manda el .gs, sin tocar la red.
const assert = require('node:assert/strict');

const test = require('node:test');
const sheets = require('../src/sheets');
const catalogo = require('../src/catalogo');

const CRUDAS = [
  // IdProducto Marca Modelo PrecioRefUsdCents Caracteristicas Imagen Activo
  ['P1', 'Samsung', 'Galaxy A54 5G', '34000', 'Pantalla: Super AMOLED 120Hz \u00b7 C\u00e1mara de 48 MP', 'https://fdn2.gsmarena.com/a.jpg', '1'],
  ['P2', 'Xiaomi', 'Redmi Note 13', '18500', 'Pantalla: AMOLED 120Hz \u00b7 Camara de 108 MP', 'https://fdn2.gsmarena.com/b.jpg', '1'],
  ['P3', 'Apple', 'iPhone 12', '52000', 'Pantalla: OLED \u00b7 Camara de 12 MP', 'https://fdn2.gsmarena.com/c.jpg', '0']
];

function conHoja(fn) {
  const anterior = sheets.leer;
  sheets.leer = async () => ({ status: 'OK', filas: CRUDAS });
  catalogo.limpiarCache();
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      sheets.leer = anterior;
      catalogo.limpiarCache();
    });
}

test('buscar es insensible a mayusculas y acentos', function () {
  return conHoja(async function () {
    const r = await catalogo.buscar('samsung');
    assert.equal(r.length, 1);
    assert.equal(r[0].modelo, 'Galaxy A54 5G');
    assert.equal(r[0].precioRefUsdCents, 34000);
  });
});

test('buscar encuentra parciales en medio de la cadena', function () {
  return conHoja(async function () {
    assert.equal((await catalogo.buscar('note')).length, 1);
    assert.equal((await catalogo.buscar('a54')).length, 1);
    assert.equal((await catalogo.buscar('redmi')).length, 1);
  });
});

test('buscar normaliza acentos: camara encuentra Camara', function () {
  return conHoja(async function () {
    sheets.leer = async () => ({
      status: 'OK',
      filas: [['P9', 'Generico', 'Cámara de 48 MP', '1000', 'Pantalla IPS', '', '1']]
    });
    catalogo.limpiarCache();
    assert.equal((await catalogo.buscar('camara')).length, 1);
    assert.equal((await catalogo.buscar('CÁMARA')).length, 1);
    assert.equal((await catalogo.buscar('ó')).length, 1);
  });
});

test('los inactivos no salen salvo incluirInactivos', function () {
  return conHoja(async function () {
    assert.equal((await catalogo.buscar('iphone')).length, 0);
    assert.equal((await catalogo.buscar('iphone', { incluirInactivos: true })).length, 1);
  });
});

test('buscar sin texto devuelve los activos, con limite', function () {
  return conHoja(async function () {
    assert.equal((await catalogo.buscar('')).length, 2);
    assert.equal((await catalogo.buscar('', { limite: 1 })).length, 1);
  });
});

test('obtener devuelve el producto o null', function () {
  return conHoja(async function () {
    assert.equal((await catalogo.obtener('P2')).modelo, 'Redmi Note 13');
    assert.equal(await catalogo.obtener('P9'), null);
  });
});

test('precioSugerido: USD tal cual, Bs convertido con el TC', function () {
  return conHoja(async function () {
    assert.equal(
      await catalogo.precioSugerido({ idProducto: 'P1', moneda: 'USD', tcDecimas: 725 }),
      34000
    );
    assert.equal(
      await catalogo.precioSugerido({ idProducto: 'P1', moneda: 'BS', tcDecimas: 725 }),
      246500
    );
    assert.equal(
      await catalogo.precioSugerido({ idProducto: 'P9', moneda: 'USD', tcDecimas: 725 }),
      null
    );
  });
});

test('guardarPrecio escribe en la hoja y limpia la cache', function () {
  const anteriorLeer = sheets.leer;
  const anteriorEscribir = sheets.escribir;
  const llamadas = [];
  sheets.leer = async () => ({ status: 'OK', filas: CRUDAS });
  sheets.escribir = async (payload) => { llamadas.push(payload); return { status: 'OK' }; };
  catalogo.limpiarCache();
  return catalogo.buscar('samsung')
    .then(() => catalogo.guardarPrecio('P1', 35000))
    .then(async function () {
      assert.equal(llamadas.length, 1);
      assert.equal(llamadas[0].tipoOperacion, 'GUARDAR_PRECIO');
      assert.equal(llamadas[0].idProducto, 'P1');
      assert.equal(llamadas[0].precioUsdCents, 35000);
      // la cache se limpio: vuelve a pedir filas a la hoja
      const antes = (await catalogo.buscar('samsung')).length;
      assert.equal(antes, 1);
    })
    .finally(() => {
      sheets.leer = anteriorLeer;
      sheets.escribir = anteriorEscribir;
      catalogo.limpiarCache();
    });
});