'use strict';

// El Code.gs no se puede ejecutar contra Sheets desde aca, pero si se puede
// ejercitar con una hoja de mentira: esto verifica lo que de verdad importa
// del puente, que son las tres cosas que en Sis_Zamir rompieron datos:
//
//   1. Una hoja recien creada (solo encabezados) devuelve [] y no reventa.
//   2. La clave de idempotencia se busca POR ENCABEZADO, aunque alguien
//      inserte una columna a mano.
//   3. Los errores del propio API llegan como {status:'ERROR'}, que es como
//      el cliente de Node los detecta.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');


// --- hoja de mentira --------------------------------------------------------

// La hoja falsa vive en test/hoja-falsa.js: test/e2e.test.js usa la misma,
// y dos copias divergirían sin avisar.
const falsa = require('./hoja-falsa.js');
const CLAVE = falsa.CLAVE;
const crearHoja = falsa.crearHoja;
const crearEntorno = falsa.crearEntorno;
const respuesta = falsa.respuesta;
const post = falsa.post;
const get = falsa.get;

const VENTA = {
  idVenta: 'V1',
  fecha: '2026-10-08T15:00:00.000Z',
  dia: '2026-10-08',
  idTienda: 'T1',
  tienda: 'Tienda Camila',
  idEmpleado: 'E1',
  vendedor: 'Camila',
  moneda: 'USD',
  tcDecimas: 725,
  pctComisionBp: 3000,
  unidades: 1,
  gananciaNetaUsdCents: 3500,
  ajustesUsdCents: 500,
  gananciaBsCents: 25375,
  comisionBsCents: 7613,
  netoDuenoBsCents: 17762,
  totalCobradoUsdCents: 4000,
  estado: 'BORRADOR',
  notas: 'le regalé un vidrio',
  idCierre: '',
  claveIdempotencia: 'abc123def456'
};

const LINEAS = [{
  idProducto: 'P1',
  modelo: 'Galaxy A54',
  cantidad: 1,
  precioUsdCents: 40000,
  costoUnitarioUsdCents: 36500,
  origen: ''
}];

const TCDIA = {
  fecha: '2026-10-08',
  idEmpleado: 'E1',
  empleado: 'Camila',
  idTienda: 'T1',
  tcDecimas: 725,
  registradoEn: '2026-10-08T15:00:00.000Z'
};

function guardarVenta(entorno, extra) {
  return post(entorno, Object.assign(
    { tipoOperacion: 'GUARDAR_VENTA', venta: VENTA, lineas: LINEAS, tcDia: TCDIA },
    extra || {}));
}

// --- pruebas ----------------------------------------------------------------

test('SALUD responde sin clave: sirve para saber si el script esta desplegado', () => {
  const entorno = crearEntorno();
  const r = get(entorno, { action: 'SALUD' });
  assert.equal(r.ok, true);
  assert.equal(typeof r.version, 'number');
  assert.ok(r.hora);
});

test('SALUD dice que version es y que hoja de precios usa: para saber si el', () => {
  // script desplegado esta desactualizado sin depender de la clave compartida.
  const entorno = crearEntorno();
  const r = get(entorno, { action: 'SALUD' });
  assert.equal(r.version, 2, 'la version sube para distinguir un deployment viejo');
  assert.equal(r.hoja, 'Precios', 'dice la hoja de precios, no la de inventario vieja');
  assert.equal(r.esLegacy, false);
});

test('SALUD marca esLegacy cuando la hoja todavia se llama Catalogo', () => {
  // Simula un deployment viejo: el mismo Codigo.gs con la hoja Catalogo.
  const entorno = crearEntorno({
    fuente: function (s) { return s.replace("'Precios'", "'Catalogo'"); }
  });
  const r = get(entorno, { action: 'SALUD' });
  assert.equal(r.hoja, 'Catalogo');
  assert.equal(r.esLegacy, true, 'asi el diagnostico puede decir que pegue el Codigo.gs nuevo');
});

test('SALUD dice el nombre del libro: para ver si estamos en la hoja correcta', () => {
  const entorno = crearEntorno({ nombreLibro: 'JHessel Bolivia' });
  const r = get(entorno, { action: 'SALUD' });
  assert.equal(r.libro, 'JHessel Bolivia',
    'sin esto no hay forma de saber si escribe en la hoja que el dueno esta viendo');
});

test('con SPREADSHEET_ID el script abre SIEMPRE ese libro, no el que este abierto', () => {
  const entorno = crearEntorno({ spreadsheetId: '1AbCdEf' });
  get(entorno, { action: 'SALUD' });
  assert.deepEqual(entorno.abiertos, ['1AbCdEf'],
    'getActiveSpreadsheet() devuelve el libro equivocado si el script no esta vinculado');
});

test('sin libro disponible la escritura dice que falta la hoja, en vez de "guardado"', () => {
  const entorno = crearEntorno({ sinLibroActivo: true, clave: CLAVE });
  const r = post(entorno, {
    tipoOperacion: 'GUARDAR_TIENDA',
    tienda: { idTienda: 'T1', nombre: 'T', pctComision: 30, activa: true }
  });
  assert.equal(r.status, 'ERROR');
  assert.match(r.message, /SPREADSHEET_ID|hoja de trabajo/,
    'sin este aviso el dueno creeria que guardo una tienda que no existe');
});

test('una lectura sin clave responde NO_AUTORIZADO y no escribe nada', () => {
  const entorno = crearEntorno();
  const r = get(entorno, { action: 'REPORTE_VENTAS' });
  assert.equal(r.status, 'ERROR');
  assert.equal(r.message, 'NO_AUTORIZADO');
  assert.deepEqual(Object.keys(entorno.hojas), []);
});

test('un POST sin apiKey responde NO_AUTORIZADO', () => {
  const entorno = crearEntorno();
  const evento = { postData: { contents: JSON.stringify({ apiKey: 'mala', tipoOperacion: 'GUARDAR_VENTA' }) } };
  const r = respuesta(entorno.contexto.doPost(evento));
  assert.equal(r.message, 'NO_AUTORIZADO');
});

test('GUARDAR_VENTA crea las hojas y escribe venta, linea y TcDia', () => {
  const entorno = crearEntorno();
  const r = guardarVenta(entorno);
  assert.equal(r.ok, true);
  assert.equal(r.id, 'V1');
  assert.equal(r.duplicada, false);

  const ventas = entorno.hojas.Ventas.datos;
  assert.equal(ventas.length, 2, 'encabezado + una venta');
  assert.equal(ventas[1][0], 'V1');
  assert.equal(ventas[1][3], 'Tienda Camila', 'la columna Tienda viaja');
  assert.equal(ventas[1][18], 1, 'Unidades en la columna 19');
  assert.equal(ventas[1][19], 'abc123def456', 'ClaveIdempotencia en la columna 20');

  assert.equal(entorno.hojas.VentaLineas.datos.length, 2);
  assert.equal(entorno.hojas.VentaLineas.datos[1][0], 'V1');
  assert.equal(entorno.hojas.VentaLineas.datos[1][5], 36500, 'el costo si se guarda');

  assert.equal(entorno.hojas.TcDia.datos.length, 2);
  assert.equal(entorno.hojas.TcDia.datos[1][4], 725);
});

test('la misma clave dos veces deja UNA venta y avisa que estaba repetida', () => {
  const entorno = crearEntorno();
  guardarVenta(entorno);
  const segunda = guardarVenta(entorno);
  assert.equal(segunda.duplicada, true);
  assert.equal(segunda.id, 'V1');
  assert.equal(entorno.hojas.Ventas.datos.length, 2, 'no se agrego una fila');
  assert.equal(entorno.hojas.VentaLineas.datos.length, 2, 'ni sus lineas');
});

test('REPORTE_VENTAS con la hoja recien creada devuelve [] y no explota', () => {
  const entorno = crearEntorno();
  // Solo con encabezados: es el estado en que queda la hoja antes de la
  // primera venta. getLastRow() es 1 y un getRange con -1 filas revienta.
  const r = get(entorno, { action: 'REPORTE_VENTAS', key: CLAVE });
  assert.deepEqual(r.filas, []);
  assert.ok(r.cabeceras.includes('IdVenta'));
  assert.ok(r.cabeceras.includes('ClaveIdempotencia'));
});

test('las columnas se resuelven por encabezado aunque alguien inserte una antes', () => {
  const entorno = crearEntorno();
  guardarVenta(entorno);
  // Alguien agrega una columna a mano entre medio de la fila de encabezado.
  entorno.hojas.Ventas.datos[0].splice(1, 0, 'ColumnaIntrusa');
  entorno.hojas.Ventas.datos[1].splice(1, 0, 'basura');

  const repetida = guardarVenta(entorno);
  assert.equal(repetida.duplicada, true,
    'si leyera por posicion, ClaveIdempotencia estaria corrida y no deduplicaria');

  const r = get(entorno, { action: 'REPORTE_VENTAS', key: CLAVE });
  assert.equal(r.filas.length, 1);
  assert.equal(r.filas[0][0], 'V1', 'IdVenta sigue siendo IdVenta');
});

test('REPORTE_VENTAS filtra por tienda y por rango de dias', () => {
  const entorno = crearEntorno();
  guardarVenta(entorno);
  guardarVenta(entorno, { venta: Object.assign({}, VENTA, { idVenta: 'V2', idTienda: 'T2', claveIdempotencia: 'otra-clave-999' }) });

  assert.equal(get(entorno, { action: 'REPORTE_VENTAS', key: CLAVE }).filas.length, 2);
  assert.equal(
    get(entorno, { action: 'REPORTE_VENTAS', key: CLAVE, idTienda: 'T2' }).filas.length, 1);
  assert.equal(
    get(entorno, { action: 'REPORTE_VENTAS', key: CLAVE, hasta: '2026-10-07' }).filas.length, 0);
  assert.equal(
    get(entorno, { action: 'REPORTE_VENTAS', key: CLAVE, desde: '2026-10-08' }).filas.length, 2);
});

test('una lectura desconocida es un error de API, no una excepcion sin catch', () => {
  const entorno = crearEntorno();
  const r = get(entorno, { action: 'REPORTE_INVENTARIO', key: CLAVE });
  assert.equal(r.status, 'ERROR');
  assert.ok(/no reconocida/i.test(r.message));
});

test('TcDia actualiza en vez de duplicar cuando el mismo empleado repite dia', () => {
  const entorno = crearEntorno();
  guardarVenta(entorno);
  guardarVenta(entorno, { venta: Object.assign({}, VENTA, { idVenta: 'V2', claveIdempotencia: 'segunda-clave-77' }) });

  const tc = entorno.hojas.TcDia.datos;
  assert.equal(tc.length, 2, 'una sola fila de TcDia para E1 el 2026-10-08');
  assert.equal(tc[1][4], 725);
});

test('el TC de otro dia es otra fila: el historico por dia se conserva', () => {
  const entorno = crearEntorno();
  guardarVenta(entorno);
  guardarVenta(entorno, {
    venta: Object.assign({}, VENTA, { idVenta: 'V2', claveIdempotencia: 'dia-dos-clave' }),
    tcDia: Object.assign({}, TCDIA, { fecha: '2026-10-09', tcDecimas: 730 })
  });
  assert.equal(entorno.hojas.TcDia.datos.length, 3);
});

test('CAMBIAR_ESTADO actualiza Estado y deja el motivo en Notas', () => {
  const entorno = crearEntorno();
  guardarVenta(entorno);
  const r = post(entorno, {
    tipoOperacion: 'CAMBIAR_ESTADO',
    idVenta: 'V1',
    hasta: 'CONFIRMADA',
    estadoAnterior: 'BORRADOR',
    idTienda: 'T1',
    motivo: 'venta cobrada'
  });
  assert.equal(r.estado, 'CONFIRMADA');

  const reporte = get(entorno, { action: 'REPORTE_VENTAS', key: CLAVE });
  const indiceEstado = reporte.cabeceras.indexOf('Estado');
  const indiceNotas = reporte.cabeceras.indexOf('Notas');
  assert.equal(reporte.filas[0][indiceEstado], 'CONFIRMADA');
  assert.ok(/venta cobrada/.test(reporte.filas[0][indiceNotas]));
});

test('CAMBIAR_ESTADO sobre una venta que no existe avisa, no escribe de mas', () => {
  const entorno = crearEntorno();
  guardarVenta(entorno);
  const r = post(entorno, { tipoOperacion: 'CAMBIAR_ESTADO', idVenta: 'V999', hasta: 'CERRADA' });
  assert.equal(r.status, 'ERROR');
  assert.ok(/No se encontro/.test(r.message));
});

test('ELIMINAR_VENTA borra la venta y sus lineas', () => {
  const entorno = crearEntorno();
  guardarVenta(entorno);
  const r = post(entorno, { tipoOperacion: 'ELIMINAR_VENTA', idVenta: 'V1', idTienda: 'T1' });
  assert.equal(r.eliminada, true);
  assert.equal(entorno.hojas.Ventas.datos.length, 1);
  assert.equal(entorno.hojas.VentaLineas.datos.length, 1, 'solo queda el encabezado');
});

test('ACTUALIZAR_VENTA reescribe la fila y reemplaza las lineas', () => {
  const entorno = crearEntorno();
  guardarVenta(entorno);
  guardarVenta(entorno, {
    venta: Object.assign({}, VENTA, {
      idVenta: 'V2', claveIdempotencia: 'segunda-venta-88', unidades: 2
    }),
    lineas: [{ idProducto: 'P9', modelo: 'Note 13', cantidad: 2, precioUsdCents: 18500, costoUnitarioUsdCents: 17000 }]
  });
  assert.equal(entorno.hojas.VentaLineas.datos.length, 3);

  const r = post(entorno, {
    tipoOperacion: 'ACTUALIZAR_VENTA',
    idVenta: 'V2',
    venta: Object.assign({}, VENTA, { idVenta: 'V2', notas: 'precio corregido' }),
    lineas: [LINEAS[0]]
  });
  assert.equal(r.ok, true);
  assert.equal(entorno.hojas.Ventas.datos.length, 3, 'no agrega fila: actualiza');
  const lineasFinales = entorno.hojas.VentaLineas.datos;
  assert.equal(lineasFinales.length, 3,
    'encabezado + la linea de V1 + la linea nueva de V2');
  assert.deepEqual(lineasFinales.slice(1).map((f) => [f[0], f[1]]), [['V1', 'P1'], ['V2', 'P1']],
    'la linea vieja de V2 (P9) se fue y la de V1 no se toco');
  assert.ok(/precio corregido/.test(entorno.hojas.Ventas.datos[2][16]));
});

test('CERRAR_TIENDA cierra las ventas indicadas y escribe el recibo', () => {
  const entorno = crearEntorno();
  guardarVenta(entorno);
  guardarVenta(entorno, { venta: Object.assign({}, VENTA, { idVenta: 'V2', claveIdempotencia: 'venta-dos-clave' }) });

  const r = post(entorno, {
    tipoOperacion: 'CERRAR_TIENDA',
    claveIdempotencia: 'cierre:T1|2026-10-08|C9',
    idsVentas: ['V1'],
    cierre: {
      idCierre: 'C9',
      fecha: '2026-10-08',
      idTienda: 'T1',
      tienda: 'Tienda Camila',
      cerradoPor: 'Dueno',
      ventas: 1,
      totalComisionBsCents: 7613,
      totalNetoDuenoBsCents: 17762,
      pagadoBsCents: 17762,
      saldoBsCents: 0,
      cerradoEn: '2026-10-08T22:00:00.000Z'
    }
  });
  assert.equal(r.ventasCerradas, 1);

  const ventas = get(entorno, { action: 'REPORTE_VENTAS', key: CLAVE });
  const iEstado = ventas.cabeceras.indexOf('Estado');
  const iCierre = ventas.cabeceras.indexOf('IdCierre');
  const porId = {};
  for (const fila of ventas.filas) porId[fila[0]] = fila;
  assert.equal(porId.V1[iEstado], 'CERRADA');
  assert.equal(porId.V1[iCierre], 'C9');
  assert.equal(porId.V2[iEstado], 'BORRADOR', 'V2 no estaba en la lista');

  const cierres = get(entorno, { action: 'REPORTE_CIERRES', key: CLAVE });
  assert.equal(cierres.filas.length, 1);
  assert.equal(cierres.filas[0][0], 'C9');
});

test('CERRAR_TIENDA repetido con la misma clave no duplica el recibo', () => {
  const entorno = crearEntorno();
  guardarVenta(entorno);
  const cuerpo = {
    tipoOperacion: 'CERRAR_TIENDA',
    claveIdempotencia: 'cierre:T1|2026-10-08|C9',
    idsVentas: ['V1'],
    cierre: { idCierre: 'C9', fecha: '2026-10-08', idTienda: 'T1', tienda: 'Camila', cerradoPor: 'Dueno', ventas: 1, totalComisionBsCents: 7613, totalNetoDuenoBsCents: 17762, pagadoBsCents: 17762, saldoBsCents: 0, cerradoEn: 'x' }
  };
  post(entorno, cuerpo);
  const segunda = post(entorno, cuerpo);
  assert.equal(segunda.duplicada, true);
  assert.equal(entorno.hojas.Cierres.datos.length, 2, 'un solo recibo');
});

test('CERRAR_TIENDA sin ventas es un error, no un recibo en blanco', () => {
  const entorno = crearEntorno();
  const r = post(entorno, { tipoOperacion: 'CERRAR_TIENDA', idsVentas: [], cierre: { idCierre: 'C1' } });
  assert.equal(r.status, 'ERROR');
  assert.equal(entorno.hojas.Cierres, undefined, 'no se creo la hoja Cierres');
});

test('GUARDAR_TIENDA crea y despues actualiza sin duplicar', () => {
  const entorno = crearEntorno();
  const alta = post(entorno, {
    tipoOperacion: 'GUARDAR_TIENDA',
    tienda: { idTienda: 'T1', nombre: 'Tienda Camila', pctComision: 30, claveHash: 'hash', activa: true }
  });
  assert.equal(alta.creada, true);

  const edicion = post(entorno, {
    tipoOperacion: 'GUARDAR_TIENDA',
    tienda: { idTienda: 'T1', pctComision: 35 }
  });
  assert.equal(edicion.actualizada, true);
  assert.equal(entorno.hojas.Tiendas.datos.length, 2);
  assert.equal(entorno.hojas.Tiendas.datos[1][1], 'Tienda Camila', 'el nombre no se pisa con undefined');
  assert.equal(entorno.hojas.Tiendas.datos[1][3], 35);
});

test('GUARDAR_EMPLEADOS da de alta y baja sin perder lo que no se manda', () => {
  const entorno = crearEntorno();
  post(entorno, {
    tipoOperacion: 'GUARDAR_EMPLEADOS',
    empleados: [{ idEmpleado: 'E1', nombre: 'Camila', idTienda: 'T1', activo: true }]
  });
  post(entorno, {
    tipoOperacion: 'GUARDAR_EMPLEADOS',
    empleados: [{ idEmpleado: 'E1', activo: false }]
  });
  const empleados = entorno.hojas.Empleados.datos;
  assert.equal(empleados.length, 2);
  assert.equal(empleados[1][1], 'Camila', 'el nombre sigue');
  assert.equal(empleados[1][3], '0', 'queda de baja');
});

test('GUARDAR_PRECIO actualiza el producto y falla si no existe', () => {
  const entorno = crearEntorno();
  post(entorno, { tipoOperacion: 'SEMBRAR_CATALOGO', productos: [{ idProducto: 'P1', marca: 'Samsung', modelo: 'Galaxy A54', precioRefUsdCents: 34000, caracteristicas: 'Pantalla AMOLED 120Hz' }] });
  const r = post(entorno, { tipoOperacion: 'GUARDAR_PRECIO', idProducto: 'P1', precioUsdCents: 35000 });
  assert.equal(r.precioUsdCents, 35000);
  assert.equal(entorno.hojas.Precios.datos[1][3], 35000);

  const r2 = post(entorno, { tipoOperacion: 'GUARDAR_PRECIO', idProducto: 'P9', precioUsdCents: 100 });
  assert.equal(r2.status, 'ERROR');
});

test('SEMBRAR_CATALOGO saltea los que ya estan y respeta el tope', () => {
  const entorno = crearEntorno();
  const primero = post(entorno, {
    tipoOperacion: 'SEMBRAR_CATALOGO',
    productos: [
      { idProducto: 'P1', modelo: 'A54', precioRefUsdCents: 34000 },
      { idProducto: 'P2', modelo: 'Note 13', precioRefUsdCents: 18500 }
    ]
  });
  assert.equal(primero.agregados, 2);
  assert.equal(primero.salteados, 0);

  const segundo = post(entorno, {
    tipoOperacion: 'SEMBRAR_CATALOGO',
    productos: [
      { idProducto: 'P1', modelo: 'A54', precioRefUsdCents: 999 },
      { idProducto: 'P3', modelo: 'iPhone 12', precioRefUsdCents: 52000 }
    ]
  });
  assert.equal(segundo.agregados, 1);
  assert.equal(segundo.salteados, 1);
  assert.equal(entorno.hojas.Precios.datos[1][3], 34000, 'el precio viejo no se pisa');

  const muchos = [];
  for (let i = 0; i < 250; i++) {
    muchos.push({ idProducto: 'X' + i, modelo: 'M' + i, precioRefUsdCents: 1000 });
  }
  const tope = post(entorno, { tipoOperacion: 'SEMBRAR_CATALOGO', productos: muchos });
  assert.equal(tope.agregados, 200, 'nunca mas de 200 por tanda');
});

test('un texto que empieza con = no se ejecuta como formula', () => {
  const entorno = crearEntorno();
  const r = post(entorno, {
    tipoOperacion: 'GUARDAR_VENTA',
    venta: Object.assign({}, VENTA, { claveIdempotencia: 'formula-clave-1', notas: '=IMPORTXML("http://x")' })
  });
  assert.equal(r.ok, true);
  const ventas = get(entorno, { action: 'REPORTE_VENTAS', key: CLAVE });
  const indiceNotas = ventas.cabeceras.indexOf('Notas');
  assert.ok(ventas.filas[0][indiceNotas].charAt(0) === "'",
    'la nota tiene que empezar con apostrofo');
});

test('el lock se libera siempre, incluso cuando la operacion falla', () => {
  const entorno = crearEntorno();
  guardarVenta(entorno);
  const antes = entorno.registro.filter((m) => m === 'release').length;
  post(entorno, { tipoOperacion: 'ELIMINAR_VENTA', idVenta: 'NO-EXISTE' });
  const despues = entorno.registro.filter((m) => m === 'release').length;
  assert.equal(despues, antes + 1);
});

test('GUARDAR_VENTA sin IdVenta es un error con mensaje, no una fila vacia', () => {
  const entorno = crearEntorno();
  const r = post(entorno, {
    tipoOperacion: 'GUARDAR_VENTA',
    venta: Object.assign({}, VENTA, { idVenta: '', claveIdempotencia: 'sin-id-clave' })
  });
  assert.equal(r.status, 'ERROR');
  assert.ok(/IdVenta/.test(r.message));
  assert.equal(entorno.hojas.Ventas.datos.length, 1, 'solo el encabezado');
});

test('generarClaveCompartida loguea una clave de 64 caracteres', () => {
  const entorno = crearEntorno();
  entorno.contexto.generarClaveCompartida();
  const conClave = entorno.registro.filter((m) => m.indexOf('SHEETS_API_KEY') === 0);
  assert.equal(conClave.length, 1);
  const valor = conClave[0].split('= ')[1];
  assert.equal(valor.length, 64);
  assert.match(valor, /^[0-9a-f]+$/);
});

test('generarClaveCompartida guarda la clave como propiedad del script', () => {
  // Si solo la loguea, el dueño tiene que copiarla a mano a Configuracion del
  // proyecto > Propiedades del script. Si se le olvida, claveEsValida() devuelve
  // false para siempre y el paso 4 del diagnostico nunca pasa.
  const entorno = crearEntorno({ clave: '' });
  entorno.contexto.generarClaveCompartida();
  const guardada = entorno.propiedades.SHEETS_API_KEY;
  assert.equal(typeof guardada, 'string');
  assert.equal(guardada.length, 64);
  assert.match(guardada, /^[0-9a-f]+$/);
  assert.equal(entorno.contexto.claveEsValida(guardada), true,
    'la clave recien generada tiene que validar contra si misma');
});

test('la clave que genera el script es la misma que valida, sin copiar a mano', () => {
  const entorno = crearEntorno({ clave: '' });
  assert.equal(entorno.contexto.claveEsValida('cualquier-cosa'), false);
  const clave = entorno.contexto.generarClaveCompartida();
  assert.equal(entorno.propiedades.SHEETS_API_KEY, clave);
  assert.equal(entorno.contexto.claveEsValida(clave), true);
});
