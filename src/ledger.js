'use strict';

// Lectura de las 7 hojas de Google y el consolidado. Este modulo no decide
// nada de dinero: solo trae filas crudas, las convierte a enteros y se las
// pasa a `money.resumenVentas`. Los importes llegan como enteros desde el
// .gs y aqui no se reescalan nunca.

const money = require('./money');
const sheets = require('./sheets');

// El .gs resuelve las columnas por encabezado, pero si algun dia cambia el
// orden esta lista es el respaldo: si la respuesta trae `cabeceras`, gana el
// encabezado; si no, se usa la posicion canonica.
const COLUMNAS = Object.freeze({
  tiendas: ['IdTienda', 'Nombre', 'Empleados', 'PctComision', 'ClaveHash', 'Activa'],
  empleados: ['IdEmpleado', 'Nombre', 'IdTienda', 'Activo'],
  ventas: ['IdVenta', 'Fecha', 'IdTienda', 'Tienda', 'IdEmpleado', 'Vendedor', 'Moneda',
    'TcDecimas', 'GananciaUsdCents', 'AjusteUsdCents', 'GananciaBsCents', 'ComisionBsCents',
    'NetoDuenoBsCents', 'TotalCobradoUsdCents', 'Estado', 'Notas', 'IdCierre', 'Unidades'],
  lineas: ['IdVenta', 'IdProducto', 'Modelo', 'Cantidad', 'PrecioUsdCents',
    'CostoUnitarioUsdCents', 'Origen'],
  cierres: ['IdCierre', 'Fecha', 'IdTienda', 'Tienda', 'CerradoPor', 'Ventas',
    'TotalComisionBsCents', 'TotalNetoBsCents', 'PagadoBsCents', 'SaldoBsCents', 'CerradoEn'],
  tcDia: ['Fecha', 'IdEmpleado', 'Empleado', 'IdTienda', 'TcDecimas', 'RegistradoEn'],
  catalogo: ['IdProducto', 'Marca', 'Modelo', 'PrecioRefUsdCents', 'Caracteristicas',
    'Imagen', 'Activo']
});

// --- conversion de lo que viene de la hoja --------------------------------

function texto(valor) {
  return valor === null || valor === undefined ? '' : String(valor);
}

function entero(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

// La hoja escribe booleanos como '1'. Aceptamos las formas que alguien pueda
// teclear a mano en la hoja.
function bandera(valor) {
  const t = texto(valor).trim().toUpperCase();
  return t === '1' || t === 'TRUE' || t === 'SI' || t === 'SÍ' || t === 'X' || t === 'S';
}

function enRango(dia, desde, hasta) {
  if (desde && dia < desde) return false;
  if (hasta && dia > hasta) return false;
  return true;
}

// Devuelve una funcion `get(fila, nombre)` ya atada a la posicion de cada
// columna. Con `cabeceras` gana el encabezado; sin ella, la posicion canonica.
function lector(cabeceras, nombres) {
  const mapa = {};
  const hayEncabezados = Array.isArray(cabeceras) && cabeceras.length > 0;
  const bajados = hayEncabezados ? cabeceras.map(function (c) { return texto(c).trim().toLowerCase(); }) : [];
  for (const nombre of nombres) {
    if (hayEncabezados) {
      const pos = bajados.indexOf(String(nombre).toLowerCase());
      if (pos !== -1) { mapa[nombre] = pos; continue; }
    }
    mapa[nombre] = nombres.indexOf(nombre);
  }
  return function (fila, nombre) {
    const pos = mapa[nombre];
    if (pos === undefined) return '';
    const valor = fila[pos];
    return valor === null || valor === undefined ? '' : valor;
  };
}

// Saca la lista de filas de la respuesta del .gs sin asumir una sola forma.
function filasDe(datos, clave) {
  if (Array.isArray(datos)) return datos;
  if (!datos || typeof datos !== 'object') return [];
  if (Array.isArray(datos[clave])) return datos[clave];
  if (Array.isArray(datos.filas)) return datos.filas;
  return [];
}

function cabecerasDe(datos) {
  return datos && !Array.isArray(datos) && Array.isArray(datos.cabeceras) ? datos.cabeceras : null;
}

function filtros(filtro) {
  const f = filtro || {};
  const extra = {};
  if (f.desde) extra.desde = f.desde;
  if (f.hasta) extra.hasta = f.hasta;
  if (f.idTienda) extra.idTienda = f.idTienda;
  return extra;
}

// --- ids -------------------------------------------------------------------

// Id corto y legible: prefijo + tiempo en base 36 + azar. No es un uuid porque
// no hace falta: la hoja no lo usa como clave primaria de deduplicacion.
function nuevoId(prefijo) {
  const stamp = Date.now().toString(36);
  const azar = Math.floor(Math.random() * 1679616).toString(36);
  return (prefijo || 'JH') + stamp + azar;
}

// --- normalizadores por hoja ----------------------------------------------

function normalizarVenta(fila, get) {
  const fecha = texto(get(fila, 'Fecha'));
  const tc = entero(get(fila, 'TcDecimas'));
  const cobradoUsd = entero(get(fila, 'TotalCobradoUsdCents'));
  return {
    idVenta: texto(get(fila, 'IdVenta')),
    fecha: fecha,
    dia: fecha.slice(0, 10),
    idTienda: texto(get(fila, 'IdTienda')),
    tienda: texto(get(fila, 'Tienda')),
    idEmpleado: texto(get(fila, 'IdEmpleado')),
    vendedor: texto(get(fila, 'Vendedor')),
    moneda: money.normalizarMoneda(get(fila, 'Moneda')),
    tcDecimas: tc,
    gananciaUsdCents: entero(get(fila, 'GananciaUsdCents')),
    ajusteUsdCents: entero(get(fila, 'AjusteUsdCents')),
    gananciaBsCents: entero(get(fila, 'GananciaBsCents')),
    comisionBsCents: entero(get(fila, 'ComisionBsCents')),
    netoDuenoBsCents: entero(get(fila, 'NetoDuenoBsCents')),
    totalCobradoUsdCents: cobradoUsd,
    totalCobradoBsCents: tc > 0 ? Math.round((cobradoUsd * tc) / 100) : 0,
    estado: texto(get(fila, 'Estado')).toUpperCase(),
    notas: texto(get(fila, 'Notas')),
    idCierre: texto(get(fila, 'IdCierre')),
    unidades: entero(get(fila, 'Unidades')),
    // Las lineas se piden aparte con listarLineasDe: traerlas siempre
    // multiplicaria el costo de Sheets sin que el resumen las necesite.
    lineas: []
  };
}

function normalizarTienda(fila, get) {
  return {
    idTienda: texto(get(fila, 'IdTienda')),
    nombre: texto(get(fila, 'Nombre')),
    empleados: texto(get(fila, 'Empleados')),
    pctComision: entero(get(fila, 'PctComision')),
    claveHash: texto(get(fila, 'ClaveHash')),
    activa: bandera(get(fila, 'Activa'))
  };
}

function normalizarEmpleado(fila, get) {
  return {
    idEmpleado: texto(get(fila, 'IdEmpleado')),
    nombre: texto(get(fila, 'Nombre')),
    idTienda: texto(get(fila, 'IdTienda')),
    activo: bandera(get(fila, 'Activo'))
  };
}

function normalizarLinea(fila, get) {
  return {
    idVenta: texto(get(fila, 'IdVenta')),
    idProducto: texto(get(fila, 'IdProducto')),
    modelo: texto(get(fila, 'Modelo')),
    cantidad: entero(get(fila, 'Cantidad')),
    precioUsdCents: entero(get(fila, 'PrecioUsdCents')),
    costoUnitarioUsdCents: entero(get(fila, 'CostoUnitarioUsdCents')),
    origen: texto(get(fila, 'Origen'))
  };
}

function normalizarCierre(fila, get) {
  return {
    idCierre: texto(get(fila, 'IdCierre')),
    fecha: texto(get(fila, 'Fecha')),
    dia: texto(get(fila, 'Fecha')).slice(0, 10),
    idTienda: texto(get(fila, 'IdTienda')),
    tienda: texto(get(fila, 'Tienda')),
    cerradoPor: texto(get(fila, 'CerradoPor')),
    ventas: entero(get(fila, 'Ventas')),
    totalComisionBsCents: entero(get(fila, 'TotalComisionBsCents')),
    totalNetoBsCents: entero(get(fila, 'TotalNetoBsCents')),
    pagadoBsCents: entero(get(fila, 'PagadoBsCents')),
    saldoBsCents: entero(get(fila, 'SaldoBsCents')),
    cerradoEn: texto(get(fila, 'CerradoEn'))
  };
}

function normalizarTc(fila, get) {
  const fecha = texto(get(fila, 'Fecha'));
  return {
    fecha: fecha,
    dia: fecha.slice(0, 10),
    idEmpleado: texto(get(fila, 'IdEmpleado')),
    empleado: texto(get(fila, 'Empleado')),
    idTienda: texto(get(fila, 'IdTienda')),
    tcDecimas: entero(get(fila, 'TcDecimas')),
    registradoEn: texto(get(fila, 'RegistradoEn'))
  };
}

function normalizarProducto(fila, get) {
  return {
    idProducto: texto(get(fila, 'IdProducto')),
    marca: texto(get(fila, 'Marca')),
    modelo: texto(get(fila, 'Modelo')),
    precioRefUsdCents: entero(get(fila, 'PrecioRefUsdCents')),
    caracteristicas: texto(get(fila, 'Caracteristicas')),
    imagen: texto(get(fila, 'Imagen')),
    activo: bandera(get(fila, 'Activo'))
  };
}

// --- lecturas --------------------------------------------------------------

async function listarVentas(filtro) {
  const f = filtro || {};
  const datos = await sheets.leer('REPORTE_VENTAS', filtros(f));
  const crudas = filasDe(datos, 'ventas').filter(Boolean);
  const get = lector(cabecerasDe(datos), COLUMNAS.ventas);
  return crudas
    .map(function (fila) { return normalizarVenta(fila, get); })
    .filter(function (venta) {
      if (f.idTienda && venta.idTienda !== f.idTienda) return false;
      return enRango(venta.dia, f.desde || '', f.hasta || '');
    });
}

async function listarTiendas() {
  const datos = await sheets.leer('REPORTE_TIENDAS', {});
  const get = lector(cabecerasDe(datos), COLUMNAS.tiendas);
  return filasDe(datos, 'tiendas').filter(Boolean).map(function (fila) {
    return normalizarTienda(fila, get);
  });
}

async function listarEmpleados() {
  const datos = await sheets.leer('REPORTE_EMPLEADOS', {});
  const get = lector(cabecerasDe(datos), COLUMNAS.empleados);
  return filasDe(datos, 'empleados').filter(Boolean).map(function (fila) {
    return normalizarEmpleado(fila, get);
  });
}

async function listarLineasDe(idVenta) {
  const id = texto(idVenta);
  if (!id) return [];
  const datos = await sheets.leer('REPORTE_LINEAS', { idVenta: id });
  const get = lector(cabecerasDe(datos), COLUMNAS.lineas);
  return filasDe(datos, 'lineas').filter(Boolean).map(function (fila) {
    return normalizarLinea(fila, get);
  }).filter(function (linea) { return linea.idVenta === id; });
}

async function listarCierres(filtro) {
  const f = filtro || {};
  const datos = await sheets.leer('REPORTE_CIERRES', filtros(f));
  const get = lector(cabecerasDe(datos), COLUMNAS.cierres);
  return filasDe(datos, 'cierres').filter(Boolean).map(function (fila) {
    return normalizarCierre(fila, get);
  }).filter(function (cierre) {
    if (f.idTienda && cierre.idTienda !== f.idTienda) return false;
    return enRango(cierre.dia, f.desde || '', f.hasta || '');
  });
}

async function listarTc(filtro) {
  const f = filtro || {};
  const datos = await sheets.leer('REPORTE_TC', filtros(f));
  const get = lector(cabecerasDe(datos), COLUMNAS.tcDia);
  return filasDe(datos, 'tcDia').filter(Boolean).map(function (fila) {
    return normalizarTc(fila, get);
  }).filter(function (registro) {
    return enRango(registro.dia, f.desde || '', f.hasta || '');
  });
}

// Lectura simple del catalogo. La busqueda con normalizacion y el filtro de
// activos viven en `catalogo.js`; esta es la base cruda.
async function listarCatalogo(filtro) {
  const f = filtro || {};
  const datos = await sheets.leer('REPORTE_CATALOGO', {});
  const get = lector(cabecerasDe(datos), COLUMNAS.catalogo);
  const productos = filasDe(datos, 'catalogo').filter(Boolean).map(function (fila) {
    return normalizarProducto(fila, get);
  });
  const busqueda = sheets.normalizar(f.q || '');
  if (!busqueda) return productos;
  return productos.filter(function (producto) {
    return sheets.normalizar(producto.modelo).indexOf(busqueda) !== -1
      || sheets.normalizar(producto.marca).indexOf(busqueda) !== -1;
  });
}

// El consolidado del dueño: los mismos filtros que la tienda, mas el resumen
// ya agrupado por tienda, empleado y dia.
async function consolidar(filtro) {
  const ventas = await listarVentas(filtro);
  const tiendas = await listarTiendas();
  return { resumen: money.resumenVentas(ventas), ventas, tiendas };
}

module.exports = {
  COLUMNAS,
  nuevoId,
  listarVentas,
  listarTiendas,
  listarEmpleados,
  listarLineasDe,
  listarCierres,
  listarTc,
  listarCatalogo,
  consolidar,
  normalizar: sheets.normalizar
};