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
  // Un 401/403 SIN cuerpo de auth no es evidencia de que la clave sea mala:
  // en produccion fue la pagina de acceso denegado de Google. Se corrige.
  assert.equal(s.pareceFalloDeAuth(null, 401), false);
  assert.equal(s.pareceFalloDeAuth(null, 403), false);
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
      return new Response(JSON.stringify(
        { ok: true, version: 4, hoja: 'Precios', libro: 'JHessel Bolivia' }), { status: 200 });
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
  assert.match(d.pasos[2].detalle, /JHessel Bolivia/,
    'el diagnostico tiene que decir en que hoja estamos, o el dueno no puede verificar nada');
  assert.equal(d.pasos[3].ok, true);
});

test('diagnostico marca el paso 3 como FALLIDO si el script desplegado usa la hoja vieja', async function () {
  // El script puede responder bien y aun asi ser el Codigo.gs viejo. Si el
  // diagnostico lo da por bueno, el dueño siembra la hoja que ya no existe.
  globalThis.fetch = async function (url) {
    if (String(url).indexOf('action=SALUD') !== -1 && String(url).indexOf('SALUD_TIENDA') === -1) {
      return new Response(JSON.stringify(
        { ok: true, version: 1, hoja: 'Catalogo', esLegacy: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: 'OK' }), { status: 200 });
  };
  const d = await s.diagnostico();
  assert.equal(d.pasos[2].ok, false, 'un deployment con la hoja vieja no es un despliegue bueno');
  assert.match(d.pasos[2].detalle, /Catalogo/);
  assert.match(d.pasos[2].accion, /Codigo.gs nuevo/);
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

test('normalizar quita acentos, baja a minusculas y colapsa espacios', function () {
  assert.equal(s.normalizar('  Camará  Póker '), 'camara poker');
  assert.equal(s.normalizar(''), '');
  assert.equal(s.normalizar(null), '');
  assert.equal(s.normalizar(undefined), '');
});

test('leer arma la query con la accion y los filtros extra', async function () {
  s.limpiarCache();
  let vista = '';
  globalThis.fetch = async function (url) {
    vista = String(url);
    return { ok: true, status: 200, text: async function () { return '{"status":"OK","ventas":[]}'; } };
  };
  await s.leer('REPORTE_VENTAS', { desde: '2026-10-01', hasta: '2026-10-31', idTienda: 'T1' });
  assert.ok(vista.indexOf('action=REPORTE_VENTAS') !== -1, vista);
  assert.ok(vista.indexOf('desde=2026-10-01') !== -1, vista);
  assert.ok(vista.indexOf('hasta=2026-10-31') !== -1, vista);
  assert.ok(vista.indexOf('idTienda=T1') !== -1, vista);
});

test('leer tambien acepta la forma objeto con accion adentro', async function () {
  s.limpiarCache();
  let vista = '';
  globalThis.fetch = async function (url) {
    vista = String(url);
    return { ok: true, status: 200, text: async function () { return '{}'; } };
  };
  await s.leer({ accion: 'REPORTE_TIENDAS' });
  assert.ok(vista.indexOf('action=REPORTE_TIENDAS') !== -1, vista);
});

test('leer lanza 502 cuando el script responde NO_AUTORIZADO', async function () {
  s.limpiarCache();
  globalThis.fetch = async function () {
    return { ok: true, status: 200, text: async function () { return '{"error":"NO_AUTORIZADO"}'; } };
  };
  await assert.rejects(
    function () { return s.leer('REPORTE_VENTAS'); },
    function (err) { return err.codigo === 502; }
  );
});
test('un 403 con HTML de Google se reporta como acceso al despliegue, no como clave mala', async function () {
  // Lo que devolvio Google el 2026-10-10: pagina de Drive, no JSON.
  // Decir "revisa la clave" manda a cambiar SHEETS_API_KEY sin resolver el problema.
  s.limpiarCache();
  globalThis.fetch = async function () {
    return new Response('<!DOCTYPE html><html><head><title>Acceso denegado</title></head><body>Acceso denegado</body></html>', {
      status: 403,
      headers: { 'content-type': 'text/html' }
    });
  };
  await assert.rejects(
    function () { return s.leer('REPORTE_VENTAS'); },
    function (err) {
      assert.equal(err.codigo, 502);
      assert.ok(/acceso/i.test(err.message), 'el mensaje debe hablar de acceso: ' + err.message);
      assert.ok(/Cualquier persona/i.test(err.message), 'debe decir quien tiene acceso: ' + err.message);
      assert.equal(/rechaz[oó] la clave/i.test(err.message), false, 'no debe culpar a la clave: ' + err.message);
      return true;
    }
  );
});

test('escribir() tambien distingue el 403 de permisos del 403 de clave', async function () {
  globalThis.fetch = async function () {
    return new Response('<html><title>Acceso denegado</title></html>', {
      status: 403,
      headers: { 'content-type': 'text/html' }
    });
  };
  await assert.rejects(
    function () { return s.escribir({ tipoOperacion: 'GUARDAR_VENTA' }); },
    function (err) {
      assert.equal(err.codigo, 502);
      assert.ok(/acceso/i.test(err.message), 'el mensaje debe hablar de acceso: ' + err.message);
      assert.equal(/rechaz[oó] la clave/i.test(err.message), false, 'no debe culpar a la clave: ' + err.message);
      return true;
    }
  );
});

test('un 403 con JSON NO_AUTORIZADO sigue siendo un problema de clave', async function () {
  s.limpiarCache();
  globalThis.fetch = async function () {
    return new Response('{"status":"ERROR","message":"NO_AUTORIZADO"}', {
      status: 403,
      headers: { 'content-type': 'application/json' }
    });
  };
  await assert.rejects(
    function () { return s.leer('REPORTE_VENTAS'); },
    function (err) {
      assert.equal(err.codigo, 502);
      assert.ok(/rechaz[oó] la clave/i.test(err.message), 'aqui si es la clave: ' + err.message);
      return true;
    }
  );
});

test('pareceFalloDeAuth ya no llama auth a un 403 sin cuerpo de clave', function () {
  assert.equal(s.pareceFalloDeAuth(null, 403), false);
  assert.equal(s.pareceFalloDeAuth({}, 403), false);
  assert.equal(s.pareceFalloDeAuth({ error: 'NO_AUTORIZADO' }, 200), true);
  assert.equal(s.pareceFalloDeAuth({ error: 'NO_AUTORIZADO' }, 403), true);
});