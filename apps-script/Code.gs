/**
 * Sis Jhessel — puente hacia Google Sheets.
 *
 * Este archivo NO calcula dinero. Toda la aritmetica vive en el servidor Node
 * (`src/money.js`); aqui solo se guardan y se leen filas. Si algo aqui parece
 * "calcular", es un error.
 *
 * Dos reglas que no se negocian:
 *
 * 1. Las columnas se resuelven SIEMPRE por encabezado, nunca por posicion. Si
 *    alguien inserta una columna a mano, el sistema sigue leyendo bien.
 * 2. Toda escritura pasa por `LockService`. Dos ventaneas pueden vender a la vez
 *    y sin lock se pisan las filas.
 *
 * Instalacion (una sola vez, la hace el dueno):
 *   1. Correr `generarClaveCompartida()` UNA vez y copiar el valor del log.
 *   2. Propiedades del proyecto > de script > SHEETS_API_KEY = ese valor.
 *   3. Implementar > Nueva implementacion > Ejecutar como: Yo >
 *      Quien tiene acceso: Cualquier persona.
 *   4. Borrar la funcion `generarClaveCompartida` del archivo.
 */

'use strict';

// --- nombres de hoja --------------------------------------------------------

var NOMBRE_HOJA_TIENDAS = 'Tiendas';
var NOMBRE_HOJA_EMPLEADOS = 'Empleados';
var NOMBRE_HOJA_CATALOGO = 'Catalogo';
var NOMBRE_HOJA_VENTAS = 'Ventas';
var NOMBRE_HOJA_LINEAS = 'VentaLineas';
var NOMBRE_HOJA_CIERRES = 'Cierres';
var NOMBRE_HOJA_TCDIA = 'TcDia';

var CANTIDAD_MAXIMA_SEMBRADO = 200;
var ESPERA_LOCK_MS = 15000;
var VERSION_SERVICIO = 1;

// --- encabezados ------------------------------------------------------------
//
// El orden es el que crea la hoja la primera vez. Despues manda el encabezado:
// `columna()` busca por nombre, asi que reordenar estas listas mas adelante no
// rompe nada.

var ENCABEZADO_TIENDAS = ['IdTienda', 'Nombre', 'Empleados', 'PctComision', 'ClaveHash',
  'Activa', 'CreadoEn'];

var ENCABEZADO_EMPLEADOS = ['IdEmpleado', 'Nombre', 'IdTienda', 'Activo', 'CreadoEn'];

var ENCABEZADO_CATALOGO = ['IdProducto', 'Marca', 'Modelo', 'PrecioRefUsdCents', 'Specs',
  'Activo'];

// Nota: el servidor tambien escribe `Tienda` y `Unidades`, que el ledger usa
// para el consolidado. Van aqui para que la hoja los tenga desde el primer dia.
var ENCABEZADO_VENTAS = ['IdVenta', 'Fecha', 'IdTienda', 'Tienda', 'IdEmpleado', 'Vendedor',
  'Moneda', 'TcDecimas', 'GananciaUsdCents', 'AjusteUsdCents', 'GananciaBsCents',
  'PctComision', 'ComisionBsCents', 'NetoDuenoBsCents', 'TotalCobradoUsdCents', 'Estado',
  'Notas', 'IdCierre', 'Unidades', 'ClaveIdempotencia', 'CreadoEn', 'ActualizadoEn'];

var ENCABEZADO_LINEAS = ['IdVenta', 'IdProducto', 'Modelo', 'Cantidad', 'PrecioUsdCents',
  'CostoUnitarioUsdCents', 'Origen'];

var ENCABEZADO_CIERRES = ['IdCierre', 'Fecha', 'IdTienda', 'Tienda', 'CerradoPor', 'Ventas',
  'TotalComisionBsCents', 'TotalNetoBsCents', 'PagadoBsCents', 'SaldoBsCents', 'CerradoEn',
  'ClaveIdempotencia'];

var ENCABEZADO_TCDIA = ['Fecha', 'IdEmpleado', 'Empleado', 'IdTienda', 'TcDecimas',
  'RegistradoEn'];

// --- autenticacion ----------------------------------------------------------

/**
 * La clave viaja en la query porque Apps Script no deja leer cabeceras HTTP.
 * Por eso la comparacion es a mano: primero longitud, luego XOR de charCodes.
 */
function claveEsValida(recibida) {
  var guardada = String(
    PropertiesService.getScriptProperties().getProperty('SHEETS_API_KEY') || '');
  var trilha = String(recibida || '');
  if (guardada.length === 0 || guardada.length !== trilha.length) {
    return false;
  }
  var diferencia = 0;
  for (var i = 0; i < guardada.length; i++) {
    diferencia |= guardada.charCodeAt(i) ^ trilha.charCodeAt(i);
  }
  return diferencia === 0;
}

/** Correr UNA vez, copiar el valor del log y despues borrar esta funcion. */
function generarClaveCompartida() {
  var clave = Utilities.getUuid().replace(/-/g, '') +
    Utilities.getUuid().replace(/-/g, '');
  Logger.log('SHEETS_API_KEY = ' + clave);
  return clave;
}

// --- utilidades -------------------------------------------------------------

function responderJSON(objeto) {
  return ContentService
    .createTextOutput(JSON.stringify(objeto))
    .setMimeType(ContentService.MimeType.JSON);
}

function responderError(mensaje) {
  // HTTP 200 con status ERROR a proposito: Apps Script no puede fijar el codigo.
  // El cliente de Node detecta `status === 'ERROR'` y lo trata como fallo.
  return responderJSON({ status: 'ERROR', message: String(mensaje || 'Error sin detalle') });
}

/** Un texto que empieza con = + - @ se ejecuta como formula en Sheets. */
function sanitizarTexto(valor) {
  var texto = valor === null || valor === undefined ? '' : String(valor);
  texto = texto.slice(0, 200);
  if (/^[=+\-@]/.test(texto)) {
    texto = "'" + texto;
  }
  return texto;
}

function entero(valor) {
  var n = Number(valor);
  return isFinite(n) ? Math.round(n) : 0;
}

function textoSimple(valor) {
  return valor === null || valor === undefined ? '' : String(valor);
}

function bandera(valor) {
  var t = textoSimple(valor).trim().toUpperCase();
  return t === '1' || t === 'TRUE' || t === 'SI' || t === 'SÍ' || t === 'X' || t === 'S';
}

function ahoraIso() {
  return new Date().toISOString();
}

/**
 * Devuelve el indice (base 0) de una columna buscada por encabezado.
 * Sin encabezado devuelve -1: el que llama decide si eso es un problema.
 */
function columna(cabeceras, nombre, porDefecto) {
  var objetivo = String(nombre || '').trim().toLowerCase();
  for (var i = 0; i < cabeceras.length; i++) {
    if (String(cabeceras[i]).trim().toLowerCase() === objetivo) {
      return i;
    }
  }
  return porDefecto === undefined ? -1 : porDefecto;
}

/** Acceso seguro: una hoja con menos columnas de las que pedimos no rompe. */
function celda(fila, indice) {
  if (indice < 0) return '';
  if (indice >= fila.length) return '';
  var v = fila[indice];
  return v === null || v === undefined ? '' : v;
}

/** Agrega las columnas que falten al final, una por una, sin tocar el resto. */
function asegurarEncabezados(hoja, encabezados) {
  var ultimaFila = hoja.getLastRow();
  var existentes = ultimaFila > 0
    ? hoja.getRange(1, 1, 1, Math.max(hoja.getLastColumn(), encabezados.length)).getValues()[0]
    : [];
  var bajados = existentes.map(function (c) {
    return String(c).trim().toLowerCase();
  });
  for (var i = 0; i < encabezados.length; i++) {
    var nombre = encabezados[i];
    if (bajados.indexOf(String(nombre).trim().toLowerCase()) === -1) {
      hoja.getRange(1, existentes.length + 1).setValue(nombre);
      Logger.log('Columna agregada a ' + hoja.getName() + ': ' + nombre);
      existentes.push(nombre);
      bajados.push(String(nombre).trim().toLowerCase());
    }
  }
  if (hoja.getFrozenRows() === 0) {
    hoja.setFrozenRows(1);
  }
}

/** Devuelve la hoja, creandola con los encabezados si no existe. */
function obtenerHoja(ss, nombre, encabezados) {
  var hoja = ss.getSheetByName(nombre);
  if (!hoja) {
    hoja = ss.insertSheet(nombre);
    hoja.getRange(1, 1, 1, encabezados.length).setValues([encabezados]);
    hoja.getRange(1, 1, 1, encabezados.length).setFontWeight('bold');
    hoja.setFrozenRows(1);
    Logger.log('Hoja creada: ' + nombre);
    return hoja;
  }
  asegurarEncabezados(hoja, encabezados);
  return hoja;
}

/**
 * Filas de datos de una hoja. Con la hoja vacia devuelve [].
 *
 * El `lastRow() < 2` es obligatorio: `getRange(2, 5, -1, 1)` con una hoja de
 * una sola fila lanza "Range exceeds grid limits", y eso sevio pasar.
 */
function leerFilas(ss, nombre) {
  var hoja = ss.getSheetByName(nombre);
  if (!hoja) return [];
  var ultimaFila = hoja.getLastRow();
  var ultimaColumna = hoja.getLastColumn();
  if (ultimaFila < 2 || ultimaColumna < 1) return [];
  var valores = hoja.getRange(1, 1, ultimaFila, ultimaColumna).getValues();
  var salida = [];
  for (var i = 1; i < valores.length; i++) {
    var fila = valores[i];
    var vacia = true;
    for (var j = 0; j < fila.length; j++) {
      if (String(celda(fila, j)).trim() !== '') {
        vacia = false;
        break;
      }
    }
    if (!vacia) {
      salida.push({ fila: fila, indice: i + 1 });
    }
  }
  return salida;
}

/**
 * Busca una fila por el valor de una columna.
 * Devuelve {fila, indiceExcel} o null. `fila` es la fila COMPLETA.
 */
function filaConValor(ss, nombreHoja, nombreColumna, valorBuscado) {
  var hoja = ss.getSheetByName(nombreHoja);
  if (!hoja) return null;
  var cabeceras = encabezadosDeHoja(hoja);
  var indice = columna(cabeceras, nombreColumna, -1);
  if (indice < 0) return null;
  var objetivo = String(valorBuscado === undefined ? '' : valorBuscado).trim();
  if (objetivo === '') return null;
  var ultimaFila = hoja.getLastRow();
  if (ultimaFila < 2) return null;
  var ancho = Math.max(cabeceras.length, hoja.getLastColumn());
  var valores = hoja.getRange(2, 1, ultimaFila - 1, ancho).getValues();
  for (var i = 0; i < valores.length; i++) {
    if (String(celda(valores[i], indice)).trim() === objetivo) {
      return { fila: valores[i], indiceExcel: i + 2 };
    }
  }
  return null;
}

/**
 * Segunda capa de idempotencia: la hoja ya vio esta clave.
 *
 * Si la columna ClaveIdempotencia no existe NO deduplicamos: es preferible
 * guardar una venta repetida que deduplicar contra la columna equivocada.
 */
function filaYaRegistrada(ss, nombreHoja, nombreColumna, clave) {
  var hoja = ss.getSheetByName(nombreHoja);
  if (!hoja) return null;
  var cabeceras = encabezadosDeHoja(hoja);
  var indice = columna(cabeceras, nombreColumna, -1);
  if (indice < 0) {
    Logger.log('AVISO: la hoja ' + nombreHoja + ' no tiene la columna ' + nombreColumna +
      '. No se deduplica.');
    return null;
  }
  var ultimaFila = hoja.getLastRow();
  if (ultimaFila < 2) return null;
  var ancho = Math.max(cabeceras.length, hoja.getLastColumn());
  var valores = hoja.getRange(2, 1, ultimaFila - 1, ancho).getValues();
  var objetivo = String(clave === undefined ? '' : clave).trim();
  if (objetivo === '') return null;
  for (var i = 0; i < valores.length; i++) {
    if (String(celda(valores[i], indice)).trim() === objetivo) {
      return {
        fila: valores[i],
        indiceExcel: i + 2,
        id: String(celda(valores[i], columna(cabeceras, 'IdVenta', 0)))
      };
    }
  }
  return null;
}

// --- reportes ---------------------------------------------------------------

/** Arma `{cabeceras, filas}` con lo que hay ahora mismo en la hoja. */
function reportar(ss, nombreHoja, filtros, filtroFn) {
  var hoja = ss.getSheetByName(nombreHoja);
  if (!hoja) {
    obtenerHoja(ss, nombreHoja, encabezadosDe(nombreHoja));
    hoja = ss.getSheetByName(nombreHoja);
  }
  var cabeceras = encabezadosDeHoja(hoja);
  var filas = [];
  var filasLeidas = leerFilas(ss, nombreHoja);
  for (var i = 0; i < filasLeidas.length; i++) {
    var actual = filasLeidas[i].fila;
    if (filtroFn && !filtroFn(actual, cabeceras, filtros)) {
      continue;
    }
    filas.push(actual);
  }
  return { cabeceras: cabeceras, filas: filas };
}

function encabezadosDe(nombreHoja) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = ss.getSheetByName(nombreHoja);
  if (!hoja) return ENCABEZADOS_POR_HOJA[nombreHoja] || [];
  return encabezadosDeHoja(hoja);
}

function encabezadosDeHoja(hoja) {
  var ultimaColumna = hoja.getLastColumn();
  if (ultimaColumna < 1) return [];
  return hoja.getRange(1, 1, 1, ultimaColumna).getValues()[0].map(function (c) {
    return String(c).trim();
  });
}

var ENCABEZADOS_POR_HOJA = {};
ENCABEZADOS_POR_HOJA[NOMBRE_HOJA_TIENDAS] = ENCABEZADO_TIENDAS;
ENCABEZADOS_POR_HOJA[NOMBRE_HOJA_EMPLEADOS] = ENCABEZADO_EMPLEADOS;
ENCABEZADOS_POR_HOJA[NOMBRE_HOJA_CATALOGO] = ENCABEZADO_CATALOGO;
ENCABEZADOS_POR_HOJA[NOMBRE_HOJA_VENTAS] = ENCABEZADO_VENTAS;
ENCABEZADOS_POR_HOJA[NOMBRE_HOJA_LINEAS] = ENCABEZADO_LINEAS;
ENCABEZADOS_POR_HOJA[NOMBRE_HOJA_CIERRES] = ENCABEZADO_CIERRES;
ENCABEZADOS_POR_HOJA[NOMBRE_HOJA_TCDIA] = ENCABEZADO_TCDIA;

/** El dia de una fila de fecha: la hoja guarda ISO, a veces con hora. */
function diaDe(valor) {
  return textoSimple(valor).slice(0, 10);
}

function filtrarPorRango(filtros) {
  var desde = textoSimple(filtros.desde);
  var hasta = textoSimple(filtros.hasta);
  return function (fila, cabeceras, _f) {
    var dia = diaDe(celda(fila, columna(cabeceras, 'Fecha', 0)));
    if (desde && dia < desde) return false;
    if (hasta && dia > hasta) return false;
    return true;
  };
}

function filtrarVentas(filtros) {
  var idTienda = textoSimple(filtros.idTienda);
  var porRango = filtrarPorRango(filtros);
  return function (fila, cabeceras, f) {
    if (!porRango(fila, cabeceras, f)) return false;
    if (idTienda && textoSimple(celda(fila, columna(cabeceras, 'IdTienda', 2))) !== idTienda) {
      return false;
    }
    return true;
  };
}

function despacharLectura(accion, parametros) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  switch (accion) {
    case 'REPORTE_TIENDAS':
      return reportar(ss, NOMBRE_HOJA_TIENDAS, parametros, null);
    case 'REPORTE_EMPLEADOS':
      return reportar(ss, NOMBRE_HOJA_EMPLEADOS, parametros, null);
    case 'REPORTE_CATALOGO':
      return reportar(ss, NOMBRE_HOJA_CATALOGO, parametros, null);
    case 'REPORTE_VENTAS':
      return reportar(ss, NOMBRE_HOJA_VENTAS, parametros, filtrarVentas(parametros));
    case 'REPORTE_CIERRES':
      return reportar(ss, NOMBRE_HOJA_CIERRES, parametros, filtrarVentas(parametros));
    case 'REPORTE_TC':
      return reportar(ss, NOMBRE_HOJA_TCDIA, parametros, filtrarPorRango(parametros));
    case 'REPORTE_LINEAS': {
      var idVenta = textoSimple(parametros.idVenta);
      return reportar(ss, NOMBRE_HOJA_LINEAS, parametros, function (fila, cabeceras) {
        if (idVenta === '') return true;
        return textoSimple(celda(fila, columna(cabeceras, 'IdVenta', 0))) === idVenta;
      });
    }
    default:
      throw new Error('Lectura no reconocida: ' + accion);
  }
}

// --- entradas ---------------------------------------------------------------

function doGet(e) {
  var parametros = (e && e.parameter) ? e.parameter : {};
  var accion = String(parametros.action || '').toUpperCase();

  // Puerto de salud ANTES de la clave: sirve para saber si el script esta
  // desplegado, y deployed es justo lo que se rompe cuando se edita el editor.
  if (accion === 'SALUD') {
    return responderJSON({
      ok: true,
      hora: ahoraIso(),
      version: VERSION_SERVICIO
    });
  }

  try {
    if (!claveEsValida(parametros.key)) {
      return responderError('NO_AUTORIZADO');
    }
    // Puerto de clave DESPUES de validar la clave: el diagnostico del servidor
    // lo usa para saber si SHEETS_API_KEY coincide, asi que tiene que existir.
    // No devuelve datos de la hoja, solo el conteo.
    if (accion === 'SALUD_TIENDA') {
      var hojaVentas = obtenerHoja(SpreadsheetApp.getActiveSpreadsheet(),
        NOMBRE_HOJA_VENTAS, encabezadosDe(NOMBRE_HOJA_VENTAS));
      var filas = hojaVentas.getLastRow() < 2 ? 0 : hojaVentas.getLastRow() - 1;
      return responderJSON({
        ok: true,
        hora: ahoraIso(),
        version: VERSION_SERVICIO,
        ventas: filas
      });
    }
    return responderJSON(despacharLectura(accion, parametros));
  } catch (error) {
    return responderError(error && error.message ? error.message : error);
  }
}

function doPost(e) {
  var datos = null;
  try {
    datos = JSON.parse(e.postData.contents);
  } catch (error) {
    return responderError('No se pudo leer el cuerpo de la peticion: ' + error.message);
  }
  if (!datos || typeof datos !== 'object') {
    return responderError('El cuerpo tiene que ser un objeto JSON.');
  }

  // Una lectura via POST no necesita lock ni escribir nada.
  var accion = String(datos.accion || datos.action || '').toUpperCase();
  if (accion.indexOf('REPORTE_') === 0) {
    try {
      if (!claveEsValida(datos.apiKey)) {
        return responderError('NO_AUTORIZADO');
      }
      return responderJSON(despacharLectura(accion, datos));
    } catch (error) {
      return responderError(error && error.message ? error.message : error);
    }
  }

  if (!claveEsValida(datos.apiKey)) {
    return responderError('NO_AUTORIZADO');
  }
  delete datos.apiKey;

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(ESPERA_LOCK_MS);
  } catch (error) {
    return responderError('La hoja esta ocupada. Reintenta en unos segundos.');
  }

  try {
    return responderJSON(despacharEscritura(String(datos.tipoOperacion || ''), datos));
  } catch (error) {
    return responderError(error && error.message ? error.message : error);
  } finally {
    lock.releaseLock();
  }
}

function despacharEscritura(operacion, datos) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  switch (operacion) {
    case 'GUARDAR_VENTA':
      return guardarVenta(ss, datos);
    case 'ACTUALIZAR_VENTA':
      return actualizarVenta(ss, datos);
    case 'CAMBIAR_ESTADO':
      return cambiarEstado(ss, datos);
    case 'ELIMINAR_VENTA':
      return eliminarVenta(ss, datos);
    case 'CERRAR_TIENDA':
      return cerrarTienda(ss, datos);
    case 'GUARDAR_PRECIO':
      return guardarPrecio(ss, datos);
    case 'GUARDAR_TIENDA':
      return guardarTienda(ss, datos);
    case 'GUARDAR_EMPLEADOS':
      return guardarEmpleados(ss, datos);
    case 'SEMBRAR_CATALOGO':
      return sembrarCatalogo(ss, datos);
    default:
      throw new Error('Operacion no reconocida: ' + operacion);
  }
}

/** Reemplaza toda la fila de una hoja sin asumir el orden de columnas. */
function escribirFila(hoja, indiceExcel, valoresPorNombre) {
  var cabeceras = encabezadosDeHoja(hoja);
  var fila = [];
  for (var i = 0; i < cabeceras.length; i++) {
    var nombre = cabeceras[i];
    fila.push(valoresPorNombre[nombre] === undefined ? '' : valoresPorNombre[nombre]);
  }
  hoja.getRange(indiceExcel, 1, 1, Math.max(cabeceras.length, 1)).setValues([fila]);
  return fila;
}

// --- ventas -----------------------------------------------------------------

function guardarVenta(ss, datos) {
  var venta = datos.venta || {};
  var clave = sanitizarTexto(venta.claveIdempotencia || datos.claveIdempotencia || '');

  var hojaVentas = obtenerHoja(ss, NOMBRE_HOJA_VENTAS, ENCABEZADO_VENTAS);
  var previa = filaYaRegistrada(ss, NOMBRE_HOJA_VENTAS, 'ClaveIdempotencia', clave);
  if (previa) {
    // Segunda capa: la hoja ya la tiene. No se vuelve a escribir.
    return { ok: true, id: previa.id, duplicada: true };
  }

  var idVenta = sanitizarTexto(venta.idVenta || datos.idVenta || '');
  if (idVenta === '') {
    throw new Error('La venta no trae IdVenta.');
  }

  var ahora = ahoraIso();
  hojaVentas.appendRow([
    idVenta,
    sanitizarTexto(venta.fecha || ahora),
    sanitizarTexto(venta.idTienda || ''),
    sanitizarTexto(venta.tienda || ''),
    sanitizarTexto(venta.idEmpleado || ''),
    sanitizarTexto(venta.vendedor || ''),
    sanitizarTexto(venta.moneda || ''),
    entero(venta.tcDecimas),
    entero(venta.gananciaUsdCents !== undefined ? venta.gananciaUsdCents : venta.gananciaNetaUsdCents),
    entero(venta.ajusteUsdCents !== undefined ? venta.ajusteUsdCents : venta.ajustesUsdCents),
    entero(venta.gananciaBsCents),
    entero(venta.pctComisionBp !== undefined ? venta.pctComisionBp : venta.pctComision),
    entero(venta.comisionBsCents),
    entero(venta.netoDuenoBsCents),
    entero(venta.totalCobradoUsdCents),
    sanitizarTexto(venta.estado || 'BORRADOR'),
    sanitizarTexto(venta.notas || ''),
    sanitizarTexto(venta.idCierre || ''),
    entero(venta.unidades !== undefined ? venta.unidades : venta.lineasCount),
    clave,
    ahora,
    ahora
  ]);

  guardarLineas(ss, idVenta, datos.lineas);
  registrarTcDia(ss, datos.tcDia);
  return { ok: true, id: idVenta, duplicada: false };
}

function guardarLineas(ss, idVenta, lineas) {
  var hojaLineas = obtenerHoja(ss, NOMBRE_HOJA_LINEAS, ENCABEZADO_LINEAS);
  var lista = Array.isArray(lineas) ? lineas : [];
  for (var i = 0; i < lista.length; i++) {
    var linea = lista[i] || {};
    hojaLineas.appendRow([
      sanitizarTexto(idVenta),
      sanitizarTexto(linea.idProducto || ''),
      sanitizarTexto(linea.modelo || ''),
      entero(linea.cantidad),
      entero(linea.precioUsdCents),
      entero(linea.costoUnitarioUsdCents),
      sanitizarTexto(linea.origen || '')
    ]);
  }
  return lista.length;
}

function registrarTcDia(ss, tcDia) {
  if (!tcDia || typeof tcDia !== 'object') return;
  var idEmpleado = sanitizarTexto(tcDia.idEmpleado || '');
  var dia = diaDe(tcDia.fecha || '');
  if (idEmpleado === '' || dia === '') return;

  var hoja = obtenerHoja(ss, NOMBRE_HOJA_TCDIA, ENCABEZADO_TCDIA);
  // Un TC por encargado por dia: si ya hay fila de hoy, se actualiza en vez de
  // duplicar. Asi el historico queda con una fila por vez.
  var cabeceras = encabezadosDeHoja(hoja);
  var filas = leerFilas(ss, NOMBRE_HOJA_TCDIA);
  for (var i = 0; i < filas.length; i++) {
    var fila = filas[i].fila;
    var mismoDia = diaDe(celda(fila, columna(cabeceras, 'Fecha', 0))) === dia;
    var mismoEmpleado =
      textoSimple(celda(fila, columna(cabeceras, 'IdEmpleado', 1))) === idEmpleado;
    if (mismoDia && mismoEmpleado) {
      hoja.getRange(filas[i].indiceExcel, columna(cabeceras, 'TcDecimas', 4) + 1)
        .setValue(entero(tcDia.tcDecimas));
      hoja.getRange(filas[i].indiceExcel, columna(cabeceras, 'RegistradoEn', 5) + 1)
        .setValue(sanitizarTexto(tcDia.registradoEn || ahoraIso()));
      return;
    }
  }
  hoja.appendRow([
    dia,
    idEmpleado,
    sanitizarTexto(tcDia.empleado || ''),
    sanitizarTexto(tcDia.idTienda || ''),
    entero(tcDia.tcDecimas),
    sanitizarTexto(tcDia.registradoEn || ahoraIso())
  ]);
}

function actualizarVenta(ss, datos) {
  var idVenta = sanitizarTexto(datos.idVenta || (datos.venta || {}).idVenta || '');
  var hojaVentas = obtenerHoja(ss, NOMBRE_HOJA_VENTAS, ENCABEZADO_VENTAS);
  var cabeceras = encabezadosDeHoja(hojaVentas);
  var indiceId = columna(cabeceras, 'IdVenta', 0);
  var ultimaFila = hojaVentas.getLastRow();
  if (ultimaFila < 2) {
    throw new Error('No se encontro esa venta.');
  }

  var ids = hojaVentas.getRange(2, indiceId + 1, ultimaFila - 1, 1).getValues();
  var encontrado = -1;
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === idVenta) {
      encontrado = i + 2;
      break;
    }
  }
  if (encontrado < 0) {
    throw new Error('No se encontro esa venta.');
  }

  var venta = datos.venta || {};
  var ahora = ahoraIso();
  escribirFila(hojaVentas, encontrado, {
    IdVenta: idVenta,
    Fecha: sanitizarTexto(venta.fecha || ahora),
    IdTienda: sanitizarTexto(venta.idTienda || ''),
    Tienda: sanitizarTexto(venta.tienda || ''),
    IdEmpleado: sanitizarTexto(venta.idEmpleado || ''),
    Vendedor: sanitizarTexto(venta.vendedor || ''),
    Moneda: sanitizarTexto(venta.moneda || ''),
    TcDecimas: entero(venta.tcDecimas),
    GananciaUsdCents: entero(
      venta.gananciaUsdCents !== undefined ? venta.gananciaUsdCents : venta.gananciaNetaUsdCents),
    AjusteUsdCents: entero(
      venta.ajusteUsdCents !== undefined ? venta.ajusteUsdCents : venta.ajustesUsdCents),
    GananciaBsCents: entero(venta.gananciaBsCents),
    PctComision: entero(venta.pctComisionBp !== undefined ? venta.pctComisionBp : venta.pctComision),
    ComisionBsCents: entero(venta.comisionBsCents),
    NetoDuenoBsCents: entero(venta.netoDuenoBsCents),
    TotalCobradoUsdCents: entero(venta.totalCobradoUsdCents),
    Estado: sanitizarTexto(venta.estado || 'BORRADOR'),
    Notas: sanitizarTexto(venta.notas || ''),
    IdCierre: sanitizarTexto(venta.idCierre || ''),
    Unidades: entero(venta.unidades !== undefined ? venta.unidades : venta.lineasCount),
    CreadoEn: sanitizarTexto(venta.creadoEn || ahora),
    ActualizadoEn: ahora
  });

  borrarLineasDe(ss, idVenta);
  guardarLineas(ss, idVenta, datos.lineas);
  registrarTcDia(ss, datos.tcDia);
  return { ok: true, id: idVenta };
}

function borrarLineasDe(ss, idVenta) {
  var hoja = ss.getSheetByName(NOMBRE_HOJA_LINEAS);
  if (!hoja) return 0;
  var cabeceras = encabezadosDeHoja(hoja);
  var indiceId = columna(cabeceras, 'IdVenta', 0);
  var ultimaFila = hoja.getLastRow();
  if (ultimaFila < 2) return 0;
  var ids = hoja.getRange(2, indiceId + 1, ultimaFila - 1, 1).getValues();
  var borradas = 0;
  for (var i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i][0]).trim() === idVenta) {
      hoja.deleteRow(i + 2);
      borradas++;
    }
  }
  return borradas;
}

function cambiarEstado(ss, datos) {
  var idVenta = sanitizarTexto(datos.idVenta || '');
  var destino = String(datos.hasta || '').toUpperCase();
  var hoja = obtenerHoja(ss, NOMBRE_HOJA_VENTAS, ENCABEZADO_VENTAS);
  var cabeceras = encabezadosDeHoja(hoja);
  var indiceId = columna(cabeceras, 'IdVenta', 0);
  var ultimaFila = hoja.getLastRow();
  if (ultimaFila < 2) {
    throw new Error('No se encontro esa venta.');
  }

  var ids = hoja.getRange(2, indiceId + 1, ultimaFila - 1, 1).getValues();
  var encontrado = -1;
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === idVenta) {
      encontrado = i + 2;
      break;
    }
  }
  if (encontrado < 0) {
    throw new Error('No se encontro esa venta.');
  }

  hoja.getRange(encontrado, columna(cabeceras, 'Estado', 15) + 1).setValue(destino);
  hoja.getRange(encontrado, columna(cabeceras, 'ActualizadoEn', -1) + 1)
    .setValue(ahoraIso());

  if (datos.idCierre !== undefined) {
    hoja.getRange(encontrado, columna(cabeceras, 'IdCierre', 17) + 1)
      .setValue(sanitizarTexto(datos.idCierre));
  }

  var motivo = sanitizarTexto(datos.motivo || '');
  if (motivo !== '' && String(motivo).charAt(0) !== "'") {
    var columnaNotas = columna(cabeceras, 'Notas', 16);
    var notasActuales = String(
      hoja.getRange(encontrado, columnaNotas + 1).getValue() || '');
    hoja.getRange(encontrado, columnaNotas + 1).setValue(
      sanitizarTexto(notasActuales === '' ? motivo : notasActuales + ' | ' + motivo));
  }

  return { ok: true, id: idVenta, estado: destino };
}

function eliminarVenta(ss, datos) {
  var idVenta = sanitizarTexto(datos.idVenta || '');
  var hoja = obtenerHoja(ss, NOMBRE_HOJA_VENTAS, ENCABEZADO_VENTAS);
  var cabeceras = encabezadosDeHoja(hoja);
  var indiceId = columna(cabeceras, 'IdVenta', 0);
  var ultimaFila = hoja.getLastRow();
  if (ultimaFila < 2) {
    throw new Error('No se encontro esa venta.');
  }
  var ids = hoja.getRange(2, indiceId + 1, ultimaFila - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === idVenta) {
      hoja.deleteRow(i + 2);
      borrarLineasDe(ss, idVenta);
      return { ok: true, id: idVenta, eliminada: true };
    }
  }
  throw new Error('No se encontro esa venta.');
}

// --- cierres ----------------------------------------------------------------

function cerrarTienda(ss, datos) {
  var idsVentas = Array.isArray(datos.idsVentas) ? datos.idsVentas : [];
  if (idsVentas.length === 0) {
    throw new Error('No hay ventas para cerrar.');
  }
  var cierre = datos.cierre || {};
  var clave = sanitizarTexto(datos.claveIdempotencia || '');
  var hojaCierres = obtenerHoja(ss, NOMBRE_HOJA_CIERRES, ENCABEZADO_CIERRES);

  if (clave !== '') {
    var previa = filaYaRegistrada(ss, NOMBRE_HOJA_CIERRES, 'ClaveIdempotencia', clave);
    if (previa) {
      return { ok: true, id: cierre.idCierre || '', duplicada: true };
    }
  }

  hojaCierres.appendRow([
    sanitizarTexto(cierre.idCierre || ''),
    sanitizarTexto(cierre.fecha || ahoraIso()),
    sanitizarTexto(cierre.idTienda || ''),
    sanitizarTexto(cierre.tienda || ''),
    sanitizarTexto(cierre.cerradoPor || ''),
    entero(cierre.ventas),
    entero(cierre.totalComisionBsCents),
    entero(cierre.totalNetoDuenoBsCents),
    entero(cierre.pagadoBsCents),
    entero(cierre.saldoBsCents),
    sanitizarTexto(cierre.cerradoEn || ahoraIso()),
    clave
  ]);

  var hojaVentas = obtenerHoja(ss, NOMBRE_HOJA_VENTAS, ENCABEZADO_VENTAS);
  var cabeceras = encabezadosDeHoja(hojaVentas);
  var indiceId = columna(cabeceras, 'IdVenta', 0);
  var indiceEstado = columna(cabeceras, 'Estado', -1);
  var indiceCierre = columna(cabeceras, 'IdCierre', -1);
  var ultimaFila = hojaVentas.getLastRow();
  var cerradas = 0;

  if (ultimaFila >= 2) {
    var ids = hojaVentas.getRange(2, indiceId + 1, ultimaFila - 1, 1).getValues();
    for (var i = ids.length - 1; i >= 0; i--) {
      if (idsVentas.indexOf(String(ids[i][0]).trim()) === -1) continue;
      var indiceExcel = i + 2;
      if (indiceEstado >= 0) {
        hojaVentas.getRange(indiceExcel, indiceEstado + 1).setValue('CERRADA');
      }
      if (indiceCierre >= 0) {
        hojaVentas.getRange(indiceExcel, indiceCierre + 1)
          .setValue(sanitizarTexto(cierre.idCierre || ''));
      }
      if (columna(cabeceras, 'ActualizadoEn', -1) >= 0) {
        hojaVentas.getRange(indiceExcel, columna(cabeceras, 'ActualizadoEn', -1) + 1)
          .setValue(ahoraIso());
      }
      cerradas++;
    }
  }

  return { ok: true, id: cierre.idCierre || '', ventasCerradas: cerradas, duplicada: false };
}

// --- tiendas, empleados y catalogo -----------------------------------------

function guardarTienda(ss, datos) {
  var tienda = datos.tienda || {};
  var idTienda = sanitizarTexto(tienda.idTienda || '');
  if (idTienda === '') {
    throw new Error('La tienda no trae IdTienda.');
  }
  var hoja = obtenerHoja(ss, NOMBRE_HOJA_TIENDAS, ENCABEZADO_TIENDAS);
  var existente = filaConValor(ss, NOMBRE_HOJA_TIENDAS, 'IdTienda', idTienda);

  if (existente) {
    var antes = existente.fila;
    var cabT = encabezadosDeHoja(hoja);
    escribirFila(hoja, existente.indiceExcel, {
      IdTienda: idTienda,
      Nombre: tienda.nombre !== undefined ? sanitizarTexto(tienda.nombre)
        : celda(antes, columna(cabT, 'Nombre', 1)),
      Empleados: tienda.empleados !== undefined ? sanitizarTexto(tienda.empleados)
        : celda(antes, columna(cabT, 'Empleados', 2)),
      PctComision: tienda.pctComision !== undefined ? entero(tienda.pctComision)
        : celda(antes, columna(cabT, 'PctComision', 3)),
      ClaveHash: tienda.claveHash !== undefined ? sanitizarTexto(tienda.claveHash)
        : celda(antes, columna(cabT, 'ClaveHash', 4)),
      Activa: tienda.activa !== undefined ? (tienda.activa === true ? '1' : '0')
        : celda(antes, columna(cabT, 'Activa', 5)),
      CreadoEn: celda(antes, columna(cabT, 'CreadoEn', 6))
    });
    return { ok: true, id: idTienda, actualizada: true };
  }

  hoja.appendRow([
    idTienda,
    sanitizarTexto(tienda.nombre || ''),
    sanitizarTexto(tienda.empleados || ''),
    entero(tienda.pctComision),
    sanitizarTexto(tienda.claveHash || ''),
    tienda.activa === false ? '0' : '1',
    ahoraIso()
  ]);
  return { ok: true, id: idTienda, creada: true };
}

function guardarEmpleados(ss, datos) {
  var lista = Array.isArray(datos.empleados) ? datos.empleados : [];
  if (lista.length === 0) {
    throw new Error('No se recibio ningun empleado.');
  }
  var hoja = obtenerHoja(ss, NOMBRE_HOJA_EMPLEADOS, ENCABEZADO_EMPLEADOS);
  var guardados = 0;
  for (var i = 0; i < lista.length; i++) {
    var empleado = lista[i] || {};
    var idEmpleado = sanitizarTexto(empleado.idEmpleado || '');
    if (idEmpleado === '') continue;
    var existente = filaConValor(ss, NOMBRE_HOJA_EMPLEADOS, 'IdEmpleado', idEmpleado);
    if (existente) {
      var antes = existente.fila;
      var cabE = encabezadosDeHoja(hoja);
      escribirFila(hoja, existente.indiceExcel, {
        IdEmpleado: idEmpleado,
        Nombre: empleado.nombre !== undefined ? sanitizarTexto(empleado.nombre)
          : celda(antes, columna(cabE, 'Nombre', 1)),
        IdTienda: empleado.idTienda !== undefined
          ? sanitizarTexto(empleado.idTienda) : celda(antes, columna(cabE, 'IdTienda', 2)),
        Activo: empleado.activo !== undefined
          ? (empleado.activo === true ? '1' : '0') : celda(antes, columna(cabE, 'Activo', 3)),
        CreadoEn: celda(antes, columna(cabE, 'CreadoEn', 4))
      });
    } else {
      hoja.appendRow([
        idEmpleado,
        sanitizarTexto(empleado.nombre || ''),
        sanitizarTexto(empleado.idTienda || ''),
        empleado.activo === false ? '0' : '1',
        ahoraIso()
      ]);
    }
    guardados++;
  }
  return { ok: true, guardados: guardados };
}

function guardarPrecio(ss, datos) {
  var idProducto = sanitizarTexto(datos.idProducto || '');
  if (idProducto === '') {
    throw new Error('Falta el producto.');
  }
  var hoja = obtenerHoja(ss, NOMBRE_HOJA_CATALOGO, ENCABEZADO_CATALOGO);
  var existente = filaConValor(ss, NOMBRE_HOJA_CATALOGO, 'IdProducto', idProducto);
  if (!existente) {
    throw new Error('No se encontro ese producto en el catalogo.');
  }
  hoja.getRange(existente.indiceExcel,
    columna(encabezadosDeHoja(hoja), 'PrecioRefUsdCents', 3) + 1)
    .setValue(entero(datos.precioUsdCents));
  return { ok: true, id: idProducto, precioUsdCents: entero(datos.precioUsdCents) };
}

function sembrarCatalogo(ss, datos) {
  var productos = Array.isArray(datos.productos) ? datos.productos : [];
  if (productos.length === 0) {
    throw new Error('No se recibio ningun producto.');
  }
  var hoja = obtenerHoja(ss, NOMBRE_HOJA_CATALOGO, ENCABEZADO_CATALOGO);
  var existentes = {};
  var filas = leerFilas(ss, NOMBRE_HOJA_CATALOGO);
  var cabeceras = encabezadosDeHoja(hoja);
  var indiceId = columna(cabeceras, 'IdProducto', 0);
  for (var i = 0; i < filas.length; i++) {
    existentes[String(celda(filas[i].fila, indiceId)).trim()] = true;
  }

  var agregados = 0;
  var salteados = 0;
  for (var j = 0; j < productos.length && agregados < CANTIDAD_MAXIMA_SEMBRADO; j++) {
    var producto = productos[j] || {};
    var id = sanitizarTexto(producto.idProducto || producto.modelo || '');
    if (id === '') {
      continue;
    }
    if (existentes[id]) {
      salteados++;
      continue;
    }
    hoja.appendRow([
      id,
      sanitizarTexto(producto.marca || ''),
      sanitizarTexto(producto.modelo || id),
      entero(producto.precioRefUsdCents !== undefined
        ? producto.precioRefUsdCents : producto.precioUsdCents),
      sanitizarTexto(producto.specs || ''),
      producto.activo === false ? '0' : '1'
    ]);
    existentes[id] = true;
    agregados++;
  }
  return { ok: true, agregados: agregados, salteados: salteados };
}
