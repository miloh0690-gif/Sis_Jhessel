'use strict';

// Comprueba la sintaxis de todo el JavaScript del proyecto sin ejecutarlo.
// Nota: `node --check` NO detecta identificadores pegados (por ejemplo
// `constmayus`), asi que esto es una red minima, no una garantia.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const raiz = path.join(__dirname, '..');
const carpetas = ['src', 'scripts', 'test', 'public'];

function juntar(entrada) {
  const completa = path.join(raiz, entrada);
  if (!fs.existsSync(completa)) return [];
  if (!fs.statSync(completa).isDirectory()) return [completa];
  return fs.readdirSync(completa)
    .filter(function (nombre) { return nombre.endsWith('.js'); })
    .map(function (nombre) { return path.join(completa, nombre); })
    .sort();
}

const entradas = ['server.js'].concat(carpetas);
const archivos = entradas.map(juntar).reduce(function (a, b) { return a.concat(b); }, []);
let fallos = 0;

for (const archivo of archivos) {
  try {
    execFileSync(process.execPath, ['--check', archivo], { stdio: 'pipe' });
  } catch (e) {
    fallos += 1;
    console.log('FALLO ' + path.relative(raiz, archivo));
    console.log(String(e.stderr || e.message).split('\n').slice(0, 6).join('\n'));
  }
}

console.log(archivos.length + ' archivo(s) revisados; ' + fallos + ' con error de sintaxis');
process.exit(fallos ? 1 : 0);