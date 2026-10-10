'use strict';

const crypto = require('crypto');

const NOMBRE_COOKIE = 'jh_sesion';
const DURACION_MS = 8 * 60 * 60 * 1000; // 8 horas
const ROLES = Object.freeze({ TIENDA: 'tienda', DUENO: 'dueno' });

// --- secreto de firmas -----------------------------------------------------

let secretoCache = null;

function secreto() {
  if (secretoCache) return secretoCache;
  const valor = String(process.env.SESSION_SECRET || '');
  if (!valor || valor.length < 16) {
    throw new Error('SESSION_SECRET no esta definido o tiene menos de 16 caracteres.');
  }
  secretoCache = valor;
  return valor;
}

// Permite pruebas sin exportar estado: reinicia el cache del secreto.
function olvidarSecreto() {
  secretoCache = null;
}

// --- hashing de contrasenas ------------------------------------------------

// Devuelve 'scrypt$<sal-hex>$<derivado-hex>'. Misma clave -> distinto hash,
// porque la sal es aleatoria.
function hashearClave(clave) {
  const texto = String(clave === null || clave === undefined ? '' : clave);
  if (!texto) throw new Error('La clave no puede estar vacia.');
  const sal = crypto.randomBytes(16).toString('hex');
  const derivado = crypto.scryptSync(texto, sal, 64).toString('hex');
  return 'scrypt$' + sal + '$' + derivado;
}

// Comparacion en tiempo constante. Devuelve false (no null) ante cualquier
// formato inesperado, para que el llamador siempre trate eso como "no coincide".
function verificarClave(clave, guardado) {
  if (!guardado) return false;
  const partes = String(guardado).split('$');
  if (partes.length !== 3) return false;
  if (partes[0] !== 'scrypt') return false;
  const sal = partes[1];
  const esperado = partes[2];
  if (!sal || !esperado) return false;
  let calculado;
  try {
    calculado = crypto.scryptSync(String(clave === null || clave === undefined ? '' : clave), sal, 64).toString('hex');
  } catch (e) {
    return false;
  }
  if (calculado.length !== esperado.length) return false;
  return crypto.timingSafeEqual(Buffer.from(calculado, 'hex'), Buffer.from(esperado, 'hex'));
}

// --- sesiones --------------------------------------------------------------

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function desdeBase64url(texto) {
  const limpio = String(texto).replace(/-/g, '+').replace(/_/g, '/');
  const relleno = limpio.length % 4 === 0 ? '' : '='.repeat(4 - (limpio.length % 4));
  return Buffer.from(limpio + relleno, 'base64').toString('utf8');
}

function firmar(carga) {
  const cuerpo = base64url(JSON.stringify(carga));
  const firma = crypto.createHmac('sha256', secreto()).update(cuerpo).digest();
  return cuerpo + '.' + base64url(firma);
}

// Devuelve la carga si la firma es valida y no expiro; null en cualquier otro caso.
function verificar(token) {
  if (!token) return null;
  const partes = String(token).split('.');
  if (partes.length !== 2) return null;
  const cuerpo = partes[0];
  const firma = partes[1];
  if (!cuerpo || !firma) return null;
  let esperado;
  try {
    esperado = crypto.createHmac('sha256', secreto()).update(cuerpo).digest();
  } catch (e) {
    return null;
  }
  let recibido;
  try {
    recibido = Buffer.from(firma, 'base64url');
  } catch (e) {
    return null;
  }
  if (esperado.length !== recibido.length) return null;
  if (!crypto.timingSafeEqual(esperado, recibido)) return null;
  let carga;
  try {
    carga = JSON.parse(desdeBase64url(cuerpo));
  } catch (e) {
    return null;
  }
  if (!carga || typeof carga !== 'object') return null;
  if (!carga.exp || Number(carga.exp) < Date.now()) return null;
  return carga;
}

// Crea el token de sesion con 8 horas de vida.
// Acepta las dos formas: crearToken('DUENO', '', 'Dueno') y
// crearToken({rol, idTienda, idEmpleado, nombre}). El rol se normaliza a
// minusculas para que la comparacion de permisos sea siempre la misma.
function crearToken(rol, idTienda, nombre) {
  const datos = (rol && typeof rol === 'object')
    ? rol
    : { rol: rol, idTienda: idTienda, nombre: nombre };
  const vacio = function (v) { return v === null || v === undefined ? '' : String(v); };
  return firmar({
    rol: String(datos.rol || '').toLowerCase(),
    idTienda: vacio(datos.idTienda),
    idEmpleado: vacio(datos.idEmpleado),
    nombre: String(datos.nombre || ''),
    exp: Date.now() + DURACION_MS
  });
}

// --- cookies ---------------------------------------------------------------

function leerCookies(cabecera) {
  const resultado = {};
  const bruto = Array.isArray(cabecera) ? cabecera.join(';') : String(cabecera || '');
  for (const trozo of bruto.split(';')) {
    const igual = trozo.indexOf('=');
    if (igual < 0) continue;
    const clave = trozo.slice(0, igual).trim();
    if (!clave) continue;
    try {
      resultado[clave] = decodeURIComponent(trozo.slice(igual + 1).trim());
    } catch (e) {
      resultado[clave] = trozo.slice(igual + 1).trim();
    }
  }
  return resultado;
}

function crearCookie(token) {
  const seguro = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return NOMBRE_COOKIE + '=' + encodeURIComponent(token) +
    '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + Math.floor(DURACION_MS / 1000) + seguro;
}

function borrarCookie() {
  return NOMBRE_COOKIE + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';
}

// --- middleware ------------------------------------------------------------

// Devuelve la carga de sesion o null. Nunca lanza.
function sesion(req) {
  try {
    const cookies = leerCookies(req.headers && req.headers.cookie);
    return verificar(cookies[NOMBRE_COOKIE]);
  } catch (e) {
    return null;
  }
}

function estaAutenticado(req) {
  return sesion(req) !== null;
}

// Normaliza la sesion a la forma que usan las rutas: {rol, idTienda, nombre}.
// El idTienda SIEMPRE sale de la sesion, nunca del cuerpo del pedido.
function exigirAuth(req, res, siguiente) {
  const carga = sesion(req);
  if (!carga) {
    res.status(401).json({ error: 'Sesion no valida o vencida. Vuelve a entrar.' });
    return;
  }
  req.sesion = {
    rol: carga.rol === ROLES.DUENO ? ROLES.DUENO : ROLES.TIENDA,
    idTienda: String(carga.idTienda || ''),
    nombre: String(carga.nombre || '')
  };
  siguiente();
}

function esDueno(req) {
  return Boolean(req && req.sesion && req.sesion.rol === ROLES.DUENO);
}

module.exports = {
  NOMBRE_COOKIE,
  DURACION_MS,
  ROLES,
  ROL_TIENDA: ROLES.TIENDA,
  ROL_DUENO: ROLES.DUENO,
  secreto,
  olvidarSecreto,
  hashearClave,
  verificarClave,
  firmar,
  verificar,
  crearToken,
  crearSesion: crearToken,
  leerCookies,
  crearCookie,
  borrarCookie,
  sesion,
  estaAutenticado,
  exigirAuth,
  exigirSesion: exigirAuth,
  esDueno
};