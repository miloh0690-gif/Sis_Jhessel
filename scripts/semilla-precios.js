'use strict';

// =================================================================
// Arma la semilla de la hoja Precios de Sis Jhessel: precios
// referenciales + caracteristicas. NO es inventario.
//
//   npm run semilla            solo arma datos/semilla-precios.json
//   npm run semilla -- --subir ademas lo manda a la hoja Precios
//   npm run semilla -- --forzar vuelve a preguntar a la API lo que fallo
//
// Que hace: recorre el indice de fichas de Sis_Zamir (89 modelos que el
// vendedor ya tiene fichados), le pregunta a una API publica de
// especificaciones por las caracteristicas REALES de cada aparato, y arma
// un JSON con una fila por producto. Los precios quedan en 0 a proposito:
// son referenciales y cambian cada semana, los pone el encargado.
//
// Que NO hace, y por que: no inventa ni completa specs. Si la API no
// encuentra el modelo, la caracteristica queda vacia y el modelo aparece
// en el reporte de fallidos. Un celular con la pantalla inventada es peor
// que un celular sin pantalla.
//
// De donde sale cada campo:
//   idProducto     marca + modelo normalizados, igual que el buscador
//   marca/modelo   como los escribe el vendedor, capitalizados
//   precioRefUsdCents  0, lo pone el dueno o el encargado
//   caracteristicas    texto plano, una caracteristica por linea, sacada de
//                      Display / Platform / Memory / Main Camera / Battery /
//                      Network / Body / Launch de la API
//   imagen         URL de la foto del aparato, para el buscador
// =================================================================

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');

const sheets = require('../src/sheets');

const API = 'https://mobile-specs-api-sandy.vercel.app/phone?name=';
const ORIGEN_POR_DEFECTO = path.join(process.env.HOME || '~', 'Desktop', 'sis_zamir', 'src', 'fichas.json');
const CARPETA_DATOS = path.join(__dirname, '..', 'datos');
const ARCHIVO_SALIDA = path.join(CARPETA_DATOS, 'semilla-precios.json');
const ARCHIVO_CACHE = path.join(CARPETA_DATOS, 'cache-specs.json');
const LOTE = 200;
const CONCURRENCIA = 6;
const ESPERA_MS = 400;

// Palabras que el vendedor escribe de mas y que la API no conoce. Se
// quitan antes de preguntar. "SH" es el prefijo que usan para Samsung
// ("Samsung SH A17") y "Esim" para la variante de tarjeta.
const RUIDO = [
  'SH', 'ESIM', 'CHIP', 'SIM', 'DUAL', 'JP', 'NANO', 'HOMO', 'ARABE', 'VIETNAM', 'CHINA',
  'BLANCO', 'LILA', 'AZUL', 'NEGRO', 'GRIS', 'ROSA', 'VERDE', 'ORO', 'PLATEADO', 'DORADO'
];

// Marca de la hoja, y como se le dice a la API. Varias marcas de la
// tienda son lineas de otra: REDMI y POCO son de Xiaomi, IPHONE e IPAD
// son de Apple, MOTO es Motorola, PAD es la tablet de Xiaomi.
const MARCA_DE_LA_HOJA = {
  REDMI: 'Redmi', POCO: 'Poco', IPHONE: 'iPhone', IPAD: 'iPad', MOTO: 'Motorola',
  PAD: 'Xiaomi Pad', XIAOMI: 'Xiaomi', SAMSUNG: 'Samsung', HONOR: 'Honor', REALME: 'Realme',
  MOTOROLA: 'Motorola', TECNO: 'Tecno', ITEL: 'Itel', INFINIX: 'Infinix', VIVO: 'Vivo',
  OPPO: 'Oppo', HUAWEI: 'Huawei', NOKIA: 'Nokia', ZTE: 'ZTE', LENOVO: 'Lenovo',
  ONEPLUS: 'OnePlus', NUBIA: 'Nubia', MEIZU: 'Meizu', ALCATEL: 'Alcatel',
  'BLACK SHARK': 'Black Shark', HMD: 'HMD'
};

// Como se le pide a la API. Sin esto "Samsung A07" no encuentra nada,
// porque la base guarda los Samsung como "Galaxy".
const PREFIJO_API = {
  REDMI: 'Xiaomi Redmi', POCO: 'Xiaomi Poco', IPHONE: 'Apple iPhone', IPAD: 'Apple iPad',
  MOTO: 'Motorola Moto', MOTOROLA: 'Motorola Moto', SAMSUNG: 'Samsung Galaxy', PAD: 'Xiaomi Pad', XIAOMI: 'Xiaomi',
  // Black Shark paso a ser parte de Nubia: la base de la API guarda
  // esos equipos como Red Magic y por eso el prefijo no coincide.
  'BLACK SHARK': 'Nubia Red Magic'
};

function argumentos() {
  const salida = { origen: ORIGEN_POR_DEFECTO, subir: false, forzar: false };
  const lista = process.argv.slice(2);
  for (let i = 0; i < lista.length; i++) {
    if (lista[i] === '--origen' && lista[i + 1]) { salida.origen = lista[i + 1]; i = i + 1; continue; }
    if (lista[i] === '--subir') { salida.subir = true; continue; }
    if (lista[i] === '--forzar') { salida.forzar = true; continue; }
    if (lista[i] === '--ayuda' || lista[i] === '-h') {
      process.stdout.write('Uso: npm run semilla [-- --origen RUTA] [-- --subir] [-- --forzar]\n');
      process.exit(0);
    }
  }
  return salida;
}

function quitarAcentos(texto) {
  return String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// El indice viene escrito como lo escribe el vendedor en mayusculas.
// "Samsung SH A17 128/6" tiene que quedar como marca Samsung, modelo
// "A17". El precio de partida no lo decide el codigo.
function separar(nombre) {
  const crudo = String(nombre || '').trim();
  const mayus = crudo.toUpperCase();
  // La marca se busca por el prefijo mas largo conocido, porque hay
  // marcas de dos palabras ("BLACK SHARK") y una de dos letras camino
  // ("IPAD", "MOTO") que se comen el resto si se toma la primera palabra.
  let marcaMayus = '';
  for (const clave of Object.keys(MARCA_DE_LA_HOJA).sort(function (a, b) { return b.length - a.length; })) {
    if (mayus === clave || mayus.indexOf(clave + ' ') === 0) { marcaMayus = clave; break; }
  }
  const marcaHoja = MARCA_DE_LA_HOJA[marcaMayus] || (mayus.split(/\s+/)[0]) || 'Varios';
  const resto = crudo.slice(marcaMayus.length).trim();
  const palabras = resto.split(/\s+/).filter(Boolean).filter(function (p) {
    const t = p.toUpperCase();
    if (RUIDO.indexOf(t) !== -1) return false;
    // Solo se van las capacidades: 256, 512, 128. Un numero de dos
    // cifras es parte del modelo ("iPhone 17", "Moto 50", "Redmi 15")
    // y quitarlo deja un nombre que la API no encuentra.
    if (/^\d{3,}$/.test(p)) return false;
    if (/^\d+\/\d+$/.test(p)) return false;
    if (/^\d+T$/i.test(p)) return false;
    return true;
  });
  const modelo = palabras.map(titular).join(' ')
    .replace(/\+/g, ' Plus ')
    // La base escribe "Razr 50" y el vendedor escribe "50 Razr".
    .replace(/^(\d+)\s+Razr/i, 'Razr $1');
  return { marca: marcaHoja, modelo: modelo.replace(/\s+/g, ' ').trim() };
}

// La API guarda los nombres en Minuscula con mayuscula inicial ("Galaxy
// A54", "Note 15 Pro"). El indice de Sis_Zamir viene en MAYUSCULAS.
function titular(palabra) {
  if (!palabra) return '';
  if (/^\d/.test(palabra)) return palabra;
  return palabra.charAt(0).toUpperCase() + palabra.slice(1).toLowerCase();
}

function idProductoDe(nombreCompleto) {
  const base = String(nombreCompleto || '')
    .replace(/\+/g, ' Plus ')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase();
  return (base || 'P').slice(0, 40);
}

// La base de la API no siempre encuentra el mismo nombre segun como este
// escrito: "Motorola Moto G75" entra y "Motorola G75" no; en cambio
// "realme p4 power" entra y "Realme P4 Power" a veces no. Se prueban las dos
// escrituras y ademas se van soltando palabras del final ("5G", "Power"),
// que es donde mas se equivoca el vendedor al pasar el nombre.
//
// Lo que NO se hace es quedarse solo con la marca: "Motorola" trae la ficha
// de un equipo cualquiera y el vendedor terminaria mostrando la pantalla del
// Moto G84 en el G86. Ficha de otro aparato es peor que ninguna ficha.
function consultasPara(nombreCompleto) {
  const partes = nombreCompleto.split(' ');
  const variantes = [];
  for (let corte = 0; corte < 3; corte++) {
    const base = corte === 0 ? nombreCompleto : partes.slice(0, partes.length - corte).join(' ');
    if (base.length <= 2) break;
    variantes.push(base, base.toLowerCase());
  }
  return variantes.filter(function (q, i, todas) { return todas.indexOf(q) === i; });
}

function textoPlano(valor) {
  if (valor === undefined || valor === null) return '';
  return String(valor)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Un ejemplo de un celular con 8 teoricos de camara y otro con 3 no le
// sirve de mucho al que esta en el mostrador. Cada campo se recorta para
// que la ficha se lea de un vistazo.
function corta(texto, maximo) {
  const limpio = String(texto || '');
  return limpio.length <= maximo ? limpio : limpio.slice(0, maximo - 1).trim() + '...';
}

function linea(etiqueta, valor, maximo) {
  const limpio = textoPlano(valor);
  if (!limpio) return '';
  return etiqueta + ': ' + corta(limpio, maximo || 160);
}

// De las diez secciones de la API solo interesan las que un vendedor
// necesita para comparar dos equipos en el mostrador. Las bandas 2G/3G y
// los campos de prueba no le dicen nada al cliente.
function caracteristicasDe(spec) {
  const s = spec || {};
  const lineas = [
    linea('Pantalla', (s.Display || {}).Type),
    linea('Resolucion', (s.Display || {}).Resolution),
    linea('Procesador', (s.Platform || {}).Chipset),
    linea('Sistema', (s.Platform || {}).OS),
    linea('Memoria', (s.Memory || {}).Internal),
    linea('Camara', (s['Main Camera'] || {}).Triple || (s['Main Camera'] || {}).Dual ||
      (s['Main Camera'] || {}).Single, 190),
    linea('Selfie', (s['Selfie camera'] || {}).Single || (s['Selfie camera'] || {}).Dual, 90),
    linea('Bateria', (s.Battery || {}).Type, 60),
    linea('Capacidad', (s.Battery || {}).Capacity, 40),
    linea('Carga', (s.Battery || {}).Charging, 90),
    // Las bandas 2G/3G/4G/5G no se copian: son veinte lineas de numeros
    // y el cliente no las distingue. Con la tecnologia alcanza.
    linea('Red', (s.Network || {}).Technology, 60),
    linea('Lanzamiento', (s.Launch || {}).Announced, 40),
    linea('Resistencia', (s.Body || {}).Features, 90)
  ].filter(Boolean);
  return lineas.join(' · ');
}

function leerIndice(origen) {
  if (!fs.existsSync(origen)) {
    process.stderr.write('No existe el indice de fichas en ' + origen + '.\nIndica otra ruta con --origen RUTA.\n');
    process.exit(1);
  }
  const datos = JSON.parse(fs.readFileSync(origen, 'utf8'));
  if (!datos || typeof datos !== 'object' || Array.isArray(datos)) {
    process.stderr.write('El indice de ' + origen + ' deberia ser un objeto con un producto por clave.\n');
    process.exit(1);
  }
  return datos;
}

function leerCache() {
  try {
    if (fs.existsSync(ARCHIVO_CACHE)) return JSON.parse(fs.readFileSync(ARCHIVO_CACHE, 'utf8'));
  } catch (e) { /* la cache es una comodidad, no un dato */ }
  return {};
}

function guardarCache(cache) {
  if (!fs.existsSync(CARPETA_DATOS)) fs.mkdirSync(CARPETA_DATOS, { recursive: true });
  fs.writeFileSync(ARCHIVO_CACHE, JSON.stringify(cache, null, 1));
}

function esperar(ms) {
  return new Promise(function (c) { setTimeout(c, ms); });
}

async function preguntar(consulta) {
  try {
    const r = await fetch(API + encodeURIComponent(consulta));
    if (!r.ok) return null;
    const d = await r.json();
    if (!d || d.status !== true || !d.data) return null;
    return d;
  } catch (e) {
    return null;
  }
}

// De la cache solo seoun los golpes certeros. Un "no encontrado" se vuelve
// a preguntar en la corrida siguiente, porque la API falla de forma
// intermitente: "Realme P4 Power" no entraba un rato despues entraba, sin
// que cambiara nada del lado nuestro.
async function specsDe(clave, consultas, forzar) {
  if (!forzar && cacheGlobal[clave]) return cacheGlobal[clave];
  for (const consulta of consultas) {
    await esperar(ESPERA_MS);
    const r = await preguntar(consulta);
    if (r && r.data) {
      cacheGlobal[clave] = r.data;
      return r.data;
    }
  }
  return null;
}

let cacheGlobal = {};

async function main() {
  const opciones = argumentos();
  const indice = leerIndice(opciones.origen);
  cacheGlobal = leerCache();

  // Una fila por modelo normalizado. El indice trae "HONOR PAD X9a" y
  // "HONOR PAD x9a" apuntando al mismo aparato: si no se deduplica, la
  // hoja muestra el mismo celular dos veces.
  const productos = [];
  const vistos = new Map();
  let repetidos = 0;

  Object.keys(indice).sort().forEach(function (nombre) {
    const partes = separar(nombre);
    // Se preguntan las dos escrituras de la marca: la que usa la API
    // ("Samsung Galaxy A07") y la que ve el vendedor ("Samsung A07").
    // Con la una o con la otra entra, segun el equipo.
    const conPrefijo = ((PREFIJO_API[partes.marca.toUpperCase()] || '') + ' ' + partes.modelo).replace(/\s+/g, ' ').trim();
    const conMarca = (partes.marca + ' ' + partes.modelo).replace(/\s+/g, ' ').trim();
    const consultas = consultasPara(conPrefijo).concat(consultasPara(conMarca))
      .filter(function (q, i, todas) { return todas.indexOf(q) === i; });
    const id = idProductoDe(partes.marca + ' ' + partes.modelo);
    if (vistos.has(id)) { repetidos = repetidos + 1; return; }
    vistos.set(id, nombre);
    productos.push({ idProducto: id, marca: partes.marca, modelo: partes.modelo, consultas: consultas });
  });

  process.stdout.write('Indice: ' + opciones.origen + '\n');
  process.stdout.write('Modelos en el indice: ' + Object.keys(indice).length + '\n');
  process.stdout.write('Productos a armar: ' + productos.length + ' (duplicados saltados: ' + repetidos + ')\n');
  process.stdout.write('Preguntando a la API de specs...\n');

  let encontrados = 0;
  let sinSpecs = 0;

  for (let i = 0; i < productos.length; i = i + CONCURRENCIA) {
    const tanda = productos.slice(i, i + CONCURRENCIA);
    const resueltos = await Promise.all(tanda.map(function (p) {
      return specsDe(p.idProducto, p.consultas, opciones.forzar).then(function (spec) {
        return { p: p, spec: spec };
      });
    }));
    resueltos.forEach(function (r) {
      if (r.spec) { encontrados = encontrados + 1; return; }
      sinSpecs = sinSpecs + 1;
      process.stdout.write('  sin ficha: ' + r.p.consultas[0] + '\n');
    });
    process.stdout.write('  ' + Math.min(i + CONCURRENCIA, productos.length) + '/' + productos.length + '\n');
  }

  guardarCache(cacheGlobal);

  // cacheGlobal guarda el dispositivo tal cual lo devuelve la API, o sea
  // ya sin la envoltura {status, data}. Por eso se lee directo.
  const filas = productos.map(function (p) {
    const d = cacheGlobal[p.idProducto] || {};
    return {
      idProducto: p.idProducto,
      marca: p.marca,
      modelo: p.modelo,
      precioRefUsdCents: 0,
      caracteristicas: d.specifications ? caracteristicasDe(d.specifications) : '',
      imagen: textoPlano(d.imageUrl || '')
    };
  });

  const salida = {
    generadoEn: new Date().toISOString(),
    origen: opciones.origen,
    total: filas.length,
    conFicha: encontrados,
    sinFicha: sinSpecs,
    productos: filas
  };
  if (!fs.existsSync(CARPETA_DATOS)) fs.mkdirSync(CARPETA_DATOS, { recursive: true });
  fs.writeFileSync(ARCHIVO_SALIDA, JSON.stringify(salida, null, 1));

  process.stdout.write('Con ficha: ' + encontrados + ' / Sin ficha: ' + sinSpecs + '\n');
  process.stdout.write('Escrito: ' + ARCHIVO_SALIDA + '\n');
  process.stdout.write('Los precios quedaron en 0 a proposito. Son referenciales y los cambian seguido.\n');

  if (!opciones.subir) {
    process.stdout.write('Modo sin --subir: la hoja no se toco.\n');
    return 0;
  }
  if (!sheets.completo()) {
    process.stderr.write('Falta SHEETS_WEBAPP_URL o SHEETS_API_KEY en el entorno.\n');
    process.exit(1);
  }

  const lotes = [];
  for (let i = 0; i < filas.length; i = i + LOTE) lotes.push(filas.slice(i, i + LOTE));
  for (const lote of lotes) {
    const respuesta = await sheets.escribir({
      tipoOperacion: 'SEMBRAR_CATALOGO',
      productos: lote.map(function (f) {
        return {
          idProducto: f.idProducto, marca: f.marca, modelo: f.modelo,
          precioRefUsdCents: f.precioRefUsdCents, specs: f.caracteristicas, imagen: f.imagen, activo: true
        };
      })
    });
    process.stdout.write('Lote de ' + lote.length + ': ' + JSON.stringify(respuesta) + '\n');
  }
  return 0;
}

module.exports = { separar, idProductoDe, consultasPara, caracteristicasDe, textoPlano, main };

if (require.main === module) {
  main().then(function (codigo) { process.exitCode = codigo || 0; });
}