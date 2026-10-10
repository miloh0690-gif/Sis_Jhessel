# Sis Jhessel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sistema web para que 4 tiendas de celulares registren ventas, y el dueño sepa cada día cuánta ganancia le corresponde por tienda y cuánto se queda cada encargado.

**Architecture:** Monolito modular Node/Express en Render por delante + Google Apps Script por detrás que traduce a filas de Google Sheets. Node es el único que calcula (todo en enteros de centavos); el navegador recibe números ya resueltos y solo los muestra. Si la hoja no responde, la venta no se confirma.

**Tech Stack:** Node ≥ 20, Express 4, dotenv, `node:crypto` (scrypt + HMAC), Google Apps Script (V8), Google Sheets. Cero frameworks de test: `node:assert`.

**Spec:** `docs/superpowers/specs/2026-10-09-sis-jhessel-design.md`

## Global Constraints

- Todos los importes son **enteros de centavos**. `*UsdCents` = centavos de dólar, `*BsCents` = centavos de bolivianos. Ningún cálculo en coma flotante sobre dinero.
- El **cálculo autoritativo es en el servidor**. El navegador nunca calcula totales; los recibe.
- El **tipo de cambio se guarda como entero en décimas** (`7,25` → `725`). El TC es obligatorio y debe ser `> 0`.
- El **% de comisión se guarda en basis points** (`30%` → `3000`), y debe estar entre `0` y `10000`.
- **Nunca hay comisión sobre pérdida**: si `gananciaBsCents <= 0`, `comisionBsCents = 0`.
- El **costo siempre se pide en USD**, en venta en Bs o en USD.
- El **servidor nunca confía en el `IdTienda` del cliente**: se resuelve desde la sesión. Si no coincide, se ignora el del cuerpo.
- Respuesta **404, nunca 403**, cuando un rol no alcanza un recurso (no confirmar existencia).
- El texto que empieza con `= + - @` se prefija con `'` al escribir en la hoja (anti inyección de fórmulas).
- Convenciones: `require`/`module.exports` (CommonJS), 2 espacios, punto y coma, `const`/`let`, sin comentarios dentro del código salvo los que fijan un valor mágico.
- Idioma del código y la interfaz: **español**. Los nombres de variables y funciones en español.
- Puerto: `Number(process.env.PORT) || 10000`.
- El proyecto **no** usa microservicios, ni WebSockets, ni base de datos fuera de Google Sheets.

## Review Focus

Cinco clases de entrada o fallo que el spec implica y que casi seguro van a morder a alguien usando el sistema.
Cada una tiene su prueba en la tarea que es dueña del código:

1. **Venta con ganancia negativa** (precio menor que el costo). La comisión debe ser `0` y el neto del dueño debe ser la pérdida completa, no un número positivo raro. → Tarea 1.
2. **Doble toque en "Confirmar venta"** o reintento de Render (que se duerme): la misma `ClaveIdempotencia` dos veces debe dar **una sola** venta y **una sola** fila en la hoja. → Tarea 7.
3. **El `.gs` devuelve HTTP 200 aunque rechace** (`{status:'ERROR', message:...}`). Si no se detecta, la UI muestra "guardado" sin haberse guardado. → Tarea 3.
4. **Encargado que manipula el `IdTienda` en el request** para ver o escribir en otra tienda. El servidor debe ignorarlo y usar el de la sesión. → Tarea 8.
5. **Apps Script duerme en la fila 1-2**, y `getLastRow()` da `0` cuando la hoja está vacía: `getRange(2, col, -1, 1)` lanza excepción y tumba toda la lectura. El cliente debe tratar "0 filas" como lista vacía. → Tarea 3.

---

## File Structure

| Archivo | Responsabilidad |
|---|---|
| `src/money.js` | Aritmética en centavos, parseo, fórmulas de venta, resumen. **Sin dependencias.** |
| `src/auth.js` | scrypt, sesiones HMAC, cookies, roles. **Sin dependencias.** |
| `src/sheets.js` | Cliente HTTP de Apps Script: GET/POST, timeout, detecta `{status:'ERROR'}`, caché. |
| `src/ledger.js` | Lectura y normalización de las 7 hojas; ids; resumen por tienda/vendedor/día. |
| `src/ventas.js` | Validación, cálculo, idempotencia, transiciones de estado. |
| `src/catalogo.js` | Búsqueda y edición de precios de referencia. |
| `src/cierres.js` | Cierre de tienda, recibo, saldos. |
| `src/estados.js` | Tabla de transiciones de estado y permisos por rol (datos puros, sin dependencias). |
| `server.js` | Express: cabeceras, rate limit, sesión, rutas, idempotencia HTTP. |
| `apps-script/Code.gs` | 7 hojas, columnas por encabezado, deduplicación, lock, sanitizar. |
| `public/index.html`, `public/app.js`, `public/app.css` | La aplicación de una sola página. |
| `test/run.js` | Corredor de los tres archivos de prueba. |
| `test/money.test.js`, `test/estados.test.js`, `test/idempotencia.test.js` | Pruebas. |
| `scripts/hash-clave.js` | Genera el hash scrypt de una contraseña. |
| `scripts/sembrar-catalogo.js` | Importa el catálogo de Sis_Zamir. |

---

### Task 1: `src/money.js` — la aritmética del dinero

Es la base de todo. Ningún otro módulo calcula.

**Files:**
- Create: `src/money.js`
- Test: `test/money.test.js`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `toCents(valor) -> number` — `Math.round(Number(valor) * 100)`, `0` si no es finito.
  - `fromCents(c) -> number` — `Math.round(c) / 100`.
  - `parseTcDecimas(valor) -> number` — acepta `"7,25"`, `7.25`, `725` ya en décimas si `esTcDecimas`. Devuelve entero de décimas.
  - `toTcDecimas(valor) -> number` — decimal → entero de décimas (`7.25` → `725`).
  - `desdeTcDecimas(decimas) -> number` — entero de décimas → decimal (`725` → `7.25`).
  - `redondear(n) -> number` — `Math.round(Number(n) || 0)`.
  - `pctABasisPoints(pct) -> number` — `30` → `3000`.
  - `bsAUsdCents(precioBsCentavos, tcDecimas) -> number` — `round(precioBsCentavos * 100 / tcDecimas)`.
  - `usdCentsABsCents(usdCents, tcDecimas) -> number` — `round(usdCents * tcDecimas / 100)`.
  - `calcularVenta({moneda, tcDecimas, pctComision, lineas, ajusteUsdCents, nota}) -> object`
  - `calcularTotales({moneda, tcDecimas, pctComision, lineas, ajusteUsdCents}) -> object` — igual que `calcularVenta` pero sin `nota` en el resultado.
  - `resumenVentas(ventas) -> object`

`calcularTotales` devuelve exactamente estas claves:

```
{
  totalCobradoUsdCents, totalCobradoBsCents,
  costoTotalUsdCents, gananciaBrutaUsdCents,
  ajusteUsdCents, gananciaNetaUsdCents,
  gananciaBsCents, comisionBsCents, netoDuenoBsCents,
  cantidadLineas, unidades
}
```

**Línea de entrada:** `{ modelo, cantidad, precioUsdCents, costoUnitarioUsdCents, idProducto, origen }`. `precioUsdCents` y `costoUnitarioUsdCents` ya vienen normalizados a USD (si `moneda === 'BS'`, el servidor los convierte antes con `bsAUsdCents`).

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `test/money.test.js` con `node:assert/strict`, importando `require('../src/money')`. Casos, con los valores exactos del spec:

```js
const assert = require('node:assert/strict');
const money = require('../src/money');

function linea(precioUsdCents, costoUnitarioUsdCents, cantidad = 1) {
  return { modelo: 'X', cantidad, precioUsdCents, costoUnitarioUsdCents };
}

// el caso real del dueño: 10.000 Bs de ganancia, 30% de comisión
{
  // 40 USD de ganancia a 7,25 = 290 Bs. Para llegar a 10.000 Bs de ganancia
  // hacen falta lineas que sumen 1.379,310344... USD; se prueba directo sobre
  // la formula que converts mil con decimales de forma exacta:
  const t = money.calcularTotales({
    moneda: 'USD', tcDecimas: 725, pctComision: 3000,
    lineas: [linea(1_000_000_00, 0)], ajusteUsdCents: 0,
  });
  // gananciaBs = 100.000,00 USD x 7,25 = 725.000.000 Bs-cents
  assert.equal(t.gananciaBsCents, 725_000_000);
  assert.equal(t.comisionBsCents, 217_500_000);   // 30%
  assert.equal(t.netoDuenoBsCents, 507_500_000);  // 70%
}

// el ejemplo textual del dueño, exacto
{
  // ganancia de 10.000 Bs = 1.000.000 Bs-cents, al 30%
  const bs = 1_000_000;
  const comision = Math.round(bs * 3000 / 10000);
  assert.equal(comision, 300_000);
  assert.equal(bs - comision, 700_000);
}

// venta en Bs: el precio se normaliza a USD
assert.equal(money.bsAUsdCents(70_000, 725), 9_655);  // 700 Bs / 7,25 = 96,55 USD

// el ejemplo del vidrio regalado
{
  const t = money.calcularTotales({
    moneda: 'USD', tcDecimas: 725, pctComision: 3000,
    lineas: [linea(34_000, 30_000), linea(0, 0)],  // A54 340/300 + vidrio 0/0
    ajusteUsdCents: 500,
  });
  assert.equal(t.gananciaBrutaUsdCents, 4_000);   // 40 USD
  assert.equal(t.gananciaNetaUsdCents, 3_500);    // -5 USD de regalo
  assert.equal(t.gananciaBsCents, 25_375);        // 35 x 7,25
}

// nunca hay comisión sobre pérdida
{
  const t = money.calcularTotales({
    moneda: 'USD', tcDecimas: 725, pctComision: 3000,
    lineas: [linea(20_000, 30_000)], ajusteUsdCents: 0,
  });
  assert.equal(t.gananciaNetaUsdCents, -10_000);
  assert.equal(t.comisionBsCents, 0);
  assert.equal(t.netoDuenoBsCents, -72_500);      // la pérdida completa, en Bs
}

// decimales de tipo de cambio
assert.equal(money.toTcDecimas(7.25), 725);
assert.equal(money.parseTcDecimas('7,25'), 725);
assert.equal(money.parseTcDecimas('7,25'), 725);
assert.equal(money.desdeTcDecimas(725), 7.25);

// base points
assert.equal(money.pctABasisPoints(30), 3000);
assert.equal(money.pctABasisPoints(12.5), 1250);

// enteros
assert.equal(money.toCents('340.55'), 34_055);
assert.equal(money.toCents('no es numero'), 0);
assert.equal(money.fromCents(34_055), 340.55);
```

- [ ] **Step 2: Correr las pruebas para ver que fallan**

Run: `node test/money.test.js`
Expected: FAIL con `Cannot find module '../src/money'`.

- [ ] **Step 3: Implementar `src/money.js`**

`money.js` no importa nada. Todas las entradas numéricas pasan por un `enteroSeguro()` local que devuelve `0` si no es finito, para que un `undefined` de un request mal formado no produzca `NaN` en la ganancia.

`calcularTotales` en este orden exacto:

1. `unidades = Σ linea.cantidad` (con `cantidad >= 1`, si no, se trata como 1).
2. `totalCobradoUsdCents = Σ linea.precioUsdCents * linea.cantidad`.
3. `costoTotalUsdCents = Σ linea.costoUnitarioUsdCents * linea.cantidad`.
4. `gananciaBrutaUsdCents = totalCobradoUsdCents - costoTotalUsdCents`.
5. `ajusteUsdCents = max(0, round(ajuste))`; `gananciaNetaUsdCents = gananciaBrutaUsdCents - ajusteUsdCents`.
6. `gananciaBsCents = usdCentsABsCents(gananciaNetaUsdCents, tcDecimas)`.
7. `comisionBsCents = gananciaBsCents > 0 ? redondear(gananciaBsCents * pctComision / 10000) : 0`.
8. `netoDuenoBsCents = gananciaBsCents - comisionBsCents`.
9. `totalCobradoBsCents = usdCentsABsCents(totalCobradoUsdCents, tcDecimas)`.
10. `cantidadLineas = lineas.length`.

`resumenVentas(ventas)` recibe objetos con `{ fecha, idTienda, tienda, idEmpleado, vendedor, estado, comisionBsCents, netoDuenoBsCents, gananciaBsCents, totalCobradoUsdCents, unidades }` y devuelve:

```
{
  cantidadVentas, unidades,
  totalCobradoBsCents, totalGananciaBsCents, totalComisionBsCents, totalNetoDuenoBsCents,
  porTienda: [{ idTienda, tienda, cantidadVentas, unidades, gananciaBsCents, comisionBsCents, netoDuenoBsCents, pendientes }],
  porEmpleado: [{ idEmpleado, vendedor, idTienda, tienda, cantidadVentas, unidades, gananciaBsCents, comisionBsCents, netoDuenoBsCents }],
  porDia: [{ dia, cantidadVentas, unidades, gananciaBsCents, comisionBsCents, netoDuenoBsCents }]
}
```

`porTienda` y `porEmpleado` se ordenan por `netoDuenoBsCents` descendente; `porDia` por `dia` ascendente. `pendientes` cuenta ventas con `estado === 'CONFIRMADA'` (cerrar pendiente de pago).

- [ ] **Step 4: Correr las pruebas para ver que pasan**

Run: `node test/money.test.js`
Expected: PASS, sin salida de error.

- [ ] **Step 5: Commit**

```bash
git add src/money.js test/money.test.js
git commit -m "money: aritmetica en centavos y formulas de venta"
```

---

### Task 2: `src/auth.js` — contraseñas, sesiones y roles

**Files:**
- Create: `src/auth.js`
- Create: `scripts/hash-clave.js`
- Test: `test/auth.test.js` (añadir al corredor en la Tarea 9, pero el archivo se crea aquí)

**Interfaces:**
- Consumes: nada.
- Produces:
  - `NOMBRE_COOKIE = 'jh_sesion'`
  - `DURACION_MS = 8 * 60 * 60 * 1000`
  - `ROL_DUENO = 'DUENO'`, `ROL_TIENDA = 'TIENDA'`
  - `hashearClave(clave) -> string` — `scrypt$saltHex$derivadoHex`, sal de 16 bytes.
  - `verificarClave(clave, guardado) -> boolean` — tiempo constante, devuelve `false` si el formato no es de 3 partes.
  - `firmar(carga) -> string` — `base64url(json).base64url(HMAC-SHA256)`.
  - `verificar(token) -> object|null` — `null` si la firma no cuadra o si `exp` venció.
  - `crearSesion({rol, idTienda, idEmpleado, nombre}) -> string`
  - `leerCookies(cabecera) -> object`
  - `crearCookie(token) -> string`
  - `borrarCookie() -> string`
  - `exigirSesion(req, res, siguiente) -> void` — 401 `{error:'Sesión no válida o vencida.'}` si no hay sesión.
  - `esDueno(req) -> boolean`

**Roles en la sesión:** `{rol, idTienda, idEmpleado, nombre, exp}`.

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `test/auth.test.js`:

```js
const assert = require('node:assert/strict');
process.env.SESSION_SECRET = 'clave-de-prueba-de-32-caracteres-minimo';
const auth = require('../src/auth');

// hash verificable, y la clave incorrecta no pasa
const h = auth.hashearClave('1234');
assert.match(h, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
assert.equal(auth.verificarClave('1234', h), true);
assert.equal(auth.verificarClave('9999', h), false);
assert.equal(auth.verificarClave('1234', 'basura'), false);
assert.equal(auth.verificarClave('1234', ''), false);

// dos hashes de la misma clave son distintos (sal aleatoria) pero ambos verifican
const h2 = auth.hashearClave('1234');
assert.notEqual(h, h2);
assert.equal(auth.verificarClave('1234', h2), true);

// sesion: firma, expiracion, adulteracion
const token = auth.firmar({ rol: 'DUENO', idTienda: null, exp: Date.now() + 1000 });
assert.equal(auth.verificar(token).rol, 'DUENO');
assert.equal(auth.verificar(token.slice(0, -2) + 'xx'), null);   // firma adulterada
assert.equal(auth.verificar('basura'), null);
assert.equal(auth.verificar('a.b'), null);                       // no base64url valido

const vencido = auth.firmar({ rol: 'TIENDA', idTienda: 'T1', exp: Date.now() - 1 });
assert.equal(auth.verificar(vencido), null);

// cookies
const c = auth.leerCookies('jh_sesion=abc; Path=/');
assert.equal(c.jh_sesion, 'abc');
const cookie = auth.crearCookie(token);
assert.match(cookie, /^jh_sesion=/);
assert.match(cookie, /HttpOnly/);
assert.match(cookie, /SameSite=Strict/);
assert.match(cookie, /Path=\//);
assert.match(auth.borrarCookie(), /Max-Age=0/);
```

- [ ] **Step 2: Correr para ver que falla**

Run: `node test/auth.test.js`
Expected: FAIL con `Cannot find module '../src/auth'`.

- [ ] **Step 3: Implementar `src/auth.js`**

`crypto.scryptSync(clave, sal, 64)` con sal de `crypto.randomBytes(16)`. `secreto()` lee `process.env.SESSION_SECRET` y lanza `Error` si falta o tiene menos de 16 caracteres. La comparación de la firma y la del hash usan `crypto.timingSafeEqual`, y sólo después de comprobar que las dos longitudes coinciden; **cuando no coinciden se devuelve `false`, nunca `null`** (el bug del original de Sis_Zamir no se copia).

`crearCookie` pone `Secure` sólo si `process.env.NODE_ENV === 'production'`.

- [ ] **Step 4: Implementar `scripts/hash-clave.js`**

CLI: `node scripts/hash-clave.js <contraseña>` imprime el hash por stdout. Si no recibe argumento, pide la contraseña por `readline` con la entrada oculta (`mute` de `readline`). Falla con mensaje claro si no hay `SESSION_SECRET`.

- [ ] **Step 5: Correr para ver que pasa**

Run: `node test/auth.test.js && node scripts/hash-clave.js 1234`
Expected: PASS, y luego imprime una línea `scrypt$...$...`.

- [ ] **Step 6: Commit**

```bash
git add src/auth.js test/auth.test.js scripts/hash-clave.js
git commit -m "auth: scrypt, sesiones HMAC y cookies de rol"
```

---

### Task 3: `src/sheets.js` — el cliente de Apps Script

**Files:**
- Create: `src/sheets.js`
- Test: `test/sheets.test.js`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `configurado() -> boolean`
  - `escribir(payload) -> Promise<object>` — POST a `SHEETS_WEBAPP_URL` con `{apiKey, ...payload}`.
  - `leer(accion) -> Promise<object>` — GET a `?action=ACCION&key=API_KEY`.
  - `diagnostico() -> Promise<object>`
  - `normalizar(texto) -> string`
  - `TIMEOUT_MS = 20000`
  - Todo error lanzado lleva `error.codigo` (502, 504 o 409) para que `server.js` lo use.

Contrato de `escribir(payload)`: **`payload.tipoOperacion` decide todo en el `.gs`.** Devuelve el objeto que el script respondió. Lanza si:
- no hay URL o clave → `codigo 503`;
- timeout → `codigo 504`;
- no se puede contactar o HTTP >= 400 → `codigo 502`;
- la respuesta trae `status === 'ERROR'` → `codigo 409`, con `error.message` del script.

**Contrato de `leer(accion)`:** devuelve el objeto parseado; si trae `{error:'NO_AUTORIZADO'}` lanza con `codigo 502` y mensaje de clave incorrecta.

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `test/sheets.test.js`. Estas pruebas no tocan la red: monkey-patchean `globalThis.fetch` para simular cada respuesta.

```js
const assert = require('node:assert/strict');
process.env.SHEETS_WEBAPP_URL = 'https://script.google.com/x/exec';
process.env.SHEETS_API_KEY = 'clave-de-prueba-0123456789';
const sheets = require('../src/sheets');

function responder(fn) { globalThis.fetch = fn; }
function json(cuerpo, estado = 200) {
  return async () => ({ status: estado, ok: estado < 400,
    json: async () => cuerpo, text: async () => JSON.stringify(cuerpo) });
}

// exito normal
responder(json({ status: 'OK', id: 'V1' }));
sheets.escribir({ tipoOperacion: 'X' }).then(r => {
  assert.equal(r.id, 'V1');

  // ERROR con HTTP 200 -> 409, NO exito
  responder(json({ status: 'ERROR', message: 'NO_AUTORIZADO' }));
  return sheets.escribir({ tipoOperacion: 'X' }).then(
    () => { throw new Error('debio lanzar'); },
    e => { assert.equal(e.codigo, 409); assert.match(e.message, /NO_AUTORIZADO/); }
  );
}).then(() => {
  // HTTP >= 400 -> 502
  responder(json({}, 500));
  return sheets.escribir({ tipoOperacion: 'X' }).then(
    () => { throw new Error('debio lanzar'); },
    e => assert.equal(e.codigo, 502)
  );
}).then(() => {
  // timeout -> 504
  responder(() => { const e = new Error('abort'); e.name = 'AbortError'; return Promise.reject(e); });
  return sheets.escribir({ tipoOperacion: 'X' }).then(
    () => { throw new Error('debio lanzar'); },
    e => assert.equal(e.codigo, 504)
  );
}).then(() => {
  // NO_AUTORIZADO en GET -> 502 con mensaje de clave
  responder(json({ error: 'NO_AUTORIZADO' }));
  return sheets.leer('REPORTE_VENTAS').then(
    () => { throw new Error('debio lanzar'); },
    e => { assert.equal(e.codigo, 502); assert.match(e.message, /clave/i); }
  );
}).then(() => {
  // normalizar quita acentos y baja a minusculas
  assert.equal(sheets.normalizar('  Camará  Póker '), 'camara poker');
  console.log('sheets: OK');
});
```

- [ ] **Step 2: Correr para ver que falla**

Run: `node test/sheets.test.js`
Expected: FAIL con `Cannot find module '../src/sheets'`.

- [ ] **Step 3: Implementar `src/sheets.js`**

`escribir` y `leer` comparten `pedir(url, opciones)`: `AbortController` + `setTimeout(TIMEOUT_MS)`; en `catch`, si `err.name === 'AbortError'` lanza con `codigo 504`, si no `codigo 502`. Después, si `res.status >= 400` lanza `codigo 502`. Si `leer`, el cuerpo con `{error:'NO_AUTORIZADO'}` lanza `codigo 502` con el mensaje *"La clave de la hoja no coincide. Revisa SHEETS_API_KEY en Render y en las propiedades del script."*

- [ ] **Step 4: Correr para ver que pasa**

Run: `node test/sheets.test.js`
Expected: imprime `sheets: OK`.

- [ ] **Step 5: Escribir `diagnostico()`**

Devuelve 4 pasos en este orden, cada uno con `{ paso, ok, detalle, accion }`:

1. `URL configurada` — ¿está `SHEETS_WEBAPP_URL`? `accion`: "En Render, Settings → Environment, agregá SHEETS_WEBAPP_URL con la URL /exec de tu implementación."
2. `Clave configurada` — ¿está `SHEETS_API_KEY`? Misma forma de `accion`.
3. `El script responde` — `leer('SALUD')`. `accion`: "Abrí Apps Script, verificá que pegaste Code.gs, y hacé Implementar → Nueva implementación."
4. `La clave coincide` — el paso 3 devolvió algo que no sea `NO_AUTORIZADO`. `accion`: "La clave del script (propiedad SHEETS_API_KEY) tiene que ser idéntica a la de Render. Si no, regenerala con generarClaveCompartida()."

`diagnostico()` nunca lanza: si `leer` falla, el paso 3 queda `ok:false` con el mensaje del error y el resto se marca `ok:false` con `detalle:'No se pudo comprobar'`.

- [ ] **Step 6: Correr para ver que pasa**

Run: `node test/sheets.test.js && node -e "require('./src/sheets').diagnostico().then(d=>console.log(JSON.stringify(d,null,2)))"`
Expected: imprime el JSON con los 4 pasos, `ok:false` porque no hay red.

- [ ] **Step 7: Commit**

```bash
git add src/sheets.js test/sheets.test.js
git commit -m "sheets: cliente de Apps Script con timeout y deteccion de ERROR 200"
```

---

### Task 4: `src/estados.js` — transiciones y permisos (datos puros)

Existe separado de `ventas.js` para que la tabla sea legible y verificable sin tocar la red.

**Files:**
- Create: `src/estados.js`
- Test: `test/estados.test.js`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `ESTADOS = ['BORRADOR','CONFIRMADA','CERRADA','ANULADA']`
  - `puedeTransitar({rol, desde, hasta}) -> boolean`
  - `puedeEditarCosto(rol, estado) -> boolean`
  - `puedeVerCosto(rol) -> boolean`
  - `explicarTransicion({rol, desde, hasta}) -> string` — motivo en español cuando se rechaza.

**La tabla de transiciones (fija, es el contrato):**

| desde \ hacia | BORRADOR | CONFIRMADA | CERRADA | ANULADA |
|---|---|---|---|---|
| BORRADOR · TIENDA | — | sí | no | no |
| BORRADOR · DUENO | — | sí | sí | sí |
| CONFIRMADA · TIENDA | sí | — | no | no |
| CONFIRMADA · DUENO | sí | — | sí | sí |
| CERRADA · TIENDA | no | no | — | no |
| CERRADA · DUENO | no | sí (reabrir) | — | sí |
| ANULADA · cualquiera | no | no | no | — |

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `test/estados.test.js` recorriendo la tabla entera, celda por celda:

```js
const assert = require('node:assert/strict');
const e = require('../src/estados');

const esperado = {
  'BORRADOR/TIENDA':   { BORRADOR: false, CONFIRMADA: true,  CERRADA: false, ANULADA: false },
  'BORRADOR/DUENO':    { BORRADOR: false, CONFIRMADA: true,  CERRADA: true,  ANULADA: true  },
  'CONFIRMADA/TIENDA': { BORRADOR: true,  CONFIRMADA: false, CERRADA: false, ANULADA: false },
  'CONFIRMADA/DUENO':  { BORRADOR: true,  CONFIRMADA: false, CERRADA: true,  ANULADA: true  },
  'CERRADA/TIENDA':    { BORRADOR: false, CONFIRMADA: false, CERRADA: false, ANULADA: false },
  'CERRADA/DUENO':     { BORRADOR: false, CONFIRMADA: true,  CERRADA: false, ANULADA: true  },
  'ANULADA/TIENDA':    { BORRADOR: false, CONFIRMADA: false, CERRADA: false, ANULADA: false },
  'ANULADA/DUENO':     { BORRADOR: false, CONFIRMADA: false, CERRADA: false, ANULADA: false },
};

for (const clave of Object.keys(esperado)) {
  const [desde, rol] = clave.split('/');
  for (const hasta of e.ESTADOS) {
    assert.equal(
      e.puedeTransitar({ rol, desde, hasta }),
      esperado[clave][hasta],
      `${rol} no debería poder ir de ${desde} a ${hasta}`
    );
  }
}

// el costo solo se edita en borrador, y solo el dueño lo ve
assert.equal(e.puedeEditarCosto('TIENDA', 'BORRADOR'), true);
assert.equal(e.puedeEditarCosto('TIENDA', 'CONFIRMADA'), false);
assert.equal(e.puedeEditarCosto('DUENO', 'CONFIRMADA'), false);
assert.equal(e.puedeVerCosto('DUENO'), true);
assert.equal(e.puedeVerCosto('TIENDA'), false);

// el motivo es explicito
assert.match(e.explicarTransicion({ rol: 'TIENDA', desde: 'CONFIRMADA', hasta: 'CERRADA' }), /cerrar/i);
assert.match(e.explicarTransicion({ rol: 'TIENDA', desde: 'BORRADOR', hasta: 'CERRADA' }), /cerrar/i);
assert.match(e.explicarTransicion({ rol: 'TIENDA', desde: 'BORRADOR', hasta: 'ANULADA' }), /anular/i);
```

- [ ] **Step 2: Correr para ver que falla**

Run: `node test/estados.test.js`
Expected: FAIL con `Cannot find module '../src/estados'`.

- [ ] **Step 3: Implementar `src/estados.js`**

La tabla como objeto literal de objetos, leída con `TABLA[desde][rol][hasta]`. `explicarTransicion` devuelve el motivo: si `hasta === 'CERRADA'` y el rol no es `DUENO`, "Sólo el dueño puede cerrar una tienda al cobrar."; si `hasta === 'ANULADA'`, "Sólo el dueño puede anular una venta."; si `desde === 'CERRADA'`, "La venta está cerrada. Que la reabra el dueño."; si no, "Una venta anulada no se vuelve a abrir."

- [ ] **Step 4: Correr para ver que pasa**

Run: `node test/estados.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/estados.js test/estados.test.js
git commit -m "estados: tabla de transiciones y permisos por rol"
```

---

### Task 5: `src/ledger.js` — leer las hojas y resumir

**Files:**
- Create: `src/ledger.js`
- Test: `test/ledger.test.js`

**Interfaces:**
- Consumes: `sheets.escribir(payload)`, `sheets.leer(accion)` de la Tarea 3; `money.resumenVentas` de la Tarea 1.
- Produces:
  - `nuevoId(prefijo) -> string`
  - `listarTiendas() -> Promise<[{idTienda, nombre, empleados, pctComision, activa}]>`
  - `listarEmpleados() -> Promise<[{idEmpleado, nombre, idTienda, activo}]>`
  - `listarVentas({desde, hasta, idTienda}) -> Promise<[venta]>` — cada venta con `{idVenta, fecha, idTienda, tienda, idEmpleado, vendedor, moneda, tcDecimas, ajusteUsdCents, gananciaBsCents, comisionBsCents, netoDuenoBsCents, totalCobradoUsdCents, estado, notas, lineas, unidades}`.
  - `listarLineasDe(idVenta) -> Promise<[linea]>`
  - `listarCatalogo({q}) -> Promise<[producto]>`
  - `listarCierres({idTienda, desde, hasta}) -> Promise<[cierre]>`
  - `listarTc({desde, hasta}) -> Promise<[registro]>`
  - `consolidar({desde, hasta, idTienda}) -> Promise<object>` — `{resumen, ventas, tiendas}`
  - `normalizar(texto) -> string` — reexportado de `sheets`.

**Reglas de normalización:** todo número viene de Sheets como texto o float. `num(v)` devuelve `0` si no es finito; los centavos llegan como enteros desde el `.gs` y no se reescalan; las fechas llegan ISO y `dia = fecha.slice(0,10)`.

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `test/ledger.test.js` con `sheets` mockeado (interceptando `sheets.escribir` y `sheets.leer` con funciones que devuelven filas crudas de hoja):

```js
const assert = require('node:assert/strict');
const sheets = require('../src/sheets');
const ledger = require('../src/ledger');

const VENTAS_CRUDAS = [
  // cabecera: IdVenta Fecha IdTienda Tienda IdEmpleado Vendedor Moneda TcDecimas
  //           GananciaUsdCents AjusteUsdCents GananciaBsCents ComisionBsCents
  //           NetoDuenoBsCents TotalCobradoUsdCents Estado Notas IdCierre
  ['V1','2026-10-08','T1','Sucursal Uno','E1','Camila','BS','725',
   '4000','500','25375','7500','17875','34000','CONFIRMADA','le regalé un vidrio',''],
  ['V2','2026-10-08','T1','Sucursal Uno','E2','Andre','USD','700',
   '-1000','0','-7000','0','-7000','20000','CERRADA','',''],
  ['V3','2026-10-07','T2','Sucursal Dos','E3','Miros','BS','730',
   '90000','0','6570000','1971000','4599000','90000','BORRADOR','',''],
];

const anteriores = sheets.leer;
sheets.leer = async (accion) => {
  if (accion === 'REPORTE_VENTAS') return { status: 'OK', ventas: VENTAS_CRUDAS };
  if (accion === 'REPORTE_TIENDAS') return { status: 'OK', filas: [
    ['T1','Sucursal Uno','Camila|Andre','3000','','1'],
    ['T2','Sucursal Dos','Miros','2500','','1'],
  ]};
  if (accion === 'REPORTE_EMPLEADOS') return { status: 'OK', filas: [
    ['E1','Camila','T1','1'], ['E2','Andre','T1','1'], ['E3','Miros','T2','1'],
  ]};
  return { status: 'OK', filas: [] };
};

(async () => {
  const ventas = await ledger.listarVentas({ desde: '2026-10-01', hasta: '2026-10-31' });
  assert.equal(ventas.length, 3);

  // los enteros llegan bien, sin reescalar
  assert.equal(ventas[0].gananciaBsCents, 25375);
  assert.equal(ventas[0].ajusteUsdCents, 500);
  assert.equal(ventas[0].estado, 'CONFIRMADA');
  assert.equal(ventas[0].dia, '2026-10-08');
  assert.equal(ventas[0].notas, 'le regalé un vidrio');

  // filtro por rango
  assert.equal((await ledger.listarVentas({ desde: '2026-10-08', hasta: '2026-10-08' })).length, 2);

  // filtro por tienda
  assert.equal((await ledger.listarVentas({ idTienda: 'T2' })).length, 1);

  // resumen: la comision de V2 es 0 aunque su comision guardada sea 0 y la ganancia negativa
  const c = await ledger.consolidar({ desde: '2026-10-01', hasta: '2026-10-31' });
  assert.equal(c.resumen.cantidadVentas, 3);
  assert.equal(c.resumen.totalGananciaBsCents, 25375 - 7000 + 6570000);
  assert.equal(c.resumen.totalComisionBsCents, 7500 + 0 + 1971000);
  // T1 tiene 1 venta CONFIRMADA sin cerrar -> 1 pendiente
  const t1 = c.resumen.porTienda.find(t => t.idTienda === 'T1');
  assert.equal(t1.pendientes, 1);
  const t2 = c.resumen.porTienda.find(t => t.idTienda === 'T2');
  assert.equal(t2.pendientes, 0);   // BORRADOR todavia no esta pendiente de cobro

  // las 2 tiendas vienen con su % de comision para pintar el consolidado
  assert.equal(c.tiendas.length, 2);
  assert.equal(c.tiendas[0].pctComision, 3000);

  sheets.leer = anteriores;
  console.log('ledger: OK');
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Correr para ver que falla**

Run: `node test/ledger.test.js`
Expected: FAIL con `Cannot find module '../src/ledger'`.

- [ ] **Step 3: Implementar `src/ledger.js`**

`listarVentas` llama `sheets.leer('REPORTE_VENTAS')` con `desde`/`hasta`/`idTienda` en la query. Filtra en el servidor (por si la hoja devuelve de más) con `dia >= desde && dia <= hasta` y `idTienda` si viene.

`consolidar` hace las tres lecturas (`REPORTE_VENTAS`, `REPORTE_TIENDAS`, `REPORTE_EMPLEADOS`) y devuelve `{resumen: money.resumenVentas(ventas), ventas, tiendas}`.

`listarVentas` devuelve `lineas: []` siempre; las líneas se piden aparte con `listarLineasDe(idVenta)` (`REPORTE_LINEAS?idVenta=`), porque el resumen no las necesita y traerlas siempre multiplicaría el costo de Sheets.

- [ ] **Step 4: Correr para ver que pasa**

Run: `node test/ledger.test.js`
Expected: imprime `ledger: OK`.

- [ ] **Step 5: Commit**

```bash
git add src/ledger.js test/ledger.test.js
git commit -m "ledger: lectura de las 7 hojas y consolidado"
```

---

### Task 6: `src/catalogo.js` — búsqueda y precios de referencia

**Files:**
- Create: `src/catalogo.js`
- Test: `test/catalogo.test.js`

**Interfaces:**
- Consumes: `sheets.leer`, `sheets.escribir`, `sheets.normalizar`.
- Produces:
  - `buscar(texto, {limite = 30} = {}) -> Promise<[{idProducto, marca, modelo, precioRefUsdCents, specs}]>`
  - `obtener(idProducto) -> Promise<producto|null>`
  - `precioSugerido({idProducto, moneda, tcDecimas}) -> Promise<number|null>` — centavos de la moneda pedida.
  - `guardarPrecio(idProducto, precioUsdCents) -> Promise<void>`

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `test/catalogo.test.js`:

```js
const assert = require('node:assert/strict');
const sheets = require('../src/sheets');
const catalogo = require('../src/catalogo');

const CRUDAS = [
  // IdProducto Marca Modelo PrecioRefUsdCents Specs Activo
  ['P1','Samsung','Galaxy A54 5G',34_000,'{"so":"8GB","ram":6}','1'],
  ['P2','Xiaomi','Redmi Note 13',18_500,'{"so":"13"}','1'],
  ['P3','Apple','iPhone 12',52_000,'{"so":"16"}','0'],   // inactivo
];

const anteriores = sheets.leer;
sheets.leer = async () => ({ status: 'OK', filas: CRUDAS });

(async () => {
  // busqueda insensible a acentos y mayusculas
  const r = await catalogo.buscar('samsung');
  assert.equal(r.length, 1);
  assert.equal(r[0].modelo, 'Galaxy A54 5G');

  // parcial en el medio de la cadena
  assert.equal((await catalogo.buscar('note')).length, 1);

  // acentos: "Xiaomi" buscado como "xiaomi" con tilde no aplica, pero "Camara" -> "camara" si
  const conAcento = await catalogo.buscar('a54');
  assert.equal(conAcento.length, 1);

  // los inactivos no salen en la busqueda
  assert.equal((await catalogo.buscar('iphone')).length, 0);
  assert.equal((await catalogo.buscar('iphone', { incluirInactivos: true })).length, 1);

  // precio sugerido: misma cifra en USD, convertido a Bs si se pide en Bs
  assert.equal(await catalogo.precioSugerido({ idProducto: 'P1', moneda: 'USD', tcDecimas: 725 }), 34_000);
  assert.equal(await catalogo.precioSugerido({ idProducto: 'P1', moneda: 'BS', tcDecimas: 725 }), 246_500);
  assert.equal(await catalogo.precioSugerido({ idProducto: 'P9', moneda: 'USD', tcDecimas: 725 }), null);

  sheets.leer = anteriores;
  console.log('catalogo: OK');
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Correr para ver que falla**

Run: `node test/catalogo.test.js`
Expected: FAIL con `Cannot find module '../src/catalogo'`.

- [ ] **Step 3: Implementar `src/catalogo.js`**

Caché en memoria con TTL de 60 s (igual idea que `inventory.js` de Sis_Zamir), y una promesa `enCurso` compartida para que dos peticiones simultáneas no hagan dos llamadas a la hoja.

`buscar` compara con `sheets.normalizar`: coincidencia exacta primero, luego parcial bidireccional. Filtra `activo === '1'` salvo que venga `incluirInactivos`.

`guardarPrecio` llama `sheets.escribir({tipoOperacion:'GUARDAR_PRECIO', idProducto, precioUsdCents})` y luego limpia la caché.

- [ ] **Step 4: Correr para ver que pasa**

Run: `node test/catalogo.test.js`
Expected: imprime `catalogo: OK`.

- [ ] **Step 5: Commit**

```bash
git add src/catalogo.js test/catalogo.test.js
git commit -m "catalogo: busqueda y precios de referencia con cache"
```

---

### Task 7: `src/ventas.js` — validación, cálculo, idempotencia y estados

Esta es la tarea con más carga. El cálculo ya existe (Tarea 1); aquí se valida la entrada y
se decide si la venta se guarda.

**Files:**
- Create: `src/ventas.js`
- Test: `test/idempotencia.test.js`

**Interfaces:**
- Consumes: `money` (T1), `estados` (T4), `ledger` (T5), `sheets` (T3), `catalogo` (T6).
- Produces:
  - `CLAVE_VIGENCIA_MS = 30 * 60 * 1000`
  - `preparar({sesion, cuerpo}) -> { venta, lineas }` — valida, normaliza y calcula. **No escribe.** Lanza `Error` con `codigo 400` y `campo` si algo no cuadra. Es lo que usa `POST /api/ventas/preview`.
  - `guardar({sesion, cuerpo}) -> Promise<{venta, repetida}>` — valida, escribe venta + líneas + `TcDia` en una sola operación, y devuelve la respuesta.
  - `cambiarEstado({sesion, idVenta, hasta}) -> Promise<{venta}>`
  - `operacionRecordada(clave) -> object|null`
  - `recordarOperacion(clave, respuesta) -> void`
  - `limpiarOperaciones() -> void` — para las pruebas.

**Validaciones de `preparar` (todas lanzan 400 con `campo`):**

- `idEmpleado` obligatorio y debe pertenecer a la tienda de la sesión. **El `idTienda` del cuerpo se ignora siempre.**
- `moneda` ∈ `{'BS','USD'}`.
- `tcDecimas` entero `> 0` (se acepta `"7,25"` y se convierte con `money.toTcDecimas`).
- `lineas` array no vacío, cada una con `cantidad >= 1` y `precio` y `costo` no negativos.
- `ajuste` `>= 0`.
- `notas` texto de hasta 500 caracteres, saneado.

Cuando `sesion.rol === 'TIENDA'` y la venta ya existe en estado distinto de `BORRADOR`, el
costo no se acepta: se conserva el costo guardado.

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `test/idempotencia.test.js`. Mockea `sheets.escribir` contando llamadas, y `ledger.listarVentas` devolviendo vacío.

```js
const assert = require('node:assert/strict');
const sheets = require('../src/sheets');
const ventas = require('../src/ventas');

let escrituras = [];
const anteriorEscribir = sheets.escribir;
sheets.escribir = async (payload) => {
  escrituras.push(payload);
  return { status: 'OK', id: 'V1', duplicada: false };
};

const sesion = { rol: 'TIENDA', idTienda: 'T1', idEmpleado: 'E1', nombre: 'Camila' };

const cuerpo = {
  idEmpleado: 'E1',
  idTienda: 'T2',            // <- intenta colarse en otra tienda
  moneda: 'USD',
  tipoCambio: '7,25',
  lineas: [{ modelo: 'Galaxy A54', cantidad: 1, precio: '340', costo: '300' }],
  ajuste: '5',
  notas: 'le regalé un vidrio',
  claveIdempotencia: 'abc123def456',
};

(async () => {
  // 1) el idTienda del cuerpo se ignora: se usa el de la sesion
  const p = await ventas.preparar({ sesion, cuerpo });
  assert.equal(p.venta.idTienda, 'T1');
  assert.equal(p.venta.tcDecimas, 725);
  assert.equal(p.venta.gananciaBrutaUsdCents, 40_00);
  assert.equal(p.venta.ajusteUsdCents, 5_00);
  assert.equal(p.venta.gananciaNetaUsdCents, 35_00);
  assert.equal(p.venta.gananciaBsCents, 25_375);
  assert.equal(p.venta.comisionBsCents, 7_613);   // 25.375 x 30% = 7.612,5 -> 7.613
  assert.equal(p.venta.netoDuenoBsCents, 17_762);
  assert.equal(p.venta.estado, 'BORRADOR');
  assert.equal(p.venta.vendedor, 'Camila');

  // 2) validaciones
  await assert.rejects(
    () => ventas.preparar({ sesion, cuerpo: { ...cuerpo, tipoCambio: '0' } }),
    e => e.codigo === 400 && /tipo de cambio/i.test(e.message)
  );
  await assert.rejects(
    () => ventas.preparar({ sesion, cuerpo: { ...cuerpo, linea: undefined, lineas: [] } }),
    e => e.codigo === 400
  );
  await assert.rejects(
    () => ventas.preparar({ sesion, cuerpo: { ...cuerpo, lineas: [{ modelo: 'X', cantidad: 0, precio: '1', costo: '1' }] } }),
    e => e.codigo === 400
  );
  await assert.rejects(
    () => ventas.preparar({ sesion, cuerpo: { ...cuerpo, idEmpleado: 'E9' } }),
    e => e.codigo === 400 && /empleado/i.test(e.message)
  );

  // 3) idempotencia: misma clave dos veces -> una sola escritura
  ventas.limpiarOperaciones();
  escrituras = [];
  const a = await ventas.guardar({ sesion, cuerpo });
  const b = await ventas.guardar({ sesion, cuerpo });
  assert.equal(b.repetida, true);
  assert.equal(b.venta.idVenta, a.venta.idVenta);
  assert.equal(escrituras.length, 1);   // UNA sola ida a la hoja
  assert.equal(escrituras[0].tipoOperacion, 'GUARDAR_VENTA');
  assert.equal(escrituras[0].venta.claveIdempotencia, 'abc123def456');

  // 4) la hoja tambien deduplica: si responde duplicada:true, se avisa y no se reintenta
  ventas.limpiarOperaciones();
  escrituras = [];
  sheets.escribir = async (payload) => {
    escrituras.push(payload);
    return { status: 'OK', id: 'V9', duplicada: true };
  };
  const c = await ventas.guardar({ sesion, cuerpo });
  assert.equal(c.repetida, true);
  assert.equal(escrituras.length, 1);

  sheets.escribir = anteriorEscribir;
  console.log('idempotencia: OK');
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Correr para ver que falla**

Run: `node test/idempotencia.test.js`
Expected: FAIL con `Cannot find module '../src/ventas'`.

- [ ] **Step 3: Implementar `src/ventas.js`**

**Memo de idempotencia:** `Map` con clave `` `venta:${claveIdempotencia}` `` y valor `{expira, respuesta}`. `operacionRecordada` devuelve la respuesta si no expiró, y borra la entrada si expiró. `recordarOperacion` si el Map llegó a 500 entradas borra la más vieja antes de insertar. `limpiarOperaciones()` vacía el Map (lo usan las pruebas).

`guardar` en este orden, sin cambiarlo:

1. Validar `claveIdempotencia` contra `/^[A-Za-z0-9_-]{8,64}$/`. Si no viene, generar una con `ledger.nuevoId('k')`.
2. **`operacionRecordada(clave)` ANTES de validar el cuerpo** — si existe, devolver `{...previa, repetida:true}`. Un reintento no debe fallar por validación.
3. `preparar({sesion, cuerpo})`.
4. `sheets.escribir({tipoOperacion:'GUARDAR_VENTA', venta: {...}, lineas: [...], tcDia: {...}})`. Una sola llamada: el `.gs` escribe las tres hojas bajo un solo lock.
5. Si la respuesta trae `duplicada === true`, devolver `{venta: {...preparada, idVenta: respuesta.id}, repetida:true}` y **no** volver a escribir.
6. `recordarOperacion(clave, respuesta)`.
7. Devolver `{venta: {...preparada, idVenta: respuesta.id, estado:'BORRADOR'}, repetida:false}`.

**Precios en Bs → USD:** si `moneda === 'BS'`, cada línea llega con `precio` en Bs y `costo` en USD. Se calcula `precioUsdCents = money.bsAUsdCents(toCents(precio), tcDecimas)` y `costoUnitarioUsdCents = toCents(costo)`.

**`cambiarEstado`:** carga la venta, valida la transición con `estados.puedeTransitar({rol: sesion.rol, desde: venta.estado, hasta})`; si no, lanza `Error` con `codigo 404` y mensaje de `estados.explicarTransicion` (**404, no 403**). Si `desde === 'CERRADA'` y `hasta === 'CONFIRMADA'`, exige `motivo` de 10 caracteres o más. Después `sheets.escribir({tipoOperacion:'CAMBIAR_ESTADO', idVenta, hasta, motivo})`.

- [ ] **Step 4: Correr para ver que pasa**

Run: `node test/idempotencia.test.js`
Expected: imprime `idempotencia: OK`.

- [ ] **Step 5: Commit**

```bash
git add src/ventas.js test/idempotencia.test.js
git commit -m "ventas: validacion, calculo e idempotencia de dos capas"
```

---

### Task 8: `src/cierres.js` — cerrar tienda y generar el recibo

**Files:**
- Create: `src/cierres.js`
- Test: `test/cierres.test.js`

**Interfaces:**
- Consumes: `money`, `ledger`, `sheets`.
- Produces:
  - `previsualizar({idTienda, dia}) -> Promise<{tienda, dia, ventas, cantidadVentas, pendientes, totalCobradoBsCents, totalGananciaBsCents, totalComisionBsCents, totalNetoDuenoBsCents, saldoPendienteBsCents}>`
  - `cerrar({sesion, idTienda, dia, pagadoBsCents}) -> Promise<{cierre, ventasCerradas}>` — exige `sesion.rol === 'DUENO'`, si no lanza `codigo 404`.

`saldoPendienteBsCents` = suma de `netoDuenoBsCents` de las ventas `CONFIRMADA` de esa tienda y ese día (las `BORRADOR` no se cobran todavía, las `CERRADA` ya se pagaron).

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `test/cierres.test.js`:

```js
const assert = require('node:assert/strict');
const sheets = require('../src/sheets');
const ledger = require('../src/ledger');
const cierres = require('../src/cierres');

const ventas = [
  { idVenta: 'V1', idTienda: 'T1', dia: '2026-10-08', estado: 'CONFIRMADA',
    netoDuenoBsCents: 17_762, comisionBsCents: 7_613, gananciaBsCents: 25_375 },
  { idVenta: 'V2', idTienda: 'T1', dia: '2026-10-08', estado: 'BORRADOR',
    netoDuenoBsCents: 90_000, comisionBsCents: 30_000, gananciaBsCents: 120_000 },
  { idVenta: 'V3', idTienda: 'T1', dia: '2026-10-08', estado: 'CERRADA',
    netoDuenoBsCents: 5_000, comisionBsCents: 2_000, gananciaBsCents: 7_000 },
];

const guardadas = { ventas: [], cierres: [] };
const aListar = ledger.listarVentas, aEscribir = sheets.escribir;
ledger.listarVentas = async () => ventas;
sheets.escribir = async (p) => { guardadas.ventas.push(p); return { status: 'OK', id: 'C1' }; };

(async () => {
  const p = await cierres.previsualizar({ idTienda: 'T1', dia: '2026-10-08' });
  assert.equal(p.cantidadVentas, 3);
  assert.equal(p.pendientes, 1);                          // solo V1
  assert.equal(p.saldoPendienteBsCents, 17_762);           // V1 nada mas
  assert.equal(p.totalComisionBsCents, 7_613);

  // un encargado no puede cerrar
  await assert.rejects(
    () => cierres.cerrar({ sesion: { rol: 'TIENDA', idTienda: 'T1' }, idTienda: 'T1', dia: '2026-10-08', pagadoBsCents: 17_762 }),
    e => e.codigo === 404
  );

  // el dueño cierra: una sola escritura, con el recibo y el paso a cerrada de V1
  const r = await cierres.cerrar({
    sesion: { rol: 'DUENO', idTienda: null, nombre: 'Dueño' },
    idTienda: 'T1', dia: '2026-10-08', pagadoBsCents: 17_762,
  });
  assert.equal(guardadas.ventas.length, 1);
  assert.equal(guardadas.ventas[0].tipoOperacion, 'CERRAR_TIENDA');
  assert.deepEqual(guardadas.ventas[0].idsVentas, ['V1']);   // solo las CONFIRMADA
  assert.equal(guardadas.ventas[0].cierre.totalNetoDuenoBsCents, 17_762);
  assert.equal(guardadas.ventas[0].cierre.pagadoBsCents, 17_762);
  assert.equal(guardadas.ventas[0].cierre.saldoBsCents, 0);
  assert.equal(r.ventasCerradas, 1);

  // no hay nada confirmado -> 400, no se genera recibo en blanco
  ventas.length = 0; ventas.push({ idVenta: 'V9', idTienda: 'T1', dia: '2026-10-08', estado: 'BORRADOR', netoDuenoBsCents: 1 });
  await assert.rejects(
    () => cierres.cerrar({ sesion: { rol: 'DUENO' }, idTienda: 'T1', dia: '2026-10-08', pagadoBsCents: 0 }),
    e => e.codigo === 400
  );

  ledger.listarVentas = aListar; sheets.escribir = aEscribir;
  console.log('cierres: OK');
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Correr para ver que falla**

Run: `node test/cierres.test.js`
Expected: FAIL con `Cannot find module '../src/cierres'`.

- [ ] **Step 3: Implementar `src/cierres.js`**

`cerrar` en este orden: validar rol (404 si no es dueño) → `previsualizar` → si `pendientes === 0` lanzar 400 *"No hay ventas confirmadas para cerrar en esa tienda y ese día."* → calcular `saldo = totalNetoDuenoBsCents - pagadoBsCents` → una sola llamada `sheets.escribir({tipoOperacion:'CERRAR_TIENDA', idsVentas, cierre:{...}})`.

- [ ] **Step 4: Correr para ver que pasa**

Run: `node test/cierres.test.js`
Expected: imprime `cierres: OK`.

- [ ] **Step 5: Commit**

```bash
git add src/cierres.js test/cierres.test.js
git commit -m "cierres: cierre diario de tienda con recibo y saldo"
```

---

### Task 9: `server.js` y el corredor de pruebas

**Files:**
- Create: `server.js`
- Create: `test/run.js`
- Create: `.env.example`
- Create: `.gitignore`
- Create: `package.json`

**Interfaces:**
- Consumes: todos los `src/`.
- Produces: servidor Express en `PORT || 10000`. Todas las rutas de `/api` de la sección 10 del spec.

**Rutas, con su control de rol:** exactamente las de la sección 10 del spec. Además:

- `GET /api/ventas/:id/lineas` (sesión) — sin costo si el rol no es dueño.
- `POST /api/ventas/:id/eliminar` (dueño) — sólo si el estado es `BORRADOR`; en otro caso 404.
- `GET /api/empleados` (sesión) — los empleados **de la tienda de la sesión**. Es lo que
  llena el selector de "quién vendió" en la vista `#/nueva`.
- `GET /api/tc-hoy` (sesión) — el TC que registró hoy el empleado de la sesión, o `null`.
  Es lo que prellena el campo de TC en la vista `#/nueva`.
- `GET /api/catalogo/:id/precio-sugerido?moneda=&tc=` (sesión) — envuelve
  `catalogo.precioSugerido`.

- [ ] **Step 1: Crear `package.json`, `.env.example` y `.gitignore`**

`package.json`:

```json
{
  "name": "sis-jhessel",
  "version": "1.0.0",
  "private": true,
  "description": "Control de ventas, ganancias y comisiones por tienda",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js",
    "pruebas": "node test/run.js",
    "hash-clave": "node scripts/hash-clave.js",
    "sembrar-catalogo": "node scripts/sembrar-catalogo.js"
  },
  "engines": { "node": ">=20" },
  "dependencies": { "dotenv": "^16.4.7", "express": "^4.21.2" }
}
```

`.env.example`:

```
PORT=10000
NODE_ENV=production
SESSION_SECRET=cambiar-por-32-caracteres-aleatorios
DUENO_PIN_HASH=scrypt$...
SHEETS_WEBAPP_URL=https://script.google.com/macros/s/.../exec
SHEETS_API_KEY=...
```

`.gitignore`: `node_modules/`, `.env`, `data/`, `*.log`.

- [ ] **Step 2: Crear `test/run.js`**

Ejecuta los cinco archivos de prueba en proceso hijo, imprime un resumen y sale con código 1 si alguno falla:

```js
const { spawnSync } = require('node:child_process');
const archivos = ['money', 'auth', 'estados', 'ledger', 'catalogo', 'idempotencia', 'cierres', 'sheets'];
let fallos = 0;
for (const a of archivos) {
  const r = spawnSync(process.execPath, [`test/${a}.test.js`], { stdio: 'inherit' });
  if (r.status !== 0) { console.error(`FALLO: ${a}.test.js`); fallos++; }
}
console.log(fallos ? `\n${fallos} archivo(s) con fallos` : '\nTodo verde');
process.exit(fallos ? 1 : 0);
```

- [ ] **Step 3: Correr el corredor para ver que pasa**

Run: `npm run pruebas`
Expected: `Todo verde`.

- [ ] **Step 4: Implementar `server.js`**

Arranque con `require('dotenv').config()`, `app.set('trust proxy', 1)`, `app.disable('x-powered-by')`, `express.json({limit:'32kb'})`, y las cabeceras `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy: geolocation=(), microphone=(), camera=()`.

Rate limit en memoria por IP: `limitar(tope, ventanaMs)`, con limpieza `setInterval(...).unref()`.

Helpers de validación: `texto(valor, max)` quita `\u0000-\u001f\u007f`, hace `trim` y `slice`; `entero(v)`; `fecha(v)` valida `/^\d{4}-\d{2}-\d{2}$/`; `responderError(res, e)` usa `e.codigo || 500` y loguea si es >= 500; `sinCosto(linea, rol)` borra `costoUnitarioUsdCents` si el rol no es dueño.

**Middleware de tienda:** cada ruta que toca datos lleva `exigirSesion`. Ninguna acepta `idTienda` del cuerpo: se lee `req.sesion.idTienda`. `POST /api/ventas` llama a `ventas.guardar({sesion: req.sesion, cuerpo: req.body})`.

**Login:** `POST /api/auth/login` con `limitar(10, 60000)`. Cuerpo `{idTienda}` para una tienda (busca el `ClaveHash` en `Tiendas` y compara con `auth.verificarClave`) o `{dueno:true}` (compara contra `process.env.DUENO_PIN_HASH`). Si la tienda está inactiva, responde el mismo 401 que si la contraseña estuviera mal. Toda respuesta de login devuelve `Set-Cookie` con `auth.crearCookie(auth.firmar({...sesion, exp: Date.now() + auth.DURACION_MS}))`.

**Error handler:** `entity.parse.failed` → 400, `entity.too.large` → 413, y al final 404 JSON para `/api/*` y `sendFile(index.html)` para el resto.

Cierre: `app.listen(PUERTO, '0.0.0.0')` con log del estado y aviso si falta `SESSION_SECRET`.

- [ ] **Step 5: Verificar sintaxis y arranque**

Run:
```bash
node --check server.js && for f in src/*.js scripts/*.js test/*.js; do node --check "$f" || exit 1; done
PORT=10999 node server.js &
sleep 2 && curl -s localhost:10999/api/health && echo && curl -s localhost:10999/api/diagnostico | head -20 && kill %1
```
Expected: sintaxis sin error; `/api/health` devuelve `{"ok":true,...}`; `/api/diagnostico` devuelve los 4 pasos.

- [ ] **Step 6: Commit**

```bash
git add package.json .env.example .gitignore server.js test/run.js
git commit -m "server: rutas Express, sesion por rol y rate limit"
```

---

### Task 10: `apps-script/Code.gs` y `appsscript.json`

**Files:**
- Create: `apps-script/Code.gs`
- Create: `apps-script/appsscript.json`

**Interfaces:**
- Consumes: los payloads que mandan `ventas.guardar` y `cierres.cerrar`.
- Produces: `doGet` y `doPost` que escriben y leen las 7 hojas.

**`tipoOperacion` que el `.gs` debe conocer:**

| Operación | Efecto |
|---|---|
| `GUARDAR_VENTA` | 1 fila en `Ventas` + N filas en `VentaLineas` + 1 fila en `TcDia` |
| `CAMBIAR_ESTADO` | actualiza `Estado` (y `IdCierre`, `Notas`) de las ventas indicadas |
| `ELIMINAR_VENTA` | borra las líneas y la fila de la venta |
| `CERRAR_TIENDA` | pone `Estado='CERRADA'` y `IdCierre` en las ventas indicadas + 1 fila en `Cierres` |
| `GUARDAR_PRECIO` | actualiza `PrecioRefUsdCents` de un producto |
| `GUARDAR_TIENDA` | alta/edición de una tienda |
| `GUARDAR_EMPLEADO` | alta/baja de un empleado |
| `SEMBRAR_CATALOGO` | agrega hasta 200 productos de una vez, salteando los que ya existen |

**Lecturas (`doGet`):** `SALUD`, `REPORTE_TIENDAS`, `REPORTE_EMPLEADOS`, `REPORTE_VENTAS`, `REPORTE_LINEAS`, `REPORTE_CATALOGO`, `REPORTE_CIERRES`, `REPORTE_TC`.

- [ ] **Step 1: Escribir `appsscript.json`**

```json
{
  "timeZone": "America/La_Paz",
  "dependencies": {},
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "oauthScopes": ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/script.external_request"]
}
```

- [ ] **Step 2: Escribir `Code.gs` completo**

Estructura, en este orden:

1. **Constantes** de nombres de hoja y los 7 arrays `ENCABEZADO_*`, exactamente como están en la sección 5.3 del spec.
2. `claveEsValida(recibida)` — lee `SHEETS_API_KEY` de `PropertiesService`, compara longitudes y luego XOR de charCodes.
3. `generarClaveCompartida()` — dos UUIDs concatenados, `Logger.log('SHEETS_API_KEY = ' + clave)`.
4. `doGet(e)` — `SALUD` **antes** de la autenticación; después `claveEsValida(e.parameter.key)`; después despacha la lectura.
5. `doPost(e)` — parsea, valida `apiKey`, y responde **antes de tomar el lock** a cualquier lectura. Para escritura: `LockService.getScriptLock()` con `waitLock(15000)` y `finally { lock.releaseLock(); }`.
6. `obtenerHoja(ss, nombre, encabezados)`, `asegurarEncabezados`, `columna(cab, nombre, porDefecto)`, `celda(fila, i)`.
7. `filaYaRegistrada(ss, hoja, 'ClaveIdempotencia', clave)` — **`columna(cab,'ClaveIdempotencia',-1)`**; si da `-1` loguea y devuelve `null` (es preferible no deduplicar que deduplicar contra la columna equivocada).
8. `sanitizarTexto(v)` — `slice(0,200)`, prefija `'` si empieza con `= + - @`.
9. `leerFilas(ss, nombre)` — **si `lastRow() < 2` devuelve `[]`**. Esto evita el `getRange(2, col, -1, 1)` que revienta con una hoja vacía.
10. Los handlers de cada `tipoOperacion`.

`responderJSON(o)` con `ContentService.createTextOutput(...).setMimeType(ContentService.MimeType.JSON)`.

En `doGet`, cuando la respuesta es un error de la propia API se devuelve `{status:'ERROR', message:'...'}` también con HTTP 200 — el cliente de la Tarea 3 lo detecta. Sólo `SALUD` devuelve algo que no es de error.

- [ ] **Step 3: Verificar la sintaxis del `.gs` sin ejecutarlo**

Como no hay `gs` en esta máquina, compilarlo con JavaScriptCore sin ejecutarlo:

```bash
osascript -l JavaScript -e "var f=read POSIX file 'apps-script/Code.gs'; var s=ObjC.import('AppKit').NSString.stringWithContentsOfFileEncodingError(f,4,nil).js; new Function(s); 'Code.gs: sintaxis OK'"
```
Expected: `Code.gs: sintaxis OK`.

- [ ] **Step 4: Commit**

```bash
git add apps-script/
git commit -m "Code.gs: 7 hojas por encabezado, lock y deduplicacion"
```

---

### Task 11: `public/` — la aplicación

**Files:**
- Create: `public/index.html`
- Create: `public/app.css`
- Create: `public/app.js`

**Interfaces:**
- Consumes: la API de la Tarea 9.
- Produces: una sola página que cambia de vista según la ruta del hash.

Vistas: `#/login`, `#/inicio`, `#/nueva`, `#/ventas`, `#/catalogo`, `#/consolidado`, `#/cierre`, `#/ajustes`.

Un encargado que escriba `#/consolidado` a mano recibe una vista de "no disponible" y **no**
recibe datos: el servidor tampoco los manda.

- [ ] **Step 1: Escribir `index.html`**

Un `<div id="app">` vacío y los tres `<script>`/`<link>`. Los iconos son texto, no librerías.

- [ ] **Step 2: Escribir `app.css` con la paleta del spec**

```css
:root {
  --primario: #362968;
  --primario-claro: #4a3a8f;
  --acento: #e8933a;
  --fondo: #f7f7fb;
  --superficie: #ffffff;
  --texto: #1b1b28;
  --peligro: #c0392b;
  --exito: #1e8e5a;
}
```

Tipografía del sistema, `max-width: 980px` en el contenedor, tarjetas con `box-shadow`
suave. Botones y tarjetas con `transition: transform .2s, box-shadow .2s` y
`:hover { transform: scale(1.02) }`. Se anima **sólo `transform` y `opacity`**.

```css
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
```

- [ ] **Step 3: Escribir `app.js`**

Estructura: un objeto `estado` con `{sesion, vista, datos}`; un `api(ruta, cuerpo)` que
agrega el `credentials: 'same-origin'` y convierte cualquier respuesta no-2xx en un error con
el `error` del servidor; un `router()` que lee `location.hash` y pinta la vista; y un
`render()` por vista que arma HTML con `textContent` para todo dato del servidor
(**nunca** interpolar datos en el HTML con `innerHTML`).

Vista `#/nueva`, la más larga:

1. Select de empleados de la tienda de la sesión (`GET /api/empleados`).
2. Select de moneda `BS`/`USD` y campo de TC, prellenado con el TC del día que devuelve
   `GET /api/tc-hoy`.
3. Botón "Agregar del catálogo": busca en `GET /api/catalogo?q=` y al elegir llena modelo,
   precio de referencia y costo vacío.
4. Botón "Agregar manual": agrega una línea con modelo, cantidad, precio y costo vacíos.
5. Campos de ajuste y de notas.
6. Recuadro de totales: en cada `input` se llama a `POST /api/ventas/preview` con 400 ms de
   espera y se pinta lo que venga. **El navegador no calcula: sólo pinta.**
7. Botones "Guardar borrador" y "Confirmar venta". El de confirmar manda la misma clave de
   idempotencia: se genera una vez al abrir la vista y se reutiliza en cada intento.

Vista `#/consolidado`: una tarjeta por tienda con ventas, ganancia, comisión y neto; el
total de las 4 arriba; las ventas `CONFIRMADA` con una insignia roja de "pendiente".

Vista `#/cierre`: tienda + fecha, botón "Previsualizar" (trae el saldo), campo de lo que
paga el encargado y botón "Cerrar tienda y pagar".

Vista `#/ajustes` (sólo dueño): % de comisión por tienda, alta/baja de empleados, e
histórico de TC (`GET /api/tc-historial`).

Todas las listas van en tablas con `<caption>` y las celdas de dinero usan
`Intl.NumberFormat('es-BO', {style:'currency', currency:'BOB'})` sobre el valor **dividido
por 100** que le pasa el servidor en el campo `*Bs`.

- [ ] **Step 4: Verificar que los archivos son sintácticamente válidos**

Run:
```bash
node --check public/app.js
python3 -c "import re,sys; s=open('public/index.html').read(); [print('etiqueta sin cerrar:',t) for t in re.findall(r'<(div|section|table|form|button|main|header|footer)\b[^>]*>(?!.*?</\1>)', s, re.S)[:5]]"
```
Expected: `node --check` sin salida; el `python3` no reporta ninguna etiqueta.

- [ ] **Step 5: Commit**

```bash
git add public/
git commit -m "public: login, venta, consolidado, cierre y ajustes"
```

---

### Task 12: `scripts/sembrar-catalogo.js` y verificación final

**Files:**
- Create: `scripts/sembrar-catalogo.js`
- Modify: `README.md`

- [ ] **Step 1: Escribir `scripts/sembrar-catalogo.js`**

Lee `~/Desktop/sis_zamir/src/fichas.json` (o la ruta de `--origen`), y por cada producto
sube `{tipoOperacion:'SEMBRAR_CATALOGO', productos:[{idProducto, marca, modelo, precioRefUsdCents, specs}]}` en lotes de 200, con `sheets.escribir`. Imprime cuántos se subieron y cuántos se saltaron por estar sin precio.

Si `fichas.json` no existe, avisa y termina con código 1, sin fallar en silencio.

- [ ] **Step 2: Reescribir `README.md`**

Título del proyecto, qué hace, las 4 tiendas, cómo correrlo en local, y el **README de
despliegue completo** de la sección 12 del spec (los 8 pasos, con el aviso de que
`Code.gs` en el editor no es lo que corre).

- [ ] **Step 3: Correr toda la verificación**

```bash
npm run pruebas
node --check server.js
for f in src/*.js scripts/*.js test/*.js public/app.js; do node --check "$f" || exit 1; done
osascript -l JavaScript -e "var f=read POSIX file 'apps-script/Code.gs'; var s=ObjC.import('AppKit').NSString.stringWithContentsOfFileEncodingError(f,4,nil).js; new Function(s); 'Code.gs OK'"
PORT=10999 node server.js &
sleep 2
curl -s localhost:10999/api/health
curl -s localhost:10999/api/diagnostico
curl -s -o /dev/null -w '%{http_code}\n' localhost:10999/api/ventas   # 401 sin sesion
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:10999/api/auth/login -H 'content-type: application/json' -d '{"idTienda":"T1","clave":"mala"}'   # 401
kill %1
```
Expected: `Todo verde`; sintaxis sin error en todo; `/api/health` con `ok:true`;
`/api/diagnostico` con 4 pasos; `401` en las dos rutas protegidas.

- [ ] **Step 4: Commit final**

```bash
git add -A
git commit -m "sembrar catalogo y README con el procedimiento de despliegue"
```