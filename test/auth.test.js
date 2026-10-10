'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'secreto-de-prueba-para-jhessel-32';

const auth = require('../src/auth');

test('hashearClave produce scrypt$sal$derivado con sal distinta cada vez', function () {
  const a = auth.hashearClave('1234');
  const b = auth.hashearClave('1234');
  assert.match(a, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.notEqual(a, b, 'misma clave debe dar hashes distintos (sal aleatoria)');
});

test('hashearClave rechaza clave vacia', function () {
  assert.throws(function () { auth.hashearClave(''); });
  assert.throws(function () { auth.hashearClave(null); });
  assert.throws(function () { auth.hashearClave(undefined); });
});

test('verificarClave acepta la correcta y rechaza las falsas', function () {
  const guardado = auth.hashearClave('camila123');
  assert.equal(auth.verificarClave('camila123', guardado), true);
  assert.equal(auth.verificarClave('camila124', guardado), false);
  assert.equal(auth.verificarClave('', guardado), false);
  assert.equal(auth.verificarClave('camila123', ''), false);
  assert.equal(auth.verificarClave('camila123', null), false);
});

test('verificarClave devuelve false ante formatos raros, nunca lanza', function () {
  const bueno = auth.hashearClave('x');
  assert.equal(auth.verificarClave('x', 'no-es-scrypt'), false);
  assert.equal(auth.verificarClave('x', 'scrypt$solo-dos-partes'), false);
  assert.equal(auth.verificarClave('x', 'scrypt$$'), false);
  assert.equal(auth.verificarClave('x', 'scrypt$' + 'a'.repeat(32) + '$corto'), false);
  assert.equal(auth.verificarClave('x', bueno), true); // el hash bien formado SI valida
});

test('firmar y verificar: round-trip con rol, tienda y nombre', function () {
  const token = auth.crearToken(auth.ROLES.TIENDA, 'T1', 'Camila');
  const carga = auth.verificar(token);
  assert.equal(carga.rol, 'tienda');
  assert.equal(carga.idTienda, 'T1');
  assert.equal(carga.nombre, 'Camila');
  assert.ok(carga.exp > Date.now());
});

test('un token con la firma tocada no pasa', function () {
  const token = auth.crearToken(auth.ROLES.DUENO, '', 'Dueño');
  const partes = token.split('.');
  // alteramos el cuerpo manteniendo la firma
  const falso = Buffer.from('{"rol":"dueno","exp":99999999999999}').toString('base64url') + '.' + partes[1];
  assert.equal(auth.verificar(falso), null);
  assert.equal(auth.verificar(partes[0] + '.firmaInventada'), null);
  assert.equal(auth.verificar(''), null);
  assert.equal(auth.verificar(null), null);
  assert.equal(auth.verificar('sinpunto'), null);
});

test('un token expirado devuelve null', function () {
  const vencido = auth.firmar({ rol: 'dueno', idTienda: '', nombre: 'x', exp: Date.now() - 1 });
  assert.equal(auth.verificar(vencido), null);
});

test('leerCookies separa por ; y quita espacios', function () {
  const c = auth.leerCookies('jh_sesion=abc; otro=1;  spaced = 2 ');
  assert.equal(c.jh_sesion, 'abc');
  assert.equal(c.otro, '1');
  assert.equal(c.spaced, '2');
});

test('leerCookies no revienta con cabeceras raras', function () {
  assert.deepEqual(auth.leerCookies(undefined), {});
  assert.deepEqual(auth.leerCookies(''), {});
  assert.deepEqual(auth.leerCookies(';=sinclave'), {});
});

test('crearCookie y borrarCookie llevan HttpOnly, SameSite y Path', function () {
  const token = auth.crearToken(auth.ROLES.TIENDA, 'T1', 'Camila');
  const cookie = auth.crearCookie(token);
  assert.match(cookie, /^jh_sesion=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, new RegExp('Max-Age=' + Math.floor(auth.DURACION_MS / 1000)));
  const borrada = auth.borrarCookie();
  assert.match(borrada, /^jh_sesion=;/);
  assert.match(borrada, /Max-Age=0/);
});

test('la cookie sobrevive el viaje de ida y vuelta (encode/decode)', function () {
  const token = auth.crearToken(auth.ROLES.TIENDA, 'T1', 'Camila Pérez');
  const req = { headers: { cookie: auth.crearCookie(token) } };
  const carga = auth.sesion(req);
  assert.ok(carga);
  assert.equal(carga.nombre, 'Camila Pérez');
});

test('sesion() devuelve null sin cookie, con cookie basura, y si el secreto falta', function () {
  assert.equal(auth.sesion({ headers: {} }), null);
  assert.equal(auth.sesion({ headers: { cookie: 'jh_sesion=basura' } }), null);
  assert.equal(auth.sesion({}), null);

  const secretoViejo = process.env.SESSION_SECRET;
  const viejoCache = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'corto';
  auth.olvidarSecreto();
  assert.equal(auth.sesion({ headers: { cookie: 'jh_sesion=abc.def' } }), null);
  process.env.SESSION_SECRET = secretoViejo || viejoCache;
  auth.olvidarSecreto();
});

test('secreto() exige 16 caracteres o mas', function () {
  const original = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'demasiadocorto';
  auth.olvidarSecreto();
  assert.throws(function () { auth.secreto(); });
  process.env.SESSION_SECRET = 'diesiseiscaracteresok';
  auth.olvidarSecreto();
  assert.equal(auth.secreto(), 'diesiseiscaracteresok');
  process.env.SESSION_SECRET = original;
  auth.olvidarSecreto();
});

test('exigirAuth responde 401 sin sesion y adjeta req.sesion con sesion valida', function () {
  // sin sesion
  let codigo = null;
  let cuerpoJson = null;
  const res1 = {
    status: function (n) { codigo = n; return this; },
    json: function (o) { cuerpoJson = o; }
  };
  let siguienteLlamado = false;
  auth.exigirAuth({ headers: {} }, res1, function () { siguienteLlamado = true; });
  assert.equal(codigo, 401);
  assert.ok(cuerpoJson.error);
  assert.equal(siguienteLlamado, false);

  // con sesion
  const token = auth.crearToken(auth.ROLES.TIENDA, 'T2', 'Andre');
  const req = { headers: { cookie: auth.crearCookie(token) } };
  const res2 = { status: function () { return this; }, json: function () {} };
  let capturada = null;
  auth.exigirAuth(req, res2, function () { capturada = req.sesion; });
  assert.equal(capturada.rol, 'tienda');
  assert.equal(capturada.idTienda, 'T2');
  assert.equal(capturada.nombre, 'Andre');
  assert.equal(auth.esDueno({ sesion: capturada }), false);
});

test('esDueno solo es true con rol dueno', function () {
  assert.equal(auth.esDueno({ sesion: { rol: auth.ROLES.DUENO } }), true);
  assert.equal(auth.esDueno({ sesion: { rol: auth.ROLES.TIENDA } }), false);
  assert.equal(auth.esDueno({}), false);
  assert.equal(auth.esDueno(null), false);
});

test('exigirAuth normaliza cualquier rol raro a tienda (fail-safe)', function () {
  const token = auth.firmar({ rol: 'superusuario', idTienda: 'T9', nombre: 'x', exp: Date.now() + 1000 });
  const req = { headers: { cookie: auth.crearCookie(token) } };
  auth.exigirAuth(req, { status: function () { return this; }, json: function () {} }, function () {});
  assert.equal(req.sesion.rol, 'tienda');
});
test('crearSesion acepta un objeto y guarda el idEmpleado', function () {
  const token = auth.crearSesion({ rol: auth.ROL_TIENDA, idTienda: 'T1', idEmpleado: 'E7', nombre: 'Miros' });
  const carga = auth.verificar(token);
  assert.equal(carga.rol, 'tienda');
  assert.equal(carga.idTienda, 'T1');
  assert.equal(carga.idEmpleado, 'E7');
  assert.equal(carga.nombre, 'Miros');
});

test('crearToken tambien acepta la forma posicional que ya usaba', function () {
  const carga = auth.verificar(auth.crearToken('DUENO', null, 'Dueño'));
  assert.equal(carga.rol, 'dueno');
  assert.equal(carga.idTienda, '');
});

test('crearSesion y exigirSesion son los mismos que crearToken y exigirAuth', function () {
  assert.equal(auth.crearSesion, auth.crearToken);
  assert.equal(auth.exigirSesion, auth.exigirAuth);
  assert.equal(auth.ROL_TIENDA, 'tienda');
  assert.equal(auth.ROL_DUENO, 'dueno');
});
