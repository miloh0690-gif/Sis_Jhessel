// Test de humo de public/app.js: carga el script en un DOM falso y comprueba
// que cada vista del hash se pinta sin ReferenceError. Un ReferenceError aqui es
// un boton que no funciona en el navegador y no lo caza node --check.
'use strict';
const fs = require('fs');
const vm = require('vm');
const ruta = require('path').join(__dirname, '..', 'public', 'app.js');
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
    appendChild(h) { if (h === null || h === undefined) return h; n.children.push(h); h.parentNode = n; n.firstChild = n.children[0]; return h; },
    removeChild(h) { const i = n.children.indexOf(h); if (i >= 0) n.children.splice(i, 1); n.firstChild = n.children[0] || null; return h; },
    setAttribute() {},
    addEventListener(tipo, fn) { (n._escuchas = n._escuchas || {})[tipo] = fn; },
    click() { if (n._escuchas && n._escuchas.click) n._escuchas.click({ preventDefault() {} }); },
    focus() {},
    get textContent() { return n._texto; },
    set textContent(v) { n._texto = String(v); n.children = []; },
    get value() { return n._value === undefined ? '' : n._value; },
    set value(v) { n._value = v; },
    get classList() { return { add() {}, remove() {}, contains() { return false; } }; }
  };
  return n;
}

const raiz = nodo('div');
raiz.id = 'app';
const aviso = nodo('div');
aviso.id = 'aviso';

const RADAS = ['#/login', '#/inicio', '#/nueva', '#/ventas', '#/catalogo', '#/consolidado', '#/cierre', '#/ajustes'];
let hashActual = '#/login';

const llamadas = [];
let sesionDevuelta = { rol: 'dueno', idTienda: '', nombre: 'Dueno' };

function fakeFetch(rutaUrl, opciones) {
  llamadas.push(rutaUrl);
  let cuerpo = {};
  if (/\/api\/auth\/session$/.test(rutaUrl)) {
    cuerpo = { sesion: sesionDevuelta };
  } else if (/\/api\/tiendas$/.test(rutaUrl)) {
    cuerpo = { tiendas: [{ idTienda: 'T1', nombre: 'Tienda Camila' }] };
  } else if (/\/api\/empleados$/.test(rutaUrl)) {
    cuerpo = { empleados: [{ idEmpleado: 'E1', nombre: 'Camila', idTienda: 'T1', activo: true }], tiendas: [{ idTienda: 'T1', nombre: 'Tienda Camila' }] };
  } else if (/\/api\/tc-hoy$/.test(rutaUrl)) {
    cuerpo = { tc: [{ idEmpleado: 'E1', tcDecimas: 725 }] };
  } else if (/\/api\/resumen/.test(rutaUrl)) {
    cuerpo = {
      resumen: {
        cantidadVentas: 3, unidades: 3, totalGananciaBsCents: 25375,
        totalComisionBsCents: 7613, totalNetoDuenoBsCents: 17762,
        porTienda: [{ idTienda: 'T1', tienda: 'Tienda Camila', ventas: 3, gananciaBsCents: 25375, comisionBsCents: 7613, netoDuenoBsCents: 17762 }]
      },
      tiendas: [{ idTienda: 'T1', nombre: 'Tienda Camila' }],
      ventas: [{ dia: '2026-10-08', tienda: 'Tienda Camila', vendedor: 'Camila', estado: 'CONFIRMADA', gananciaBsCents: 25375, comisionBsCents: 7613, netoDuenoBsCents: 17762 }]
    };
  } else if (/\/api\/ventas\?/.test(rutaUrl)) {
    cuerpo = { ventas: [{ dia: '2026-10-08', tienda: 'Tienda Camila', vendedor: 'Camila', estado: 'CONFIRMADA', gananciaBsCents: 25375, comisionBsCents: 7613, netoDuenoBsCents: 17762 }] };
  } else if (/\/api\/catalogo/.test(rutaUrl)) {
    cuerpo = { productos: [{ idProducto: 'P1', marca: 'Samsung', modelo: 'Galaxy A54 5G', precioRefUsdCents: 34000 }] };
  } else if (/\/api\/cierres\/preview/.test(rutaUrl)) {
    cuerpo = { cantidadVentas: 2, pendientes: 1, totalGananciaBsCents: 25375, totalComisionBsCents: 7613, totalNetoDuenoBsCents: 17762, saldoPendienteBsCents: 17762 };
  } else if (/\/api\/tc-historial/.test(rutaUrl)) {
    cuerpo = { tc: [{ dia: '2026-10-08', empleado: 'Camila', idTienda: 'T1', tcDecimas: 725 }] };
  }
  return Promise.resolve({
    ok: true,
    status: 200,
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
  isFinite,
  Promise,
  encodeURIComponent,
  setTimeout,
  clearTimeout,
  fetch: fakeFetch,
  document: {
    readyState: 'complete',
    getElementById(id) { return id === 'app' ? raiz : (id === 'aviso' ? aviso : nodo('div')); },
    createElement: nodo,
    createTextNode(t) { const n = nodo('#text'); n._texto = String(t); return n; },
    addEventListener() {}
  }
};
contexto.window = contexto;
contexto.location = {
  get hash() { return hashActual; },
  set hash(v) {
    if (hashActual === v) return;
    hashActual = v;
    if (contexto.__hashchange) setTimeout(() => contexto.__hashchange(), 0);
  }
};
contexto.window.addEventListener = function (tipo, fn) { if (tipo === 'hashchange') contexto.__hashchange = fn; };

vm.createContext(contexto);
try {
  vm.runInContext(fuente, contexto, { filename: 'app.js' });
} catch (e) {
  console.log('FALLA AL CARGAR app.js -> ' + e.message);
  process.exit(1);
}

const test = require('node:test');
const assert = require('node:assert/strict');

function asserts() { return new Promise(r => setTimeout(r, 60)); }

test('cada vista del hash se pinta sin ReferenceError', async () => {
  for (const hash of RADAS) {
    if (hash === '#/login') continue;
    hashActual = hash;
    raiz.children = [];
    raiz.firstChild = null;
    raiz._texto = '';
    contexto.__hashchange();
    await asserts();
    assert.ok(raiz.children.length > 0, hash + ' no se pinto nada');
  }
});

test('sin sesion, entrar a cualquier vista lleva al formulario de login', async () => {
  sesionDevuelta = null;
  hashActual = '#/inicio';
  raiz.children = [];
  contexto.__hashchange();
  await asserts();
  assert.equal(hashActual, '#/login');
  assert.ok(raiz.children.length > 0);
});

test('un encargado en #/consolidado no recibe datos de las 4 tiendas', async () => {
  sesionDevuelta = { rol: 'tienda', idTienda: 'T1', nombre: 'Camila' };
  const antes = llamadas.length;
  hashActual = '#/consolidado';
  raiz.children = [];
  contexto.__hashchange();
  await asserts();
  const datos = llamadas.slice(antes)
    .filter(u => /resumen|ventas|cierres|empleados|catalogo/.test(u));
  assert.deepEqual(datos, []);
});
