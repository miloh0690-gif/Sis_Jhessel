'use strict';

// Genera el hash de una contrasena de tienda o del dueno para pegarlo en la
// hoja Tiendas (columna ClaveHash) o en la variable DUENO_CLAVE_HASH de Render.
//
//   node scripts/hash-clave.js "mi clave"
//   node scripts/hash-clave.js            (pregunta sin eco)

const readline = require('readline');
const auth = require('../src/auth');

function escribir(clave) {
  process.stdout.write(auth.hashearClave(clave) + '\n');
}

const clave = process.argv[2];
if (clave !== undefined) {
  escribir(clave);
} else if (process.stdin.isTTY) {
  const interfaz = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  interfaz.question('Contrasena: ', function (respuesta) {
    interfaz.close();
    escribir(respuesta);
  });
  interfaz.on('line', function () { interfaz.output.write = process.stdout.write.bind(process.stdout); });
} else {
  process.stderr.write('Uso: node scripts/hash-clave.js "mi clave"\n');
  process.exit(1);
}
