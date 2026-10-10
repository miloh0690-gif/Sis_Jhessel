'use strict';

require('dotenv').config();

const path = require('node:path');
const express = require('express');

const auth = require('./src/auth');
const ledger = require('./src/ledger');
const sheets = require('./src/sheets');
const money = require('./src/money');
const ventas = require('./src/ventas');
const cierres = require('./src/cierres');
const catalogo = require('./src/catalogo');

const app = express();
const PUERTO = Number(process.env.PORT) || 10000;
const VERSION = 1;

const CAMPOS_DE_COSTO = [
  'gananciaUsdCents',
  'gananciaBrutaUsdCents',
  'gananciaNetaUsdCents',
  'ajusteUsdCents',
  'ajustesUsdCents',
  'costoTotalUsdCents',
  'costoTotalBsCents'
];

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

// --- cabeceras -------------------------------------------------------------
app.use(function (req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

// --- rate limit ------------------------------------------------------------
const golpes = new Map();
const VENTANA_MS = 60 * 1000;

function limitar(tope, ventanaMs) {
  return function (req, res, next) {
    const ahora = Date.now();
    const clave = req.ip || 'desconocido';
    const previos = golpes.get(clave) || [];
    const vivos = previos.filter(function (t) { return ahora - t < ventanaMs; });
    if (vivos.length >= tope) {
      golpes.set(clave, vivos);
      res.status(429).json({ error: 'Demasiadas peticiones seguidas. Espera un momento.' });
      return;
    }
    vivos.push(ahora);
    golpes.set(clave, vivos);
    next();
  };
}

setInterval(function () {
  const ahora = Date.now();
  for (const [clave, tiempos] of golpes.entries()) {
    const vivos = tiempos.filter(function (t) { return ahora - t < VENTANA_MS; });
    if (vivos.length === 0) golpes.delete(clave);
    else golpes.set(clave, vivos);
  }
}, 5 * 60 * 1000).unref();

// --- validacion ------------------------------------------------------------
function texto(valor, maximo) {
  return String(valor === undefined || valor === null ? '' : valor)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, maximo || 200);
}

function entero(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? Math.floor(numero) : 0;
}

function fecha(valor) {
  const limpio = texto(valor, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(limpio) ? limpio : '';
}

function hoyIso() {
  return new Date().toISOString().slice(0, 10);
}

function responderError(res, e) {
  const codigo = Number(e && e.codigo) >= 400 && Number(e && e.codigo) < 600 ? Number(e.codigo) : 500;
  if (codigo >= 500) console.error('[error]', (e && e.stack) || e);
  if (res.headersSent) return;
  const mensaje = codigo === 500 ? 'Error interno del servidor.' : texto(e.message, 300);
  res.status(codigo).json({ error: mensaje || 'Error interno del servidor.' });
}

// `auth.esDueno` recibe el request completo (lee `req.sesion`); pasarle la
// sesion a mano hacia que todo se tratara como tienda y el dueno perdia
// los cierres, el costo y las anulaciones.
function esDueno(req) {
  return auth.esDueno(req);
}

function exigirDueno(req, res, next) {
  if (esDueno(req)) {
    next();
    return;
  }
  // Nunca 403: no confirmamos que el recurso exista.
  res.status(404).json({ error: 'No se encontro el recurso.' });
}

// El idTienda sale SIEMPRE de la sesion. El cliente puede pedir otra tienda
// en la query solo si es el dueno.
function tiendaDeLaPeticion(req) {
  const sesion = req.sesion || {};
  const pedida = texto(req.query && (req.query.tienda || req.query.idTienda), 40);
  const propia = texto(sesion.idTienda, 40);
  if (auth.esDueno(sesion)) return pedida || propia;
  return propia;
}

function sinCosto(objeto, esDueño) {
  if (esDueño || !objeto || typeof objeto !== 'object') return objeto;
  for (const campo of CAMPOS_DE_COSTO) delete objeto[campo];
  if (Array.isArray(objeto.lineas)) {
    for (const linea of objeto.lineas) delete linea.costoUnitarioUsdCents;
  }
  return objeto;
}

function limpiarVentas(lista, esDueño) {
  return (Array.isArray(lista) ? lista : []).map(function (venta) {
    return sinCosto(venta, esDueño);
  });
}

// --- salud y diagnostico ---------------------------------------------------
app.get('/api/health', function (req, res) {
  res.json({
    ok: true,
    version: VERSION,
    hora: new Date().toISOString(),
    hojas: sheets.completo()
  });
});

app.get('/api/diagnostico', async function (req, res) {
  try {
    res.json(await sheets.diagnostico());
  } catch (e) {
    responderError(res, e);
  }
});

// --- tiendas para la pantalla de login (publico, sin hashes) ---------------
app.get('/api/tiendas', async function (req, res) {
  try {
    const tiendas = await ledger.listarTiendas();
    res.json({
      tiendas: tiendas.map(function (t) {
        return { idTienda: t.idTienda, nombre: t.nombre, activa: t.activa };
      })
    });
  } catch (e) {
    responderError(res, e);
  }
});

// --- login -----------------------------------------------------------------
const AVISO_LOGIN = 'Contrasena incorrecta.';

app.post('/api/auth/login', limitar(10, 60000), async function (req, res) {
  const cuerpo = req.body || {};
  const clave = String(cuerpo.clave === undefined || cuerpo.clave === null ? '' : cuerpo.clave);
  const quiereDueño = cuerpo.dueno === true || texto(cuerpo.rol, 10).toLowerCase() === 'dueno';

  if (!clave) {
    res.status(400).json({ error: 'Falta la contrasena.' });
    return;
  }

  try {
    if (quiereDueño) {
      const guardada = String(process.env.DUENO_PIN_HASH || '');
      if (!guardada || !auth.verificarClave(clave, guardada)) {
        res.status(401).json({ error: AVISO_LOGIN });
        return;
      }
      const token = auth.crearToken({ rol: auth.ROL_DUENO, idTienda: '', idEmpleado: '', nombre: 'Dueno' });
      res.setHeader('Set-Cookie', auth.crearCookie(token));
      res.json({ rol: auth.ROL_DUENO, nombre: 'Dueno' });
      return;
    }

    const idTienda = texto(cuerpo.idTienda, 40);
    if (!idTienda) {
      res.status(400).json({ error: 'Falta indicar la tienda.' });
      return;
    }
    const tiendas = await ledger.listarTiendas();
    const tienda = tiendas.find(function (t) { return t.idTienda === idTienda; });
    // Mismo 401 si la tienda no existe, esta inactiva o la clave esta mal: no
    // revelamos cuales son los accesos validos.
    if (!tienda || tienda.activa !== true || !tienda.claveHash) {
      res.status(401).json({ error: AVISO_LOGIN });
      return;
    }
    if (!auth.verificarClave(clave, tienda.claveHash)) {
      res.status(401).json({ error: AVISO_LOGIN });
      return;
    }
    const token = auth.crearToken({
      rol: auth.ROL_TIENDA,
      idTienda: tienda.idTienda,
      idEmpleado: texto(cuerpo.idEmpleado, 40),
      nombre: tienda.nombre
    });
    res.setHeader('Set-Cookie', auth.crearCookie(token));
    res.json({ rol: auth.ROL_TIENDA, idTienda: tienda.idTienda, nombre: tienda.nombre });
  } catch (e) {
    responderError(res, e);
  }
});

app.post('/api/auth/logout', function (req, res) {
  res.setHeader('Set-Cookie', auth.borrarCookie());
  res.json({ ok: true });
});

app.get('/api/auth/session', function (req, res) {
  // Esta ruta va ANTES del middleware de sesion, asi que la carga se lee
  // directo de la cookie: responder 401 aca haria que el navegador no
  // supiera si su sesion vencio o si nunca la tuvo.
  const carga = auth.sesion(req);
  const sesion = carga
    ? {
      rol: carga.rol,
      idTienda: carga.idTienda,
      idEmpleado: carga.idEmpleado,
      nombre: carga.nombre,
      dueno: auth.esDueno({ sesion: { rol: carga.rol } })
    }
    : null;
  if (!sesion) {
    res.json({ sesion: null });
    return;
  }
  res.json({ sesion: sesion });
});

// --- todo lo demas exige sesion -------------------------------------------
app.use('/api', auth.exigirSesion);

// --- empleados y tipo de cambio ------------------------------------------
app.get('/api/empleados', async function (req, res) {
  try {
    const todos = await ledger.listarEmpleados();
    const tienda = tiendaDeLaPeticion(req);
    const lista = esDueno(req) && !tienda ? todos : todos.filter(function (e) {
      return e.idTienda === tienda;
    });
    res.json({ empleados: lista });
  } catch (e) {
    responderError(res, e);
  }
});

app.get('/api/tc-hoy', async function (req, res) {
  try {
    const dia = fecha(req.query && req.query.fecha) || hoyIso();
    const tienda = tiendaDeLaPeticion(req);
    const pedido = texto(req.query && req.query.empleado, 40);
    let registros = await ledger.listarTc({ desde: dia, hasta: dia });
    if (tienda) {
      registros = registros.filter(function (r) { return r.idTienda === tienda; });
    }
    if (pedido) {
      registros = registros.filter(function (r) { return r.idEmpleado === pedido; });
    }
    res.json({ fecha: dia, registros: registros, tc: registros.length ? registros[0] : null });
  } catch (e) {
    responderError(res, e);
  }
});

app.get('/api/tc-historial', exigirDueno, async function (req, res) {
  try {
    const desde = fecha(req.query && req.query.desde);
    const hasta = fecha(req.query && req.query.hasta);
    const registros = await ledger.listarTc({ desde: desde, hasta: hasta });
    res.json({ registros: registros });
  } catch (e) {
    responderError(res, e);
  }
});

// --- consolidado -----------------------------------------------------------
app.get('/api/resumen', async function (req, res) {
  try {
    const desde = fecha(req.query && req.query.desde);
    const hasta = fecha(req.query && req.query.hasta);
    const tienda = tiendaDeLaPeticion(req);
    const datos = await ledger.consolidar({ desde: desde, hasta: hasta, idTienda: tienda });
    res.json({
      resumen: datos.resumen,
      tiendas: datos.tiendas.map(function (t) {
        return { idTienda: t.idTienda, nombre: t.nombre, pctComision: t.pctComision, activa: t.activa };
      }),
      ventas: limpiarVentas(datos.ventas, esDueno(req))
    });
  } catch (e) {
    responderError(res, e);
  }
});

// --- ventas ----------------------------------------------------------------
app.get('/api/ventas', async function (req, res) {
  try {
    const desde = fecha(req.query && req.query.desde);
    const hasta = fecha(req.query && req.query.hasta);
    const tienda = tiendaDeLaPeticion(req);
    const estado = texto(req.query && req.query.estado, 20).toUpperCase();
    let lista = await ledger.listarVentas({ desde: desde, hasta: hasta, idTienda: tienda });
    if (estado) {
      lista = lista.filter(function (v) { return texto(v.estado).toUpperCase() === estado; });
    }
    res.json({ ventas: limpiarVentas(lista, esDueno(req)) });
  } catch (e) {
    responderError(res, e);
  }
});

app.get('/api/ventas/:id/lineas', async function (req, res) {
  try {
    const idVenta = texto(req.params.id, 60);
    const linea = await ventas.listarLineasDe(idVenta);
    res.json({ lineas: limpiarVentas(linea, esDueno(req)) });
  } catch (e) {
    responderError(res, e);
  }
});

app.post('/api/ventas/preview', async function (req, res) {
  try {
    const preparado = await ventas.preparar({ sesion: req.sesion, cuerpo: req.body || {} });
    const venta = sinCosto(Object.assign({}, preparado.venta), esDueno(req));
    res.json({ venta: venta, lineas: venta.lineas || [] });
  } catch (e) {
    responderError(res, e);
  }
});

app.post('/api/ventas', async function (req, res) {
  try {
    const cuerpo = req.body || {};
    const clave = texto(cuerpo.claveIdempotencia || cuerpo.clave, 64);
    const r = await ventas.guardar({ sesion: req.sesion, cuerpo: cuerpo, clave: clave });
    res.status(200).json({
      venta: sinCosto(Object.assign({}, r.venta), esDueno(req)),
      repetida: r.repetida === true
    });
  } catch (e) {
    responderError(res, e);
  }
});

app.post('/api/ventas/:id', async function (req, res) {
  try {
    const r = await ventas.actualizarVenta({
      sesion: req.sesion,
      idVenta: texto(req.params.id, 60),
      cuerpo: req.body || {}
    });
    res.json({ venta: sinCosto(Object.assign({}, r.venta || {}), esDueno(req)) });
  } catch (e) {
    responderError(res, e);
  }
});

app.post('/api/ventas/:id/estado', async function (req, res) {
  try {
    const cuerpo = req.body || {};
    const r = await ventas.cambiarEstado({
      sesion: req.sesion,
      idVenta: texto(req.params.id, 60),
      hasta: texto(cuerpo.hasta || cuerpo.estado, 20).toUpperCase(),
      motivo: texto(cuerpo.motivo, 300)
    });
    res.json({ venta: sinCosto(Object.assign({}, r.venta || {}), esDueno(req)) });
  } catch (e) {
    responderError(res, e);
  }
});

app.post('/api/ventas/:id/eliminar', async function (req, res) {
  try {
    const r = await ventas.eliminarVenta({ sesion: req.sesion, idVenta: texto(req.params.id, 60) });
    res.json({ ok: true, eliminado: r && r.eliminado !== false });
  } catch (e) {
    responderError(res, e);
  }
});

// --- catalogo --------------------------------------------------------------
app.get('/api/catalogo', async function (req, res) {
  try {
    const busqueda = texto(req.query && req.query.q, 120);
    const limite = entero(req.query && req.query.limite) || 30;
    const productos = await catalogo.buscar(busqueda, { limite: limite });
    res.json({ productos: productos });
  } catch (e) {
    responderError(res, e);
  }
});

app.get('/api/catalogo/:id/precio-sugerido', async function (req, res) {
  try {
    const query = req.query || {};
    const r = await catalogo.precioSugerido({
      idProducto: texto(req.params.id, 60),
      moneda: texto(query.moneda, 4).toUpperCase(),
      tcDecimas: money.tcADecimas(query.tc)
    });
    if (!r) {
      res.status(404).json({ error: 'No se encontro el recurso.' });
      return;
    }
    res.json(r);
  } catch (e) {
    responderError(res, e);
  }
});

app.post('/api/ventas/precio-sugerido', async function (req, res) {
  try {
    const cuerpo = req.body || {};
    const r = await catalogo.precioSugerido({
      idProducto: texto(cuerpo.idProducto, 60),
      moneda: texto(cuerpo.moneda, 4).toUpperCase(),
      tcDecimas: money.tcADecimas(cuerpo.tcDecimas !== undefined ? cuerpo.tcDecimas : cuerpo.tc)
    });
    if (!r) {
      res.status(404).json({ error: 'No se encontro el recurso.' });
      return;
    }
    res.json(r);
  } catch (e) {
    responderError(res, e);
  }
});

app.post('/api/catalogo/:id/precio', async function (req, res) {
  try {
    const cuerpo = req.body || {};
    const idProducto = texto(req.params.id, 60);
    if (!idProducto) {
      res.status(400).json({ error: 'Falta indicar el producto.' });
      return;
    }
    const precio = entero(cuerpo.precioUsdCents !== undefined ? cuerpo.precioUsdCents : cuerpo.precioUsd);
    await catalogo.guardarPrecio(idProducto, precio);
    res.json({ ok: true, idProducto: idProducto, precioUsdCents: precio });
  } catch (e) {
    responderError(res, e);
  }
});

// --- cierres ---------------------------------------------------------------
app.get('/api/cierres/preview', exigirDueno, async function (req, res) {
  try {
    const query = req.query || {};
    const vista = await cierres.previsualizar({
      idTienda: texto(query.tienda || query.idTienda, 40),
      dia: texto(query.dia, 10)
    });
    res.json({ vista: Object.assign({}, vista, { ventas: limpiarVentas(vista.ventas, true) }) });
  } catch (e) {
    responderError(res, e);
  }
});

app.post('/api/cierres/preview', exigirDueno, async function (req, res) {
  try {
    const cuerpo = req.body || {};
    const vista = await cierres.previsualizar({
      idTienda: texto(cuerpo.idTienda, 40),
      dia: texto(cuerpo.dia, 10)
    });
    res.json({ vista: Object.assign({}, vista, { ventas: limpiarVentas(vista.ventas, true) }) });
  } catch (e) {
    responderError(res, e);
  }
});

app.get('/api/cierres', exigirDueno, async function (req, res) {
  try {
    const query = req.query || {};
    const cierresListados = await ledger.listarCierres({
      idTienda: texto(query.tienda, 40),
      desde: fecha(query.desde),
      hasta: fecha(query.hasta)
    });
    res.json({ cierres: cierresListados });
  } catch (e) {
    responderError(res, e);
  }
});

app.post('/api/cierres', exigirDueno, async function (req, res) {
  try {
    const cuerpo = req.body || {};
    const r = await cierres.cerrar({
      sesion: req.sesion,
      idTienda: texto(cuerpo.idTienda, 40),
      dia: texto(cuerpo.dia, 10),
      pagadoBsCents: cuerpo.pagadoBsCents !== undefined ? cuerpo.pagadoBsCents : cuerpo.pagado
    });
    res.json({ cierre: r.cierre, ventasCerradas: r.ventasCerradas, repetida: r.repetida === true });
  } catch (e) {
    responderError(res, e);
  }
});

// --- ajustes del dueno -----------------------------------------------------
app.post('/api/ajustes/tienda/:id', exigirDueno, async function (req, res) {
  try {
    const cuerpo = req.body || {};
    const idTienda = texto(req.params.id, 40);
    if (!idTienda) {
      res.status(400).json({ error: 'Falta indicar la tienda.' });
      return;
    }
    const resultado = await sheets.escribir({
      tipoOperacion: 'GUARDAR_TIENDA',
      tienda: {
        idTienda: idTienda,
        nombre: texto(cuerpo.nombre, 80),
        pctComision: entero(cuerpo.pctComision !== undefined ? cuerpo.pctComision : cuerpo.comision),
        activa: cuerpo.activa === undefined ? undefined : cuerpo.activa === true,
        claveHash: cuerpo.claveHash !== undefined ? texto(cuerpo.claveHash, 200) : undefined,
        creadoPor: texto(req.sesion.nombre, 80)
      }
    });
    res.json({ ok: true, tienda: resultado });
  } catch (e) {
    responderError(res, e);
  }
});

app.post('/api/ajustes/empleados', exigirDueno, async function (req, res) {
  try {
    const cuerpo = req.body || {};
    const lista = Array.isArray(cuerpo.empleados) ? cuerpo.empleados : [];
    if (lista.length === 0) {
      res.status(400).json({ error: 'Falta indicar el empleado.' });
      return;
    }
    const empleados = lista.map(function (e) {
      return {
        idEmpleado: texto(e.idEmpleado, 60),
        nombre: texto(e.nombre, 80),
        idTienda: texto(e.idTienda, 40),
        activo: e.activo === undefined ? true : e.activo === true
      };
    });
    const resultado = await sheets.escribir({
      tipoOperacion: 'GUARDAR_EMPLEADOS',
      empleados: empleados,
      creadoPor: texto(req.sesion.nombre, 80)
    });
    res.json({ ok: true, empleados: empleados.length, resultado: resultado });
  } catch (e) {
    responderError(res, e);
  }
});

// --- frontend y errores ----------------------------------------------------
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

app.use(function (req, res, next) {
  if (req.path.indexOf('/api/') === 0) {
    res.status(404).json({ error: 'No se encontro el recurso.' });
    return;
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// eslint-disable-next-line no-unused-vars
app.use(function (err, req, res, next) {
  if (err && err.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'El cuerpo de la peticion no es JSON valido.' });
    return;
  }
  if (err && err.type === 'entity.too.large') {
    res.status(413).json({ error: 'La peticion es demasiado grande.' });
    return;
  }
  responderError(res, err || new Error('Error desconocido.'));
});

// --- arranque --------------------------------------------------------------
if (require.main === module) {
  app.listen(PUERTO, '0.0.0.0', function () {
    console.log('Sis Jhessel escuchando en el puerto ' + PUERTO);
    if (!process.env.SESSION_SECRET) {
      console.warn('AVISO: falta SESSION_SECRET. Las sesiones no se podran firmar de forma estable.');
    }
    if (!sheets.completo()) {
      console.warn('AVISO: faltan SHEETS_WEBAPP_URL o SHEETS_API_KEY. La hoja no esta conectada.');
    }
  });
}

module.exports = { app, esDueno, tiendaDeLaPeticion, sinCosto, texto, entero, fecha, limitar, CAMPOS_DE_COSTO };
