/* ===========================================================================
   TEMA ACADEMIA DG — la parte que necesita JavaScript
   ===========================================================================
   Compañero de tema-adg.css. Hoy hace una sola cosa, y a propósito: cuanto
   menos haga este archivo, menos puede romper.

   EL VOLVER AL MENÚ
   Las secciones se abren de dos formas: adentro del hub (academia-dg.html las
   carga en un iframe) o sueltas, con el link directo o un marcador.
   - Adentro del hub, el menú ya está arriba: un "volver" acá sobraría, y si
     alguien lo tocara cargaría el hub ADENTRO del hub.
   - Sueltas, en cambio, no hay forma de volver: quedás encerrado en esa
     pantalla y la única salida es escribir la dirección a mano.
   Por eso el botón se agrega sólo en el segundo caso. Se detecta mirando si la
   página es la ventana de arriba; si el navegador no deja mirar (pasa entre
   dominios distintos), se asume que está adentro y no se agrega nada, que es
   la opción que no molesta.

   Se usa poniendo, al final del <body>:
     <script src="tema-adg.js"></script>
   No hace falta nada más: busca la barra solo.
   =========================================================================== */
(function () {
  'use strict';

  function estaSuelta() {
    try { return window.self === window.top; }
    catch (e) { return false; }   // sin poder mirar, no molestamos
  }

  function ponerVolver() {
    var barra = document.querySelector('.adg-barra');
    if (!barra) return;                                   // la app no usa la barra

    /* Adentro del hub la barra de la sección SOBRA: el hub ya tiene su propia
       barra arriba con la navegación y el salir, así que quedaban dos barras
       apiladas y unos 90px de encabezado antes del contenido. En la tablet eso
       es pantalla que se pierde. Se esconde acá y se ve sólo cuando la sección
       se abre suelta, que es cuando de verdad hace falta.

       No se esconde poniéndole display:none al elemento, porque cada app
       vuelve a mostrar su barra MÁS TARDE (cuando Firebase confirma quién
       entró) y pisaría esto. En su lugar se marca el documento y tema-adg.css
       se encarga con una regla que gana siempre. */
    if (!estaSuelta()) { document.documentElement.setAttribute('data-adg-dentro', '1'); return; }

    if (barra.querySelector('.adg-volver')) return;       // ya está puesto

    var a = document.createElement('a');
    a.className = 'adg-volver';
    a.href = 'academia-dg.html';
    a.title = 'Volver al menú del sistema';
    a.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
                  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                  '<path d="M15 5l-7 7 7 7"/></svg><span>Menú</span>';
    barra.insertBefore(a, barra.firstChild);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ponerVolver);
  } else {
    ponerVolver();
  }
})();
