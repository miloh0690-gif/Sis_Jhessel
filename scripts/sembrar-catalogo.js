'use strict';

// =================================================================
// Siembra el catalogo de Sis Jhessel desde el indice de fichas de
// Sis_Zamir (src/fichas.json).
//
//   npm run sembrar-catalogo
//   npm run sembrar-catalogo -- --origen /ruta/otro/fichas.json
//   npm run sembrar-catalogo -- --seco        no escribe, solo muestra
//
// Que hace y por que existe: el catalogo de Sis Jhessel arranca con los
// modelos que ya estan fichados en el proyecto hermano, para que el
// buscador de la pantalla de venta no arranque vacio.
//
// Lo que NO hace, y por que: no descarga las fichas ni inventa precios.
// El indice de Sis_Zamir solo dice "este modelo esta en tal archivo del
// dataset"; los precios estan en otro lado y cambian cada semana. Por eso
// el precio se siembra en 0: lo pone el encargado al vender o el dueno
// desde la pantalla de Catalogo, que es lo que el diseno pide. Poner un
// precio aqui seria un numero viejo Presented como si fuera el de hoy.
//
// Variables: necesita SHEETS_WEBAPP_URL y SHEETS_API_KEY de Sis Jhessel,
// igual que el servidor.
// =================================================================

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');

const sheets = require('../src/sheets');

const ORIGEN_POR_DEFECTO = path.join(process.env.HOME || '~', 'Desktop', 'sis_zamir', 'src', 'fichas.json');
const LOTE = 200;

// Marcas que se reconocen al principio del nombre del modelo. El indice
// de Sis_Zamir viene escrito en mayusculas y con la capacidad al final
// ("SAMSUNG A07 128/4"), asi que la marca es el primer token conocido.
const MARCAS = [
  'SAMSUNG', 'HONOR', 'XIAOMI', 'REDMI', 'POCO', 'IPHONE', 'IPAD', 'MOTOROLA', 'MOTO',
  'REALME', 'INFINIX', 'BLACK SHARK', 'NUBIA', 'TECNO', 'ITEL', 'OPPO', 'VIVO', 'ONEPLUS',
  'HUAWEI', 'NOKIA', 'ZTE', 'LENOVO', 'MEIZU', 'ALCATEL', 'HMD', 'NOVA', 'QUAD',
  'WIRELESS', 'SMART WATCH', 'AURICULARES', 'PARLA'
];

function argumentos() {
  const salida = { origen: ORIGEN_POR_DEFECTO, seco: false };
  const lista = process.argv.slice(2);
  for (let i = 0; i < lista.length; i++) {
    if (lista[i] === '--origen' && lista[i + 1]) { salida.origen = lista[i + 1]; i = i + 1; continue; }
    if (lista[i] === '--seco') { salida.seco = true; continue; }
    if (lista[i] === '--ayuda' || lista[i] === '-h') {
      process.stdout.write('Uso: npm run sembrar-catalogo [-- --origen RUTA] [-- --seco]\n');
      process.exit(0);
    }
  }
  return salida;
}

function separarMarca(nombre) {
  const limpio = String(nombre || '').trim();
  const mayus = limpio.toUpperCase();
  for (const marca of MARCAS) {
    if (mayus.indexOf(marca + ' ') === 0 || mayus === marca) {
      return {
        marca: mayus === marca ? 'Xiaomi' : marca,
        modelo: limpio.slice(marca.length).trim() || limpio
      };
    }
  }
  // Sin marca reconocible: la primera palabra se vuelve marca. Es mejor
  // que dejar la marca vacia, porque el buscador ordena por marca.
  const corte = limpio.indexOf(' ');
  if (corte > 0) { return { marca: limpio.slice(0, corte), modelo: limpio.slice(corte + 1) }; }
  return { marca: 'Varios', modelo: limpio };
}

function idProductoDe(marca, modelo) {
  const base = (marca + '-' + modelo)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase();
  return (base || 'P').slice(0, 40);
}

function leerIndice(origen) {
  if (!fs.existsSync(origen)) {
    process.stderr.write(
      'No existe el indice de fichas en ' + origen + '.\n' +
      'Indica otra ruta con --origen RUTA.\n'
    );
    process.exit(1);
  }
  let crudo;
  try {
    crudo = fs.readFileSync(origen, 'utf8');
  } catch (e) {
    process.stderr.write('No se pudo leer ' + origen + ': ' + e.message + '\n');
    process.exit(1);
  }
  let datos;
  try {
    datos = JSON.parse(crudo);
  } catch (e) {
    process.stderr.write('El indice de ' + origen + ' no es JSON valido: ' + e.message + '\n');
    process.exit(1);
  }
  if (!datos || typeof datos !== 'object' || Array.isArray(datos)) {
    process.stderr.write('El indice de ' + origen + ' deberia ser un objeto con un producto por clave.\n');
    process.exit(1);
  }
  return datos;
}

function main() {
  const opciones = argumentos();
  const indice = leerIndice(opciones.origen);

  const productos = [];
  const vistos = new Map();
  let saltadosDuplicados = 0;

  Object.keys(indice).sort().forEach(function (nombre) {
    const partes = separarMarca(nombre);
    const id = idProductoDe(partes.marca, partes.modelo);
    if (vistos.has(id)) {
      // Dos nombres que dan el mismo id: se gana el primero en orden
      // alfabetico, que es determinista entre corridas.
      saltadosDuplicados = saltadosDuplicados + 1;
      return;
    }
    vistos.set(id, nombre);
    productos.push({
      idProducto: id,
      marca: partes.marca,
      modelo: partes.modelo,
      precioRefUsdCents: 0,
      specs: ''
    });
  });

  process.stdout.write('Indice: ' + opciones.origen + '\n');
  process.stdout.write('Modelos en el indice: ' + Object.keys(indice).length + '\n');
  process.stdout.write('Productos a sembrar: ' + productos.length + '\n');
  if (saltadosDuplicados > 0) {
    process.stdout.write('Saltados por id repetido: ' + saltadosDuplicados + '\n');
  }
  const marcas = new Set(productos.map(function (p) { return p.marca; }));
  process.stdout.write('Marcas: ' + marcas.size + '\n');

  if (opciones.seco) {
    process.stdout.write('Modo --seco: no se escribio nada.\n');
    productos.slice(0, 8).forEach(function (p) {
      process.stdout.write('  ' + p.idProducto + '  ' + p.marca + ' / ' + p.modelo + '\n');
    });
    return;
  }

  if (!sheets.completo()) {
    process.stderr.write(
      'Falta SHEETS_WEBAPP_URL o SHEETS_API_KEY en el entorno.\n' +
      'Copia .env.example a .env y rellena los dos valores.\n'
    );
    process.exit(1);
  }

  let subidas = 0;
  let yaEran = 0;
  const lotes = [];
  for (let i = 0; i < productos.length; i = i + LOTE) {
    lotes.push(productos.slice(i, i + LOTE));
  }

  return lotes.reduce(function (cadena, lote) {
    return cadena.then(function () {
      return sheets.escribir({ tipoOperacion: 'SEMBRAR_CATALOGO', productos: lote })
        .then(function (respuesta) {
          const agregados = (respuesta && (respuesta.agregados || respuesta.insertados)) || 0;
          const repetidas = (respuesta && respuesta.omitidos) || 0;
          subidas = subidas + numeroEntero(agregados);
          yaEran = yaEran + numeroEntero(repetidas);
          process.stdout.write('Lote de ' + lote.length + ': ' + agregados + ' agregados, ' + repetidas + ' ya estaban.\n');
        });
    });
  }, Promise.resolve()).then(function () {
    process.stdout.write('Total agregado: ' + subidas + '\n');
    process.stdout.write('Ya estaban: ' + yaEran + '\n');
    process.stdout.write('Los precios quedaron en 0 a proposito. Ponlos desde la pantalla de Catalogo.\n');
  }).catch(function (e) {
    process.stderr.write('Fallo la siembra: ' + (e && e.message ? e.message : e) + '\n');
    process.exit(1);
  });
}

function numeroEntero(valor) {
  const n = Number(valor);
  return isFinite(n) ? n : 0;
}

module.exports = { separarMarca, idProductoDe, leerIndice, main };

if (require.main === module) {
  const resultado = main();
  if (resultado && typeof resultado.then === 'function') {
    resultado.then(function () { process.exitCode = 0; });
  } else {
    process.exitCode = 0;
  }
}
