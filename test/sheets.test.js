'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SHEETS_WEBAPP_URL = 'https://script.google.com/macros/s/ABC/exec';
process.env.SHEETS_API_KEY = 'clave-de-prueba';

const s = require('../src/sheets');

test('configuracion: url y clave se detectan', function () {
  assert.equal(s.tieneUrl(), true);
  assert.equal(s.tieneClave(), true);
  assert.equal(s.completo(), true);
});

test('construirUrl agrega la clave solo cuando corresponde', function () {
  const con = s.construirUrl(true);
  assert.match(con, /\/exec\?key=clave-de-prueba$/);
  assert.equal(s.construirUrl(false), 'https://script.google.com/macros/s/ABC/exec');
});

test('construirUrl usa & si la url ya trae query', function () {
  process.env.SHEETS_WEBAPP_URL = 'https://x.com/exec?v=1';
  assert.match(s.construirUrl(true), /exec\?v=1&key=clave-de-prueba$/);
  process.env.SHEETS_WEBAPP_URL = 'https://script.google.com/macros/s/ABC/exec';
});

test('TRAMPA 1: escribir() revienta cuando Apps Script devuelve 200 con status ERROR', async function () {
  // Este es el caso que en Sis_Zamir mostraba "venta registrada" sin tocar la hoja.
  globalThis.fetch = async function () {
    return new Response(JSON.stringify({ status: 'ERROR', message: 'La hoja Ventas no existe' }), { status: 200 });
  };
  await assert.rejects(
    function () { return s.escribir({ tipoOperacion: 'REGISTRAR_VENTA' }); },
    function (e) {
      assert.equal(e.codigo, 409);
      assert.match(e.message, /La hoja Ventas no existe/);
      return true;
    }
  );
});

test('escribir() devuelve los datos cuando el script responde bien', async function () {
  globalThis.fetch = async function () {
    return new Response(JSON.stringify({ status: 'OK', id: 'V1', duplicada: false }), { status: 200 });
  };
  const r = await s.escribir({ tipoOperacion: 'REGISTRAR_VENTA' });
  assert.equal(r.status, 'OK');
  assert.equal(r.id, 'V1');
});

test('escribir() manda la clave en el cuerpo del POST, no en la URL', async function () {
  let visto = null;
  globalThis.fetch = async function (url, opciones) {
    visto = { url, opciones };
    return new Response(JSON.stringify({ status: 'OK' }), { status: 200 });
  };
  await s.escribir({ tipoOperacion: 'X' });
  assert.match(visto.url, /^https:\/\/script\.google\.com\/macros\/s\/ABC\/exec$/);
  assert.equal(visto.opciones.method, 'POST');
  const cuerpo = JSON.parse(visto.opciones.body);
  assert.equal(cuerpo.apiKey, 'clave-de-prueba');
  assert.equal(cuerpo.tipoOperacion, 'X');
});

test('sin URL o sin clave responde 503 con mensaje util', async function () {
  globalThis.fetch = async function () { throw new Error('no deberia llamarse'); };
  const originalUrl = process.env.SHEETS_WEBAPP_URL;
  const originalClave = process.env.SHEETS_API_KEY;

  process.env.SHEETS_WEBAPP_URL = '';
  await assert.rejects(function () { return s.escribir({}); }, function (e) {
    assert.equal(e.codigo, 503);
    assert.match(e.message, /SHEETS_WEBAPP_URL/);
    return true;
  });

  process.env.SHEETS_WEBAPP_URL = originalUrl;
  process.env.SHEETS_API_KEY = '';
  await assert.rejects(function () { return s.escribir({}); }, function (e) {
    assert.equal(e.codigo, 503);
    assert.match(e.message, /SHEETS_API_KEY/);
    return true;
  });
  process.env.SHEETS_API_KEY = originalClave;
});

test('pareceFalloDeAuth reconoce los 4akovichos de Apps Script', function () {
  assert.equal(s.pareceFalloDeAuth({ error: 'NO_AUTORIZADO' }, 200), true);
  assert.equal(s.pareceFalloDeAuth({ message: 'Invalid token' }, 200), true);
  assert.equal(s.pareceFalloDeAuth({ message: 'API KEY invalida' }, 200), true);
  assert.equal(s.pareceFalloDeAuth(null, 401), true);
  assert.equal(s.pareceFalloDeAuth(null, 403), true);
  assert.equal(s.pareceFalloDeAuth({ status: 'OK' }, 200), false);
  assert.equal(s.pareceFalloDeAuth(null, 200), false);
});

test('un rechazo de clave produce 502 con instruccion, no 500 generico', async function () {
  globalThis.fetch = async function () {
    return new Response(JSON.stringify({ error: 'NO_AUTORIZADO' }), { status: 200 });
  };
  await assert.rejects(function () { return s.escribir({}); }, function (e) {
    assert.equal(e.codigo, 502);
    assert.match(e.message, /SHEETS_API_KEY/);
    return true;
  });
});

test('un cuerpo que no es JSON no se toma como exito silencioso', async function () {
  globalThis.fetch = async function () { return new Response('<html>error</html>', { status: 200 }); };
  await assert.rejects(function () { return s.escribir({}); }, function (e) {
    assert.equal(e.codigo, 502);
    return true;
  });
});

test('un 500 de la hoja no se confunde con un rechazo de clave', async function () {
  globalThis.fetch = async function () { return new Response('{}', { status: 500 }); };
  await assert.rejects(function () { return s.escribir({}); }, function (e) {
    assert.equal(e.codigo, 502);
    assert.match(e.message, /500/);
    return true;
  });
});

test('un abort por timeout se distingue de un no-contacto', async function () {
  const original = globalThis.fetch;
  globalThis.fetch = function (url, opciones) {
    return new Promise(function (resolver, rechazar) {
      opciones.signal.addEventListener('abort', function () {
        const e = new Error('abortado');
        e.name = 'AbortError';
        rechazar(e);
      });
    });
  };
  process.env.SHEETS_TIMEOUT_MS = '60';
  delete require.cache[require.resolve('../src/sheets')];
  const s2 = require('../src/sheets');
  await assert.rejects(function () { return s2.escribir({}); }, function (e) {
    assert.equal(e.codigo, 504);
    return true;
  });
  process.env.SHEETS_TIMEOUT_MS = '20000';
  globalThis.fetch = original;
  delete require.cache[require.resolve('../src/sheets')];
});

test('diagnostico devuelve 4 pasos y marca los que faltan', async function () {
  globalThis.fetch = async function (url) {
    if (String(url).indexOf('action=SALUD') !== -1 && String(url).indexOf('SALUD_TIENDA') === -1) {
      return new Response(JSON.stringify({ ok: true, version: 4 }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: 'OK' }), { status: 200 });
  };
  const d = await s.diagnostico();
  assert.equal(d.pasos.length, 4);
  assert.deepEqual(d.pasos.map(function (p) { return p.paso; }), [1, 2, 3, 4]);
  assert.equal(d.pasos[0].ok, true);
  assert.equal(d.pasos[1].ok, true);
  assert.equal(d.pasos[2].ok, true);
  assert.match(d.pasos[2].detalle, /Version 4/);
  assert.equal(d.pasos[3].ok, true);
});

test('diagnostico marca el paso 3 como fallido si el script no responde', async function () {
  globalThis.fetch = async function () { throw new Error('sin red'); };
  const d = await s.diagnostico();
  assert.equal(d.pasos[0].ok, true);
  assert.equal(d.pasos[2].ok, false);
  assert.match(d.pasos[2].accion, /Implementar|Nueva implementacion/);
});

test('conCache no dispara dos llamadas simultaneas y cachea el resultado', async function () {
  s.limpiarCache();
  let llamadas = 0;
  const calcular = async function () { llamadas += 1; return ['a', 'b']; };
  const [x, y] = await Promise.all([s.conCache('k1', calcular), s.conCache('k1', calcular)]);
  assert.deepEqual(x, ['a', 'b']);
  assert.deepEqual(y, ['a', 'b']);
  assert.equal(llamadas, 1);
  await s.conCache('k1', calcular);
  assert.equal(llamadas, 1, 'la segunda llamada debe salir del cache');
});

test('conCache borra la entrada si el calculo falla, para no cachear el error', async function () {
  s.limpiarCache();
  await assert.rejects(function () { return s.conCache('k2', async function () { throw s.error('fallo', 502); }); });
  const r = await s.conCache('k2', async function () { return 'recuperado'; });
  assert.equal(r, 'recuperado');
});
