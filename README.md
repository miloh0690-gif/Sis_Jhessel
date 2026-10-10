# Sis Jhessel

Control de ventas, comisiones y cierre diario para cuatro tiendas de celulares.

El dueño entra con su propia clave y ve las cuatro tiendas juntas. Cada encargado
entra con la clave de su tienda, anota lo que vendio y cuanto le corresponde de
comision. Cuando el dueño registra el pago del dia, las ventas de esa tienda quedan
cerradas y queda un recibo.

## Las cuatro tiendas

| Tienda | Encargados |
|---|---|
| Tienda Camila | Camila |
| Tienda Andre | Andre |
| Tienda Miros | Miros |
| Tienda Cuarta | Didi y Micky |

La comision es un porcentaje **de la ganancia**, distinto por tienda, y lo edita el
dueno desde la pantalla de Ajustes.

## Como funciona el dinero

Todo se guarda en **centavos enteros** y lo calcula el servidor. El navegador solo
muestra lo que le devuelven.

```
ganancia USD = suma de (precio de venta - costo) x cantidad, menos los ajustes
ganancia Bs  = ganancia USD x tipo de cambio de esa venta
comision     = ganancia Bs x % de la tienda   (0 si la ganancia es negativa)
neto dueno   = ganancia Bs - comision
```

El tipo de cambio lo teclea el encargado al vender y **se guarda con la venta**, para
que el dueno pueda auditar despues que tipo cambio uso cada uno cada dia.

Un ejemplo real: si en la semana la ganancia fueron 10.000 Bs y la comision de esa
tienda es 30%, la comision son 3.000 Bs y al dueno le quedan 7.000 Bs.

## Correrlo en local

```bash
npm install
cp .env.example .env        # rellena SESSION_SECRET y SHEETS_*
npm start                   # http://localhost:10000
```

Sin `SHEETS_WEBAPP_URL` y `SHEETS_API_KEY` el servidor arranca y responde el login,
pero toda lectura de datos devuelve 503 con un mensaje claro. `/api/diagnostico`
dice en que paso del enlace con Google Sheets se esta.

### Comandos

```bash
npm run pruebas              # 152 pruebas en 10 archivos
npm run sintaxis             # revisa la sintaxis de todo el codigo
npm run sembrar-catalogo     # sube los modelos de Sis_Zamir como catalogo inicial
npm run hash-clave -- "1234" # genera el hash de una contrasena
```

Para el hash del dueno: `npm run hash-clave -- "la contrasena"` e imprime una linea
que empieza con `scrypt$`. Esa linea va en `DUENO_PIN_HASH`. **La contrasena no se
guarda en ningun lado**, solo el hash.

### Siembra del catalogo

```bash
npm run sembrar-catalogo -- --seco      # solo muestra lo que subiria
npm run sembrar-catalogo                # escribe de verdad
npm run sembrar-catalogo -- --origen RUTA
```

Los precios se siembran **en 0 a proposito**: los precios de referencia del catalogo
del proyecto hermano son viejos y cambian cada semana. Los pone el encargado al
vender o el dueno desde la pantalla de Catalogo.

## Despliegue en Render

1. Crear el servicio en Render desde este repo. `npm install` en el build y
   `node server.js` como start command. El puerto lo inyecta Render.
2. En **Google Apps Script** pegar `apps-script/Code.gs`. Ejecutar **una sola vez** la
   funcion `generarClaveCompartida()` y copiar la clave del log.
3. En Apps Script: **Configuración del proyecto → Propiedades del script**, agregar
   `SHEETS_API_KEY` con esa clave.
4. En Render, variables de entorno:
   - `SHEETS_WEBAPP_URL` = la URL `/exec` del despliegue de Apps Script
   - `SHEETS_API_KEY` = la misma clave
   - `SESSION_SECRET` = 32 caracteres hex (`openssl rand -hex 32`)
   - `DUENO_PIN_HASH` = lo que imprimio `npm run hash-clave -- "tu contrasena"`
5. Apps Script → **Implementar → Nueva implementación**. Ejecutar como: *Yo*.
   Acceso: *Cualquier persona*.
6. **Borrar** la funcion `generarClaveCompartida()` del script.
7. Correr `npm run sembrar-catalogo` una vez desde la maquina.
8. Dar de alta las tiendas y los empleados desde la pantalla de Ajustes (con el login
   de dueno).

> [!warning] El orden importa
> `Code.gs` guardado en el editor **no es lo que corre**. `/exec` sirve la ultima
> version desplegada. Sin "Nueva implementacion", el sistema sigue viendo la version
> vieja y los cambios no se notan. Repetir: Implementar → Editar → **Nueva version**
> → Implementar.

> [!warning] La clave viaja en la URL
> Apps Script no deja leer cabeceras HTTP, asi que la clave va en `?key=` en las
> lecturas y en el cuerpo en las escrituras. Es visible en los registros de
> ejecucion del script. Es un coste aceptado de usar Sheets como base de datos.

## Pruebas

```bash
npm run pruebas
```

152 pruebas: la aritmetica en centavos, los estados y permisos por rol, la
idempotencia de dos capas, el cierre diario, el `Code.gs` corrido sobre una hoja de
mentira, y la interfaz cargada en un DOM falso para cazar botones rotos que
`node --check` no ve.

## Donde esta cada cosa

| Ruta | Que guarda |
|---|---|
| `server.js` | rutas HTTP, sesion por rol, rate limit del login |
| `src/money.js` | la aritmetica en centavos enteros |
| `src/auth.js` | scrypt, sesiones HMAC, cookie |
| `src/estados.js` | la tabla de transiciones de estados |
| `src/ledger.js` | lectura de las 7 hojas y el consolidado |
| `src/ventas.js` | validacion, calculo e idempotencia |
| `src/cierres.js` | el cierre diario y el recibo |
| `src/catalogo.js` | busqueda y precios de referencia |
| `src/sheets.js` | cliente de Apps Script |
| `apps-script/Code.gs` | las 7 hojas en Google Sheets |
| `public/` | la aplicacion de una sola pagina |
