'use strict';

// Cliente de Google Apps Script. Es el unico camino para leer o escribir en
// las hojas. Dos tramapas que este archivo existe para evitar:
//
// 1. Apps Script responde HTTP 200 incluso cuando rechaza, con un cuerpo
//    {status:'ERROR', message:'...'}. Si solo miramos el codigo HTTP, la app
//    muestra "venta registrada" aunque la hoja nunca se toco.
// 2. Si falta SESSION_SECRET, placa o timeout, hay que distinguir esos casos
//    de un error de la hoja, porque la instruccion que ve el dueño es otra.

const TIMEOUT_MS = Number(process.env.SHEETS_TIMEOUT_MS) || 20000;
const CACHE_TTL_MS = Number(process.env.SHEETS_CACHE_MS) || 20000;

function config() {
  return {
    url: String(process.env.SHEETS_WEBAPP_URL || '').trim(),
    clave: String(process.env.SHEETS_API_KEY || '').trim()
  };
}

function tieneUrl() {
  return config().url.length > 0;
}

function tieneClave() {
  return config().clave.length > 0;
}

function completo() {
  return tieneUrl() && tieneClave();
}

function construirUrl(conClave) {
  const c = config();
  const conQuery = c.url.indexOf('?') !== -1;
  const marca = conQuery ? '&' : '?';
  return conClave ? c.url + marca + 'key=' + encodeURIComponent(c.clave) : c.url;
}

function error(mensaje, codigo) {
  const e = new Error(mensaje);
  e.codigo = codigo || 502;
  return e;
}

const MENSAJE_ACCESO = 'El despliegue de Google Apps Script devolvio 403 con la pagina de ' +
  'acceso denegado: el script no acepta peticiones anonimas. Eso NO es la clave. En Apps Script: ' +
  'Implementar > Nueva implementacion > Tipo: Aplicacion web > Ejecutar como: Yo > ' +
  'Quien tiene acceso: Cualquier persona. Despues implementalo de nuevo y recarga esta pantalla.';

// Un 403 de permisos y un 403 de clave se parecen en el estado pero no en el
// cuerpo: la clave devuelve JSON con NO_AUTORIZADO, el acceso devuelve HTML de Google.
// Confundirlos mandaba a cambiar SHEETS_API_KEY una y otra vez sin resolver nada.
function esAccesoDenegado(datos, textoCrudo, estadoHttp) {
  if (estadoHttp !== 401 && estadoHttp !== 403) return false;
  if (datos !== null && datos !== undefined) return false;
  const crudo = String(textoCrudo || '').trim();
  return crudo.charAt(0) === '<' || crudo.indexOf('<html') !== -1;
}

function pareceFalloDeAuth(datos, estadoHttp) {
  const texto = (datos && (datos.message || datos.error)) || '';
  const mayus = String(texto).toUpperCase();
  return mayus.indexOf('NO_AUTORIZADO') !== -1 ||
    mayus.indexOf('UNAUTHORIZED') !== -1 ||
    mayus.indexOf('TOKEN') !== -1 ||
    mayus.indexOf('API KEY') !== -1 ||
    mayus.indexOf('APIKEY') !== -1;
}

// payload === null -> GET (solo lectura). Objeto -> POST.
async function pedirRemoto(payload) {
  const c = config();
  if (!c.url) throw error('Falta SHEETS_WEBAPP_URL en el servidor.', 503);
  if (!c.clave) throw error('Falta SHEETS_API_KEY en el servidor.', 503);

  const metodo = payload === null ? 'GET' : 'POST';
  const url = construirUrl(payload === null);
  const controlador = new AbortController();
  const temporizador = setTimeout(function () { controlador.abort(); }, TIMEOUT_MS);

  let respuesta;
  try {
    respuesta = await fetch(url, {
      method: metodo,
      headers: { 'Content-Type': 'application/json' },
      body: payload === null ? undefined : JSON.stringify(Object.assign({ apiKey: c.clave }, payload)),
      signal: controlador.signal
    });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw error('Google Sheets tardo demasiado en responder. Revisa la conexion.', 504);
    }
    throw error('No se pudo contactar Google Sheets. Revisa la URL del despliegue.', 502);
  } finally {
    clearTimeout(temporizador);
  }

  const texto = await respuesta.text();
  let datos = null;
  try {
    datos = texto ? JSON.parse(texto) : null;
  } catch (e) {
    datos = null;
  }

  if (esAccesoDenegado(datos, texto, respuesta.status)) {
    throw error(MENSAJE_ACCESO, 502);
  }
  if (pareceFalloDeAuth(datos, respuesta.status)) {
    throw error('Google Sheets rechazo la clave. Revisa SHEETS_API_KEY en Render y en el script.', 502);
  }
  if (!respuesta.ok) {
    throw error('Google Sheets respondio con error ' + respuesta.status + '.', 502);
  }
  if (datos === null) {
    throw error('Google Sheets devolvio una respuesta que no se entiende. Puede que falte desplegar la ultima version del script.', 502);
  }
  return datos;
}

// TRAMPA 1: HTTP 200 no significa exito.Apps Script devuelve {status:'ERROR'}.
// Cualquier excepcion aqui se propaga con codigo 409 para que la ruta la
// traduzca a un mensaje honesto y no a un "guardado" falso.
async function escribir(payload) {
  const datos = await pedirRemoto(payload);
  if (datos && datos.status === 'ERROR') {
    const e = new Error('Google Sheets rechazo la operacion: ' + String(datos.message || 'sin detalle'));
    e.codigo = 409;
    throw e;
  }
  limpiarCache();
  return datos;
}

async function leer(accion, extra) {
  const c = config();
  if (!c.url) throw error('Falta SHEETS_WEBAPP_URL en el servidor.', 503);
  // Acepta las dos formas: leer('REPORTE_VENTAS') y leer({accion, ...filtros}).
  // Los filtros viajan en la query; el .gs los usa solo para acotar.
  const base = (accion && typeof accion === 'object')
    ? Object.assign({}, accion)
    : Object.assign({}, extra, { accion: accion });
  // Se aceptan las dos grafias: el .gs lee e.parameter.action, pero el
  // llamante puede escribir 'accion'. Con la grafia equivocada la query
  // llevaba action=undefined y el script respondia 'Accion no reconocida'.
  const nombreAccion = base.accion === undefined ? base.action : base.accion;
  delete base.accion;
  delete base.action;
  // El .gs lee e.parameter.action: el parametro de la URL se llama 'action'.
  const query = new URLSearchParams(
    Object.assign({}, base, { action: nombreAccion, key: c.clave })
  ).toString();
  const url = c.url + (c.url.indexOf('?') !== -1 ? '&' : '?') + query;
  const controlador = new AbortController();
  const temporizador = setTimeout(function () { controlador.abort(); }, TIMEOUT_MS);
  let texto;
  try {
    const respuesta = await fetch(url, { method: 'GET', signal: controlador.signal });
    texto = await respuesta.text();
    if (esAccesoDenegado(null, texto, respuesta.status)) {
      throw error(MENSAJE_ACCESO, 502);
    }
    if (respuesta.status === 401 || respuesta.status === 403) {
      throw error('Google Sheets rechazo la clave.', 502);
    }
  } catch (e) {
    if (e && e.codigo) throw e;
    if (e && e.name === 'AbortError') throw error('Google Sheets tardo demasiado.', 504);
    throw error('No se pudo leer de Google Sheets.', 502);
  } finally {
    clearTimeout(temporizador);
  }
  let datos;
  try {
    datos = texto ? JSON.parse(texto) : null;
  } catch (e) {
    throw error('Google Sheets devolvio algo que no es JSON.', 502);
  }
  if (datos && datos.error === 'NO_AUTORIZADO') throw error('Google Sheets rechazo la clave.', 502);
  limpiarCache();
  return datos;
}

// Puerto de salud: se consulta por ?action=SALUD sin validar la clave, para
// poder distinguir "el script esta caido" de "la clave esta mala".
async function salud() {
  const c = config();
  if (!c.url) throw error('Falta SHEETS_WEBAPP_URL en el servidor.', 503);
  const controlador = new AbortController();
  const temporizador = setTimeout(function () { controlador.abort(); }, TIMEOUT_MS);
  try {
    const respuesta = await fetch(construirUrl(false) + (construirUrl(false).indexOf('?') !== -1 ? '&' : '?') + 'action=SALUD', { signal: controlador.signal });
    return await respuesta.json();
  } catch (e) {
    throw error('El script de Google Sheets no responde.', 502);
  } finally {
    clearTimeout(temporizador);
  }
}

// Cuatro pasos que el dueño puede seguir en este orden para arreglar la hoja.
async function diagnostico() {
  const pasos = [];
  const c = config();

  pasos.push({ paso: 1, ok: tieneUrl(), titulo: 'URL del despliegue en Render', detalle: tieneUrl() ? 'SHEETS_WEBAPP_URL esta definida.' : 'Falta SHEETS_WEBAPP_URL en las variables de Render.', accion: tieneUrl() ? 'Ninguna.' : 'Pega la URL /exec de la Implementacion en las variables de Render.' });
  pasos.push({ paso: 2, ok: tieneClave(), titulo: 'Clave compartida en Render', detalle: tieneClave() ? 'SHEETS_API_KEY esta definida.' : 'Falta SHEETS_API_KEY en las variables de Render.', accion: tieneClave() ? 'Ninguna.' : 'Copia la clave del log del script a SHEETS_API_KEY en Render.' });
  pasos.push({ paso: 3, ok: false, titulo: 'El script responde', detalle: 'Pendiente de probar.', accion: 'Ninguna todavia.' });
  pasos.push({ paso: 4, ok: false, titulo: 'La clave coincide', detalle: 'Pendiente de probar.', accion: 'Ninguna todavia.' });

  if (tieneUrl()) {
    try {
      const s = await salud();
      pasos[2].ok = Boolean(s && s.ok);
      pasos[2].detalle = s && s.ok ? 'El script responde. Version ' + String(s.version || '?') + '.' : 'El script respondio algo raro.';
      pasos[2].accion = s && s.ok ? 'Ninguna.' : 'En Apps Script: Implementar > Nueva implementacion. Sin nueva version, /exec sirve el codigo viejo.';
    } catch (e) {
      pasos[2].detalle = 'El script no responde: ' + e.message;
      pasos[2].accion = 'En Apps Script: Implementar > Nueva implementacion. Sin nueva version, /exec sigue sirviendo el codigo viejo. Revisa tambien que el acceso sea "Cualquier persona".';
    }
  }
  if (tieneUrl() && tieneClave() && pasos[2].ok) {
    try {
      const d = await leer({ action: 'SALUD_TIENDA' });
      pasos[3].ok = !d || d.status !== 'ERROR';
      pasos[3].detalle = pasos[3].ok ? 'La clave es aceptada.' : 'El script rechazo la clave.';
      pasos[3].accion = pasos[3].ok ? 'Ninguna.' : 'La SHEETS_API_KEY de Render debe ser identica a la propiedad SHEETS_API_KEY del script.';
    } catch (e) {
      pasos[3].detalle = e.message;
      pasos[3].accion = 'La SHEETS_API_KEY de Render debe ser identica a la propiedad SHEETS_API_KEY del script.';
    }
  }

  return { completo: completo(), pasos, version: 2 };
}

// --- cache de lecturas -----------------------------------------------------

const cache = new Map();

function limpiarCache() {
  cache.clear();
}

async function conCache(clave, calcular) {
  const ahora = Date.now();
  const guardado = cache.get(clave);
  if (guardado && guardado.enCurso) return guardado.enCurso;
  if (guardado && guardado.valor !== undefined && guardado.expira > ahora) return guardado.valor;
  const enCurso = calcular().then(function (valor) {
    cache.set(clave, { valor, expira: Date.now() + CACHE_TTL_MS });
    return valor;
  }).catch(function (e) {
    cache.delete(clave);
    throw e;
  });
  cache.set(clave, { enCurso, expira: ahora + CACHE_TTL_MS });
  return enCurso;
}

// Compara textos sin depender de acentos, mayusculas ni espacios dobles.
function normalizar(texto) {
  if (texto === null || texto === undefined) return '';
  return String(texto)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = {
  TIMEOUT_MS,
  CACHE_TTL_MS,
  tieneUrl,
  tieneClave,
  completo,
  construirUrl,
  error,
  pareceFalloDeAuth,
  esAccesoDenegado,
  MENSAJE_ACCESO,
  pedirRemoto,
  escribir,
  leer,
  normalizar,
  salud,
  diagnostico,
  limpiarCache,
  conCache
};
