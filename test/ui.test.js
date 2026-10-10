// Prueba de humo de public/app.js: carga el script en un DOM falso y comprueba
// que cada vista del hash se pinta sin ReferenceError. Un ReferenceError aqui es
// un boton que no funciona en el navegador y no lo caza node --check.
//
// El DOM falso tiene que tener los mismos ids que public/index.html, porque la
// pantalla los busca por id. Si index.html y esta lista se separan, la prueba
// sigue verde mientras el boton no existe: ese es el fallo que tapa.
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ruta = path.join(__dirname, '..', 'public', 'app.js');
const fuente = fs.readFileSync(ruta, 'utf8');

function nodo(etiqueta) {
  const n = {
    tagName: etiqueta,
    nodeType: 1,
    className: '',
    children: [],
    firstChild: null,
    hidden: false,
    style: {},
    _texto: '',
    _value: '',
    appendChild(h) { if (h === null || h === undefined) return h; n.children.push(h); h.parentNode = n; n.firstChild = n.children[0]; return h; },
    removeChild(h) { const i = n.children.indexOf(h); if (i >= 0) n.children.splice(i, 1); n.firstChild = n.children[0] || null; return h; },
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener(tipo, fn) { (n._escuchas = n._escuchas || {})[tipo] = fn; },
    removeEventListener() {},
    click() { if (n._escuchas && n._escuchas.click) n._escuchas.click({ preventDefault() {}, target: n }); },
    focus() {},
    scrollIntoView() {},
    get textContent() { return n._texto; },
    set textContent(v) { n._texto = String(v); n.children = []; },
    get value() { return n._value; },
    set value(v) { n._value = v; },
    get classList() {
      return {
        add() { n._clases = (n._clases || []); },
        remove() {},
        contains() { return false; }
      };
    }
  };
  return n;
}

// Los ids que app.js busca. Si se agrega uno nuevo al html hay que agregarlo
// aqui, y si falta uno la pantalla no lo encuentra.
const IDS = [
  'pantalla-login', 'pantalla-app', 'barra-pestanas', 'pestanas', 'contenido',
  'rotulo-tienda', 'rotulo-rol', 'boton-salir', 'boton-dueno', 'lista-tiendas',
  'caja-error-login', 'capa-modal'
];

const porId = {};
IDS.forEach(function (id) {
  const n = nodo('div');
  n.id = id;
  porId[id] = n;
});
// El aviso lleva una caja adentro, como en el html: el script la busca con
// firstChild y le cambia la clase.
const aviso = nodo('div');
aviso.id = 'aviso';
aviso.appendChild(nodo('div'));
porId.aviso = aviso;

const RADAS = [
  '#/login', '#/inicio', '#/vender', '#/ventas', '#/precios',
  '#/dueno', '#/tienda/T1', '#/cierre/T1', '#/ajustes'
];
const TIENDAS = [
  { idTienda: 'T1', nombre: 'Tienda Camila', empleados: 'Camila', pctComision: 30 },
  { idTienda: 'T2', nombre: 'Tienda Andre', empleados: 'Andre', pctComision: 25 },
  { idTienda: 'T3', nombre: 'Tienda Miros', empleados: 'Miros', pctComision: 30 },
  { idTienda: 'T4', nombre: 'Tienda Didi y Micky', empleados: 'Didi, Micky', pctComision: 30 }
];

let hashActual = '#/login';
const llamadas = [];
const peticiones = [];
let sesionDevuelta = { rol: 'dueno', idTienda: '', nombre: 'Dueno' };

const VENTA = {
  dia: '2026-10-08', idTienda: 'T1', tienda: 'Tienda Camila', vendedor: 'Camila',
  estado: 'CONFIRMADA', tcDecimas: 725, gananciaBsCents: 25375,
  comisionBsCents: 7613, netoDuenoBsCents: 17762
};

function fakeFetch(rutaUrl, opciones) {
  llamadas.push(rutaUrl);
  peticiones.push({ ruta: rutaUrl, metodo: (opciones && opciones.method) || 'GET' });
  let cuerpo = {};
  if (/\/api\/auth\/session$/.test(rutaUrl)) {
    cuerpo = { sesion: sesionDevuelta };
  } else if (/\/api\/tiendas$/.test(rutaUrl)) {
    cuerpo = { tiendas: TIENDAS };
  } else if (/\/api\/empleados$/.test(rutaUrl)) {
    cuerpo = {
      empleados: [
        { idEmpleado: 'E1', nombre: 'Camila', idTienda: 'T1', activo: true },
        { idEmpleado: 'E2', nombre: 'Didi', idTienda: 'T4', activo: true },
        { idEmpleado: 'E3', nombre: 'Micky', idTienda: 'T4', activo: true }
      ]
    };
  } else if (/\/api\/tc-hoy$/.test(rutaUrl)) {
    cuerpo = { tcs: [{ idEmpleado: 'E1', empleado: 'Camila', idTienda: 'T1', tcDecimas: 725 }] };
  } else if (/\/api\/resumen/.test(rutaUrl)) {
    cuerpo = {
      resumen: {
        cantidadVentas: 3, unidades: 3, totalGananciaBsCents: 25375,
        totalComisionBsCents: 7613, totalNetoDuenoBsCents: 17762,
        porTienda: TIENDAS.map(function (t) {
          return {
            idTienda: t.idTienda, tienda: t.nombre, cantidadVentas: 1, unidades: 1,
            gananciaBsCents: 25375, comisionBsCents: 7613, netoDuenoBsCents: 17762
          };
        })
      },
      tiendas: TIENDAS,
      ventas: [VENTA]
    };
  } else if (/\/api\/ventas\?/.test(rutaUrl)) {
    cuerpo = { ventas: [VENTA] };
  } else if (/\/api\/catalogo/.test(rutaUrl)) {
    cuerpo = {
      productos: [{
        idProducto: 'P1', marca: 'Samsung', modelo: 'Galaxy A54 5G',
        precioRefUsdCents: 34000, caracteristicas: 'Pantalla AMOLED', imagen: 'https://x/a.jpg'
      }]
    };
  } else if (/\/api\/cierres\/preview/.test(rutaUrl)) {
    cuerpo = {
      vista: {
        tienda: 'Tienda Camila', dia: '2026-10-10', cantidadVentas: 2, pendientes: 1,
        ventas: [VENTA], totalGananciaBsCents: 25375, totalComisionBsCents: 7613,
        totalNetoDuenoBsCents: 17762, saldoPendienteBsCents: 17762
      }
    };
  } else if (/\/api\/ventas\/preview/.test(rutaUrl)) {
    cuerpo = {
      venta: {
        gananciaNetaUsdCents: 3500, gananciaBsCents: 25375,
        comisionBsCents: 7613, netoDuenoBsCents: 17762
      }
    };
  }
  return Promise.resolve({
    ok: true,
    status: 200,
    json: function () { return Promise.resolve(cuerpo); },
    text: function () { return Promise.resolve(JSON.stringify(cuerpo)); }
  });
}

const contexto = {
  console,
  Intl,
  Math,
  Date,
  JSON,
  Number,
  String,
  Object,
  Array,
  Error,
  isFinite,
  Promise,
  encodeURIComponent,
  setTimeout,
  clearTimeout,
  prompt: function () { return 'clave-de-prueba'; },
  fetch: fakeFetch,
  document: {
    readyState: 'complete',
    getElementById(id) { return porId[id] || (function () { const n = nodo('div'); n.id = id; porId[id] = n; return n; })(); },
    createElement: nodo,
    createTextNode(t) { const n = nodo('#text'); n._texto = String(t); return n; },
    addEventListener() {}
  }
};
contexto.window = contexto;
contexto.window.scrollTo = function () {};
contexto.window.addEventListener = function (tipo, fn) { if (tipo === 'hashchange') contexto.__hashchange = fn; };
contexto.location = {
  get hash() { return hashActual; },
  set hash(v) {
    if (hashActual === v) return;
    hashActual = v;
    if (contexto.__hashchange) setTimeout(() => contexto.__hashchange(), 0);
  }
};

vm.createContext(contexto);
try {
  vm.runInContext(fuente, contexto, { filename: 'app.js' });
} catch (e) {
  console.log('FALLA AL CARGAR app.js -> ' + e.message);
  process.exit(1);
}

const test = require('node:test');
const assert = require('node:assert/strict');

function asentar() { return new Promise(function (r) { setTimeout(r, 70); }); }

function limpiarPantalla() {
  porId.contenido.children = [];
  porId.contenido.firstChild = null;
  porId.contenido._texto = '';
}

test('cada vista del hash se pinta sin ReferenceError', async () => {
  sesionDevuelta = { rol: 'dueno', idTienda: '', nombre: 'Dueno' };
  for (const hash of RADAS) {
    if (hash === '#/login') continue;
    hashActual = hash;
    limpiarPantalla();
    contexto.__hashchange();
    await asentar();
    assert.ok(porId.contenido.children.length > 0, hash + ' no se pinto nada');
  }
});

test('sin sesion, entrar a cualquier vista lleva al formulario de login', async () => {
  sesionDevuelta = null;
  hashActual = '#/inicio';
  limpiarPantalla();
  contexto.__hashchange();
  await asentar();
  assert.equal(hashActual, '#/login');
});

test('un encargado en una pantalla del dueno no pide datos de las cuatro tiendas', async () => {
  sesionDevuelta = { rol: 'tienda', idTienda: 'T1', nombre: 'Camila' };
  const antes = llamadas.length;
  hashActual = '#/dueno';
  limpiarPantalla();
  contexto.__hashchange();
  await asentar();
  assert.equal(hashActual, '#/inicio', 'lo devolvio a su propia pantalla');
  // /api/resumen si se puede pedir: la pantalla de inicio lo usa y el
  // servidor ya lo limita a la tienda de la sesion. Lo que un encargado no
  // puede tocar son las pantallas del dueno.
  const datos = llamadas.slice(antes).filter(function (u) {
    return /\/api\/(cierres|ajustes|tc-historial)/.test(u);
  });
  assert.deepEqual(datos, []);
});

test('las cuatro tiendas son cuatro pestanas y el dueño tiene la suya', async () => {
  sesionDevuelta = { rol: 'dueno', idTienda: '', nombre: 'Dueno' };
  hashActual = '#/dueno';
  limpiarPantalla();
  contexto.__hashchange();
  await asentar();
  const enlaces = porId.pestanas.children.filter(function (n) { return n.tagName === 'a'; });
  assert.equal(enlaces.length, 5, 'son cuatro tiendas mas la del dueño');
  const textos = enlaces.map(function (a) { return a.children[1]._texto; });
  assert.deepEqual(textos, ['Tienda Camila', 'Tienda Andre', 'Tienda Miros', 'Tienda Didi y Micky', 'Dueño']);
});

test('el encargado no ve pestanas de otras tiendas', async () => {
  sesionDevuelta = { rol: 'tienda', idTienda: 'T4', nombre: 'Micky' };
  hashActual = '#/inicio';
  limpiarPantalla();
  contexto.__hashchange();
  await asentar();
  const textos = porId.pestanas.children.map(function (a) { return a.children[1]._texto; });
  assert.deepEqual(textos, ['Inicio', 'Vender', 'Ventas', 'Precios']);
  assert.equal(porId['rotulo-tienda']._texto, 'Tienda Didi y Micky');
});

// Rutas que el servidor solo expone como GET. Un POST a cualquiera de ellas
// cae en el middleware de sesion y vuelve 401; y POST /api/ventas?desde=..
// crea una venta de verdad.
const SOLO_LECTURA = [
  /^\/api\/tiendas$/,
  /^\/api\/auth\/session$/,
  /^\/api\/auth\/logout$/,
  /^\/api\/empleados$/,
  /^\/api\/tc-hoy$/,
  /^\/api\/tc-historial/,
  /^\/api\/resumen/,
  /^\/api\/ventas\/precio-sugerido$/,
  /^\/api\/ventas\?/,
  /^\/api\/ventas$/
];

test('ninguna vista pide por POST una ruta que el servidor solo expone como GET', async () => {
  const vistas = RADAS.filter(function (h) { return h !== '#/login'; });
  for (const rol of [
    { rol: 'dueno', idTienda: '', nombre: 'Dueno' },
    { rol: 'tienda', idTienda: 'T1', nombre: 'Camila' }
  ]) {
    sesionDevuelta = rol;
    for (const hash of vistas) {
      const antes = peticiones.length;
      hashActual = hash;
      limpiarPantalla();
      contexto.__hashchange();
      await asentar();
      const malas = peticiones.slice(antes)
        .filter(function (p) { return p.metodo === 'POST'; })
        .filter(function (p) { return SOLO_LECTURA.some(function (patron) { return patron.test(p.ruta); }); })
        .map(function (p) { return p.metodo + ' ' + p.ruta; });
      assert.deepEqual(malas, [], rol.rol + ' en ' + hash + ' mando POST a rutas de lectura');
    }
  }
});

test('la lista de tiendas se pide con GET y nunca con POST', async () => {
  sesionDevuelta = null;
  hashActual = '#/login';
  limpiarPantalla();
  contexto.__hashchange();
  await asentar();
  // El arreglo de las cuatro tiendas se pide una vez y se queda en memoria,
  // asi que en la segunda pasada no vuelve a salir. Lo que importa es que
  // cuando salio, salio como GET: con POST el servidor lo corta con 405 y
  // la pantalla de entrada se queda vacia sin decir por que.
  const tiendas = peticiones.filter(function (p) { return /\/api\/tiendas$/.test(p.ruta); });
  assert.ok(tiendas.length > 0, 'la entrada no pidio las tiendas ninguna vez');
  assert.deepEqual(tiendas.map(function (p) { return p.metodo; }), tiendas.map(function () { return 'GET'; }));
  assert.ok(porId['lista-tiendas'].children.length > 0, 'no se pintaron las tiendas de entrada');
});