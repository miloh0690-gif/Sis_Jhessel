'use strict';

// Catalogo de equipos: solo precios de referencia y ficha tecnica.
// No hay stock: el dueño lendio el equipo y cada vendedor teclea su costo.
const sheets = require('./sheets');
const money = require('./money');

const TTL_MS = Number(process.env.CATALOGO_CACHE_SEG || 0) * 1000 || 60000;

let cache = null;
let expira = 0;
let enCurso = null;

function bandera(valor) {
  return valor === true || valor === 1 || valor === '1'
    || String(valor).trim().toLowerCase() === 'true';
}

// Trae todos los productos de la hoja una vez y los deja en cache 60 s.
// Dos peticiones simultaneas comparten la misma promesa: la hoja no se
// golpea dos veces por el mismo puff.
function todos() {
  if (cache && Date.now() < expira) return Promise.resolve(cache);
  if (enCurso) return enCurso;
  enCurso = sheets.leer('REPORTE_CATALOGO', {})
    .then(function (datos) {
      const lista = (datos && (datos.filas || datos.catalogo)) || [];
      cache = Array.isArray(lista) ? lista.filter(Boolean).map(productoDesdeFila) : [];
      expira = Date.now() + TTL_MS;
      return cache;
    })
    .finally(() => { enCurso = null; });
  return enCurso;
}

// La fila cruda puede venir por encabezado (el .gs manda cabeceras) o por
// posicion canonica. Las columnas de la hoja Catalogo son:
// IdProducto Marca Modelo PrecioRefUsdCents Caracteristicas Imagen Activo
const COLUMNAS = ['IdProducto', 'Marca', 'Modelo', 'PrecioRefUsdCents', 'Caracteristicas',
  'Imagen', 'Activo'];

function productoDesdeFila(fila) {
  const cab = fila && fila.cabeceras ? fila.cabeceras : null;
  function get(nombre, indice) {
    if (cab) {
      const i = cab.findIndex((c) => String(c).trim().toLowerCase() === nombre.toLowerCase());
      if (i >= 0) return fila[i];
    }
    return fila[indice];
  }
  return {
    idProducto: String(get('IdProducto', 0) || '').trim(),
    marca: String(get('Marca', 1) || '').trim(),
    modelo: String(get('Modelo', 2) || '').trim(),
    precioRefUsdCents: money.entero(get('PrecioRefUsdCents', 3)),
    caracteristicas: String(get('Caracteristicas', 4) || '').trim(),
    imagen: String(get('Imagen', 5) || '').trim(),
    activo: bandera(get('Activo', 6))
  };
}

function coincide(producto, busqueda) {
  const modelo = sheets.normalizar(producto.modelo);
  const marca = sheets.normalizar(producto.marca);
  const total = modelo + ' ' + marca;
  if (modelo === busqueda || marca === busqueda) return true;
  return modelo.indexOf(busqueda) !== -1
    || marca.indexOf(busqueda) !== -1
    || total.indexOf(busqueda) !== -1;
}

async function buscar(texto, opciones) {
  const op = opciones || {};
  const limite = op.limite === undefined ? 30 : Number(op.limite);
  const busqueda = sheets.normalizar(texto || '');
  const productos = (await todos()).filter(function (p) {
    return op.incluirInactivos ? true : p.activo;
  });
  if (!busqueda) return productos.slice(0, limite);
  const coincidencias = productos.filter((p) => coincide(p, busqueda));
  return coincidencias.slice(0, limite);
}

async function obtener(idProducto) {
  const id = String(idProducto || '').trim();
  if (!id) return null;
  const productos = await todos();
  for (const p of productos) {
    if (p.idProducto === id) return p;
  }
  return null;
}

// El precio de referencia vive en USD. Si el vendedor cobra en Bs se
// convierte con el TC de esa misma venta, nunca con uno guardado.
async function precioSugerido(datos) {
  const d = datos || {};
  const producto = await obtener(d.idProducto);
  if (!producto) return null;
  const moneda = money.normalizarMoneda(d.moneda);
  if (moneda === 'BS') {
    return money.precioUsdCentsAPrecioBsCents(producto.precioRefUsdCents, d.tcDecimas);
  }
  return producto.precioRefUsdCents;
}

async function guardarPrecio(idProducto, precioUsdCents) {
  await sheets.escribir({
    tipoOperacion: 'GUARDAR_PRECIO',
    idProducto: String(idProducto || '').trim(),
    precioUsdCents: money.entero(precioUsdCents)
  });
  limpiarCache();
}

function limpiarCache() {
  cache = null;
  expira = 0;
}

module.exports = {
  buscar,
  obtener,
  precioSugerido,
  guardarPrecio,
  limpiarCache,
  TTL_MS
};