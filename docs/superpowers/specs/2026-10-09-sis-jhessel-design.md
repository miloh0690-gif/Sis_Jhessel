# Sis Jhessel — diseño del sistema de ventas y comisiones

- fecha:: 2026-10-09
- tipo:: spec
- proyecto:: Sis Jhessel
- cliente:: Jhessel (4 tiendas de celulares)
- estado:: aprobado por el dueño (2026-10-09)
- repo:: https://github.com/miloh0690-gif/Sis_Jhessel

## 1. Resumen

Sistema de control de ventas, ganancias y comisiones para **4 tiendas de celulares**.
Cada tienda tiene su propia contraseña; hay un **login de dueño** que ve las 4 juntas.

El dueño pone equipos en sus tiendas. El encargado vende, cobra, y al final del día le
entrega al dueño **solo la ganancia**. La comisión del encargado se calcula sobre esa
ganancia con un **% que el dueño configura por tienda**.

No hay stock ni entradas/salidas de inventario: los equipos son del dueño y el dueño solo
necesita saber cuánto le corresponde por tienda y por día.

- **Moneda de costo:** USD (centavos de dólar). El equipo se compra en dólares.
- **Moneda de venta:** Bs o USD, la que el cliente pague.
- **Tipo de cambio:** lo teclea el encargado al vender. Se guarda **por venta**.
- **Cálculo:** 100% en el servidor, en enteros de centavos.

## 2. Los actores y qué pueden hacer

| Actor | Acceso | Puede |
|---|---|---|
| **Dueño** | login aparte, 1 contraseña | Ver las 4 tiendas, ver costo y neto, editar % de comisión por tienda, cerrar tienda (pagar), reabrir, anular, alta/baja de empleados |
| **Encargado de tienda** | login de su tienda, 1 contraseña por tienda | Ver solo su tienda, registrar venta (borrador/confirmar), editar precio y TC, editar costo **solo en borrador**, ver su comisión, ver el catálogo y editar precio de referencia |

Cada tienda tiene su propia lista de empleados. En la tienda 4 hay **dos** (Didi y Micky),
porque cada uno cobra con **su propio precio y su propio TC**. Por eso **cada venta registra
qué empleado la hizo**.

Los encargados **no pueden** cerrar tienda, borrar una venta cerrada, anular, ni ver otra tienda.

## 3. Modelo de dinero

Todos los importes viajan y se calculan como **enteros**. El navegador nunca calcula: solo
muestra lo que el servidor devuelve.

### 3.1 Unidades

- `*UsdCents` → centavos de dólar (costo, precio en USD, ajustes)
- `*BsCents` → centavos de bolivianos (ganancia convertida, comisión, neto)

### 3.2 Fórmulas autoritativas

```
// 1) cada línea, en USD (centavos)
lineaGananciaUsd = (precioUsdCents − costoUnitarioUsdCents) × cantidad

// 2) suma de líneas
gananciaBrutaUsdCents = Σ lineaGananciaUsd

// 3) ajustes (regalos, descuentos) — restan
gananciaNetaUsdCents = gananciaBrutaUsdCents − ajustesUsdCents

// 4) conversión a Bs con el TC de ESTA venta
gananciaBsCents = redondear(gananciaNetaUsdCents × tc / 100)
   // tc viene como décimas: 7,25 → 725 ; 7,25 Bs por dólar

// 5) comisión de la tienda
comisionBsCents = gananciaBsCents > 0
  ? redondear(gananciaBsCents × pctComision / 10000)   // pct en basis points: 30% → 3000
  : 0                                                   // nunca hay comisión sobre pérdida

// 6) lo que se lleva el dueño
netoDueñoBsCents = gananciaBsCents − comisionBsCents
```

### 3.3 Ejemplo verificado con el dueño

Entrada: Camila vende en toda la semana Cellular, generando **10.000 Bs de ganancia**.
Comisión de su tienda: **30%**.

```
gananciaBs   = 1.000.000 Bs-cents   (10.000 Bs)
comision     = round(1.000.000 × 3000 / 10000) = 300.000 Bs-cents = 3.000 Bs
neto dueño   = 1.000.000 − 300.000  = 700.000 Bs-cents = 7.000 Bs
```

Es exactamente lo que el dueño pidió: "de ella la comisión es de 30% así que el dueño se
queda con 7000bs".

### 3.4 Ajustes

Venta con **líneas** (celular + accesorios), un **número de ajuste** y una **nota**.

> Ejemplo real del dueño: "le regalé un vidrio"

```
ventas:
  - Samsung A54   ×1  precio 340 USD   costo 300 USD   →  +40 USD
  - Vidrio        ×1  precio   0 USD   costo   0 USD   →   +0 USD
ajuste: 5 USD  nota: "le regalé un vidrio"
ganancia neta = 35 USD   →  × TC de la venta
```

El ajuste se guarda **en USD** y la nota se guarda **texto libre**. Al entrar el ajuste,
todos los totales del recuadro se recalculan solos, en vivo.

### 3.5 Moneda y tipo de cambio

El vendedor marca **en qué moneda le pagan**. Si pagan en Bs, el precio hay que normalizarlo a
USD porque el costo está en USD:

```
precioUsdCents = round(precioBsCentavos × 100 / tcDecimas)
```

Comprobado: 700,00 Bs con `TcDecimas = 725` → `70000 × 100 / 725 = 9655` centavos USD
(96,55 USD). Es la conversión correcta porque `tcDecimas/100` son Bs por dólar.

Si la venta es en USD, `precioUsdCents` es el precio directo. El TC **igual se guarda**, y
sirve para dos cosas: dejar registrado el tipo que usó ese vendedor ese día, y convertir a Bs
el total cobrado:

```
totalCobradoBsCents = round(totalCobradoUsdCents × tcDecimas / 100)
```

El costo **siempre** se pide en USD, en cualquiera de los dos casos.

El TC se guarda como **entero en décimas** (`7,25` → `725`) para no perder precisión ni
arrastrar error de punto flotante.

**Reglas de validación en servidor:** `tc > 0` obligatorio; `0 ≤ pctComision ≤ 10000`;
cantidad `≥ 1`; `ajustesUsdCents ≥ 0`; costo `≥ 0`.

## 4. Estados de venta y cierre

```
borrador  ──confirmar──▶  confirmada  ──dueño paga──▶  cerrada
   │                          │                          │
   │ borrar (encargado)       │                          │ dueño reabre
   ▼                          ▼                          ▼
  (se va)              sigue editable             vuelve a confirmada
                                                          
anulada  ◀── dueño anula en cualquier estado (queda registrada, no se borra)
```

| Estado | Quién lo pone | Qué se puede hacer |
|---|---|---|
| `borrador` | Encargado | editar todo (incluido costo), borrar |
| `confirmada` | Encargado | editar precio, cantidad, TC, ajuste, nota. **NO editar costo** |
| `cerrada` | Dueño (al cerrar tienda) | nada, solo el dueño puede reabrir |
| `anulada` | Dueño | queda en el histórico, no se borra |

### 4.1 El cierre diario

Botón del dueño: **Cerrar tienda** (por tienda y por día).

Muestra: cuántas ventas hay, cuántas confirmadas, cuántas pendientes, total comisionado,
total neto, saldo por cobrar. El dueño confirma el pago → el sistema:

1. Marca todas las ventas de esa tienda y ese día con estado `cerrada`.
2. Escribe una fila en la hoja `Cierres` con: tienda, fecha, quién cerró, cuántas ventas,
   total comisionado, total neto, cuánto pagó el encargado, saldo.
3. Anota `IdCierre` en cada venta cerrada, para poder auditar.

**Ventas `confirmada` sin cerrar = pendientes**, se ven en rojo en el consolidado. Eso es
justo lo que el dueño pidió: lo que le falta por recoger.

## 5. Arquitectura

### 5.1 Las dos capas

```
Navegador  ──HTTP──▶  Node/Express (Render)  ──HTTPS──▶  Google Apps Script  ──▶  Google Sheets
   (muestra)             (decide, calcula,             (dicts acceso,             (los datos)
                          valida, autentica)           crea hojas, deduplica)
```

Node es el **único** que calcula. El navegador recibe números ya resueltos.
Apps Script no hace lógica de negocio: sólo traduce a filas de hoja.

Si la hoja no responde, la venta **no se confirma**: se queda en `borrador` local en el
navegador y se avisa. Nunca se reporta como guardada lo que no se guardó.

### 5.2 Módulos (`src/`)

| Archivo | Responsabilidad | Depende de |
|---|---|---|
| `money.js` | Aritmética en centavos. Parseo, redondeos, fórmulas de §3.2, resumen | — |
| `auth.js` | scrypt, sesiones HMAC, cookies, PIN de tienda y de dueño | `node:crypto` |
| `sheets.js` | Cliente HTTP de Apps Script: `GET`/`POST`, timeout, detecta `{status:'ERROR'}`, caché corto | — |
| `ledger.js` | Lectura de las 7 hojas, normalización, resumen por tienda/vendedor/día, ids | `sheets.js` |
| `catalogo.js` | Búsqueda del catálogo, edición de precio de referencia, semilla desde Sis_Zamir | `sheets.js` |
| `ventas.js` | Validación de la venta, cálculo, idempotencia, transiciones de estado | `money.js`, `ledger.js`, `sheets.js` |
| `cierres.js` | Cierre de tienda, recibo, saldos | `money.js`, `ledger.js`, `sheets.js` |

Cada módulo se puede leer y probar sin abrir los demás. `money.js` no depende de nada.

### 5.3 Las 7 hojas

Todas con columnas buscadas **por encabezado**, nunca por posición.

| Hoja | Columnas | Quién escribe |
|---|---|---|
| `Tiendas` | `IdTienda`, `Nombre`, `Empleados`, `PctComision`, `ClaveHash`, `Activa`, `CreadoEn` | dueño |
| `Empleados` | `IdEmpleado`, `Nombre`, `IdTienda`, `Activo`, `CreadoEn` | dueño |
| `Catalogo` | `IdProducto`, `Marca`, `Modelo`, `PrecioRefUsdCents`, `Specs`, `Activo` | cualquiera (precio) |
| `Ventas` | `IdVenta`, `Fecha`, `IdTienda`, `IdEmpleado`, `Vendedor`, `Moneda`, `TcDecimas`, `GananciaUsdCents`, `AjusteUsdCents`, `GananciaBsCents`, `PctComision`, `ComisionBsCents`, `NetoDuenoBsCents`, `TotalCobradoUsdCents`, `Estado`, `Notas`, `IdCierre`, `ClaveIdempotencia`, `CreadoEn`, `ActualizadoEn` | sistema |
| `VentaLineas` | `IdVenta`, `IdProducto`, `Modelo`, `Cantidad`, `PrecioUsdCents`, `CostoUnitarioUsdCents`, `Origen` | sistema |
| `Cierres` | `IdCierre`, `Fecha`, `IdTienda`, `Tienda`, `CerradoPor`, `Ventas`, `TotalComisionBsCents`, `TotalNetoBsCents`, `PagadoBsCents`, `SaldoBsCents`, `CerradoEn` | dueño |
| `TcDia` | `Fecha`, `IdEmpleado`, `Empleado`, `IdTienda`, `TcDecimas`, `RegistradoEn` | sistema |

`TcDia` se escribe sola en cada venta: es el histórico de "qué TC manejó cada encargado cada
día", que es lo que pidió el dueño para poder auditar.

### 5.4 Semilla del catálogo

El catálogo se siembra desde `Sis_Zamir` (precios de referencia + specs tipo GSM) pero
**los precios son editables** por cualquiera, porque cambian seguido. La importación es un
script de una vez: `scripts/sembrar-catalogo.js`, lee el JSON de Sis_Zamir y sube las filas.

No se importa nada de `src/fichas.json` en runtime: el catálogo de Jhessel vive en su propia
hoja.

## 6. Seguridad

- **Contraseñas con scrypt.** Cada tienda tiene su hash (`scrypt$salt$derivado`). El dueño
  tiene el suyo en variable de entorno `DUENO_PIN_HASH`. Los hashes viven en la hoja
  `Tiendas` y sólo el dueño los ve (los encargados nunca reciben el hash).
- **Comparación en tiempo constante** con `crypto.timingSafeEqual`, siempre comparando
  longitudes iguales primero.
- **Sesión por cookie firmada.** HMAC-SHA256 sobre `{rol, tiendaId, exp}`. Cookie
  `HttpOnly`, `SameSite=Strict`, `Secure` en producción, 8 horas.
- **El servidor nunca confía en el cliente.** El `IdTienda` de una venta sale de la sesión,
  no del cuerpo del request. Si mandan un `IdTienda` que no es el suyo, se ignora.
- **Rol en servidor.** Cada ruta declara qué rol la puede tocar. Un encargado que pide una
  ruta de dueño recibe **404**, no 403, para no confirmar que el recurso existe.
- **Rate limit** en login: 10 intentos por minuto por IP.
- **Sin coste para el encargado.** En cualquier respuesta de venta el campo `costoUsdCents`
  se borra si quien pregunta no es el dueño.
- **Anti inyección de fórmulas** en el `.gs`: todo texto que empieza con `= + - @` se
  prefija con `'`.
- **Tienda inactiva = login rechazado**, sin mensaje que la distinga de una contraseña mala.

## 7. Fiabilidad

- **Idempotencia en dos capas.** Capa 1: memoria, 30 minutos, `Map` con tope de 500, se
  consulta **antes** de validar, para que un reintento no falle. Capa 2: columna
  `ClaveIdempotencia` en la hoja. Render free se duerme y provoca reintentos del cliente;
  esto evita el cobro doble.
- **Respuesta repetida** trae `{...respuesta, repetida:true}` con HTTP 200.
- **Columnas por encabezado**, siempre. Si falta una columna, el `.gs` la agrega al final y
  avisa por log. Nunca se asume una posición.
- **El `.gs` devuelve 200 aunque rechace**, con `{status:'ERROR'}`. El cliente lo detecta y
  lo convierte en error 409. Sin esto se mostraría "guardado" sin haberse guardado.
- **Lock de Apps Script** (`LockService`, 15 s) en toda escritura, para que dos ventas
  simultáneas no se pisen.
- **Timeout** de 20 s en cada llamada a Apps Script.
- **Diagnóstico.** `GET /api/diagnostico` con 4 pasos: URL configurada, clave configurada,
  el script responde a `?action=SALUD`, la clave coincide. Cada paso dice qué hacer.
- **Cabeceras**: `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Permissions-Policy` sin cámara ni micro.

## 8. Pantallas

**Login.** Una pantalla con 5 botones: 4 tiendas + Dueño.

**Encargado:**
- **Inicio**: TC del día prellenado (lo teclea una vez), botón grande "Nueva venta", y
  resumen de su semana: vendido, ganancia, comisión, y cuántas ventas están **pendientes**.
- **Nueva venta** (una pantalla): quién vendió → moneda y TC → líneas (del catálogo o
  manual, con modelo, cantidad, precio de venta y costo) → ajustes con nota → recuadro de
  totales en vivo. Botones "Guardar borrador" y "Confirmar".
- **Mis ventas**: filtro por día/semana, con el estado visible.
- **Catálogo**: buscar, ver ficha, editar precio de referencia.

**Dueño:**
- **Consolidado**: una tarjeta por tienda con la semana —ventas, ganancia, comisión, neto— y
  arriba el total de las 4. Pendientes en rojo.
- **Cierre del día**: elegir tienda y fecha, ver el detalle, confirmar el pago.
- **Ajustes**: % de comisión por tienda, alta/baja de empleados, histórico de TC (`TcDia`).
- **Detalle de tienda**: mismo listado que el encargado pero **con costo y neto**.

## 9. Estructura de archivos

```
Sis_Jhessel/
├── server.js                    Express, rutas, auth de sesión, idempotencia
├── package.json
├── .env.example
├── src/
│   ├── money.js                 ← sin dependencias
│   ├── auth.js
│   ├── sheets.js
│   ├── ledger.js
│   ├── catalogo.js
│   ├── ventas.js
│   └── cierres.js
├── apps-script/
│   ├── Code.gs
│   └── appsscript.json
├── public/
│   ├── index.html               login + shell de la app
│   ├── app.js
│   └── app.css
├── scripts/
│   ├── hash-clave.js            generar hash scrypt de una contraseña
│   └── sembrar-catalogo.js      importar catálogo de Sis_Zamir
└── test/
    ├── money.test.js            fórmulas con el caso real del dueño
    ├── estados.test.js          transiciones y permisos por rol
    └── idempotencia.test.js     misma clave dos veces = una venta
```

## 10. API

| Ruta | Rol | Qué hace |
|---|---|---|
| `GET /api/health` | todos | vivo |
| `GET /api/diagnostico` | todos | los 4 pasos de configuración |
| `GET /api/tiendas` | público | las 4 tiendas para el login (id, nombre, activo) |
| `POST /api/auth/login` | público | `{idTienda}` o `{dueno:true}` + contraseña → cookie |
| `POST /api/auth/logout` | sesión | borra cookie |
| `GET /api/auth/session` | — | quién soy, qué tienda, qué rol |
| `GET /api/resumen?desde&hasta` | sesión | consolidado del rol: por tienda, por vendedor, por día |
| `GET /api/ventas?desde&hasta&tienda` | sesión | listado (el costo solo si es dueño) |
| `POST /api/ventas/preview` | sesión | calcula totales sin guardar (recuadro en vivo) |
| `POST /api/ventas` | encargado | guarda venta (`ClaveIdempotencia` en el cuerpo) |
| `POST /api/ventas/:id/estado` | encargado/duño | borrador→confirmada; dueño: cerrar/reabrir/anular |
| `POST /api/ventas/precio-sugerido` | sesión | precio de referencia del catálogo en Bs o USD |
| `GET /api/catalogo?q` | sesión | buscar productos |
| `POST /api/catalogo/:id/precio` | sesión | editar precio de referencia |
| `GET /api/cierres?tienda&desde&hasta` | dueño | recibos |
| `POST /api/cierres` | dueño | cierra tienda del día y paga |
| `GET /api/tc-historial` | dueño | qué TC manejó cada encargado cada día |
| `POST /api/ajustes/tienda/:id` | dueño | cambia % de comisión, nombre, activa |
| `POST /api/ajustes/empleados` | dueño | alta/baja de empleados |

## 11. Pruebas

Sin framework, sin dependencias: `test/run.js` corre los tres archivos con `node:assert`.

- **`money.test.js`** — fórmulas de §3.2: caso real del dueño (10.000 Bs / 30% → 3.000 /
  7.000); TC con décimas; venta en Bs; venta en USD; ajuste de 5 USD con nota; comisión
  cero cuando la ganancia es negativa; redondeos; `TcDecimas` ↔ decimal.
- **`estados.test.js`** — tabla de transiciones: quién puede pasar de qué estado a qué, y
  que un encargado nunca alcanza `cerrada`, `anulada` ni otra tienda.
- **`idempotencia.test.js`** — misma `ClaveIdempotencia` dos veces devuelve la misma venta
  con `repetida:true` y **una sola** fila en la hoja.

Además, verificación manual al final: sintaxis de todos los `.js` (`node --check`), sintaxis
del `.gs` con `new Function`, arranque del server, suite de pruebas, y smoke HTTP con
`curl` contra `/api/health` y `/api/diagnostico`.

## 12. Despliegue

1. `npm install` en Render, `startCommand: node server.js`.
2. En Apps Script: pegar `Code.gs`, ejecutar **una vez** `generarClaveCompartida()`,
   copiar la clave del log.
3. Propiedades del script → `SHEETS_API_KEY` = esa clave.
4. Render → variables de entorno: `SHEETS_WEBAPP_URL`, `SHEETS_API_KEY`, `SESSION_SECRET`
   (32+ caracteres aleatorios), `DUENO_PIN_HASH` (con `npm run hash-clave`).
5. Apps Script → Implementar → **Nueva implementación** → Ejecutar como: Yo / Acceso:
   Cualquier persona.
6. Borrar la función generadora de la clave.
7. `npm run sembrar-catalogo` una vez.
8. Alta de tiendas y empleados desde la pantalla de Ajustes.

> El orden importa: `Code.gs` en el editor **no** es lo que corre. `/exec` sirve la última
> **versión desplegada**. Sin "Nueva versión", el sistema ve la versión vieja.

## 13. Fuera de alcance (YAGNI)

No hay control de stock ni entradas/salidas (los equipos son del dueño). No hay multi-idioma.
No hay app móvil nativa (el sitio es responsive). No hay IA. No hay multi-moneda además de
Bs/USD. No hay roles intermedios: tienda o dueño.

## 14. Paleta

El logo del local es un panel índigo con texto blanco y acentos ámbar de las marcas vecinas.

- Primario `#362968` (índigo)
- Primario claro `#4a3a8f`
- Acento `#e8933a` (ámbar)
- Fondo `#f7f7fb`, superficie blanca, texto `#1b1b28`
- Peligro `#c0392b` (pendientes, anuladas)
- Éxito `#1e8e5a`