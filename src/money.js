'use strict';

// Toda la aritmetica del sistema vive aqui y trabaja con enteros.
// Los importes de dinero son SIEMPRE enteros de centavos:
//   - centavos de dolar para costos y precios de referencia
//   - centavos de bolivianos para totales, comision y neto del dueno
// El navegador solo muestra; el servidor es la unica autoridad.

const MONEDAS = Object.freeze({ BS: 'BS', USD: 'USD' });
const MONEDA_POR_DEFECTO = MONEDAS.BS;
const COMISION_BP_MAXIMO = 10000; // 100% en basis points
const COMISION_BP_MINIMO = 0;

// --- basicos ---------------------------------------------------------------

// Convierte lo que una persona teclea a centavos enteros. "340", "340,00" y
// "340.00" son lo mismo: los bolivianos escriben la coma decimal y el teclado
// del celular tambien la ofrece. Sin esta normalizacion un precio tecleado con
// coma daba 0 en vez de 34000.
function aCents(valor) {
  if (valor === null || valor === undefined || valor === '') return 0;
  const texto = String(valor).trim().replace(',', '.');
  const n = Number(texto);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function aDecimal(cents) {
  const n = Number(cents);
  return Number.isFinite(n) ? Math.round(n) / 100 : 0;
}

// Convierte lo que el vendedor teclea ("7,25", "7.25", 7.25) a decimas enteras.
// 7,25 -> 725. Devuelve 0 si no es valido o no es positivo.
function tcADecimas(valor) {
  if (valor === null || valor === undefined || valor === '') return 0;
  const texto = String(valor).trim().replace(',', '.');
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(texto)) return 0;
  const n = Number(texto);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
}

// 725 -> "7,25". Para mostrar en la interfaz.
function decimasATc(decimas) {
  const n = Number(decimas);
  if (!Number.isFinite(n)) return '';
  const entero = Math.floor(Math.abs(n) / 100);
  const resto = Math.abs(n) % 100;
  const signo = n < 0 ? '-' : '';
  return resto === 0 ? signo + String(entero) : signo + entero + ',' + String(resto).padStart(2, '0');
}

// "30", 30, 0.3, "30%" -> 3000 basis points. Acepta 0..100.
function pctComisionABp(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  let texto = String(valor).trim().replace('%', '').replace(',', '.');
  if (texto === '') return null;
  let n = Number(texto);
  if (!Number.isFinite(n)) return null;
  // 0.30 significa 30%. Solo si viene con punto y es <= 1.
  if (texto.indexOf('.') !== -1 && Math.abs(n) <= 1) n = n * 100;
  if (!Number.isFinite(n)) return null;
  const bp = Math.round(n * 100);
  if (bp < COMISION_BP_MINIMO || bp > COMISION_BP_MAXIMO) return null;
  return bp;
}

function bpAPct(bp) {
  const n = Number(bp);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n) / 100;
}

function normalizarMoneda(valor) {
  const texto = String(valor === null || valor === undefined ? '' : valor).trim().toUpperCase();
  if (texto === 'USD' || texto === 'DOLAR' || texto === 'DOLARES' || texto === '$') return MONEDAS.USD;
  if (texto === 'BS' || texto === 'BOBOLIVIANO' || texto === 'BOBOLIVIANOS' || texto === 'BS.' || texto === '') {
    return MONEDA_POR_DEFECTO;
  }
  return null;
}

// --- calculo de una venta --------------------------------------------------

// Normaliza una linea cruda del cliente a la forma que usa el calculo.
// precioUsdCents y costoUnitarioUsdCents SIEMPRE en centavos de dolar.
function normalizarLinea(linea) {
  const l = linea && typeof linea === 'object' ? linea : {};
  const cantidad = Math.max(1, Math.floor(Number(l.cantidad) || 0) || 1);
  const precioUsdCents = Math.round(Number(l.precioUsdCents) || 0);
  const costoUnitarioUsdCents = Math.round(Number(l.costoUnitarioUsdCents) || 0);
  const idProducto = String(l.idProducto === undefined || l.idProducto === null ? '' : l.idProducto).slice(0, 64);
  const modelo = String(l.modelo === undefined || l.modelo === null ? '' : l.modelo).trim().slice(0, 200);
  const origen = String(l.origen === undefined || l.origen === null ? '' : l.origen).trim().slice(0, 64);
  return { idProducto, modelo, cantidad, precioUsdCents, costoUnitarioUsdCents, origen };
}

// Si el cliente paga en Bs, convierte el precio tecleado a centavos de dolar
// usando el TC de esa misma venta.
// precioUsdCents = round(precioBsCentavos * 100 / tcDecimas)
function precioBsAUsdCents(precioBsCents, tcDecimas) {
  const bs = Math.round(Number(precioBsCents) || 0);
  const tc = Math.round(Number(tcDecimas) || 0);
  if (tc <= 0) return 0;
  return Math.round((bs * 100) / tc);
}

// Si el cliente paga en USD, el precio ya viene en centavos de dolar y el TC
// solo se aplica al total.
function precioUsdCentsAPrecioBsCents(precioUsdCents, tcDecimas) {
  const usd = Math.round(Number(precioUsdCents) || 0);
  const tc = Math.round(Number(tcDecimas) || 0);
  if (tc <= 0) return 0;
  return Math.round((usd * tc) / 100);
}

// Calcula todos los totales de una venta. Es la unica funcion autoritativa:
// lo que el navegador muestre puede estar desfasado, esto no.
// Devuelve centavos enteros en todas las claves que terminan en Cents.
// Los totales de una venta: toda la aritmetica autoritativa vive aqui y en
// ninguna parte mas. No lleva la nota porque los totales no la necesitan.
function calcularTotales({ lineas, ajustesUsdCents, ajusteUsdCents, tcDecimas, pctComisionBp, moneda, precioBsCents, precioUsdCents, cantidad }) {
  const tc = Math.round(Number(tcDecimas) || 0);
  const bp = pctComisionBp === null || pctComisionBp === undefined ? 0 : Math.round(Number(pctComisionBp) || 0);
  const mon = normalizarMoneda(moneda) || MONEDA_POR_DEFECTO;

  // Si viene una sola linea suelta (venta rapida de un solo equipo) se
  // convierte al mismo formato de lista.
  let crudas = Array.isArray(lineas) ? lineas.filter(Boolean) : [];
  if (!crudas.length && (precioUsdCents !== undefined || precioBsCents !== undefined)) {
    crudas = [{ cantidad, precioUsdCents, precioBsCents }];
  }

  const items = crudas.map(normalizarLinea);

  // Si el pago es en Bs y la linea trae el precio en Bs, lo pasamos a USD.
  if (mon === MONEDAS.BS && tc > 0) {
    for (let i = 0; i < items.length; i += 1) {
      const cruda = crudas[i] || {};
      if (cruda.precioBsCents !== undefined && cruda.precioUsdCents === undefined) {
        items[i].precioUsdCents = precioBsAUsdCents(cruda.precioBsCents, tc);
      }
    }
  }

  let totalCobradoUsdCents = 0;
  let costoTotalUsdCents = 0;
  let gananciaBrutaUsdCents = 0;
  const lineasDetalle = items.map(function (item) {
    const totalLineaUsdCents = item.precioUsdCents * item.cantidad;
    const costoLineaUsdCents = item.costoUnitarioUsdCents * item.cantidad;
    const gananciaUsdCents = totalLineaUsdCents - costoLineaUsdCents;
    totalCobradoUsdCents += totalLineaUsdCents;
    costoTotalUsdCents += costoLineaUsdCents;
    gananciaBrutaUsdCents += gananciaUsdCents;
    return {
      idProducto: item.idProducto,
      modelo: item.modelo,
      cantidad: item.cantidad,
      precioUsdCents: item.precioUsdCents,
      costoUnitarioUsdCents: item.costoUnitarioUsdCents,
      totalUsdCents: totalLineaUsdCents,
      gananciaUsdCents,
      origen: item.origen
    };
  });

  const bruto = ajustesUsdCents === undefined || ajustesUsdCents === null ? ajusteUsdCents : ajustesUsdCents;
  const ajustes = Math.round(Number(bruto) || 0);
  const gananciaNetaUsdCents = gananciaBrutaUsdCents - ajustes;

  // gananciaBsCents = round(gananciaNetaUsdCents * tcDecimas / 100)
  const gananciaBsCents = tc > 0 ? Math.round((gananciaNetaUsdCents * tc) / 100) : 0;

  // Nunca hay comision sobre perdida: si la ganancia es <= 0 la comision es 0
  // y el dueno se queda con la perdida completa.
  const comisionBsCents = gananciaBsCents > 0 ? Math.round((gananciaBsCents * bp) / 10000) : 0;
  const netoDuenoBsCents = gananciaBsCents - comisionBsCents;

  const totalCobradoBsCents = tc > 0 ? Math.round((totalCobradoUsdCents * tc) / 100) : 0;
  const costoTotalBsCents = tc > 0 ? Math.round((costoTotalUsdCents * tc) / 100) : 0;

  return {
    moneda: mon,
    tcDecimas: tc,
    pctComisionBp: bp,
    lineas: lineasDetalle,
    cantidadLineas: lineasDetalle.length,
    unidades: lineasDetalle.reduce(function (s, l) { return s + l.cantidad; }, 0),
    totalCobradoUsdCents,
    costoTotalUsdCents,
    totalCobradoBsCents,
    costoTotalBsCents,
    ajustesUsdCents: ajustes,
    gananciaBrutaUsdCents,
    gananciaNetaUsdCents,
    gananciaBsCents,
    comisionBsCents,
    netoDuenoBsCents
  };
}

// --- resumen para el consolidado -------------------------------------------

// Convierte algo que venga de la hoja en entero. Los centavos llegan como
// enteros desde el .gs y no se reescalan.
function entero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

// El total cobrado en Bs: si la hoja ya lo trajo se respeta; si no, se
// convierte desde el total en USD con el TC de esa misma venta.
function cobradoBs(venta) {
  const dado = venta.totalCobradoBsCents;
  if (dado !== null && dado !== undefined && dado !== '') return entero(dado);
  const tc = entero(venta.tcDecimas);
  return tc > 0 ? Math.round((entero(venta.totalCobradoUsdCents) * tc) / 100) : 0;
}

// Agrupa las ventas por tienda, por empleado y por dia. Una venta CONFIRMADA
// cuenta como pendiente de cobro; la BORRADOR todavia no se cobra y la
// CERRADA ya se pago.
function resumenVentas(ventas) {
  const lista = Array.isArray(ventas) ? ventas.filter(Boolean) : [];
  const totales = {
    cantidadVentas: 0,
    unidades: 0,
    totalCobradoBsCents: 0,
    totalGananciaBsCents: 0,
    totalComisionBsCents: 0,
    totalNetoDuenoBsCents: 0
  };
  const tiendas = new Map();
  const empleados = new Map();
  const dias = new Map();

  function acumular(mapa, clave, base) {
    if (!mapa.has(clave)) mapa.set(clave, base);
    return mapa.get(clave);
  }

  for (const venta of lista) {
    const unidades = entero(venta.unidades);
    const ganancia = entero(venta.gananciaBsCents);
    const comision = entero(venta.comisionBsCents);
    const neto = entero(venta.netoDuenoBsCents);
    const cobrado = cobradoBs(venta);

    totales.cantidadVentas += 1;
    totales.unidades += unidades;
    totales.totalCobradoBsCents += cobrado;
    totales.totalGananciaBsCents += ganancia;
    totales.totalComisionBsCents += comision;
    totales.totalNetoDuenoBsCents += neto;

    const idTienda = String(venta.idTienda || '');
    const t = acumular(tiendas, idTienda, {
      idTienda: idTienda,
      tienda: String(venta.tienda || ''),
      cantidadVentas: 0,
      unidades: 0,
      gananciaBsCents: 0,
      comisionBsCents: 0,
      netoDuenoBsCents: 0,
      pendientes: 0
    });
    t.cantidadVentas += 1;
    t.unidades += unidades;
    t.gananciaBsCents += ganancia;
    t.comisionBsCents += comision;
    t.netoDuenoBsCents += neto;
    if (String(venta.estado || '') === 'CONFIRMADA') t.pendientes += 1;

    const idEmpleado = String(venta.idEmpleado || '');
    const emp = acumular(empleados, idEmpleado || String(venta.vendedor || ''), {
      idEmpleado: idEmpleado,
      vendedor: String(venta.vendedor || ''),
      idTienda: idTienda,
      tienda: String(venta.tienda || ''),
      cantidadVentas: 0,
      unidades: 0,
      gananciaBsCents: 0,
      comisionBsCents: 0,
      netoDuenoBsCents: 0
    });
    emp.cantidadVentas += 1;
    emp.unidades += unidades;
    emp.gananciaBsCents += ganancia;
    emp.comisionBsCents += comision;
    emp.netoDuenoBsCents += neto;

    const dia = String(venta.dia || venta.fecha || '').slice(0, 10);
    const d = acumular(dias, dia, {
      dia: dia,
      cantidadVentas: 0,
      unidades: 0,
      gananciaBsCents: 0,
      comisionBsCents: 0,
      netoDuenoBsCents: 0
    });
    d.cantidadVentas += 1;
    d.unidades += unidades;
    d.gananciaBsCents += ganancia;
    d.comisionBsCents += comision;
    d.netoDuenoBsCents += neto;
  }

  const porNetoDesc = function (a, b) { return b.netoDuenoBsCents - a.netoDuenoBsCents; };
  return {
    cantidadVentas: totales.cantidadVentas,
    unidades: totales.unidades,
    totalCobradoBsCents: totales.totalCobradoBsCents,
    totalGananciaBsCents: totales.totalGananciaBsCents,
    totalComisionBsCents: totales.totalComisionBsCents,
    totalNetoDuenoBsCents: totales.totalNetoDuenoBsCents,
    porTienda: Array.from(tiendas.values()).sort(porNetoDesc),
    porEmpleado: Array.from(empleados.values()).sort(porNetoDesc),
    porDia: Array.from(dias.values()).sort(function (a, b) {
      return a.dia < b.dia ? -1 : (a.dia > b.dia ? 1 : 0);
    })
  };
}

// calcularVenta es calcularTotales mas la nota, que es lo que queda escrito en
// la fila de la hoja.
function calcularVenta(entrada) {
  const resultado = calcularTotales(entrada || {});
  resultado.nota = String((entrada && entrada.nota) || '');
  return resultado;
}
module.exports = {
  MONEDAS,
  MONEDA_POR_DEFECTO,
  COMISION_BP_MAXIMO,
  COMISION_BP_MINIMO,
  aCents,
  aDecimal,
  tcADecimas,
  decimasATc,
  pctComisionABp,
  bpAPct,
  normalizarMoneda,
  normalizarLinea,
  precioBsAUsdCents,
  precioUsdCentsAPrecioBsCents,
  entero,
  calcularTotales,
  calcularVenta,
  resumenVentas
};