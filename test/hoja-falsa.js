// Hoja de Google Sheets simulada + Code.gs ejecutado en memoria.
//
// Sirve para dos cosas:
//  1. test/codegs.test.js prueba el Code.gs contra esta hoja.
//  2. test/e2e.test.js levanta un servidor HTTP que habla como el web app de
//     Apps Script y le pega el server.js real encima, para probar el sistema
//     entero de punta a punta sin Google.
//
// NO duplicar la hoja falsa: si hace falta tocar esto, se toca aca.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');

const CLAVE = 'clave-de-prueba-1234';

function crearHoja(nombre) {
  return {
    nombre: nombre,
    datos: [],
    congeladas: 0,
    getLastRow: function () { return this.datos.length; },
    getLastColumn: function () {
      let max = 0;
      for (const fila of this.datos) {
        if (fila.length > max) max = fila.length;
      }
      return max;
    },
    setFrozenRows: function (n) { this.congeladas = n; },
    getFrozenRows: function () { return this.congeladas; },
    getRange: function (fila, columna, filas, columnas) {
      const hoja = this;
      if (filas < 1 || columnas < 1) {
        throw new Error('Range exceeds grid limits: ' + fila + ',' + columna + ',' + filas);
      }
      if (fila + filas - 1 > Math.max(hoja.datos.length, 1)) {
        throw new Error('Range exceeds grid limits: ' + fila + ',' + columna + ',' + filas);
      }
      return {
        getValues: function () {
          const salida = [];
          for (let f = 0; f < filas; f++) {
            const real = hoja.datos[fila - 1 + f] || [];
            const linea = [];
            for (let c = 0; c < columnas; c++) {
              linea.push(real[columna - 1 + c] === undefined ? '' : real[columna - 1 + c]);
            }
            salida.push(linea);
          }
          return salida;
        },
        getValue: function () {
          const real = hoja.datos[fila - 1] || [];
          const v = real[columna - 1];
          return v === undefined ? '' : v;
        },
        setValue: function (valor) {
          while (hoja.datos.length < fila) hoja.datos.push([]);
          if (!hoja.datos[fila - 1]) hoja.datos[fila - 1] = [];
          hoja.datos[fila - 1][columna - 1] = valor;
          return this;
        },
        setFontWeight: function () { return this; },
        setFontSize: function () { return this; },
        setHorizontalAlignment: function () { return this; },
        setNumberFormat: function () { return this; },
        setValues: function (matriz) {
          for (let f = 0; f < filas; f++) {
            while (hoja.datos.length < fila + f) hoja.datos.push([]);
            if (!hoja.datos[fila - 1 + f]) hoja.datos[fila - 1 + f] = [];
            for (let c = 0; c < columnas; c++) {
              hoja.datos[fila - 1 + f][columna - 1 + c] = matriz[f][c];
            }
          }
          return this;
        }
      };
    },
    appendRow: function (fila) {
      this.datos.push(fila.slice());
      return this;
    },
    deleteRow: function (indice) {
      this.datos.splice(indice - 1, 1);
      return this;
    }
  };
}

function crearEntorno(opciones) {
  const config = opciones || {};
  const clave = config.clave === undefined ? CLAVE : config.clave;
  const hojas = config.hojas || {};
  const registro = [];
  const abiertos = [];
  // Propiedades del script: arrancan con la clave puesta, como si el dueño ya
  // la hubiera configurado. El arnes de generarClaveCompartida() la escribe.
  const propiedades = { SHEETS_API_KEY: clave };
  if (config.spreadsheetId) propiedades.SPREADSHEET_ID = config.spreadsheetId;
  const idSinAbrir = config.idSinAbrir === true;
  const ss = {
    getName: function () { return config.nombreLibro || 'JHessel en pruebas'; },
    getSheetByName: function (nombre) { return hojas[nombre] || null; },
    insertSheet: function (nombre) {
      hojas[nombre] = crearHoja(nombre);
      return hojas[nombre];
    }
  };

  const contexto = {
    SpreadsheetApp: {
      getActiveSpreadsheet: function () { return config.sinLibroActivo ? null : ss; },
      // openById es lo que permite fijar SIEMPRE el mismo libro. Si el script no
      // esta vinculado a una hoja, getActiveSpreadsheet() devuelve el equivocado.
      openById: function (id) {
        abiertos.push(String(id));
        if (idSinAbrir) return null;
        return ss;
      }
    },
    PropertiesService: {
      getScriptProperties: function () {
        return {
          getProperty: function (nombre) {
            return Object.prototype.hasOwnProperty.call(propiedades, nombre)
              ? propiedades[nombre]
              : '';
          },
          setProperty: function (nombre, valor) { propiedades[nombre] = String(valor); },
          deleteProperty: function (nombre) { delete propiedades[nombre]; }
        };
      }
    },
    LockService: {
      getScriptLock: function () {
        return {
          waitLock: function () { return true; },
          releaseLock: function () { registro.push('release'); }
        };
      }
    },
    Logger: { log: function (mensaje) { registro.push(String(mensaje)); } },
    Utilities: {
      getUuid: function () { return '00000000-0000-4000-8000-000000000000'; }
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: function (texto) {
        return {
          setMimeType: function () {
            return { texto: texto, getContent: function () { return texto; } };
          }
        };
      }
    }
  };
  contexto.globalThis = contexto;

  vm.createContext(contexto);
  let fuente = fs.readFileSync(
    path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  // config.fuente transforma el Codigo.gs antes de correrlo: asi el arnes puede
  // simular un deployment VIEJO (por ejemplo, con la hoja Catalogo) sin tocar el real.
  if (config.fuente) fuente = config.fuente(fuente);
  vm.runInContext(fuente, contexto, { filename: 'Code.gs' });

  return { contexto: contexto, hojas: hojas, registro: registro, ss: ss,
    propiedades: propiedades, abiertos: abiertos };
}

function respuesta(objeto) {
  return JSON.parse(objeto.getContent());
}

// sheets.escribir manda la clave en el cuerpo del POST (Apps Script no lee
// cabeceras HTTP), asi que el arnes la manda igual.
function post(entorno, cuerpo) {
  const evento = { postData: { contents: JSON.stringify(Object.assign({ apiKey: CLAVE }, cuerpo)) } };
  return respuesta(entorno.contexto.doPost(evento));
}

function get(entorno, parametros) {
  return respuesta(entorno.contexto.doGet({ parameter: parametros }));
}

// Servidor HTTP que habla como el web app de Apps Script: devuelve SIEMPRE 200,
// y un rechazo del script llega como {status:'ERROR'} en el cuerpo. Asi el
// cliente (sheets.js) tiene que ser el que detecta el fallo, igual que en vida
// real.
function servidorWebApp(entorno) {
  const servidor = http.createServer(function (req, res) {
    const partes = req.url.split('?');
    const ruta = partes[0];
    const parametros = {};
    if (partes[1]) {
      partes[1].split('&').forEach(function (par) {
        if (!par) return;
        const eq = par.indexOf('=');
        const clave = decodeURIComponent(eq === -1 ? par : par.slice(0, eq));
        const valor = eq === -1 ? '' : decodeURIComponent(par.slice(eq + 1).replace(/\+/g, ' '));
        parametros[clave] = valor;
      });
    }

    function mandar(cuerpo) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(cuerpo.getContent());
    }

    if (req.method === 'GET') {
      try {
        mandar(entorno.contexto.doGet({ parameter: parametros }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ERROR', message: String(e && e.message) }));
      }
      return;
    }

    let crudo = '';
    req.on('data', function (trozo) { crudo += trozo; });
    req.on('end', function () {
      try {
        mandar(entorno.contexto.doPost({ postData: { contents: crudo || '{}' } }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ERROR', message: String(e && e.message) }));
      }
    });
  });

  const listo = new Promise(function (resolver) {
    servidor.listen(0, '127.0.0.1', function () {
      resolver('http://127.0.0.1:' + servidor.address().port + '/macros/s/e2e/exec');
    });
  });

  return {
    listo: listo,
    // fetch mantiene conexiones keep-alive: sin closeAllConnections, close()
    // se queda esperando y el proceso nunca termina.
    cerrar: function () {
      return new Promise(function (c) {
        if (servidor.closeAllConnections) servidor.closeAllConnections();
        servidor.close(c);
      });
    }
  };
}

module.exports = {
  CLAVE: CLAVE,
  crearHoja: crearHoja,
  crearEntorno: crearEntorno,
  respuesta: respuesta,
  post: post,
  get: get,
  servidorWebApp: servidorWebApp
};