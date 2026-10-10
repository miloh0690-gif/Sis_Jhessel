'use strict';

(function () {
  var app = document.getElementById('app');
  var cajaAviso = document.getElementById('aviso');

  var estado = { sesion: null, vista: '', datos: {}, lineaClave: '' };
  var empleadoElegido = '';
  var monedaElegida = 'BS';
  var tcElegido = '';
  var temporizadorTotales = null;

  var FORMATO_BS = new Intl.NumberFormat('es-BO', {
    style: 'currency',
    currency: 'BOB',
    minimumFractionDigits: 2
  });

  // ---------- utilidades ----------

  function dineroBs(centavos) {
    var n = Number(centavos);
    if (!isFinite(n)) { n = 0; }
    return FORMATO_BS.format(n / 100);
  }

  function numero(valor) {
    var n = Number(valor);
    return isFinite(n) ? n : 0;
  }

  function texto(valor) {
    if (valor === undefined || valor === null) { return ''; }
    return String(valor);
  }

  function quitar(marca) {
    while (marca && marca.firstChild) { marca.removeChild(marca.firstChild); }
  }

  function crear(etiqueta, atributos, hijos) {
    var nodo = document.createElement(etiqueta);
    var attrs = atributos || {};
    Object.keys(attrs).forEach(function (nombre) {
      var valor = attrs[nombre];
      if (valor === undefined || valor === null || valor === false) { return; }
      if (nombre === 'texto') { nodo.textContent = texto(valor); return; }
      if (nombre === 'clase') { nodo.className = valor; return; }
      if (nombre === 'evento') {
        Object.keys(valor).forEach(function (tipo) { nodo.addEventListener(tipo, valor[tipo]); });
        return;
      }
      if (valor === true) { nodo.setAttribute(nombre, ''); return; }
      nodo.setAttribute(nombre, valor);
    });
    (hijos || []).forEach(function (hijo) {
      if (hijo === null || hijo === undefined) { return; }
      nodo.appendChild(typeof hijo === 'string' ? document.createTextNode(hijo) : hijo);
    });
    return nodo;
  }

  function aviso(mensaje, tipo) {
    if (!cajaAviso) { return; }
    cajaAviso.textContent = mensaje;
    cajaAviso.className = 'aviso visible ' + (tipo || '');
    cajaAviso.hidden = false;
    if (temporizadorAviso) { clearTimeout(temporizadorAviso); }
    temporizadorAviso = setTimeout(function () {
      cajaAviso.className = 'aviso';
    }, 3200);
  }
  var temporizadorAviso = null;

  function vaciar(marca) { quitar(marca); }

  // ---------- API ----------

  function api(ruta, cuerpo) {
    var opciones = {
      method: cuerpo === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    };
    if (cuerpo !== undefined) {
      opciones.headers['Content-Type'] = 'application/json';
      opciones.body = JSON.stringify(cuerpo);
    }
    return fetch(ruta, opciones).then(function (respuesta) {
      return respuesta.text().then(function (textoRespuesta) {
        var cuerpoRespuesta = null;
        if (textoRespuesta) {
          try { cuerpoRespuesta = JSON.parse(textoRespuesta); } catch (e) { cuerpoRespuesta = null; }
        }
        if (!respuesta.ok) {
          var mensaje = (cuerpoRespuesta && cuerpoRespuesta.error)
            ? cuerpoRespuesta.error
            : 'No se pudo completar la operacion (' + respuesta.status + ').';
          var fallo = new Error(mensaje);
          fallo.codigo = respuesta.status;
          throw fallo;
        }
        return cuerpoRespuesta === null ? {} : cuerpoRespuesta;
      });
    }, function () {
      var fallo = new Error('No hay conexion con el servidor. Revisa la red.');
      fallo.codigo = 0;
      throw fallo;
    });
  }

  function error(e) {
    aviso(e && e.message ? e.message : 'Ocurrio un error inesperado.', 'malo');
    if (window.console && console.error) { console.error(e); }
  }

  // ---------- piezas de pantalla ----------

  function metrica(rotulo, valor, clase) {
    return crear('div', { clase: 'metrica' }, [
      crear('span', { clase: 'rotulo', texto: rotulo }),
      crear('span', { clase: 'valor ' + (clase || ''), texto: valor })
    ]);
  }

  function insigniaEstado(estadoVenta) {
    var clave = texto(estadoVenta).toLowerCase();
    return crear('span', { clase: 'insignia ' + clave, texto: texto(estadoVenta || '-') });
  }

  function tabla(titulo, columnas, filas) {
    var thead = crear('thead', {}, [
      crear('tr', {}, columnas.map(function (col) {
        return crear('th', { clase: col.num ? 'num' : '', texto: col.titulo });
      }))
    ]);
    var tbody = crear('tbody', {}, filas);
    return crear('div', { clase: 'tabla-envoltura' }, [
      crear('table', {}, [
        crear('caption', { texto: titulo }),
        thead,
        tbody
      ])
    ]);
  }

  function celda(valor, esNum) {
    var hijo = (valor && valor.nodeType) ? valor : texto(valor);
    return crear('td', { clase: esNum ? 'num' : '' }, [hijo]);
  }

  function celdaBs(centavos) {
    return crear('td', { clase: 'num', texto: dineroBs(centavos) });
  }

  function vacio(mensaje) {
    return crear('p', { clase: 'vacio', texto: mensaje });
  }

  // ---------- cabecera y navegación ----------

  function cabecera() {
    var sesion = estado.sesion || {};
    var esDueño = sesion.rol === 'dueno';
    var enlaces = [
      { hash: '#/inicio', texto: 'Inicio' },
      { hash: '#/nueva', texto: 'Nueva venta' },
      { hash: '#/ventas', texto: 'Ventas' },
      { hash: '#/catalogo', texto: 'Catalogo' }
    ];
    if (esDueño) {
      enlaces.push({ hash: '#/consolidado', texto: 'Consolidado' });
      enlaces.push({ hash: '#/cierre', texto: 'Cierre del dia' });
      enlaces.push({ hash: '#/ajustes', texto: 'Ajustes' });
    }

    var nav = crear('nav', {}, enlaces.map(function (enlace) {
      return crear('a', {
        href: enlace.hash,
        clase: estado.vista === enlace.hash ? 'activo' : '',
        texto: enlace.texto
      });
    }).concat([
      crear('a', {
        href: '#/salir',
        texto: 'Salir',
        evento: {
          click: function (evento) {
            evento.preventDefault();
            api('/api/auth/logout', {}).then(function () {
              estado.sesion = null;
              location.hash = '#/login';
              router();
            }, error);
          }
        }
      })
    ]));

    return crear('header', { clase: 'cabecera' }, [
      crear('h1', { texto: 'Sis Jhessel' }),
      crear('p', {
        clase: 'sub',
        texto: (esDueño ? 'Dueño' : 'Encargado') + ' - ' + texto(sesion.nombre || '')
      }),
      nav
    ]);
  }

  // ---------- vista: login ----------

  function vistaLogin() {
    var contenedor = crear('div', { clase: 'tarjeta login' }, [
      crear('h1', { texto: 'Sis Jhessel' }),
      crear('p', { clase: 'lema', texto: 'Control de ventas y comisiones por tienda.' })
    ]);

    var contenedorClave = crear('div', { clase: 'campo oculto' }, [
      crear('label', { for: 'clave', texto: 'Contrasena' }),
      crear('input', { type: 'password', id: 'clave', autocomplete: 'current-password', inputmode: 'numeric' })
    ]);

    var idTiendaElegida = '';
    var esDueño = false;

    var botones = crear('div', { clase: 'acciones-login' }, []);

    var botonEnviar = crear('button', {
      clase: 'btn-primario',
      texto: 'Entrar',
      evento: {
        click: function () { enviar(); }
      }
    });

    function pintarBotones(tiendas) {
      vaciar(botones);
      tiendas.forEach(function (tienda) {
        botones.appendChild(crear('button', {
          clase: 'btn-linea',
          texto: 'Entrar a ' + texto(tienda.nombre),
          evento: {
            click: function () {
              idTiendaElegida = texto(tienda.idTienda);
              esDueño = false;
              contenedorClave.classList.remove('oculto');
              document.getElementById('clave').value = '';
              document.getElementById('clave').focus();
            }
          }
        }));
      });
      botones.appendChild(crear('button', {
        clase: 'btn-linea',
        texto: 'Entrar como dueno',
        evento: {
          click: function () {
            idTiendaElegida = '';
            esDueño = true;
            contenedorClave.classList.remove('oculto');
            document.getElementById('clave').value = '';
            document.getElementById('clave').focus();
          }
        }
      }));
    }

    function enviar() {
      var campo = document.getElementById('clave');
      var clave = campo ? campo.value : '';
      if (!clave) { aviso('Escribe la contrasena.', 'malo'); return; }
      var cuerpo = esDueño ? { dueno: true, clave: clave } : { idTienda: idTiendaElegida, clave: clave };
      botonEnviar.disabled = true;
      api('/api/auth/login', cuerpo).then(function (datos) {
        estado.sesion = datos.sesion || { rol: datos.rol, idTienda: datos.idTienda, nombre: datos.nombre };
        aviso('Sesion iniciada.', 'bueno');
        location.hash = '#/inicio';
        router();
      }, function (e) {
        botonEnviar.disabled = false;
        if (e.codigo === 401) { aviso('Contrasena incorrecta.', 'malo'); }
        error(e);
      });
    }

    contenedor.appendChild(botones);
    contenedor.appendChild(contenedorClave);
    contenedor.appendChild(crear('div', { clase: 'acciones' }, [botonEnviar]));

    api('/api/tiendas', {}).then(function (datos) {
      pintarBotones((datos && datos.tiendas) || []);
    }, function (e) {
      contenedor.appendChild(vacio('No se pudieron cargar las tiendas: ' + e.message));
    });

    return contenedor;
  }

  // ---------- vista: inicio (encargado) ----------

  function vistaInicio() {
    var caja = crear('div', {});
    var sesion = estado.sesion || {};

    if (sesion.rol === 'dueno') { return vistaConsolidado(); }

    caja.appendChild(crear('h2', { clase: 'titulo-seccion', texto: 'Tu semana' }));

    var resumen = crear('div', { clase: 'rejilla' }, [vacio('Cargando...')]);

    function pintar(periodo) {
      var desde = new Date();
      var dias = periodo === 'hoy' ? 1 : 7;
      desde.setDate(desde.getDate() - (dias - 1));
      var desdeIso = desde.toISOString().slice(0, 10);
      var hastaIso = new Date().toISOString().slice(0, 10);
      api('/api/resumen?desde=' + desdeIso + '&hasta=' + hastaIso, {}).then(function (datos) {
        var r = (datos && datos.resumen) || {};
        vaciar(resumen);
        resumen.appendChild(metrica('Ventas', texto(numero(r.cantidadVentas))));
        resumen.appendChild(metrica('Ganancia generada', dineroBs(r.totalGananciaBsCents)));
        resumen.appendChild(metrica('Tu comision', dineroBs(r.totalComisionBsCents), 'exito'));
        resumen.appendChild(metrica('Neto del dueno', dineroBs(r.totalNetoDuenoBsCents)));
        var pendientes = Array.isArray(datos.pendientes) ? datos.pendientes.length : numero(r.pendientes);
        resumen.appendChild(metrica('Pendientes de cierre', texto(pendientes),
          pendientes > 0 ? 'negro' : ''));
      }, function (e) {
        vaciar(resumen);
        resumen.appendChild(vacio('No se pudo cargar el resumen: ' + e.message));
      });
    }

    caja.appendChild(resumen);
    caja.appendChild(crear('div', { clase: 'acciones' }, [
      crear('button', { clase: 'btn-primario', texto: 'Nueva venta', evento: { click: function () { location.hash = '#/nueva'; } } }),
      crear('button', { clase: 'btn-linea', texto: 'Ver mis ventas', evento: { click: function () { location.hash = '#/ventas'; } } })
    ]));

    caja.appendChild(crear('h2', { clase: 'titulo-seccion', texto: 'Cambiar periodo' }));
    caja.appendChild(crear('div', { clase: 'acciones' }, [
      crear('button', { clase: 'btn-linea', texto: 'Hoy', evento: { click: function () { pintar('hoy'); } } }),
      crear('button', { clase: 'btn-linea', texto: 'Ultimos 7 dias', evento: { click: function () { pintar('semana'); } } })
    ]));

    pintar('semana');
    return caja;
  }

  // ---------- vista: nueva venta ----------

  function vistaNueva() {
    if (!estado.lineaClave) {
      estado.lineaClave = 'ui' + Date.now().toString(36) + Math.floor(Math.random() * 1679616).toString(36);
    }
    var lineas = [];
    var idCounter = 0;

    var caja = crear('div', {});
    caja.appendChild(crear('h2', { clase: 'titulo-seccion', texto: 'Nueva venta' }));

    var selEmpleado = crear('select', {
      evento: { change: function () { empleadoElegido = selEmpleado.value; pedirTotales(); } }
    }, [crear('option', { value: '', texto: 'Elegir_encargado' })]);

    var selMoneda = crear('select', {
      evento: { change: function () { monedaElegida = selMoneda.value; pedirTotales(); } }
    }, [
      crear('option', { value: 'BS', texto: 'Bs' }),
      crear('option', { value: 'USD', texto: 'USD' })
    ]);
    selMoneda.value = monedaElegida;

    var campoTc = crear('input', {
      type: 'text',
      inputmode: 'decimal',
      placeholder: '7,25',
      evento: { input: function () { tcElegido = campoTc.value; pedirTotales(); } }
    });

    caja.appendChild(crear('div', { clase: 'tarjeta' }, [
      crear('h2', { texto: 'Quien y como cobra' }),
      crear('div', { clase: 'campo' }, [crear('label', { texto: 'Quien vendio' }), selEmpleado]),
      crear('div', { clase: 'cuadros' }, [
        crear('div', { clase: 'campo par' }, [crear('label', { texto: 'Moneda del pago' }), selMoneda]),
        crear('div', { clase: 'campo par' }, [crear('label', { texto: 'Tipo de cambio' }), campoTc])
      ]),
      crear('p', { clase: 'nota', texto: 'El costo del equipo siempre se carga en dolares.' })
    ]));

    // --- lineas ---
    var listaLineas = crear('div', { clase: 'lineas' }, []);

    function totalDeLineas() {
      return lineas.reduce(function (suma, linea) { return suma + (numero(linea.cantidad) || 1); }, 0);
    }

    function agregarLinea(datos) {
      idCounter = idCounter + 1;
      var linea = {
        id: idCounter,
        idProducto: datos.idProducto || '',
        modelo: datos.modelo || '',
        cantidad: datos.cantidad === undefined ? 1 : datos.cantidad,
        precioUsdCents: datos.precioUsdCents === undefined ? '' : datos.precioUsdCents,
        costoUnitarioUsdCents: datos.costoUnitarioUsdCents === undefined ? '' : datos.costoUnitarioUsdCents,
        origen: datos.origen || ''
      };
      lineas.push(linea);
      pintarLineas();
      pedirTotales();
    }

    function quitarLinea(id) {
      lineas = lineas.filter(function (linea) { return linea.id !== id; });
      pintarLineas();
      pedirTotales();
    }

    function pintarLineas() {
      vaciar(listaLineas);
      if (lineas.length === 0) {
        listaLineas.appendChild(vacio('Agrega al menos un producto.'));
        return;
      }
      lineas.forEach(function (linea, indice) {
        var inModelo = crear('input', {
          type: 'text',
          value: linea.modelo,
          evento: {
            input: function () { linea.modelo = inModelo.value; linea.idProducto = ''; pedirTotales(); }
          }
        });
        var inCantidad = crear('input', {
          type: 'number', min: '1', step: '1', value: linea.cantidad,
          evento: { input: function () { linea.cantidad = inCantidad.value; pedirTotales(); } }
        });
        var inPrecio = crear('input', {
          type: 'number', min: '0', step: '0.01', value: linea.precioUsdCents,
          evento: { input: function () { linea.precioUsdCents = inPrecio.value; pedirTotales(); } }
        });
        var inCosto = crear('input', {
          type: 'number', min: '0', step: '0.01', value: linea.costoUnitarioUsdCents,
          evento: { input: function () { linea.costoUnitarioUsdCents = inCosto.value; pedirTotales(); } }
        });

        listaLineas.appendChild(crear('div', { clase: 'linea' }, [
          crear('div', { clase: 'cabeza-linea' }, [
            crear('span', { clase: 'num-linea', texto: 'Producto ' + (indice + 1) }),
            crear('button', {
              clase: 'btn-peligro btn-chico',
              type: 'button',
              texto: 'Quitar',
              evento: { click: function () { quitarLinea(linea.id); } }
            })
          ]),
          crear('div', { clase: 'campo' }, [crear('label', { texto: 'Modelo' }), inModelo]),
          crear('div', { clase: 'cuadros' }, [
            crear('div', { clase: 'campo par' }, [crear('label', { texto: 'Cantidad' }), inCantidad]),
            crear('div', { clase: 'campo par' }, [crear('label', { texto: 'Precio de venta (USD)' }), inPrecio])
          ]),
          crear('div', { clase: 'campo' }, [crear('label', { texto: 'Costo unitario (USD)' }), inCosto]),
          crear('p', { clase: 'nota solo-lector', texto: 'Origen: ' + (linea.origen || 'carga manual') })
        ]));
      });
    }

    // --- buscador de catalogo ---
    var entradaBusqueda = crear('input', { type: 'search', placeholder: 'Buscar modelo en el catalogo' });
    var resultados = crear('div', {}, []);

    var botonBuscar = crear('button', {
      clase: 'btn-linea btn-chico',
      type: 'button',
      texto: 'Buscar',
      evento: {
        click: function () {
          var textoBusqueda = entradaBusqueda.value.trim();
          api('/api/catalogo?q=' + encodeURIComponent(textoBusqueda), {}).then(function (datos) {
            vaciar(resultados);
            var lista = (datos && datos.productos) || [];
            if (lista.length === 0) {
              resultados.appendChild(vacio('No se encontro ningun producto.'));
              return;
            }
            lista.forEach(function (producto) {
              resultados.appendChild(crear('button', {
                clase: 'btn-linea btn-chico',
                type: 'button',
                texto: texto(producto.marca) + ' ' + texto(producto.modelo),
                evento: {
                  click: function () {
                    agregarLinea({
                      idProducto: producto.idProducto,
                      modelo: texto(producto.modelo),
                      cantidad: 1,
                      precioUsdCents: producto.precioRefUsdCents,
                      costoUnitarioUsdCents: '',
                      origen: 'catalogo'
                    });
                  }
                }
              }));
            });
          }, error);
        }
      }
    });

    caja.appendChild(crear('div', { clase: 'tarjeta' }, [
      crear('h2', { texto: 'Productos' }),
      crear('div', { clase: 'campo' }, [
        crear('label', { texto: 'Buscar en el catalogo' }),
        crear('div', { clase: 'fila-boton' }, [entradaBusqueda, botonBuscar])
      ]),
      resultados,
      crear('div', { clase: 'acciones' }, [
        crear('button', {
          clase: 'btn-linea',
          type: 'button',
          texto: 'Agregar del catalogo',
          evento: { click: function () { botonBuscar.click(); } }
        }),
        crear('button', {
          clase: 'btn-linea',
          type: 'button',
          texto: 'Agregar manual',
          evento: {
            click: function () {
              agregarLinea({ modelo: '', cantidad: 1, precioUsdCents: '', costoUnitarioUsdCents: '', origen: 'manual' });
            }
          }
        })
      ]),
      listaLineas
    ]));

    // --- ajustes y notas ---
    var inAjuste = crear('input', {
      type: 'number', min: '0', step: '0.01', placeholder: '0',
      evento: { input: pedirTotales }
    });
    var inNotas = crear('textarea', {
      rows: '2',
      placeholder: 'Ejemplo: le regale un vidrio',
      evento: { input: function () { pedirTotales(); } }
    });

    caja.appendChild(crear('div', { clase: 'tarjeta ajustes' }, [
      crear('h2', { texto: 'Ajustes y notas' }),
      crear('div', { clase: 'campo' }, [
        crear('label', { texto: 'Ajuste (USD, resta de la ganancia)' }), inAjuste
      ]),
      crear('div', { clase: 'campo' }, [crear('label', { texto: 'Notas de la venta' }), inNotas])
    ]));

    // --- totales ---
    var recuadroTotales = crear('div', { clase: 'rejilla' }, [vacio('Completa los datos para ver los totales.')]);

    function pintarTotales(totales) {
      vaciar(recuadroTotales);
      recuadroTotales.appendChild(metrica('Ganancia USD', (numero(totales.gananciaNetaUsdCents) / 100).toFixed(2)));
      recuadroTotales.appendChild(metrica('Ganancia Bs', dineroBs(totales.gananciaBsCents)));
      recuadroTotales.appendChild(metrica('Comision', dineroBs(totales.comisionBsCents)));
      recuadroTotales.appendChild(metrica('Neto del dueno', dineroBs(totales.netoDuenoBsCents)));
      recuadroTotales.appendChild(metrica('Total cobrado Bs', dineroBs(totales.totalCobradoBsCents)));
      recuadroTotales.appendChild(metrica('Unidades', texto(numero(totales.unidades) || totalDeLineas())));
    }

    function pedirTotales() {
      if (temporizadorTotales) { clearTimeout(temporizadorTotales); }
      temporizadorTotales = setTimeout(function () {
        var cuerpo = armarCuerpo();
        if (!cuerpo) { return; }
        api('/api/ventas/preview', cuerpo).then(function (datos) {
          pintarTotales((datos && datos.totales) || {});
        }, function (e) {
          vaciar(recuadroTotales);
          recuadroTotales.appendChild(vacio(e.message));
        });
      }, 400);
    }

    function armarCuerpo() {
      if (!empleadoElegido) { return null; }
      if (lineas.length === 0) { return null; }
      var tc = texto(tcElegido).replace(',', '.');
      if (!(Number(tc) > 0)) { return null; }
      return {
        idEmpleado: empleadoElegido,
        moneda: monedaElegida,
        tcDecimas: Math.round(Number(tc) * 100),
        ajusteUsd: inAjuste.value === '' ? '0' : inAjuste.value,
        notas: inNotas.value,
        lineas: lineas.map(function (linea) {
          return {
            idProducto: linea.idProducto,
            modelo: linea.modelo,
            cantidad: linea.cantidad,
            precioUsdCents: linea.precioUsdCents,
            costoUnitarioUsdCents: linea.costoUnitarioUsdCents,
            origen: linea.origen
          };
        })
      };
    }

    caja.appendChild(crear('div', { clase: 'tarjeta' }, [
      crear('h2', { texto: 'Totales' }),
      crear('p', { clase: 'nota', texto: 'Los calcula el servidor. Aqui solo se muestran.' }),
      recuadroTotales
    ]));

    // --- guardar ---
    function guardar(confirmar) {
      var cuerpo = armarCuerpo();
      if (!cuerpo) { aviso('Completa encargado, tipo de cambio y al menos un producto.', 'malo'); return; }
      cuerpo.claveIdempotencia = estado.lineaClave;
      if (confirmar) { cuerpo.confirmar = true; }
      api('/api/ventas', cuerpo).then(function (datos) {
        estado.lineaClave = '';
        aviso(datos.repetida ? 'La venta ya estaba registrada.' : 'Venta guardada.', 'bueno');
        lineas = [];
        pintarLineas();
        inAjuste.value = '';
        inNotas.value = '';
        location.hash = '#/ventas';
        router();
      }, error);
    }

    caja.appendChild(crear('div', { clase: 'acciones' }, [
      crear('button', { clase: 'btn-linea', texto: 'Guardar borrador', evento: { click: function () { guardar(false); } } }),
      crear('button', { clase: 'btn-primario', texto: 'Confirmar venta', evento: { click: function () { guardar(true); } } })
    ]));

    // --- datos iniciales ---
    api('/api/empleados', {}).then(function (datos) {
      var lista = (datos && datos.empleados) || [];
      vaciar(selEmpleado);
      selEmpleado.appendChild(crear('option', { value: '', texto: 'Elegir encargado' }));
      lista.forEach(function (empleado) {
        selEmpleado.appendChild(crear('option', { value: empleado.idEmpleado, texto: empleado.nombre }));
      });
      if (lista.length === 1) { selEmpleado.value = lista[0].idEmpleado; empleadoElegido = selEmpleado.value; }
    }, error);

    api('/api/tc-hoy', {}).then(function (datos) {
      var lista = (datos && datos.tc) || (datos && datos.tcs) || [];
      if (lista.length > 0) {
        campoTc.value = texto(numero(lista[0].tcDecimas) / 100).replace('.', ',');
        tcElegido = campoTc.value;
      }
    }, function () { /* sin TC del dia se teclea a mano */ });

    pintarLineas();
    return caja;
  }

  // ---------- vista: ventas ----------

  function vistaVentas() {
    var caja = crear('div', {});
    caja.appendChild(crear('h2', { clase: 'titulo-seccion', texto: 'Ventas' }));

    var desde = crear('input', { type: 'date', value: new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10) });
    var hasta = crear('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
    var zona = crear('div', {});

    function cargar() {
      vaciar(zona);
      zona.appendChild(vacio('Cargando...'));
      api('/api/ventas?desde=' + desde.value + '&hasta=' + hasta.value, {}).then(function (datos) {
        var lista = (datos && datos.ventas) || [];
        vaciar(zona);
        if (lista.length === 0) {
          zona.appendChild(vacio('No hay ventas en ese rango.'));
          return;
        }
        var esDueño = (estado.sesion || {}).rol === 'dueno';
        var columnas = [
          { titulo: 'Fecha' }, { titulo: 'Vendedor' }, { titulo: 'Estado' },
          { titulo: 'Ganancia Bs', num: true }, { titulo: 'Comision Bs', num: true }
        ];
        if (esDueño) { columnas.push({ titulo: 'Neto dueno Bs', num: true }); }
        var filas = lista.map(function (venta) {
          var celdas = [
            celda(texto(venta.dia)),
            celda(texto(venta.vendedor)),
            celda(insigniaEstado(venta.estado)),
            celdaBs(venta.gananciaBsCents),
            celdaBs(venta.comisionBsCents)
          ];
          if (esDueño) { celdas.push(celdaBs(venta.netoDuenoBsCents)); }
          return crear('tr', { clase: venta.estado === 'CONFIRMADA' ? 'pendiente-fila' : '' }, celdas);
        });
        zona.appendChild(tabla('Ventas del periodo', columnas, filas));
      }, function (e) {
        vaciar(zona);
        zona.appendChild(vacio('No se pudieron cargar las ventas: ' + e.message));
      });
    }

    caja.appendChild(crear('div', { clase: 'tarjeta' }, [
      crear('div', { clase: 'fila-boton' }, [
        crear('div', { clase: 'campo' }, [crear('label', { texto: 'Desde' }), desde]),
        crear('div', { clase: 'campo' }, [crear('label', { texto: 'Hasta' }), hasta]),
        crear('button', { clase: 'btn-linea', texto: 'Buscar', evento: { click: cargar } })
      ])
    ]));
    caja.appendChild(zona);
    cargar();
    return caja;
  }

  // ---------- vista: catalogo ----------

  function vistaCatalogo() {
    var caja = crear('div', {});
    caja.appendChild(crear('h2', { clase: 'titulo-seccion', texto: 'Catalogo' }));

    var entrada = crear('input', { type: 'search', placeholder: 'Buscar modelo' });
    var zona = crear('div', {});

    function cargar() {
      vaciar(zona);
      api('/api/catalogo?q=' + encodeURIComponent(entrada.value.trim()), {}).then(function (datos) {
        var lista = (datos && datos.productos) || [];
        vaciar(zona);
        if (lista.length === 0) {
          zona.appendChild(vacio('No se encontraron productos.'));
          return;
        }
        var filas = lista.map(function (producto) {
          var inPrecio = crear('input', {
            type: 'number', min: '0', step: '0.01',
            value: (numero(producto.precioRefUsdCents) / 100).toFixed(2)
          });
          return crear('tr', {}, [
            celda(texto(producto.marca)),
            celda(texto(producto.modelo)),
            crear('td', { clase: 'num' }, [inPrecio]),
            crear('td', {}, [
              crear('button', {
                clase: 'btn-linea btn-chico',
                type: 'button',
                texto: 'Guardar',
                evento: {
                  click: function () {
                    var centavos = Math.round(Number(String(inPrecio.value).replace(',', '.')) * 100);
                    api('/api/catalogo/' + encodeURIComponent(producto.idProducto) + '/precio', {
                      precioUsdCents: centavos
                    }).then(function () {
                      aviso('Precio actualizado.', 'bueno');
                    }, error);
                  }
                }
              })
            ])
          ]);
        });
        zona.appendChild(tabla('Precios de referencia (USD)', [
          { titulo: 'Marca' }, { titulo: 'Modelo' }, { titulo: 'Precio', num: true }, { titulo: '' }
        ], filas));
      }, function (e) {
        vaciar(zona);
        zona.appendChild(vacio('No se pudo cargar el catalogo: ' + e.message));
      });
    }

    caja.appendChild(crear('div', { clase: 'tarjeta' }, [
      crear('div', { clase: 'fila-boton' }, [
        crear('div', { clase: 'campo' }, [crear('label', { texto: 'Buscar' }), entrada]),
        crear('button', { clase: 'btn-linea', texto: 'Buscar', evento: { click: cargar } })
      ]),
      crear('p', { clase: 'nota', texto: 'El precio de referencia es una ayuda. El precio real lo pone el vendedor al cerrar la venta.' }),
      zona
    ]));
    cargar();
    return caja;
  }

  // ---------- vista: consolidado (dueno) ----------

  function vistaConsolidado() {
    var caja = crear('div', {});
    caja.appendChild(crear('h2', { clase: 'titulo-seccion', texto: 'Consolidado de las 4 tiendas' }));

    var hasta = new Date();
    var desde = new Date();
    desde.setDate(desde.getDate() - 6);
    var total = crear('div', { clase: 'rejilla' }, [vacio('Cargando...')]);
    var porTienda = crear('div', {});
    var pendientes = crear('div', {});

    function cargar() {
      var desdeIso = desde.toISOString().slice(0, 10);
      var hastaIso = hasta.toISOString().slice(0, 10);
      api('/api/resumen?desde=' + desdeIso + '&hasta=' + hastaIso, {}).then(function (datos) {
        var resumen = (datos && datos.resumen) || {};
        vaciar(total);
        total.appendChild(metrica('Tiendas', texto((datos.tiendas || []).length)));
        total.appendChild(metrica('Ventas', texto(numero(resumen.cantidadVentas))));
        total.appendChild(metrica('Ganancia total', dineroBs(resumen.totalGananciaBsCents)));
        total.appendChild(metrica('Comisiones', dineroBs(resumen.totalComisionBsCents)));
        total.appendChild(metrica('Neto del dueno', dineroBs(resumen.totalNetoDuenoBsCents), 'exito'));

        vaciar(porTienda);
        var tiendas = (resumen.porTienda || []);
        if (tiendas.length === 0) {
          porTienda.appendChild(vacio('Sin ventas en la semana.'));
        } else {
          porTienda.appendChild(crear('div', { clase: 'rejilla' }, tiendas.map(function (tienda) {
            return crear('div', { clase: 'tarjeta' }, [
              crear('h2', { texto: tienda.tienda || tienda.nombre || tienda.idTienda }),
              metrica('Ventas', texto(numero(tienda.ventas))),
              metrica('Ganancia', dineroBs(tienda.gananciaBsCents)),
              metrica('Comision del encargado', dineroBs(tienda.comisionBsCents)),
              metrica('Neto del dueno', dineroBs(tienda.netoDuenoBsCents), 'exito')
            ]);
          })));
        }

        var lista = (datos && datos.ventas) || [];
        var filaPendientes = lista.filter(function (v) { return v.estado === 'CONFIRMADA'; });
        vaciar(pendientes);
        if (filaPendientes.length > 0) {
          pendientes.appendChild(crear('h3', { texto: 'Ventas pendientes de cerrar' }));
          pendientes.appendChild(tabla('Sin cerrar (se ven en rojo)', [
            { titulo: 'Fecha' }, { titulo: 'Tienda' }, { titulo: 'Vendedor' }, { titulo: 'Estado' },
            { titulo: 'Neto dueno Bs', num: true }
          ], filaPendientes.map(function (v) {
            return crear('tr', { clase: 'pendiente-fila' }, [
              celda(texto(v.dia)),
              celda(texto(v.tienda)),
              celda(texto(v.vendedor)),
              celda(crear('span', { clase: 'insignia pendiente', texto: 'PENDIENTE' })),
              celdaBs(v.netoDuenoBsCents)
            ]);
          })));
        }
      }, function (e) {
        vaciar(total);
        total.appendChild(vacio('No se pudo cargar el consolidado: ' + e.message));
      });
    }

    caja.appendChild(crear('div', { clase: 'tarjeta' }, [crear('h2', { texto: 'Total de la semana' }), total]));
    caja.appendChild(porTienda);
    caja.appendChild(pendientes);
    cargar();
    return caja;
  }

  // ---------- vista: cierre (dueno) ----------

  function vistaCierre() {
    var caja = crear('div', {});
    caja.appendChild(crear('h2', { clase: 'titulo-seccion', texto: 'Cierre del dia' }));

    var selTienda = crear('select', {});
    var inFecha = crear('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
    var zonaPrevia = crear('div', {});
    var inPagado = crear('input', { type: 'number', min: '0', step: '0.01', value: '0' });

    function cargarTiendas() {
      api('/api/tiendas', {}).then(function (datos) {
        vaciar(selTienda);
        ((datos && datos.tiendas) || []).forEach(function (tienda) {
          selTienda.appendChild(crear('option', { value: tienda.idTienda, texto: tienda.nombre }));
        });
      }, error);
    }

    function previsualizar() {
      vaciar(zonaPrevia);
      zonaPrevia.appendChild(vacio('Calculando...'));
      api('/api/cierres/preview', { idTienda: selTienda.value, dia: inFecha.value }).then(function (datos) {
        vaciar(zonaPrevia);
        if (numero(datos.pendientes) === 0) {
          zonaPrevia.appendChild(vacio('No hay ventas confirmadas para cerrar en esa tienda y ese dia.'));
          return;
        }
        zonaPrevia.appendChild(crear('div', { clase: 'rejilla' }, [
          metrica('Ventas del dia', texto(datos.cantidadVentas)),
          metrica('Pendientes', texto(datos.pendientes)),
          metrica('Ganancia', dineroBs(datos.totalGananciaBsCents)),
          metrica('Comisiones', dineroBs(datos.totalComisionBsCents)),
          metrica('Neto del dueno', dineroBs(datos.totalNetoDuenoBsCents), 'exito'),
          metrica('Saldo a cobrar', dineroBs(datos.saldoPendienteBsCents), 'negro')
        ]));
      }, function (e) {
        vaciar(zonaPrevia);
        zonaPrevia.appendChild(vacio(e.message));
      });
    }

    caja.appendChild(crear('div', { clase: 'tarjeta' }, [
      crear('div', { clase: 'fila-boton' }, [
        crear('div', { clase: 'campo' }, [crear('label', { texto: 'Tienda' }), selTienda]),
        crear('div', { clase: 'campo' }, [crear('label', { texto: 'Fecha' }), inFecha]),
        crear('button', { clase: 'btn-linea', texto: 'Previsualizar', evento: { click: previsualizar } })
      ]),
      zonaPrevia
    ]));

    caja.appendChild(crear('div', { clase: 'tarjeta' }, [
      crear('h2', { texto: 'Pago del encargado' }),
      crear('div', { clase: 'campo' }, [
        crear('label', { texto: 'Cuanto entrega (Bs)' }), inPagado
      ]),
      crear('div', { clase: 'acciones' }, [
        crear('button', {
          clase: 'btn-primario',
          texto: 'Cerrar tienda y pagar',
          evento: {
            click: function () {
              var centavos = Math.round(Number(String(inPagado.value).replace(',', '.')) * 100);
              if (!isFinite(centavos) || centavos < 0) { aviso('Escribe un monto valido.', 'malo'); return; }
              api('/api/cierres', {
                idTienda: selTienda.value,
                dia: inFecha.value,
                pagadoBsCents: centavos
              }).then(function (datos) {
                aviso('Cierre registrado. Saldo: ' + dineroBs((datos.cierre || {}).saldoBsCents), 'bueno');
                previsualizar();
              }, error);
            }
          }
        })
      ])
    ]));

    cargarTiendas();
    return caja;
  }

  // ---------- vista: ajustes (dueno) ----------

  function vistaAjustes() {
    var caja = crear('div', {});
    caja.appendChild(crear('h2', { clase: 'titulo-seccion', texto: 'Ajustes' }));

    var zonaComisiones = crear('div', {});
    var zonaEmpleados = crear('div', {});
    var zonaTc = crear('div', {});

    function cargarTiendas() {
      api('/api/tiendas', {}).then(function (datos) {
        var tiendas = (datos && datos.tiendas) || [];
        vaciar(zonaComisiones);
        if (tiendas.length === 0) {
          zonaComisiones.appendChild(vacio('No hay tiendas registradas.'));
          return;
        }
        zonaComisiones.appendChild(tabla('Comision por tienda', [
          { titulo: 'Tienda' }, { titulo: 'Comision (%)', num: true }, { titulo: '' }
        ], tiendas.map(function (tienda) {
          var inPct = crear('input', { type: 'number', min: '0', max: '100', step: '0.01', value: numero(tienda.pctComision) });
          return crear('tr', {}, [
            celda(texto(tienda.nombre)),
            crear('td', { clase: 'num' }, [inPct]),
            crear('td', {}, [
              crear('button', {
                clase: 'btn-linea btn-chico',
                type: 'button',
                texto: 'Guardar',
                evento: {
                  click: function () {
                    var pct = Number(String(inPct.value).replace(',', '.'));
                    if (!isFinite(pct) || pct < 0 || pct > 100) { aviso('La comision va de 0 a 100.', 'malo'); return; }
                    api('/api/ajustes/tienda/' + encodeURIComponent(tienda.idTienda), {
                      pctComision: pct
                    }).then(function () {
                      aviso('Comision actualizada.', 'bueno');
                    }, error);
                  }
                }
              })
            ])
          ]);
        })));
      }, error);
    }

    function cargarEmpleados() {
      api('/api/empleados', {}).then(function (datos) {
        var lista = (datos && datos.empleados) || [];
        vaciar(zonaEmpleados);
        if (lista.length === 0) {
          zonaEmpleados.appendChild(vacio('No hay empleados dados de alta.'));
        } else {
          zonaEmpleados.appendChild(tabla('Empleados', [
            { titulo: 'Nombre' }, { titulo: 'Tienda' }, { titulo: 'Estado' }
          ], lista.map(function (empleado) {
            return crear('tr', {}, [
              celda(texto(empleado.nombre)),
              celda(texto(empleado.idTienda)),
              celda(empleado.activo ? 'Activo' : 'Inactivo')
            ]);
          })));
        }

        var inNombre = crear('input', { type: 'text', placeholder: 'Nombre del empleado' });
        var inTienda = crear('select', {}, (datos.tiendas || []).map(function (tienda) {
          return crear('option', { value: tienda.idTienda, texto: tienda.nombre });
        }));
        zonaEmpleados.appendChild(crear('div', { clase: 'fila-boton' }, [
          crear('div', { clase: 'campo' }, [crear('label', { texto: 'Nombre' }), inNombre]),
          crear('div', { clase: 'campo' }, [crear('label', { texto: 'Tienda' }), inTienda]),
          crear('button', {
            clase: 'btn-linea',
            texto: 'Dar de alta',
            evento: {
              click: function () {
                if (!inNombre.value.trim()) { aviso('Escribe el nombre.', 'malo'); return; }
                api('/api/ajustes/empleados', {
                  empleados: [{
                    idEmpleado: 'E' + Date.now().toString(36),
                    nombre: inNombre.value.trim(),
                    idTienda: inTienda.value,
                    activo: true
                  }]
                }).then(function () {
                  aviso('Empleado dado de alta.', 'bueno');
                  cargarEmpleados();
                }, error);
              }
            }
          })
        ]));
      }, error);
    }

    function cargarTc() {
      var desde = new Date();
      desde.setDate(desde.getDate() - 29);
      api('/api/tc-historial?desde=' + desde.toISOString().slice(0, 10) + '&hasta=' + new Date().toISOString().slice(0, 10), {})
        .then(function (datos) {
          var lista = (datos && datos.tc) || (datos && datos.tcs) || [];
          vaciar(zonaTc);
          if (lista.length === 0) {
            zonaTc.appendChild(vacio('Todavia no hay tipos de cambio registrados.'));
            return;
          }
          zonaTc.appendChild(tabla('Tipo de cambio por encargado y dia', [
            { titulo: 'Fecha' }, { titulo: 'Empleado' }, { titulo: 'Tienda' }, { titulo: 'TC', num: true }
          ], lista.map(function (f) {
            return crear('tr', {}, [
              celda(texto(f.dia || f.fecha)),
              celda(texto(f.empleado)),
              celda(texto(f.idTienda)),
              crear('td', { clase: 'num', texto: (numero(f.tcDecimas) / 100).toFixed(2) })
            ]);
          })));
        }, error);
    }

    caja.appendChild(crear('div', { clase: 'tarjeta' }, [crear('h2', { texto: 'Comisiones' }), zonaComisiones]));
    caja.appendChild(crear('div', { clase: 'tarjeta' }, [crear('h2', { texto: 'Empleados' }), zonaEmpleados]));
    caja.appendChild(crear('div', { clase: 'tarjeta' }, [crear('h2', { texto: 'Historico de tipos de cambio' }), zonaTc]));

    cargarTiendas();
    cargarEmpleados();
    cargarTc();
    return caja;
  }

  // ---------- vista no disponible ----------

  function vistaNoDisponible(mensaje) {
    return crear('div', { clase: 'tarjeta' }, [
      crear('h2', { texto: 'No disponible' }),
      vacio(mensaje),
      crear('div', { clase: 'acciones' }, [
        crear('button', { clase: 'btn-linea', texto: 'Volver al inicio', evento: { click: function () { location.hash = '#/inicio'; } } })
      ])
    ]);
  }

  // ---------- router ----------

  var VISTAS_DUENO = ['#/consolidado', '#/cierre', '#/ajustes'];

  function router() {
    var hash = location.hash || '#/login';
    var vista = hash.split('?')[0];
    estado.vista = vista;
    vaciar(app);

    api('/api/auth/session', {}).then(function (datos) {
      var sesion = (datos && datos.sesion) || null;
      estado.sesion = sesion;

      if (!sesion) {
        if (vista !== '#/login') { location.hash = '#/login'; return; }
        app.appendChild(vistaLogin());
        return;
      }

      if (vista === '#/login' || vista === '#/salir') { location.hash = '#/inicio'; return; }

      if (VISTAS_DUENO.indexOf(vista) !== -1 && sesion.rol !== 'dueno') {
        app.appendChild(cabecera());
        app.appendChild(vistaNoDisponible('Esa pantalla es solo del dueno. Tu tienda no puede verla.'));
        return;
      }

      app.appendChild(cabecera());
      var cuerpo;
      switch (vista) {
        case '#/inicio': cuerpo = vistaInicio(); break;
        case '#/nueva': cuerpo = vistaNueva(); break;
        case '#/ventas': cuerpo = vistaVentas(); break;
        case '#/catalogo': cuerpo = vistaCatalogo(); break;
        case '#/consolidado': cuerpo = vistaConsolidado(); break;
        case '#/cierre': cuerpo = vistaCierre(); break;
        case '#/ajustes': cuerpo = vistaAjustes(); break;
        default: location.hash = '#/inicio'; return;
      }
      app.appendChild(cuerpo);
    }, function () {
      estado.sesion = null;
      vaciar(app);
      app.appendChild(vistaLogin());
    });
  }

  window.addEventListener('hashchange', router);
  document.addEventListener('DOMContentLoaded', router);
  if (document.readyState !== 'loading') { router(); }
}());
