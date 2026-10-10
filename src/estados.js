'use strict';

// Estados de una venta y quien puede moverla. Datos puros: sin red, sin disco.
// La tabla de transiciones es el unico lugar donde se decide si algo se puede
// hacer; el servidor la consulta y nunca la reimplementa.

const ESTADOS = Object.freeze({
  BORRADOR: 'BORRADOR',
  CONFIRMADA: 'CONFIRMADA',
  CERRADA: 'CERRADA',
  ANULADA: 'ANULADA'
});

const LISTA_ESTADOS = Object.freeze([ESTADOS.BORRADOR, ESTADOS.CONFIRMADA, ESTADOS.CERRADA, ESTADOS.ANULADA]);

const ROLES = Object.freeze({ TIENDA: 'TIENDA', DUENO: 'DUENO' });

// [desde][hasta] = { TIENDA: bool, DUENO: bool }
const TRANSICIONES = Object.freeze({
  BORRADOR: {
    BORRADOR: { TIENDA: false, DUENO: false },
    CONFIRMADA: { TIENDA: true, DUENO: true },
    CERRADA: { TIENDA: false, DUENO: true },
    ANULADA: { TIENDA: false, DUENO: true }
  },
  CONFIRMADA: {
    BORRADOR: { TIENDA: true, DUENO: true },
    CONFIRMADA: { TIENDA: false, DUENO: false },
    CERRADA: { TIENDA: false, DUENO: true },
    ANULADA: { TIENDA: false, DUENO: true }
  },
  CERRADA: {
    BORRADOR: { TIENDA: false, DUENO: false },
    CONFIRMADA: { TIENDA: false, DUENO: true },
    CERRADA: { TIENDA: false, DUENO: false },
    ANULADA: { TIENDA: false, DUENO: true }
  },
  ANULADA: {
    BORRADOR: { TIENDA: false, DUENO: false },
    CONFIRMADA: { TIENDA: false, DUENO: false },
    CERRADA: { TIENDA: false, DUENO: false },
    ANULADA: { TIENDA: false, DUENO: false }
  }
});

function normalizarEstado(valor) {
  const texto = String(valor === null || valor === undefined ? '' : valor).trim().toUpperCase();
  return LISTA_ESTADOS.indexOf(texto) !== -1 ? texto : null;
}

function normalizarRol(valor) {
  const texto = String(valor === null || valor === undefined ? '' : valor).trim().toUpperCase();
  if (texto === ROLES.DUENO) return ROLES.DUENO;
  return ROLES.TIENDA; // fail-safe: cualquier rol raro vale como tienda
}

function esEstadoValido(valor) {
  return normalizarEstado(valor) !== null;
}

// Consulta la tabla. Rol desconocido => TIENDA (nunca mas permisos).
function puedeTransicionar(desde, hasta, rol) {
  const origen = normalizarEstado(desde);
  const destino = normalizarEstado(hasta);
  if (!origen || !destino) return false;
  const fila = TRANSICIONES[origen][destino];
  if (!fila) return false;
  return fila[normalizarRol(rol)] === true;
}

// Que estados puede mover este rol desde el estado actual.
function destinosPermitidos(desde, rol) {
  const origen = normalizarEstado(desde);
  if (!origen) return [];
  const r = normalizarRol(rol);
  return LISTA_ESTADOS.filter(function (destino) { return TRANSICIONES[origen][destino][r] === true; });
}

// Una venta ANULADA no se toca nunca mas. Las CERRADAS solo las mueve el dueno.
function esTerminal(valor) {
  return normalizarEstado(valor) === ESTADOS.ANULADA;
}

function estaCerrada(valor) {
  return normalizarEstado(valor) === ESTADOS.CERRADA;
}

// Una venta sigue "pendiente" mientras no este CERRADA ni ANULADA: el dueño la ve
// marcada en rojo porque todavia no leiblesso el dinero.
function estaPendiente(valor) {
  const e = normalizarEstado(valor);
  return e === ESTADOS.BORRADOR || e === ESTADOS.CONFIRMADA;
}

// --- permisos de edicion de contenido --------------------------------------

// El encargado puede tocar todo mientras este en BORRADOR. En CONFIRMADA ya no
// puede mover el costo (eso es ganancia para el, moverlo despues seria cambiar
// el acuerdo). El dueno si puede, y solo el dueno en CERRADA (reapertura).
function puedeEditarContenido(estado, rol, cambios) {
  const e = normalizarEstado(estado);
  if (!e) return false;
  const r = normalizarRol(rol);
  if (e === ESTADOS.ANULADA) return false;
  if (r === ROLES.DUENO) return true;
  // r === TIENDA
  if (e === ESTADOS.BORRADOR) return true;
  if (e === ESTADOS.CONFIRMADA) {
    // no puede tocar costo ni ajuste (los numeros que definen la ganancia)
    const tocaDinero = cambios && (cambios.costo || cambios.ajustes);
    return !tocaDinero;
  }
  return false; // CERRADA
}

// Solo BORRADOR se borra de verdad, y el dueño decide si lo hace.
function puedeBorrar(estado, rol) {
  const e = normalizarEstado(estado);
  if (!e) return false;
  if (normalizarRol(rol) === ROLES.DUENO) return e === ESTADOS.BORRADOR;
  return e === ESTADOS.BORRADOR;
}

// --- reglas de costo y motivo del rechazo ---------------------------------

// El costo lo edita el dueño siempre, y el encargado solo mientras la venta
// es un borrador. Una vez confirmada, el encargado ya no puede cambiar lo que
// costo el equipo.
function puedeEditarCosto(rol, estado) {
  const r = normalizarRol(rol);
  const s = normalizarEstado(estado);
  if (!esEstadoValido(s)) return false;
  if (r === ROLES.DUENO) return s !== 'CERRADA' && s !== 'ANULADA';
  return s === 'BORRADOR';
}

// El costo solo lo ve el dueño: el encargado necesita conocer su ganancia,
// no el costo del equipo.
function puedeVerCosto(rol) {
  return normalizarRol(rol) === ROLES.DUENO;
}

// Devuelve '' cuando la transicion esta permitida, y el motivo en espanol
// cuando se rechaza, para que el servidor pueda explicar sin inventar texto.
function explicarTransicion({ rol, desde, hasta } = {}) {
  const r = normalizarRol(rol);
  const d = normalizarEstado(desde);
  const h = normalizarEstado(hasta);
  if (!esEstadoValido(h)) return 'El estado "' + String(hasta) + '" no existe.';
  if (!esEstadoValido(d)) return 'La venta esta en un estado que no se reconoce.';
  if (puedeTransicionar(d, h, r)) return '';
  if (estaCerrada(d)) {
    return 'Una venta cerrada solo la puede reabrir o anular el dueno, y es lo unico que se puede hacer con ella.';
  }
  if (String(d) === 'ANULADA') {
    return 'Una venta anulada ya no se toca: queda registrada como anulada.';
  }
  if (String(h) === 'CERRADA') {
    return 'Solo el dueno puede cerrar una tienda y registrar el pago.';
  }
  if (r !== ROLES.DUENO) {
    return 'Como encargado no podes pasar de ' + d + ' a ' + h + '. Esa operacion es del dueno.';
  }
  return 'No se puede pasar de ' + d + ' a ' + h + '.';
}
module.exports = {
  ESTADOS,
  LISTA_ESTADOS,
  ROLES,
  TRANSICIONES,
  normalizarEstado,
  normalizarRol,
  esEstadoValido,
  puedeTransicionar,
  destinosPermitidos,
  esTerminal,
  estaCerrada,
  estaPendiente,
  puedeEditarContenido,
  puedeBorrar,
  puedeEditarCosto,
  puedeVerCosto,
  explicarTransicion
};
