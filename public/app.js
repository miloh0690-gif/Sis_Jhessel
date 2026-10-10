'use strict';

/* =================================================================
   Sis Jhessel — la pantalla.

   Como esta armado: un solo objeto de estado, un enrutador por el hash y
   una funcion por vista. No hay framework y no hace falta: son pocas
   pantallas y el mostrador pide que cambiar de una sea instantaneo.

   Reglas que no se rompen en este archivo:

   - Todo lo que viene del servidor entra por textContent. Nunca se arma
     una etiqueta con innerHTML usando datos, porque un nombre de producto
     con "<" romperia la pantalla y un nombre con "<script>" seria peor.
   - Ningun total se calcula aqui. El navegador pinta lo que el servidor
     devuelve. Si el total se calculara en el celular, dos celulares
     darían dos cifras distintas y el dueño no sabria cual es la buena.
   - El rol manda. Un encargado no ve la barra de las cuatro tiendas ni el
     modo del dueno, y el servidor le responde 404 si lo intenta igual.
   ================================================================= */

(function () {
  const $ = function (id) { return document.getElementById(id); };

  const ESTADO = {
    sesion: null,
    tiendas: [],
    vista: '',
    // Datos de la vista de venta. Se guardan en el estado y no en el DOM
    // para que al cambiar de pestana y volver no se pierda lo tecleado.
    venta: null,
    consultaPrecios: '',
    cargando: false
  };

  /* ---------------------------------------------------------------- */
  /* Formato                                                          */
  /* ---------------------------------------------------------------- */

  const MONEDA = new Intl.NumberFormat('es-BO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Todo importe llega en centavos enteros. Ahi se divide entre 100 una
  // sola vez, al pintar, para no arrastrar decimales por toda la app.
  function dinero(centavos) {
    const n = Number(centavos);
    if (!isFinite(n)) return '0,00';
    return MONEDA.format(n / 100);
  }

  function numero(valor, decimales) {
    const n = Number(valor);
    if (!isFinite(n)) return '0';
    return n.toLocaleString('es-BO', {
      minimumFractionDigits: decimales || 0,
      maximumFractionDigits: decimales === undefined ? 0 : decimales
    });
  }

  // El dueno teclea "7,25" o "7.25". Las dos cosas son el mismo numero.
  function aDecimal(texto) {
    const limpio = String(texto === undefined || texto === null ? '' : texto).trim().replace(',', '.');
    const n = Number(limpio);
    return isFinite(n) ? n : 0;
  }

  function fechaCorta(iso) {
    const s = String(iso || '').slice(0, 10);
    if (!s) return '—';
    const partes = s.split('-');
    return partes.length === 3 ? partes[2] + '/' + partes[1] : s;
  }

  function hoyIso() {
    const d = new Date();
    const mes = String(d.getMonth() + 1).padStart(2, '0');
    const dia = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + mes + '-' + dia;
  }

  function inicioDeSemana() {
    const d = new Date();
    const dia = d.getDay();
    const retroceso = dia === 0 ? 6 : dia - 1;
    d.setDate(d.getDate() - retroceso);
    const mes = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + mes + '-' + dd;
  }

  /* ---------------------------------------------------------------- */
  /* Armado de nodos. Nada de innerHTML con datos.                      */
  /* ---------------------------------------------------------------- */

  function crear(etiqueta, atributos, hijos) {
    const el = document.createElement(etiqueta);
    const attrs = atributos || {};
    Object.keys(attrs).forEach(function (clave) {
      const valor = attrs[clave];
      if (valor === undefined || valor === null || valor === false) return;
      if (clave === 'texto') {
        el.textContent = String(valor);
      } else if (clave === 'html') {
        // Solo para marcado de la propia aplicacion, nunca con datos.
        el.innerHTML = valor;
      } else if (clave === 'clase') {
        el.className = valor;
      } else if (clave === 'evento') {
        el.addEventListener(valor.tipo, valor.fn);
      } else if (valor === true) {
        el.setAttribute(clave, '');
      } else {
        el.setAttribute(clave, String(valor));
      }
    });
    (Array.isArray(hijos) ? hijos : (hijos ? [hijos] : [])).forEach(function (hijo) {
      if (hijo === undefined || hijo === null || hijo === false) return;
      el.appendChild(typeof hijo === 'object' ? hijo : document.createTextNode(String(hijo)));
    });
    return el;
  }

  function limpiar(nodo) {
    while (nodo.firstChild) nodo.removeChild(nodo.firstChild);
    return nodo;
  }

  function campo(etiqueta, opciones) {
    const op = opciones || {};
    const entrada = crear('input', {
      type: op.tipo || 'text',
      value: op.valor === undefined ? '' : op.valor,
      placeholder: op.placeholder || '',
      inputmode: op.inputmode || (op.tipo === 'number' ? 'decimal' : 'text'),
      step: op.step || (op.tipo === 'number' ? 'any' : null),
      class: 'h-11 w-full rounded-xl bg-hondo px-3 text-sm text-texto outline-none border border-borde focus:border-azul ' +
        (op.clase || '')
    });
    if (op.id) entrada.id = op.id;
    if (op.evento) {
      Object.keys(op.evento).forEach(function (clave) {
        entrada.addEventListener(clave, op.evento[clave]);
      });
    }
    if (!etiqueta) return entrada;
    return crear('label', { clase: 'block' }, [
      crear('span', { clase: 'mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-apagado', texto: etiqueta }),
      entrada
    ]);
  }

  function areaTexto(etiqueta, opciones) {
    const op = opciones || {};
    const entrada = crear('textarea', {
      rows: op.filas || 2,
      placeholder: op.placeholder || '',
      class: 'w-full rounded-xl bg-hondo px-3 py-2.5 text-sm text-texto outline-none border border-borde focus:border-azul resize-none'
    });
    entrada.value = op.valor === undefined ? '' : op.valor;
    if (op.evento) {
      Object.keys(op.evento).forEach(function (clave) {
        entrada.addEventListener(clave, op.evento[clave]);
      });
    }
    return crear('label', { clase: 'block' }, [
      crear('span', { clase: 'mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-apagado', texto: etiqueta }),
      entrada
    ]);
  }

  function boton(texto, opciones) {
    const op = opciones || {};
    return crear('button', {
      type: 'button',
      clase: 'tap rounded-xl px-4 py-3 text-sm font-bold ' + (op.clase || 'bg-superficie text-texto border border-borde'),
      evento: op.evento ? { click: op.evento } : null,
      disabled: op.deshabilitado ? true : null
    }, [texto]);
  }

  function aviso(mensaje, tipo) {
    const capa = $('aviso');
    const caja = limpiar(capa).firstChild;
    const colores = {
      bien: 'bg-verde/15 text-verde border border-verde/30',
      mal: 'bg-rosa/15 text-rosa border border-rosa/30',
      ojo: 'bg-ambar/15 text-ambar border border-ambar/30'
    };
    limpiar(caja);
    caja.className = 'aviso mx-auto max-w-lg rounded-2xl px-4 py-3 text-center text-sm font-semibold shadow-lg ' +
      (colores[tipo] || colores.ojo);
    caja.appendChild(document.createTextNode(mensaje));
    capa.classList.remove('hidden');
    clearTimeout(capa.__t);
    capa.__t = setTimeout(function () { capa.classList.add('hidden'); }, 3200);
  }

  function errorDe(e) {
    return aviso((e && e.message ? e.message : 'Algo fallo. Intentalo otra vez.'), 'mal');
  }

  /* ---------------------------------------------------------------- */
  /* Hablar con el servidor                                           */
  /* ---------------------------------------------------------------- */

  async function api(ruta, opciones) {
    const op = opciones || {};
    const respuesta = await fetch(ruta, {
      method: op.cuerpo ? 'POST' : 'GET',
      credentials: 'same-origin',
      headers: op.cuerpo ? { 'Content-Type': 'application/json' } : undefined,
      body: op.cuerpo ? JSON.stringify(op.cuerpo) : undefined
    });
    let datos = null;
    try {
      datos = await respuesta.json();
    } catch (e) {
      datos = null;
    }
    if (!respuesta.ok) {
      const err = new Error((datos && datos.error) || ('Falló la petición (' + respuesta.status + ').'));
      err.codigo = respuesta.status;
      throw err;
    }
    return datos;
  }

  /* ---------------------------------------------------------------- */
  /* Piezas que se repiten en varias pantallas                        */
  /* ---------------------------------------------------------------- */

  function insignia(estado) {
    const mapa = {
      BORRADOR: ['gris', 'Borrador'],
      CONFIRMADA: ['azul', 'Confirmada'],
      CERRADA: ['verde', 'Cerrada'],
      ANULADA: ['rosa', 'Anulada']
    };
    const par = mapa[estado] || ['gris', estado || '—'];
    const tonos = {
      gris: 'bg-superficie text-apagado border-borde',
      azul: 'bg-azul/15 text-azul border-azul/30',
      verde: 'bg-verde/15 text-verde border-verde/30',
      rosa: 'bg-rosa/15 text-rosa border-rosa/30'
    };
    return crear('span', {
      clase: 'rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ' + tonos[par[0]],
      texto: par[1]
    });
  }

  function tarjetaKPI(etiqueta, valor, opciones) {
    const op = opciones || {};
    return crear('div', {
      clase: 'rounded-2xl border border-borde bg-superficie border-l-4 p-3.5 ' + (op.borde || 'border-l-azul')
    }, [
      crear('p', { clase: 'text-[9px] font-bold uppercase tracking-widest text-apagado', texto: etiqueta }),
      crear('p', {
        clase: 'mt-1 font-dato text-lg font-semibold ' + (op.color || 'text-titulo'),
        texto: valor
      }),
      op.pie ? crear('p', { clase: 'mt-0.5 text-[10px] text-apagado', texto: op.pie }) : null
    ]);
  }

  function seccion(titulo, hijos, opciones) {
    const op = opciones || {};
    return crear('section', { clase: op.clase || 'mb-4' }, [
      op.accion ? crear('div', { clase: 'mb-2 flex items-end justify-between gap-3' }, [
        crear('h2', { clase: 'font-display text-[11px] font-bold uppercase tracking-widest text-apagado', texto: titulo }),
        op.accion
      ]) : crear('h2', { clase: 'mb-2 font-display text-[11px] font-bold uppercase tracking-widest text-apagado', texto: titulo })
    ].concat(Array.isArray(hijos) ? hijos : [hijos]));
  }

  function vacio(mensaje) {
    return crear('div', {
      clase: 'rounded-2xl border border-dashed border-borde bg-hondo px-4 py-8 text-center text-sm text-apagado'
    }, [mensaje]);
  }

  function tabla(columnas, filas, opciones) {
    const op = opciones || {};
    if (!filas || filas.length === 0) return vacio(op.vacio || 'Nada por acá todavía.');
    const cabeza = crear('tr', {}, columnas.map(function (c) {
      return crear('th', {
        clase: 'px-2 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-apagado ' + (c.clase || ''),
        texto: c.titulo
      });
    }));
    const cuerpo = filas.map(function (fila) {
      const esAnulada = fila.estado === 'ANULADA';
      const esPendiente = fila.estado === 'CONFIRMADA';
      return crear('tr', {
        clase: 'border-t border-borde/60 ' + (esAnulada ? 'anulada ' : '') + (esPendiente ? 'pendiente-fuerte' : '')
      }, fila.celdas.map(function (celda, i) {
        return crear('td', {
          clase: 'px-2 py-2.5 align-top text-xs ' + (columnas[i] && columnas[i].clase ? columnas[i].clase : '') +
            (celda && celda.clase ? ' ' + celda.clase : '')
        }, celda && celda.valor !== undefined ? celda.valor : (celda === null || celda === undefined ? '—' : celda));
      }));
    });
    return crear('div', { clase: 'overflow-hidden rounded-2xl border border-borde bg-superficie' }, [
      crear('div', { clase: 'overflow-x-auto' }, [
        crear('table', { clase: 'w-full border-collapse' }, [crear('thead', {}, [cabeza]), crear('tbody', {}, cuerpo)])
      ])
    ]);
  }

  /* ---------------------------------------------------------------- */
  /* Sesion                                                           */
  /* ---------------------------------------------------------------- */

  async function cargarSesion() {
    try {
      const datos = await api('/api/auth/session');
      ESTADO.sesion = datos.sesion || null;
      if (ESTADO.sesion && ESTADO.sesion.rol === 'dueno') {
        // El dueno ve las cuatro tiendas siempre. Si la hoja todavia esta
        // vacia se avisa una vez en vez de fallar en cada pantalla.
        if (!ESTADO.tiendas.length) {
          try {
            ESTADO.tiendas = (await api('/api/tiendas')).tiendas || [];
          } catch (e) {
            ESTADO.tiendas = [];
          }
        }
      }
      return ESTADO.sesion;
    } catch (e) {
      ESTADO.sesion = null;
      return null;
    }
  }

  function esDueno() {
    return Boolean(ESTADO.sesion && ESTADO.sesion.rol === 'dueno');
  }

  function nombreTienda(id) {
    const t = ESTADO.tiendas.find(function (x) { return x.idTienda === id; });
    return t ? t.nombre : (id || '—');
  }

  /* ---------------------------------------------------------------- */
  /* Pestañas                                                         */
  /* ---------------------------------------------------------------- */

  // El encargado entra a su tienda y no ve pestañas de otras tiendas: no
  // tiene nada que hacer ahi y mostrarlas confunde. El dueno ve las cuatro
  // mas la suya.
  function pestanas() {
    if (!ESTADO.sesion) return [];
    if (!esDueno()) {
      return [
        { hash: '#/inicio', icono: '🏠', texto: 'Inicio' },
        { hash: '#/vender', icono: '🛒', texto: 'Vender' },
        { hash: '#/ventas', icono: '🧾', texto: 'Ventas' },
        { hash: '#/precios', icono: '🔎', texto: 'Precios' }
      ];
    }
    const tiendas = ESTADO.tiendas.slice(0, 4);
    const lista = tiendas.map(function (t, i) {
      return { hash: '#/tienda/' + t.idTienda, icono: ['🟣', '🔵', '🟢', '🟠'][i] || '🏪', texto: t.nombre };
    });
    lista.push({ hash: '#/dueno', icono: '🔑', texto: 'Dueño' });
    return lista;
  }

  function pintarPestanas() {
    const lista = pestanas();
    const barra = $('barra-pestanas');
    const caja = limpiar($('pestanas'));
    if (!lista.length) {
      barra.classList.add('hidden');
      return;
    }
    caja.className = 'mx-auto grid max-w-lg grid-cols-' + lista.length;
    lista.forEach(function (p) {
      const activa = ESTADO.vista === p.hash;
      caja.appendChild(crear('a', {
        href: p.hash,
        clase: 'tap flex flex-col items-center gap-0.5 py-2.5 ' + (activa ? 'text-azul' : 'text-apagado')
      }, [
        crear('span', { clase: 'text-xl leading-none', texto: p.icono }),
        crear('span', { clase: 'max-w-full truncate px-1 text-[10px] font-bold', texto: p.texto })
      ]));
    });
    barra.classList.remove('hidden');
  }

  /* ---------------------------------------------------------------- */
  /* Entrada                                                          */
  /* ---------------------------------------------------------------- */

  async function pintarLogin() {
    $('pantalla-app').classList.add('hidden');
    $('barra-pestanas').classList.add('hidden');
    $('pantalla-login').classList.remove('hidden');
    limpiar($('caja-error-login'));

    if (!ESTADO.tiendas.length) {
      try {
        ESTADO.tiendas = (await api('/api/tiendas')).tiendas || [];
      } catch (e) {
        ESTADO.tiendas = [];
      }
    }
    const lista = limpiar($('lista-tiendas'));
    if (!ESTADO.tiendas.length) {
      lista.appendChild(crear('p', {
        clase: 'col-span-2 rounded-2xl border border-ambar/30 bg-ambar/10 px-4 py-3 text-center text-xs text-ambar',
        texto: 'Todavía no hay tiendas cargadas. El dueño las da de alta desde el modo Dueño.'
      }));
    }
    ESTADO.tiendas.slice(0, 4).forEach(function (t, i) {
      lista.appendChild(crear('button', {
        type: 'button',
        clase: 'tap-lento flex items-center gap-3 rounded-2xl border border-borde bg-superficie px-3 py-3.5 text-left',
        evento: function () { entrar({ idTienda: t.idTienda, clave: pedirClave(t.nombre) }); }
      }, [
        crear('span', { clase: 'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-hondo text-xl', texto: ['🟣', '🔵', '🟢', '🟠'][i] || '🏪' }),
        crear('span', { clase: 'min-w-0' }, [
          crear('span', { clase: 'block truncate font-display text-sm font-bold text-titulo', texto: t.nombre }),
          crear('span', { clase: 'block text-[10px] uppercase tracking-wider text-apagado', texto: 'Tienda' })
        ])
      ]));
    });

    $('boton-dueno').onclick = function () { entrar({ dueno: true, clave: pedirClave('Dueño') }); };
  }

  function pedirClave(titulo) {
    return prompt('Clave de ' + titulo);
  }

  async function entrar(cuerpo) {
    const caja = $('caja-error-login');
    caja.classList.add('hidden');
    if (cuerpo.clave === null || cuerpo.clave === undefined) return;
    try {
      await api('/api/auth/login', { cuerpo: cuerpo });
      ESTADO.tiendas = [];
      await cargarSesion();
      location.hash = esDueno() ? '#/dueno' : '#/inicio';
      await enrutar();
    } catch (e) {
      limpiar(caja);
      caja.classList.remove('hidden');
      caja.appendChild(crear('span', { texto: e.message }));
    }
  }

  async function salir() {
    try {
      await api('/api/auth/logout', { cuerpo: {} });
    } catch (e) { /* si falla el logout, se limpia igual */ }
    ESTADO.sesion = null;
    ESTADO.tiendas = [];
    ESTADO.venta = null;
    location.hash = '#/login';
    await enrutar();
  }

  /* ---------------------------------------------------------------- */
  /* Vista: inicio del encargado                                     */
  /* ---------------------------------------------------------------- */

  async function vistaInicio() {
    const idTienda = ESTADO.sesion.idTienda;
    const desde = inicioDeSemana();
    const [resumen, tc] = await Promise.all([
      api('/api/resumen?desde=' + desde + '&hasta=' + hoyIso()),
      api('/api/tc-hoy').catch(function () { return { tcs: [] }; })
    ]);
    const r = resumen.resumen || {};
    const mias = (resumen.ventas || []).filter(function (v) { return v.idTienda === idTienda; });
    const pendientes = mias.filter(function (v) { return v.estado === 'CONFIRMADA'; });
    const encontrado = (tc.tcs || []).find(function (x) { return x.idTienda === idTienda; });

    return [
      seccion('Tu tienda', crear('div', { clase: 'flex items-center gap-3' }, [
        crear('div', { clase: 'flex h-12 w-12 items-center justify-center rounded-2xl bg-marca text-2xl font-bold text-white font-display', texto: 'J' }),
        crear('div', {}, [
          crear('p', { clase: 'font-display text-lg font-bold text-titulo', texto: nombreTienda(idTienda) }),
          crear('p', { clase: 'text-xs text-apagado', texto: ESTADO.sesion.nombre || 'Encargado' })
        ])
      ])),

      seccion('Semana', crear('div', { clase: 'grid grid-cols-2 gap-2.5' }, [
        tarjetaKPI('Ventas', numero(r.cantidadVentas || 0)),
        tarjetaKPI('Unidades', numero(r.unidades || 0), { borde: 'border-l-violeta' }),
        tarjetaKPI('Ganancia', 'Bs ' + dinero(r.totalGananciaBsCents), { borde: 'border-l-verde', color: 'text-verde' }),
        tarjetaKPI('Comisión', 'Bs ' + dinero(r.totalComisionBsCents), { borde: 'border-l-ambar', color: 'text-ambar' })
      ])),

      seccion('Tipo de cambio de hoy', [
        encontrado
          ? crear('div', { clase: 'rounded-2xl border border-borde bg-superficie px-4 py-3' }, [
            crear('p', { clase: 'font-dato text-2xl font-semibold text-titulo', texto: String(encontrado.tcDecimas / 100).replace('.', ',') }),
            crear('p', { clase: 'text-[10px] uppercase tracking-wider text-apagado', texto: encontrado.empleado || 'El que manejas' })
          ])
          : crear('div', { clase: 'rounded-2xl border border-borde bg-superficie px-4 py-3' }, [
            crear('p', { clase: 'text-sm text-apagado', texto: 'Todavía no registraste el TC de hoy. Teclealo al vender.' })
          ])
      ]),

      seccion('Cobrar', crear('div', { clase: 'grid grid-cols-2 gap-2.5' }, [
        crear('a', {
          href: '#/vender',
          clase: 'tap flex flex-col items-center justify-center gap-1 rounded-2xl bg-azul py-5 text-white shadow-lg shadow-azul/20'
        }, [
          crear('span', { clase: 'text-3xl', texto: '🛒' }),
          crear('span', { clase: 'font-bold', texto: 'Nueva venta' })
        ]),
        crear('a', {
          href: '#/ventas',
          clase: 'tap flex flex-col items-center justify-center gap-1 rounded-2xl border border-borde bg-superficie py-5'
        }, [
          crear('span', { clase: 'text-3xl', texto: '🧾' }),
          crear('span', { clase: 'font-bold text-titulo', texto: 'Mis ventas' })
        ])
      ])),

      pendientes.length
        ? seccion('Pendientes de cobrar (' + numero(pendientes.length) + ')', tabla(
          [{ titulo: 'Venta' }, { titulo: 'Vendedor' }, { titulo: 'Ganancia', clase: 'text-right' }],
          pendientes.map(function (v) {
            return {
              estado: v.estado,
              celdas: [fechaCorta(v.dia), v.vendedor || '—',
                { valor: 'Bs ' + dinero(v.gananciaBsCents), clase: 'font-dato text-verde text-right' }]
            };
          }), { vacio: 'Nada pendiente.' }))
        : null
    ];
  }

  /* ---------------------------------------------------------------- */
  /* Vista: nueva venta                                               */
  /* ---------------------------------------------------------------- */

  function ventaVacia(idEmpleado, tc) {
    return {
      idEmpleado: idEmpleado || '',
      moneda: 'USD',
      tcDecimas: tc ? tc.tcDecimas : '',
      lineas: [],
      ajusteUsd: '',
      notas: '',
      // La clave de idempotencia se genera una vez al abrir la pantalla y
      // se reutiliza en cada intento. Si el internet se corta a la mitad y
      // el encargado le da "Enviar" otra vez, el servidor devuelve la
      // venta que ya habia guardado en vez de duplicarla.
      claveIdempotencia: 'ui' + Date.now().toString(36) + Math.floor(Math.random() * 1679616).toString(36)
    };
  }

  async function vistaVender() {
    if (!ESTADO.venta) {
      let idEmpleado = '';
      let tc = null;
      try {
        const empleados = await api('/api/empleados');
        const lista = empleados.empleados || [];
        idEmpleado = lista.length ? lista[0].idEmpleado : '';
      } catch (e) { /* se muestra el formulario igual */ }
      try {
        const tcs = (await api('/api/tc-hoy')).tcs || [];
        const mio = tcs.find(function (x) { return x.idEmpleado === idEmpleado; });
        tc = mio || tcs[0] || null;
      } catch (e) { /* sin TC previo */ }
      ESTADO.venta = ventaVacia(idEmpleado, tc);
    }
    const v = ESTADO.venta;

    let empleados = [];
    try {
      empleados = (await api('/api/empleados')).empleados || [];
    } catch (e) { /* el selector queda vacio */ }

    const bloqueEmpleado = empleados.length > 1
      ? campo('¿Quién vendió?', {
        valor: v.idEmpleado,
        evento: { change: function (e) { v.idEmpleado = e.target.value; pedirTotales(); } }
      }, {})
      : null;

    const lineas = v.lineas.map(function (linea, indice) {
      return crear('div', {
        clase: 'mb-2 rounded-2xl border border-borde bg-superficie p-3'
      }, [
        crear('div', { clase: 'flex items-start justify-between gap-2' }, [
          crear('div', { clase: 'min-w-0' }, [
            crear('p', { clase: 'truncate font-display text-sm font-bold text-titulo', texto: linea.modelo }),
            crear('p', { clase: 'text-[10px] text-apagado', texto: linea.idProducto || 'manual' })
          ]),
          crear('button', {
            type: 'button',
            clase: 'tap rounded-lg border border-borde px-2 py-1 text-xs text-rosa',
            evento: function () { v.lineas.splice(indice, 1); repintarVenta(); pedirTotales(); }
          }, ['Quitar'])
        ]),
        crear('div', { clase: 'mt-2.5 grid grid-cols-2 gap-2' }, [
          campo('Cantidad', {
            tipo: 'number', valor: linea.cantidad,
            evento: { input: function (e) { linea.cantidad = e.target.value; pedirTotales(); } }
          }),
          campo('Precio (' + v.moneda + ')', {
            tipo: 'number', valor: linea.precio,
            evento: { input: function (e) { linea.precio = e.target.value; pedirTotales(); } }
          })
        ])
      ]);
    });

    return [
      bloqueEmpleado,
      seccion('Cómo te pagaron', crear('div', { clase: 'grid grid-cols-2 gap-2' }, [
        boton('Bs', {
          clase: v.moneda === 'BS' ? 'tap rounded-xl bg-azul py-3 font-bold text-white' : 'tap rounded-xl border border-borde bg-superficie py-3 font-bold text-apagado',
          evento: function () { v.moneda = 'BS'; repintarVenta(); pedirTotales(); }
        }),
        boton('USD', {
          clase: v.moneda === 'USD' ? 'tap rounded-xl bg-azul py-3 font-bold text-white' : 'tap rounded-xl border border-borde bg-superficie py-3 font-bold text-apagado',
          evento: function () { v.moneda = 'USD'; repintarVenta(); pedirTotales(); }
        })
      ])),

      seccion('Tipo de cambio', [
        campo('Bs por un dólar', {
          tipo: 'number', valor: v.tcDecimas === '' ? '' : String(v.tcDecimas / 100).replace('.', ','),
          evento: {
            input: function (e) { v.tcDecimas = e.target.value; pedirTotales(); },
            blur: function (e) { v.tcDecimas = e.target.value; repintarVenta(); }
          }
        }),
        crear('p', {
          clase: 'mt-1.5 text-[10px] text-apagado',
          texto: 'El tipo que usaste hoy. Se guarda con la venta para que el dueño pueda revisarlo después.'
        })
      ]),

      seccion('Qué vendiste', [
        crear('button', {
          type: 'button',
          clase: 'tap w-full rounded-2xl border border-dashed border-azul/40 bg-azul/10 py-4 text-sm font-bold text-azul',
          evento: buscarProducto
        }, ['🔎  Buscar en la lista de precios']),
        crear('button', {
          type: 'button',
          clase: 'tap mt-2 w-full rounded-xl border border-borde bg-superficie py-3 text-sm font-semibold text-apagado',
          evento: agregarManual
        }, ['+ Agregar a mano']),
        v.lineas.length ? crear('div', { clase: 'mt-3' }, lineas) : null
      ]),

      seccion('Ajuste', [
        crear('div', { clase: 'grid grid-cols-2 gap-2' }, [
          campo('En USD', {
            tipo: 'number', valor: v.ajusteUsd,
            evento: { input: function (e) { v.ajusteUsd = e.target.value; pedirTotales(); } }
          }),
          crear('div', { clase: 'self-end' }, [
            crear('span', { clase: 'mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-apagado', texto: 'Por qué' }),
            crear('input', {
              type: 'text', placeholder: 'le regalé un vidrio',
              class: 'h-11 w-full rounded-xl bg-hondo px-3 text-sm text-texto outline-none border border-borde focus:border-azul',
              evento: { input: function (e) { v.notas = e.target.value; } }
            })
          ])
        ]),
        crear('p', { clase: 'mt-1.5 text-[10px] text-apagado', texto: 'Un regalo o un descuento sale de la ganancia. Va en dólares.' })
      ]),

      seccion('Totales', crear('div', { id: 'caja-totales', clase: 'rounded-2xl border border-borde bg-hondo p-3.5' }, [
        crear('p', { clase: 'text-xs text-apagado', texto: 'Tocá un campo para ver los totales.' })
      ])),

      seccion('Guardar', crear('div', { clase: 'grid grid-cols-2 gap-2.5' }, [
        boton('Guardar borrador', { clase: 'tap rounded-2xl border border-borde bg-superficie py-3.5 font-bold text-apagado', evento: function () { guardarVenta('BORRADOR'); } }),
        boton('Confirmar venta', { clase: 'tap rounded-2xl bg-azul py-3.5 font-bold text-white shadow-lg shadow-azul/20', evento: function () { guardarVenta('CONFIRMADA'); } })
      ]))
    ];
  }

  function cuerpoDeVenta() {
    const v = ESTADO.venta;
    return {
      idEmpleado: v.idEmpleado,
      moneda: v.moneda,
      tcDecimas: v.tcDecimas,
      ajusteUsd: v.ajusteUsd === '' ? '0' : v.ajusteUsd,
      notas: v.notas,
      lineas: v.lineas.map(function (l) {
        return {
          idProducto: l.idProducto || '',
          modelo: l.modelo || '',
          cantidad: l.cantidad === '' ? '1' : String(l.cantidad),
          precio: l.precio === '' ? '0' : String(l.precio),
          costo: l.costo === undefined ? '' : String(l.costo)
        };
      })
    };
  }

  let relojTotales = null;
  function pedirTotales() {
    clearTimeout(relojTotales);
    relojTotales = setTimeout(async function () {
      if (!ESTADO.venta || !ESTADO.venta.lineas.length) return;
      try {
        const r = await api('/api/ventas/preview', { cuerpo: cuerpoDeVenta() });
        pintarTotales(r.venta || r.totales || {});
      } catch (e) {
        const caja = $('caja-totales');
        if (caja) {
          limpiar(caja);
          caja.appendChild(crear('p', { clase: 'text-xs text-apagado', texto: e.message }));
        }
      }
    }, 400);
  }

  function pintarTotales(t) {
    const caja = $('caja-totales');
    if (!caja) return;
    limpiar(caja);
    const fila = function (etiqueta, valor, color) {
      return crear('div', { clase: 'flex items-baseline justify-between gap-3 py-0.5' }, [
        crear('span', { clase: 'text-[11px] uppercase tracking-wider text-apagado', texto: etiqueta }),
        crear('span', { clase: 'font-dato text-sm font-semibold ' + color, texto: valor })
      ]);
    };
    caja.appendChild(fila('Ganancia USD', '$ ' + dinero(t.gananciaNetaUsdCents !== undefined ? t.gananciaNetaUsdCents : 0), 'text-titulo'));
    caja.appendChild(fila('Ganancia Bs', 'Bs ' + dinero(t.gananciaBsCents), 'text-verde'));
    caja.appendChild(fila('Comisión', 'Bs ' + dinero(t.comisionBsCents), 'text-ambar'));
    caja.appendChild(fila('Le queda al dueño', 'Bs ' + dinero(t.netoDuenoBsCents), 'text-azul'));
  }

  function repintarVenta() {
    if (ESTADO.vista === '#/vender') enrutar();
  }

  async function guardarVenta(estado) {
    const v = ESTADO.venta;
    if (!v.lineas.length) return aviso('Agregá al menos un producto.', 'ojo');
    const cuerpo = cuerpoDeVenta();
    cuerpo.claveIdempotencia = v.claveIdempotencia;
    try {
      const r = await api('/api/ventas', { cuerpo: cuerpo });
      ESTADO.venta = null;
      aviso(r && r.repetida ? 'Esa venta ya estaba guardada.' : 'Venta guardada.', 'bien');
      location.hash = '#/ventas';
      await enrutar();
    } catch (e) {
      errorDe(e);
    }
  }

  function agregarManual() {
    ESTADO.venta.lineas.push({ idProducto: '', modelo: 'Producto a mano', cantidad: '1', precio: '', costo: '' });
    repintarVenta();
    pedirTotales();
  }

  /* ---------------------------------------------------------------- */
  /* Vista: lista de precios referenciales                             */
  /* ---------------------------------------------------------------- */

  async function vistaPrecios() {
    const contenedor = crear('div', {});
    const entrada = campo('Buscar equipo', {
      valor: ESTADO.consultaPrecios,
      placeholder: 'samsung a54, iphone, redmi note…',
      evento: {
        input: function (e) {
          ESTADO.consultaPrecios = e.target.value;
          clearTimeout(contenedor.__reloj);
          contenedor.__reloj = setTimeout(cargarPrecios, 350);
        }
      }
    });

    async function cargarPrecios() {
      const zona = limpiar($('zona-precios') || crear('div', { id: 'zona-precios' }));
      zona.id = 'zona-precios';
      try {
        const r = await api('/api/catalogo?q=' + encodeURIComponent(ESTADO.consultaPrecios || ''));
        const lista = r.productos || [];
        if (!lista.length) {
          zona.appendChild(vacio('No hay nada con ese nombre.'));
          return;
        }
        lista.forEach(function (p) {
          zona.appendChild(crear('button', {
            type: 'button',
            clase: 'tap-lento mb-2 flex w-full items-center gap-3 rounded-2xl border border-borde bg-superficie p-3 text-left',
            evento: function () { verFicha(p); }
          }, [
            p.imagen
              ? crear('img', { src: p.imagen, alt: '', loading: 'lazy', class: 'h-14 w-14 shrink-0 rounded-xl bg-hondo object-contain' })
              : crear('span', { clase: 'flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-hondo text-2xl', texto: '📱' }),
            crear('span', { clase: 'min-w-0 flex-1' }, [
              crear('span', { clase: 'block truncate font-display text-sm font-bold text-titulo', texto: p.modelo }),
              crear('span', { clase: 'block truncate text-[10px] uppercase tracking-wider text-apagado', texto: p.marca }),
              crear('span', {
                clase: 'block truncate text-[11px] ' + (p.precioRefUsdCents ? 'text-verde' : 'text-ambar'),
                texto: p.precioRefUsdCents ? ('Ref. $ ' + dinero(p.precioRefUsdCents)) : 'Sin precio de referencia'
              })
            ])
          ]));
        });
      } catch (e) {
        zona.appendChild(crear('p', { clase: 'text-xs text-rosa', texto: e.message }));
      }
    }

    contenedor.appendChild(entrada);
    contenedor.appendChild(crear('div', { id: 'zona-precios', clase: 'mt-3' }));
    setTimeout(cargarPrecios, 0);
    return contenedor;
  }

  function verFicha(producto) {
    const capa = $('capa-modal');
    limpiar(capa);
    const cerrar = function () { capa.classList.add('hidden'); };
    const precio = crear('input', {
      type: 'number',
      value: producto.precioRefUsdCents ? String(producto.precioRefUsdCents / 100).replace('.', ',') : '',
      placeholder: '0,00',
      class: 'font-dato h-12 w-full rounded-xl bg-hondo px-3 text-lg text-texto outline-none border border-borde focus:border-azul centro'
    });
    capa.appendChild(crear('div', {
      clase: 'tap mx-auto mt-8 max-w-sm rounded-2xl border border-borde bg-superficie p-4'
    }, [
      crear('div', { clase: 'flex items-start justify-between gap-3' }, [
        crear('div', { clase: 'min-w-0' }, [
          crear('p', { clase: 'font-display text-lg font-bold leading-tight text-titulo', texto: producto.modelo }),
          crear('p', { clase: 'text-[10px] uppercase tracking-widest text-apagado', texto: producto.marca })
        ]),
        crear('button', { type: 'button', clase: 'tap rounded-lg border border-borde px-2 py-1 text-xs text-apagado', evento: cerrar }, ['✕'])
      ]),
      producto.imagen
        ? crear('img', { src: producto.imagen, alt: '', class: 'mx-auto my-3 h-40 rounded-2xl bg-hondo object-contain' })
        : null,
      crear('p', { clase: 'my-3 rounded-xl bg-hondo p-3 text-xs leading-relaxed text-apagado', texto: producto.caracteristicas || 'Sin características todavía.' }),
      crear('p', { clase: 'mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-apagado', texto: 'Precio de referencia (USD)' }),
      precio,
      crear('p', { clase: 'mt-1.5 text-[10px] text-apagado', texto: 'Es una referencia. El precio real lo pones al vender.' }),
      boton('Guardar precio', {
        clase: 'tap mt-3 w-full rounded-2xl bg-azul py-3.5 font-bold text-white',
        evento: async function () {
          try {
            await api('/api/catalogo/' + encodeURIComponent(producto.idProducto) + '/precio', {
              cuerpo: { precioUsdCents: precio.value }
            });
            cerrar();
            aviso('Precio guardado.', 'bien');
            enrutar();
          } catch (e) {
            errorDe(e);
          }
        }
      })
    ]));
    capa.classList.remove('hidden');
  }

  function buscarProducto() {
    const capa = $('capa-modal');
    limpiar(capa);
    const zona = crear('div', { id: 'busca-precios', clase: 'mt-2' });
    const entrada = crear('input', {
      type: 'search',
      placeholder: 'samsung a54, iphone, redmi…',
      class: 'h-12 w-full rounded-xl bg-hondo px-3 text-base text-texto outline-none border border-borde focus:border-azul'
    });
    const cerrar = function () { capa.classList.add('hidden'); };

    async function cargar() {
      const r = await api('/api/catalogo?q=' + encodeURIComponent(entrada.value || ''));
      limpiar(zona);
      const lista = r.productos || [];
      if (!lista.length) {
        zona.appendChild(vacio('Nada con ese nombre.'));
        return;
      }
      lista.forEach(function (p) {
        zona.appendChild(crear('button', {
          type: 'button',
          clase: 'tap-lento mb-2 flex w-full items-center gap-3 rounded-2xl border border-borde bg-superficie p-2.5 text-left',
          evento: function () {
            ESTADO.venta.lineas.push({
              idProducto: p.idProducto, modelo: p.modelo, cantidad: '1',
              precio: '', costo: '', caracteristicas: p.caracteristicas, imagen: p.imagen
            });
            cerrar();
            repintarVenta();
            pedirTotales();
          }
        }, [
          crear('span', { clase: 'min-w-0 flex-1' }, [
            crear('span', { clase: 'block truncate font-display text-sm font-bold text-titulo', texto: p.modelo }),
            crear('span', {
              clase: 'block truncate text-[10px] ' + (p.precioRefUsdCents ? 'text-verde' : 'text-ambar'),
              texto: p.precioRefUsdCents ? ('Ref. $ ' + dinero(p.precioRefUsdCents)) : 'Sin precio de referencia'
            })
          ])
        ]));
      });
    }

    entrada.addEventListener('input', function () {
      clearTimeout(entrada.__reloj);
      entrada.__reloj = setTimeout(cargar, 300);
    });
    capa.appendChild(crear('div', { clase: 'tap mx-auto mt-6 max-w-sm rounded-2xl border border-borde bg-superficie p-4' }, [
      crear('div', { clase: 'mb-3 flex items-center justify-between' }, [
        crear('h3', { clase: 'font-display text-base font-bold text-titulo', texto: 'Buscar equipo' }),
        crear('button', { type: 'button', clase: 'tap rounded-lg border border-borde px-2 py-1 text-xs text-apagado', evento: cerrar }, ['✕'])
      ]),
      entrada,
      zona
    ]));
    capa.classList.remove('hidden');
    setTimeout(cargar, 200);
  }

  /* ---------------------------------------------------------------- */
  /* Vista: ventas                                                    */
  /* ---------------------------------------------------------------- */

  async function vistaVentas(idTienda) {
    const desde = inicioDeSemana();
    const r = await api('/api/ventas?desde=' + desde + '&hasta=' + hoyIso() +
      (idTienda ? '&tienda=' + encodeURIComponent(idTienda) : ''));
    const lista = r.ventas || [];
    const cuerpo = lista.map(function (v) {
      return {
        estado: v.estado,
        celdas: [
          crear('div', {}, [
            crear('p', { clase: 'font-display text-xs font-bold text-titulo', texto: fechaCorta(v.dia) }),
            crear('p', { clase: 'text-[10px] text-apagado', texto: v.vendedor || '—' })
          ]),
          insignia(v.estado),
          crear('div', { clase: 'text-right' }, [
            crear('p', { clase: 'font-dato text-xs font-semibold text-verde', texto: 'Bs ' + dinero(v.gananciaBsCents) }),
            crear('p', { clase: 'font-dato text-[10px] text-apagado', texto: 'TC ' + String(v.tcDecimas / 100).replace('.', ',') })
          ])
        ]
      };
    });
    return [
      seccion(idTienda ? nombreTienda(idTienda) : 'Semana', tabla(
        [{ titulo: 'Día' }, { titulo: 'Estado' }, { titulo: 'Ganancia', clase: 'text-right' }],
        cuerpo, { vacio: 'Esta semana no vendiste nada todavía.' })),
      seccion('Leyenda', crear('div', { clase: 'flex flex-wrap gap-2 text-[10px] text-apagado' }, [
        crear('span', { clase: 'rounded-lg border border-ambar/30 bg-ambar/10 px-2 py-1 text-ambar', texto: 'En amarillo: cobrada y todavía sin cerrar.' }),
        crear('span', { clase: 'rounded-lg border border-borde px-2 py-1', texto: 'La marca roja es la que el dueño tiene que cerrar.' })
      ]))
    ];
  }

  /* ---------------------------------------------------------------- */
  /* Vista: una tienda (solo dueño)                                   */
  /* ---------------------------------------------------------------- */

  async function vistaTienda(idTienda) {
    const desde = inicioDeSemana();
    const r = await api('/api/ventas?desde=' + desde + '&hasta=' + hoyIso() + '&tienda=' + encodeURIComponent(idTienda));
    const lista = r.ventas || [];
    const t = ESTADO.tiendas.find(function (x) { return x.idTienda === idTienda; });
    const total = function (clave) {
      return lista.reduce(function (a, v) { return a + (Number(v[clave]) || 0); }, 0);
    };
    const pendientes = lista.filter(function (v) { return v.estado === 'CONFIRMADA'; });

    return [
      seccion(nombreTienda(idTienda), crear('div', { clase: 'flex items-center justify-between gap-3' }, [
        crear('p', { clase: 'text-xs text-apagado', texto: t && t.empleados ? t.empleados : '—' }),
        crear('span', { clase: 'rounded-full border border-borde bg-superficie px-2 py-1 font-dato text-[11px] text-ambar', texto: (t && t.pctComision !== undefined ? t.pctComision : '?') + '% comisión' })
      ])),

      seccion('Semana', crear('div', { clase: 'grid grid-cols-2 gap-2.5' }, [
        tarjetaKPI('Ventas', numero(lista.length)),
        tarjetaKPI('Ganancia', 'Bs ' + dinero(total('gananciaBsCents')), { borde: 'border-l-verde', color: 'text-verde' }),
        tarjetaKPI('Al encargado', 'Bs ' + dinero(total('comisionBsCents')), { borde: 'border-l-ambar', color: 'text-ambar' }),
        tarjetaKPI('Te queda', 'Bs ' + dinero(total('netoDuenoBsCents')), { borde: 'border-l-azul' })
      ])),

      seccion('Cobrar de esta tienda', crear('div', { clase: 'grid grid-cols-2 gap-2.5' }, [
        crear('a', {
          href: '#/cierre/' + idTienda,
          clase: 'tap flex flex-col items-center justify-center gap-1 rounded-2xl bg-verde py-4 text-hondo'
        }, [
          crear('span', { clase: 'text-2xl', texto: '🤝' }),
          crear('span', { clase: 'font-bold', texto: 'Cerrar día' })
        ]),
        crear('a', {
          href: '#/ajustes',
          clase: 'tap flex flex-col items-center justify-center gap-1 rounded-2xl border border-borde bg-superficie py-4'
        }, [
          crear('span', { clase: 'text-2xl', texto: '⚙️' }),
          crear('span', { clase: 'font-bold text-titulo', texto: 'Ajustes' })
        ])
      ])),

      pendientes.length
        ? seccion('Sin cerrar (' + numero(pendientes.length) + ')', tabla(
          [{ titulo: 'Día' }, { titulo: 'Vendedor' }, { titulo: 'Neto', clase: 'text-right' }],
          pendientes.map(function (v) {
            return {
              estado: v.estado,
              celdas: [fechaCorta(v.dia), v.vendedor || '—',
                { valor: 'Bs ' + dinero(v.netoDuenoBsCents), clase: 'font-dato text-right text-azul' }]
            };
          })))
        : seccion('Cobrar de esta tienda', crear('p', { clase: 'rounded-2xl border border-verde/30 bg-verde/10 px-4 py-3 text-sm text-verde', texto: 'Todo cerrado. No hay nada pendiente.' })),

      seccion('Semana', tabla(
        [{ titulo: 'Día' }, { titulo: 'Vendedor' }, { titulo: 'Ganancia', clase: 'text-right' }],
        lista.map(function (v) {
          return {
            estado: v.estado,
            celdas: [fechaCorta(v.dia), v.vendedor || '—',
              { valor: 'Bs ' + dinero(v.gananciaBsCents), clase: 'font-dato text-right text-verde' }]
          };
        }), { vacio: 'Esta semana no vendieron nada.' }))
    ];
  }

  /* ---------------------------------------------------------------- */
  /* Vista: modo dueño                                               */
  /* ---------------------------------------------------------------- */

  async function vistaDueno() {
    const desde = inicioDeSemana();
    const r = await api('/api/resumen?desde=' + desde + '&hasta=' + hoyIso());
    const resumen = r.resumen || {};
    const porTienda = resumen.porTienda || [];

    const tarjetas = porTienda.map(function (t) {
      const id = t.idTienda;
      const pendiente = (r.ventas || []).filter(function (v) {
        return v.idTienda === id && v.estado === 'CONFIRMADA';
      });
      return crear('a', {
        href: '#/tienda/' + id,
        clase: 'tap-lento mb-2.5 flex items-center gap-3 rounded-2xl border border-borde bg-superficie p-3.5'
      }, [
        crear('span', { clase: 'min-w-0 flex-1' }, [
          crear('span', { clase: 'block font-display text-sm font-bold text-titulo', texto: t.tienda || nombreTienda(id) }),
          crear('span', { clase: 'mt-0.5 block text-[10px] text-apagado', texto: numero(t.cantidadVentas || 0) + ' ventas · ' + numero(t.unidades || 0) + ' equipos' }),
          crear('span', {
            clase: 'mt-1 block font-dato text-sm font-semibold text-azul',
            texto: 'Bs ' + dinero(t.netoDuenoBsCents || 0)
          })
        ]),
        pendiente.length
          ? crear('span', { clase: 'shrink-0 rounded-full bg-ambar/15 px-2 py-1 text-[10px] font-bold text-ambar', texto: numero(pendiente.length) + ' sin cerrar' })
          : crear('span', { clase: 'shrink-0 text-apagado', texto: '›' })
      ]);
    });

    return [
      seccion('Tu semana', crear('div', { clase: 'grid grid-cols-2 gap-2.5' }, [
        tarjetaKPI('Ventas', numero(resumen.cantidadVentas || 0)),
        tarjetaKPI('Unidades', numero(resumen.unidades || 0), { borde: 'border-l-violeta' }),
        tarjetaKPI('Ganancia', 'Bs ' + dinero(resumen.totalGananciaBsCents), { borde: 'border-l-verde', color: 'text-verde' }),
        tarjetaKPI('Comisiones', 'Bs ' + dinero(resumen.totalComisionBsCents), { borde: 'border-l-ambar', color: 'text-ambar' }),
        crear('div', { clase: 'col-span-2 rounded-2xl border border-azul/30 bg-azul/10 p-4' }, [
          crear('p', { clase: 'text-[9px] font-bold uppercase tracking-widest text-apagado', texto: 'Te queda de la semana' }),
          crear('p', { clase: 'mt-0.5 font-dato text-2xl font-semibold text-azul', texto: 'Bs ' + dinero(resumen.totalNetoDuenoBsCents) })
        ])
      ])),

      seccion('Tus tiendas', tarjetas.length ? tarjetas : vacio('Todavía no hay ventas en la semana.')),

      seccion('Herramientas', crear('div', { clase: 'grid grid-cols-3 gap-2.5' }, [
        crear('a', { href: '#/ajustes', clase: 'tap flex flex-col items-center gap-1 rounded-2xl border border-borde bg-superficie py-4' }, [
          crear('span', { clase: 'text-2xl', texto: '⚙️' }), crear('span', { clase: 'text-[10px] font-bold text-titulo', texto: 'Ajustes' })
        ]),
        crear('a', { href: '#/ventas', clase: 'tap flex flex-col items-center gap-1 rounded-2xl border border-borde bg-superficie py-4' }, [
          crear('span', { clase: 'text-2xl', texto: '🧾' }), crear('span', { clase: 'text-[10px] font-bold text-titulo', texto: 'Ventas' })
        ]),
        crear('a', { href: '#/precios', clase: 'tap flex flex-col items-center gap-1 rounded-2xl border border-borde bg-superficie py-4' }, [
          crear('span', { clase: 'text-2xl', texto: '🔎' }), crear('span', { clase: 'text-[10px] font-bold text-titulo', texto: 'Precios' })
        ])
      ]))
    ];
  }

  /* ---------------------------------------------------------------- */
  /* Vista: cierre del día                                            */
  /* ---------------------------------------------------------------- */

  async function vistaCierre(idTienda) {
    const id = idTienda || (ESTADO.sesion.idTienda || '');
    const dia = hoyIso();
    const r = await api('/api/cierres/preview?tienda=' + encodeURIComponent(id) + '&dia=' + dia);
    const vista = r.vista || {};
    const pagado = crear('input', {
      type: 'number',
      placeholder: String((vista.saldoPendienteBsCents || 0) / 100).replace('.', ','),
      class: 'font-dato h-14 w-full rounded-xl bg-hondo px-3 text-center text-2xl font-semibold text-texto outline-none border border-borde focus:border-azul'
    });

    return [
      seccion('Cerrar ' + (vista.tienda || nombreTienda(id)) + ' · ' + fechaCorta(dia), [
        crear('div', { clase: 'grid grid-cols-2 gap-2.5' }, [
          tarjetaKPI('Ventas', numero(vista.cantidadVentas || 0)),
          tarjetaKPI('Sin cerrar', numero(vista.pendientes || 0), { borde: 'border-l-ambar', color: 'text-ambar' }),
          tarjetaKPI('Comisiones', 'Bs ' + dinero(vista.totalComisionBsCents || 0), { borde: 'border-l-ambar' }),
          tarjetaKPI('Te queda', 'Bs ' + dinero(vista.saldoPendienteBsCents || 0), { borde: 'border-l-azul' })
        ])
      ]),

      seccion('Qué te entregó', tabla(
        [{ titulo: 'Vendedor' }, { titulo: 'Comisión', clase: 'text-right' }],
        (vista.ventas || []).map(function (v) {
          return { estado: v.estado, celdas: [v.vendedor || '—', { valor: 'Bs ' + dinero(v.comisionBsCents), clase: 'font-dato text-right text-ambar' }] };
        }), { vacio: 'No hay ventas para cerrar hoy.' })),

      seccion('Lo que te pagan', [
        crear('p', { clase: 'mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-apagado', texto: 'Bs que te entrega el encargado' }),
        pagado,
        boton('Cerrar el día', {
          clase: 'tap mt-3 w-full rounded-2xl bg-verde py-4 font-bold text-hondo',
          evento: async function () {
            try {
              await api('/api/cierres', { cuerpo: { idTienda: id, dia: dia, pagadoBsCents: pagado.value } });
              aviso('Cerrado. Las ventas de hoy quedaron pagadas.', 'bien');
              location.hash = '#/tienda/' + id;
              await enrutar();
            } catch (e) {
              errorDe(e);
            }
          }
        }),
        crear('p', { clase: 'mt-2 text-[10px] text-apagado', texto: 'Con esto las ventas de hoy quedan cerradas y se guarda un recibo.' })
      ])
    ];
  }

  /* ---------------------------------------------------------------- */
  /* Vista: ajustes (solo dueño)                                      */
  /* ---------------------------------------------------------------- */

  async function vistaAjustes() {
    constlosDatos = await Promise.all([
      api('/api/tiendas').catch(function () { return { tiendas: [] }; }),
      api('/api/empleados').catch(function () { return { empleados: [] }; }),
      api('/api/tc-hoy').catch(function () { return { tcs: [] }; })
    ]);
    const tiendas = (losDatos[0].tiendas) || [];
    const empleados = (losDatos[1].empleados) || [];
    const tcs = (losDatos[2].tcs) || [];

    const bloques = tiendas.map(function (t) {
      const comision = crear('input', {
        type: 'number',
        value: String(t.pctComision === undefined ? '' : t.pctComision),
        class: 'font-dato h-11 w-24 rounded-xl bg-hondo px-3 text-center text-titulo outline-none border border-borde focus:border-azul'
      });
      return crear('div', { clase: 'mb-2.5 rounded-2xl border border-borde bg-superficie p-3.5' }, [
        crear('div', { clase: 'flex items-center justify-between gap-3' }, [
          crear('div', { clase: 'min-w-0' }, [
            crear('p', { clase: 'font-display text-sm font-bold text-titulo', texto: t.nombre }),
            crear('p', { clase: 'truncate text-[10px] text-apagado', texto: t.empleados || '—' })
          ]),
          crear('div', { clase: 'flex items-center gap-2' }, [
            crear('span', { clase: 'text-[10px] text-apagado', texto: '%' }),
            comision
          ])
        ]),
        boton('Guardar comisión', {
          clase: 'tap mt-2.5 w-full rounded-xl border border-borde py-2.5 text-xs font-bold text-azul',
          evento: async function () {
            try {
              await api('/api/ajustes/tienda/' + encodeURIComponent(t.idTienda), { cuerpo: { pctComision: comision.value } });
              ESTADO.tiendas = [];
              await cargarSesion();
              aviso('Comisión de ' + t.nombre + ' guardada.', 'bien');
            } catch (e) {
              errorDe(e);
            }
          }
        })
      ]);
    });

    return [
      seccion('Comisión por tienda', bloques.length ? bloques : vacio('No hay tiendas cargadas.')),

      seccion('Empleados', tabla(
        [{ titulo: 'Nombre' }, { titulo: 'Tienda' }, { titulo: 'Estado' }],
        empleados.map(function (e) {
          return { celdas: [e.nombre, nombreTienda(e.idTienda), e.activo ? '🟢' : '⚪'] };
        }), { vacio: 'Sin empleados dados de alta.' })),

      seccion('Tipo de cambio de hoy', tabla(
        [{ titulo: 'Empleado' }, { titulo: 'Tienda' }, { titulo: 'TC', clase: 'text-right' }],
        tcs.map(function (t) {
          return { celdas: [t.empleado || '—', nombreTienda(t.idTienda), { valor: String(t.tcDecimas / 100).replace('.', ','), clase: 'font-dato text-right' }] };
        }), { vacio: 'Nadie registró su TC hoy.' })),

      seccion('Agregar empleado', crear('button', {
        type: 'button',
        clase: 'tap w-full rounded-2xl border border-dashed border-azul/40 bg-azul/10 py-3.5 text-sm font-bold text-azul',
        evento: agregarEmpleado
      }, ['+ Dar de alta a alguien']))
    ];
  }

  function agregarEmpleado() {
    const capa = $('capa-modal');
    limpiar(capa);
    const cerrar = function () { capa.classList.add('hidden'); };
    const nombre = crear('input', { type: 'text', placeholder: 'Nombre', class: 'h-12 w-full rounded-xl bg-hondo px-3 text-texto outline-none border border-borde focus:border-azul' });
    const tienda = crear('select', { class: 'h-12 w-full rounded-xl bg-hondo px-3 text-texto outline-none border border-borde focus:border-azul' },
      ESTADO.tiendas.map(function (t) { return crear('option', { value: t.idTienda, texto: t.nombre }); }));
    const clave = crear('input', { type: 'text', placeholder: 'Clave que va a usar para entrar', class: 'h-12 w-full rounded-xl bg-hondo px-3 text-texto outline-none border border-borde focus:border-azul' });
    capa.appendChild(crear('div', { clase: 'tap mx-auto mt-8 max-w-sm space-y-2.5 rounded-2xl border border-borde bg-superficie p-4' }, [
      crear('h3', { clase: 'font-display text-base font-bold text-titulo', texto: 'Nuevo empleado' }),
      nombre, tienda, clave,
      boton('Guardar', {
        clase: 'tap w-full rounded-2xl bg-azul py-3.5 font-bold text-white',
        evento: async function () {
          try {
            await api('/api/ajustes/empleados', {
              cuerpo: { empleados: [{ nombre: nombre.value, idTienda: tienda.value }], clave: clave.value }
            });
            cerrar();
            aviso('Empleado dado de alta.', 'bien');
            enrutar();
          } catch (e) {
            errorDe(e);
          }
        }
      })
    ]));
    capa.classList.add('hidden');
    capa.classList.remove('hidden');
  }

  /* ---------------------------------------------------------------- */
  /* Enrutador                                                        */
  /* ---------------------------------------------------------------- */

  const VISTAS_DUENO = ['#/dueno', '#/ajustes'];

  async function enrutar() {
    const hash = location.hash || '#/login';
    ESTADO.vista = hash;

    if (hash === '#/login') {
      ESTADO.sesion = null;
      ESTADO.venta = null;
      await pintarLogin();
      return;
    }

    await cargarSesion();
    if (!ESTADO.sesion) {
      location.hash = '#/login';
      await pintarLogin();
      return;
    }

    // Las vistas del dueño existen para el dueño. Un encargado que llegue
    // por error a esa pantalla ve un aviso y su propia pantalla, no un 404
    // seco ni un error de consola.
    const esSoloDueno = VISTAS_DUENO.indexOf(hash) === 0 || hash.indexOf('#/cierre/') === 0 || hash.indexOf('#/tienda/') === 0;
    if (esSoloDueno && !esDueno()) {
      location.hash = '#/inicio';
      return;
    }

    $('pantalla-login').classList.add('hidden');
    $('pantalla-app').classList.remove('hidden');
    $('capa-modal').classList.add('hidden');
    $('rotulo-tienda').textContent = esDueno() ? 'Todas las tiendas' : nombreTienda(ESTADO.sesion.idTienda);
    $('rotulo-rol').textContent = esDueno() ? 'Dueño' : (ESTADO.sesion.nombre || 'Encargado');

    const contenido = limpiar($('contenido'));
    let nodos;
    try {
      if (hash === '#/vender') nodos = await vistaVender();
      else if (hash === '#/ventas') nodos = await vistaVentas(esDueno() ? '' : ESTADO.sesion.idTienda);
      else if (hash === '#/precios') nodos = await vistaPrecios();
      else if (hash === '#/dueno') nodos = await vistaDueno();
      else if (hash === '#/ajustes') nodos = await vistaAjustes();
      else if (hash.indexOf('#/tienda/') === 0) nodos = await vistaTienda(hash.slice('#/tienda/'.length));
      else if (hash.indexOf('#/cierre/') === 0) nodos = await vistaCierre(hash.slice('#/cierre/'.length));
      else nodos = await vistaInicio();
    } catch (e) {
      nodos = [crear('div', { clase: 'rounded-2xl border border-rosa/30 bg-rosa/10 p-4 text-sm text-rosa' }, [e.message])];
    }

    const caja = crear('div', { clase: 'vista' }, Array.isArray(nodos) ? nodos : [nodos]);
    contenido.appendChild(caja);
    window.scrollTo(0, 0);
    pintarPestanas();
  }

  /* ---------------------------------------------------------------- */
  /* Arranque                                                         */
  /* ---------------------------------------------------------------- */

  window.addEventListener('hashchange', enrutar);
  $('boton-salir').addEventListener('click', salir);
  $('capa-modal').addEventListener('click', function (e) {
    if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
  });
  enrutar();
})();