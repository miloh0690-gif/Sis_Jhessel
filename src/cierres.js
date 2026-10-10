'use strict';

const ledger = require('./ledger');
const sheets = require('./sheets');
const money = require('./money');

const PREFIJO_CLAVE = 'cierre:';
const DIAS_RE = /^\d{4}-\d{2}-\d{2}$/;
const ESTADO_PENDIENTE = 'CONFIRMADA';

function error(mensaje, codigo) {
  const e = new Error(mensaje);
  e.codigo = codigo;
  return e;
}

function texto(valor) {
  return String(valor === undefined || valor === null ? '' : valor)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 120);
}

function diaValido(dia) {
  const limpio = String(dia === undefined || dia === null ? '' : dia).trim();
  return DIAS_RE.test(limpio) ? limpio : '';
}

function enteroNoNegativo(valor, nombre) {
  const numero = Number(valor);
  if (valor === undefined || valor === null || valor === '' || !Number.isFinite(numero)) {
    throw error(`${nombre} tiene que ser un numero.`, 400);
  }
  const entero = Math.floor(numero);
  if (entero < 0) throw error(`${nombre} no puede ser negativo.`, 400);
  return entero;
}

function esDueno(sesion) {
  if (!sesion) return false;
  const rol = texto(sesion.rol).toUpperCase();
  // El rol de la sesion viene en minusculas (auth.ROLES). Se comparan todas
  // las grafias porque un 403 aqui seria "el dueno no puede cerrar".
  const r = String(rol || '').trim().toUpperCase();
  return r === 'DUENO' || r === 'DUEÑO' || r === 'DUEN0';
}

function suma(ventas, campo) {
  let total = 0;
  for (const venta of ventas) {
    const valor = Number(venta && venta[campo]);
    if (Number.isFinite(valor)) total += valor;
  }
  return Math.round(total);
}

function esDeLaTiendaYDia(venta, idTienda, dia) {
  if (!venta) return false;
  const tienda = texto(venta.idTienda);
  const diaVenta = diaValido(venta.dia) || String(venta.dia || '').slice(0, 10);
  return tienda === idTienda && diaVenta === dia;
}

function nombreDeLaTienda(ventas, idTienda) {
  for (const venta of ventas) {
    if (texto(venta.tienda)) return texto(venta.tienda);
  }
  return '';
}

async function tiendaDe(idTienda) {
  let tiendas = [];
  try {
    tiendas = await ledger.listarTiendas();
  } catch (e) {
    tiendas = [];
  }
  const lista = Array.isArray(tiendas) ? tiendas : [];
  const encontrada = lista.find((t) => texto(t && t.idTienda) === idTienda);
  return encontrada ? encontrada : null;
}

async function previsualizar({ idTienda, dia } = {}) {
  const tienda = texto(idTienda);
  if (!tienda) throw error('Falta indicar la tienda.', 400);
  const fecha = diaValido(dia);
  if (!fecha) throw error('La fecha del cierre debe tener el formato AAAA-MM-DD.', 400);

  const todas = await ledger.listarVentas({ idTienda: tienda, desde: fecha, hasta: fecha });
  const lista = (Array.isArray(todas) ? todas : []).filter((v) => esDeLaTiendaYDia(v, tienda, fecha));

  const pendientes = lista.filter((v) => texto(v.estado).toUpperCase() === ESTADO_PENDIENTE);

  let nombre = nombreDeLaTienda(lista, tienda);
  if (!nombre) {
    const encontrada = await tiendaDe(tienda);
    if (encontrada) nombre = texto(encontrada.nombre);
  }

  return {
    idTienda: tienda,
    tienda: nombre,
    dia: fecha,
    ventas: lista,
    cantidadVentas: lista.length,
    pendientes: pendientes.length,
    idsPendientes: pendientes.map((v) => texto(v.idVenta)),
    totalCobradoBsCents: suma(pendientes, 'totalCobradoBsCents'),
    totalGananciaBsCents: suma(pendientes, 'gananciaBsCents'),
    totalComisionBsCents: suma(pendientes, 'comisionBsCents'),
    totalNetoDuenoBsCents: suma(pendientes, 'netoDuenoBsCents'),
    saldoPendienteBsCents: suma(pendientes, 'netoDuenoBsCents'),
    totalesDelDia: {
      cantidadVentas: lista.length,
      totalCobradoBsCents: suma(lista, 'totalCobradoBsCents'),
      totalGananciaBsCents: suma(lista, 'gananciaBsCents'),
      totalComisionBsCents: suma(lista, 'comisionBsCents'),
      totalNetoDuenoBsCents: suma(lista, 'netoDuenoBsCents'),
    },
  };
}

async function cerrar({ sesion, idTienda, dia, pagadoBsCents } = {}) {
  if (!esDueno(sesion)) {
    throw error('No se encontro el recurso.', 404);
  }

  const tienda = texto(idTienda);
  if (!tienda) throw error('Falta indicar la tienda.', 400);
  const fecha = diaValido(dia);
  if (!fecha) throw error('La fecha del cierre debe tener el formato AAAA-MM-DD.', 400);
  const pagado = enteroNoNegativo(pagadoBsCents, 'El pago');

  const vista = await previsualizar({ idTienda: tienda, dia: fecha });

  if (vista.pendientes === 0) {
    throw error('No hay ventas confirmadas para cerrar en esa tienda y ese dia.', 400);
  }

  const saldo = Math.round(vista.saldoPendienteBsCents - pagado);

  const cierre = {
    idCierre: ledger.nuevoId('C'),
    fecha,
    dia: fecha,
    idTienda: tienda,
    tienda: vista.tienda,
    cerradoPor: texto(sesion.nombre) || 'Dueno',
    ventas: vista.pendientes,
    idsVentas: vista.idsPendientes,
    totalGananciaBsCents: vista.totalGananciaBsCents,
    totalComisionBsCents: vista.totalComisionBsCents,
    totalNetoDuenoBsCents: vista.totalNetoDuenoBsCents,
    pagadoBsCents: pagado,
    saldoBsCents: saldo,
    cerradoEn: new Date().toISOString(),
  };

  const escrito = await sheets.escribir({
    tipoOperacion: 'CERRAR_TIENDA',
    claveIdempotencia: PREFIJO_CLAVE + tienda + '|' + fecha + '|' + cierre.idCierre,
    idsVentas: vista.idsPendientes,
    cierre,
  });

  if (escrito && escrito.duplicada === true) {
    return { cierre, ventasCerradas: vista.idsPendientes.length, repetida: true };
  }

  return { cierre, ventasCerradas: vista.idsPendientes.length };
}

module.exports = {
  PREFIJO_CLAVE,
  ESTADO_PENDIENTE,
  previsualizar,
  cerrar,
  diaValido,
  esDueno,
};