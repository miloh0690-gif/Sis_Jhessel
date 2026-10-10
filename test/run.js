'use strict';

// Corredor de pruebas. Cada archivo corre en su propio proceso: asi un error de
// arnes en un archivo no hace fallar los demas, y el total es el resumen real.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ARCHIVOS = [
  'money',
  'auth',
  'estados',
  'sheets',
  'ledger',
  'catalogo',
  'idempotencia',
  'cierres',
  'codegs'
];

const raiz = path.join(__dirname, '..');
let fallos = 0;
let total = 0;

for (const archivo of ARCHIVOS) {
  const ruta = path.join(raiz, 'test', archivo + '.test.js');
  const r = spawnSync(process.execPath, ['--test', ruta], { encoding: 'utf8' });
  const salida = String(r.stdout || '') + String(r.stderr || '');
  const marca = /ℹ tests (\d+)/.exec(salida);
  const pruebas = marca ? Number(marca[1]) : 0;
  total += pruebas;
  const bien = r.status === 0;
  if (!bien) fallos += 1;
  console.log((bien ? '  ok  ' : ' FALLO') + '  ' + archivo.padEnd(14) + pruebas + ' prueba(s)');
  if (!bien) {
    const linea = /✖[^\n]*/g;
    const fallosReal = salida.match(linea);
    if (fallosReal) fallosReal.slice(0, 12).forEach(function (l) { console.log('        ' + l.trim()); });
  }
}

console.log('\n' + (total - 0) + ' pruebas en ' + ARCHIVOS.length + ' archivos; ' + fallos + ' archivo(s) con fallos');
process.exit(fallos ? 1 : 0);