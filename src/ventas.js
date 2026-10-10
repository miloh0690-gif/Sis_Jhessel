'use strict';

// Ventas: valida la entrada, calcula con money (la unica autoridad), decide si
// la venta se guarda y mueve los estados.
//
// Reglas que este archivo_encode y nadie mas:
//   - El idTienda SIEMPRE sale de la sesion. Un idTienda del cuerpo se ignora
//     sin avisar: es un dato del cliente y el cliente no decide.
//   - El porcentaje de comision sale de la hoja Tiendas, nunca del cuerpo.
//   - Idempotencia de dos capas: memoria 30 min (este archivo) + columna
//     ClaveIdempotencia en la hoja (el .gs). Un doble toque o un reintento de
//     Render no pueden duplicar una venta.
//   - Nunca se responde 403: lo que no existe o no se puede tocar responde 404.

const money = require('./money');
const estados = require('./estados');
const ledger = require('./ledger');
const sheets = require('./sheets');

const CLAVE_VIGENCIA_MS = 30 * 60 * 1000;
const CLAVE_MAXIMO = 500;
const PREFIJO_CLAVE = 'venta:';
const MOTIVO_REAPERTURA_MINIMO = 10;
const MAX_NOTAS = 500;

const operaciones = new Map();

function operacionRecordada(clave) {
  const previa = operaciones.get(clave);
  if (!previa) return null;
  if (Date.now() > previa.expira) {
    operaciones.delete(clave);
    return null;
  }
  return previa.respuesta;
}

function recordarOperacion(clave, respuesta) {
  if (operaciones.size >= CLAVE_MAXIMO) {
    const masVieja = operaciones.keys().next();
    if (!masVieja.done) operaciones.delete(masVieja.value);
  }
  operaciones.set(clave, { expira: Date.now() + CLAVE_VIGENCIA_MS, respuesta: respuesta });
}

function limpiarOperaciones() {
  operaciones.clear();
}

setInterval(function () {
  const ahora = Date.now();
  operaciones.forEach(function (entrada, clave) {
    if (ahora > entrada.expira) operaciones.delete(clave);
  });
}, 5 * 60 * 1000).unref();

// --- validacion ------------------------------------------------------------

function fallo(codigo, mensaje, campo) {
  const error = new Error(mensaje);
  error.codigo = codigo;
  if (campo) error.campo = campo;
  return error;
}

function noEncontrado(mensaje) {
  return fallo(404, mensaje || 'No se encontro esa venta.');
}

// Quita controles, corta y evita que un texto startsWith de signo se lea como
// formula de Sheets (=, +, -, @).
function sanearTexto(valor, maximo) {
  let texto = String(valor === null || valor === undefined ? '' : valor)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, maximo);
  if (texto && /^[=+\-@]/.test(texto)) texto = "'" + texto;
  return texto;
}

function claveValida(valor) {
  const texto = String(valor === null || valor === undefined ? '' : valor);
  return /^[A-Za-z0-9_-]{8,64}$/.test(texto) ? texto : '';
}

// La sesion manda. Si el dueno esta registrando para una tienda, el idTienda
// tiene que venir en el cuerpo porque el dueno no pertenece a ninguna.
function tiendaDeSesion(sesion, cuerpo) {
  if (sesion && sesion.rol === 'DUENO') {
    return sanearTexto(cuerpo.idTienda, 64);
  }
  return String((sesion && sesion.idTienda) || '');
}

async function tiendaDe(idTienda) {
  const tiendas = await ledger.listarTiendas();
  const lista = Array.isArray(tiendas) ? tiendas : [];
  for (let i = 0; i < lista.length; i += 1) {
    if (lista[i] && lista[i].idTienda === idTienda) return lista[i];
  }
  return null;
}

async function empleadoDe(idEmpleado, idTienda) {
  const empleados = await ledger.listarEmpleados();
  const lista = Array.isArray(empleados) ? empleados : [];
  for (let i = 0; i < lista.length; i += 1) {
    const e = lista[i];
    if (e && e.idEmpleado === idEmpleado && e.idTienda === idTienda && e.activo !== false) return e;
  }
  return null;
}

// La hoja guarda el porcentaje como lo teclea el dueno (30 = 30%), pero el
// calculo trabaja en basis points (3000). Si alguien dejo 3000 escrito, se
// respeta como basis points en vez de fallar.
function comisionDeTienda(valor) {
  const n = money.entero(valor);
  if (n > money.COMISION_BP_MAXIMO) return Math.min(money.COMISION_BP_MAXIMO, n);
  return Math.max(0, n) * 100;
}

// --- preparar --------------------------------------------------------------

// Valida y calcula. NO escribe nada. Es lo que sirve POST /api/ventas/preview:
// el navegador ve lo mismo que va a ver el servidor.
async function preparar({ sesion, cuerpo } = {}) {
  const datos = cuerpo && typeof cuerpo === 'object' ? cuerpo : {};
  const idTienda = tiendaDeSesion(sesion, datos);
  if (!idTienda) throw fallo(400, 'No se sabe a que tienda pertenece la venta.', 'idTienda');

  const tienda = await tiendaDe(idTienda);
  if (!tienda) throw noEncontrado('Esa tienda no esta disponible.');

  const idEmpleado = sanearTexto(datos.idEmpleado, 64);
  if (!idEmpleado) throw fallo(400, 'Elegi que encargado hizo la venta.', 'idEmpleado');
  const empleado = await empleadoDe(idEmpleado, idTienda);
  if (!empleado) {
    throw fallo(400, 'Ese empleado no pertenece a esta tienda.', 'idEmpleado');
  }

  const moneda = money.normalizarMoneda(datos.moneda);
  if (!moneda) throw fallo(400, 'La moneda no es valida: solo Bs o USD.', 'moneda');

  const tcDecimas = money.tcADecimas(
    datos.tipoCambio === undefined ? datos.tcDecimas : datos.tipoCambio
  );
  if (tcDecimas <= 0) throw fallo(400, 'El tipo de cambio tiene que ser mayor que cero.', 'tipoCambio');

  const crudas = Array.isArray(datos.lineas) ? datos.lineas : [];
  if (!crudas.length) throw fallo(400, 'La venta necesita al menos una linea.', 'lineas');

  const lineas = crudas.map(function (cruda, indice) {
    const linea = cruda && typeof cruda === 'object' ? cruda : {};
    const cantidad = Math.floor(Number(linea.cantidad));
    if (!Number.isFinite(cantidad) || cantidad < 1) {
      throw fallo(400, 'La cantidad de la linea ' + (indice + 1) + ' tiene que ser 1 o mas.', 'lineas');
    }
    const precioCents = money.aCents(linea.precio);
    const costoCents = money.aCents(linea.costo);
    if (precioCents < 0) throw fallo(400, 'El precio no puede ser negativo.', 'lineas');
    if (costoCents < 0) throw fallo(400, 'El costo no puede ser negativo.', 'lineas');
    return {
      idProducto: sanearTexto(linea.idProducto, 64),
      modelo: sanearTexto(linea.modelo, 200),
      origen: sanearTexto(linea.origen, 64),
      cantidad: cantidad,
      precioUsdCents: moneda === money.MONEDAS.USD
        ? precioCents
        : money.precioBsAUsdCents(precioCents, tcDecimas),
      costoUnitarioUsdCents: costoCents,
      precioCobradoCents: precioCents
    };
  });

  const ajusteCents = money.aCents(datos.ajuste === undefined ? datos.ajustesUsdCents : datos.ajuste);
  if (ajusteCents < 0) throw fallo(400, 'El ajuste no puede ser negativo.', 'ajuste');

  const pctComisionBp = comisionDeTienda(tienda.pctComision);
  const totales = money.calcularTotales({
    lineas: lineas,
    ajustesUsdCents: ajusteCents,
    tcDecimas: tcDecimas,
    pctComisionBp: pctComisionBp,
    moneda: moneda
  });

  const ahora = new Date();
  const notas = sanearTexto(datos.notas, MAX_NOTAS);
  const venta = {
    idVenta: '',
    fecha: ahora.toISOString(),
    dia: ahora.toISOString().slice(0, 10),
    idTienda: idTienda,
    tienda: tienda.nombre || '',
    idEmpleado: idEmpleado,
    vendedor: empleado.nombre || (sesion && sesion.nombre) || '',
    moneda: moneda,
    tcDecimas: tcDecimas,
    pctComisionBp: pctComisionBp,
    lineasCount: totales.lineas.length,
    unidades: totales.unidades,
    totalCobradoUsdCents: totales.totalCobradoUsdCents,
    totalCobradoBsCents: totales.totalCobradoBsCents,
    costoTotalUsdCents: totales.costoTotalUsdCents,
    costoTotalBsCents: totales.costoTotalBsCents,
    gananciaBrutaUsdCents: totales.gananciaBrutaUsdCents,
    ajustesUsdCents: totales.ajustesUsdCents,
    ajusteUsdCents: totales.ajustesUsdCents,
    gananciaNetaUsdCents: totales.gananciaNetaUsdCents,
    gananciaBsCents: totales.gananciaBsCents,
    comisionBsCents: totales.comisionBsCents,
    netoDuenoBsCents: totales.netoDuenoBsCents,
    estado: estados.ESTADOS.BORRADOR,
    notas: notas,
    idCierre: '',
    claveIdempotencia: ''
  };

  return { venta: venta, lineas: totales.lineas, tcDia: filaTcDia(venta) };
}

// El TC que manejo ese encargado ese dia queda escrito junto a la venta: es lo
// que permite al dueno reconstruir la operacion dias despues.
function filaTcDia(venta) {
  return {
    fecha: venta.dia,
    idEmpleado: venta.idEmpleado,
    empleado: venta.vendedor,
    idTienda: venta.idTienda,
    tcDecimas: venta.tcDecimas,
    registradoEn: new Date().toISOString()
  };
}

// --- guardar ---------------------------------------------------------------

async function guardar({ sesion, cuerpo } = {}) {
  const datos = cuerpo && typeof cuerpo === 'object' ? cuerpo : {};
  const clave = claveValida(datos.claveIdempotencia) || ledger.nuevoId('k');

  // Antes de validar: un reintento tiene que devolver la respuesta previa, no
  // un 400 por un cuerpo que el cliente ya no tiene delante.
  const previa = operacionRecordada(PREFIJO_CLAVE + clave);
  if (previa) return Object.assign({}, previa, { repetida: true });

  const preparado = await preparar({ sesion: sesion, cuerpo: datos });
  const venta = Object.assign({}, preparado.venta, { claveIdempotencia: clave });

  // Una sola llamada: el .gs escribe venta, lineas y TcDia bajo un solo lock.
  const escrito = await sheets.escribir({
    tipoOperacion: 'GUARDAR_VENTA',
    venta: venta,
    lineas: preparado.lineas,
    tcDia: preparado.tcDia
  });
  const respuesta = escrito && typeof escrito === 'object' ? escrito : {};
  const idVenta = String(respuesta.id || ledger.nuevoId('V'));

  // Segunda capa: si la hoja vio la clave, no se vuelve a escribir.
  if (respuesta.duplicada === true) {
    const recordada = { venta: Object.assign({}, venta, { idVenta: idVenta }), repetida: true };
    recordarOperacion(PREFIJO_CLAVE + clave, recordada);
    return recordada;
  }

  const guardada = { venta: Object.assign({}, venta, { idVenta: idVenta }), repetida: false };
  recordarOperacion(PREFIJO_CLAVE + clave, guardada);
  return guardada;
}

// --- editar y transiciones --------------------------------------------------

async function ventaPorId(idVenta) {
  const ventas = await ledger.listarVentas({});
  const lista = Array.isArray(ventas) ? ventas : [];
  for (let i = 0; i < lista.length; i += 1) {
    if (lista[i] && lista[i].idVenta === idVenta) return lista[i];
  }
  return null;
}

function duenoDeLaSesion(sesion) {
  // `auth` guarda el rol en minuscula (`auth.ROLES`), pero esta funcion se
  // llama desde codigo de pruebas y de un futuro modulo con la otra grafia.
  // Comparar solo 'DUENO' hacia que el dueno real se tratara como encargado y
  // sus correcciones de costo se descartaran en silencio.
  return estados.normalizarRol(sesion && sesion.rol) === estados.ROLES.DUENO;
}

// El dueno ve las cuatro tiendas. Un encargado solo la suya: si la venta es de
// otra, no existe para el. Sin esta comprobacion, conocer el IdVenta de otra
// tienda bastaba para confirmar, reabrir o borrar sus ventas.
function esDeLaSesion(sesion, venta) {
  if (!venta) return false;
  if (duenoDeLaSesion(sesion)) return true;
  return String(venta.idTienda || '') === String((sesion && sesion.idTienda) || '');
}

async function actualizarVenta({ sesion, idVenta, cuerpo } = {}) {
  const id = String(idVenta || '').trim();
  if (!id) throw noEncontrado('No se encontro esa venta.');

  // La sesion manda sobre el idTienda, asi que primero se resuelve cual es la
  // tienda real de la venta existente.
  const datos = cuerpo && typeof cuerpo === 'object' ? cuerpo : {};
  const idTienda = duenoDeLaSesion(sesion) ? sanearTexto(datos.idTienda, 64) : String((sesion && sesion.idTienda) || '');
  const existentes = await ledger.listarVentas({ idTienda: idTienda });
  const lista = Array.isArray(existentes) ? existentes : [];
  let actual = null;
  for (let i = 0; i < lista.length; i += 1) {
    if (lista[i] && lista[i].idVenta === id) { actual = lista[i]; break; }
  }
  if (!actual) throw noEncontrado('No se encontro esa venta.');

  const tocarDinero = datos.ajuste !== undefined || datos.ajustesUsdCents !== undefined ||
    (Array.isArray(datos.lineas) && datos.lineas.some(function (l) { return l && l.costo !== undefined; }));

  if (!estados.puedeEditarContenido(actual.estado, sesion && sesion.rol, { costo: tocarDinero, ajustes: tocarDinero })) {
    if (!duenoDeLaSesion(sesion) && estados.estaCerrada(actual.estado)) {
      throw noEncontrado('Una venta cerrada solo la toca el dueno.');
    }
    if (!duenoDeLaSesion(sesion) && String(actual.estado) === estados.ESTADOS.CONFIRMADA && tocarDinero) {
      throw noEncontrado('La venta ya esta confirmada: el costo ya no se toca.');
    }
    if (String(actual.estado) === estados.ESTADOS.ANULADA) {
      throw noEncontrado('Una venta anulada ya no se toca.');
    }
    throw noEncontrado('Esa venta ya no se puede editar.');
  }

  // El costo de una venta que ya no es borrador NO se vuelve a calcular: se
  // conserva el que quedo escrito. Si se dejara en cero, la ganancia se
  // inflaria sola y el dueno pagaria de mas.
  let cuerpoSeguro = datos;
  if (!duenoDeLaSesion(sesion) && String(actual.estado) !== estados.ESTADOS.BORRADOR) {
    const guardadas = await ledger.listarLineasDe(id);
    const lista = Array.isArray(guardadas) ? guardadas : [];
    cuerpoSeguro = Object.assign({}, datos, {
      lineas: (Array.isArray(datos.lineas) ? datos.lineas : []).map(function (l, indice) {
        const linea = Object.assign({}, l);
        delete linea.costo;
        const guardada = linea.idProducto
          ? lista.find(function (g) { return g && g.idProducto === linea.idProducto; })
          : lista[indice];
        if (guardada) linea.costo = (guardada.costoUnitarioUsdCents || 0) / 100;
        return linea;
      })
    });
  }

  // La venta define su tienda y su vendedor: el dueno no la mueve a otra ni le
  // cambia el empleado que quedo registrado.
  const preparado = await preparar({
    sesion: Object.assign({}, sesion, { idTienda: actual.idTienda || idTienda }),
    cuerpo: Object.assign({}, cuerpoSeguro, {
      idTienda: actual.idTienda || idTienda,
      idEmpleado: actual.idEmpleado,
      tipoCambio: datos.tipoCambio === undefined ? datos.tcDecimas : datos.tipoCambio
    })
  });
  const venta = Object.assign({}, preparado.venta, {
    idVenta: id,
    estado: actual.estado,
    idCierre: actual.idCierre || '',
    notas: datos.notas === undefined ? (actual.notas || '') : preparado.venta.notas
  });

  await sheets.escribir({
    tipoOperacion: 'ACTUALIZAR_VENTA',
    idVenta: id,
    venta: venta,
    lineas: preparado.lineas,
    tcDia: preparado.tcDia
  });

  return { venta: venta };
}

async function cambiarEstado({ sesion, idVenta, hasta, motivo } = {}) {
  const id = String(idVenta || '').trim();
  const destino = estados.normalizarEstado(hasta);
  if (!id || !destino) throw noEncontrado('No se encontro esa venta.');

  const actual = await ventaPorId(id);
  if (!actual) throw noEncontrado('No se encontro esa venta.');
  if (!esDeLaSesion(sesion, actual)) throw noEncontrado('No se encontro esa venta.');

  if (!estados.puedeTransicionar(actual.estado, destino, sesion && sesion.rol)) {
    throw noEncontrado(estados.explicarTransicion({
      rol: sesion && sesion.rol,
      desde: actual.estado,
      hasta: destino
    }) || 'Esa operacion no esta permitida.');
  }

  // Reabrir una cerrada deshace un pago: tiene que quedar escrito por que.
  if (estados.estaCerrada(actual.estado) && destino === estados.ESTADOS.CONFIRMADA) {
    const texto = sanearTexto(motivo, 300);
    if (texto.replace(/'/g, '').length < MOTIVO_REAPERTURA_MINIMO) {
      throw fallo(400, 'Para reabrir una venta cerrada hace falta un motivo de al menos 10 caracteres.', 'motivo');
    }
  }

  const venta = Object.assign({}, actual, {
    estado: destino,
    idCierre: destino === estados.ESTADOS.CERRADA ? String((actual.idCierre) || '') : actual.idCierre
  });

  await sheets.escribir({
    tipoOperacion: 'CAMBIAR_ESTADO',
    idVenta: id,
    hasta: destino,
    estadoAnterior: actual.estado,
    idTienda: actual.idTienda || '',
    motivo: sanearTexto(motivo, 300)
  });

  return { venta: venta };
}

async function eliminarVenta({ sesion, idVenta } = {}) {
  const id = String(idVenta || '').trim();
  if (!id) throw noEncontrado('No se encontro esa venta.');
  const actual = await ventaPorId(id);
  if (!actual) throw noEncontrado('No se encontro esa venta.');
  if (!esDeLaSesion(sesion, actual)) throw noEncontrado('No se encontro esa venta.');
  if (!estados.puedeBorrar(actual.estado, sesion && sesion.rol)) {
    throw noEncontrado('Solo una venta en borrador se borra.');
  }
  await sheets.escribir({
    tipoOperacion: 'ELIMINAR_VENTA',
    idVenta: id,
    idTienda: actual.idTienda || ''
  });
  return { eliminada: true, idVenta: id };
}

function listarLineasDe(idVenta) {
  return ledger.listarLineasDe(String(idVenta || '').trim());
}

// Lectura de lineas con la sesion de por medio: 404 si la venta no es de esta
// tienda y sin costo para el encargado (el costo del equipo es del dueno).
async function lineasDeLaSesion({ sesion, idVenta } = {}) {
  const id = String(idVenta || '').trim();
  if (!id) throw noEncontrado('No se encontro esa venta.');
  const actual = await ventaPorId(id);
  if (!actual) throw noEncontrado('No se encontro esa venta.');
  if (!esDeLaSesion(sesion, actual)) throw noEncontrado('No se encontro esa venta.');

  const crudas = await ledger.listarLineasDe(id);
  const lista = Array.isArray(crudas) ? crudas : [];
  if (duenoDeLaSesion(sesion)) return lista.slice();
  return lista.map(function (linea) {
    const copia = Object.assign({}, linea);
    delete copia.costoUnitarioUsdCents;
    return copia;
  });
}

module.exports = {
  CLAVE_VIGENCIA_MS,
  CLAVE_MAXIMO,
  PREFIJO_CLAVE,
  preparar,
  guardar,
  actualizarVenta,
  cambiarEstado,
  eliminarVenta,
  listarLineasDe,
  lineasDeLaSesion,
  esDeLaSesion,
  operacionRecordada,
  recordarOperacion,
  limpiarOperaciones,
  sanearTexto,
  claveValida
};