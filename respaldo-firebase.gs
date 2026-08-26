/**
 * RESPALDO DE FIREBASE A DRIVE — Academia DG
 * v2026-08-11
 *
 * Qué hace: todas las noches baja los nodos de Firebase que son FUENTE DE
 * VERDAD y los deja en Drive, adentro de BACKUPS ADG / FIREBASE, en una
 * carpeta por fecha. Escribe además un resumen con los conteos del día.
 *
 * Por qué existe: el activador que ya está (ejecutarBackupsProgramados) copia
 * la PLANILLA. Pero el calendario, las evaluaciones, la libreta del agente,
 * el inventario y las pausas no viven en la planilla: viven en Firebase, y de
 * eso no había ninguna copia bajable.
 *
 * ------------------------------------------------------------------------
 * CÓMO INSTALARLO (leer antes de pegar)
 *
 * 1. Entrar al proyecto ADG que TIENE LOS ACTIVADORES. Es uno de los doce con
 *    ese nombre; el bueno se reconoce en https://script.google.com/home/triggers
 * 2. Crear un ARCHIVO NUEVO (+ → Secuencia de comandos) y llamarlo
 *    respaldo-firebase. NO pegar esto adentro de un archivo que ya existe.
 * 3. Guardar (el disquete). No hace falta Implementar: eso solo se necesita
 *    para aplicaciones web como el puente.
 * 4. Correr UNA VEZ a mano respFB_probar() y mirar el registro. Eso no crea
 *    ningún activador y sirve para ver que lee bien.
 * 5. Recién ahí, correr UNA VEZ respFB_instalarActivador().
 *
 * Todas las funciones empiezan con respFB_ a propósito: en Apps Script todos
 * los archivos comparten el mismo espacio de nombres, y dos funciones con el
 * mismo nombre se pisan EN SILENCIO. Con el prefijo no puede chocar con nada
 * de lo que ya está.
 *
 * NO hay onOpen acá. El menú de la planilla vive en su archivo y si se
 * declarara otro onOpen, el menú desaparecería sin decir por qué.
 * ------------------------------------------------------------------------
 */

var RESPFB_URL = 'https://academia-dg-default-rtdb.firebaseio.com';
var RESPFB_CARPETA_RAIZ = 'BACKUPS ADG';
var RESPFB_CARPETA = 'FIREBASE';
var RESPFB_DIAS_QUE_SE_GUARDAN = 60;

/* A qué correo avisar cuando algo sale mal. Vacío = al dueño del script.
   Si los avisos no llegan, poner acá el correo a mano: corriendo por
   activador, Google a veces no sabe decir quién es el dueño. */
var RESPFB_AVISAR_A = '';

/**
 * TODOS los nodos. El respaldo se copia entero y tal cual está: no decide, no
 * filtra, no arregla variaciones ni duplicados. Un respaldo que interpreta deja
 * de ser un respaldo.
 *
 * 'grande' marca los que no se pueden pedir de un saque: se preguntan primero
 * las claves de arriba y después se baja una por una. Sin eso, pedir dia/ o
 * ops_v1 entero puede pasarse de los seis minutos que da Apps Script, o del
 * tamaño máximo de una respuesta, y el respaldo queda a medias.
 *
 * 'hijos' es para los nodos donde el permiso de lectura está puesto en los
 * hijos y no en el padre: si el padre se niega, se arma pedazo por pedazo.
 */
/* OJO AL AGREGAR APPS: si nace un nodo nuevo, va acá. Dos que faltaban y son
   justo los que más duelen perder:

   · padron_v1  — el padrón canónico, cada alumno con su A#### y su precio. Es
     el que declaramos maestro el 14/08/2026 y el que leen nivelación,
     profe-agenda, profe-dia, envíos, pausas y alto-rendimiento. No estaba en
     ningún respaldo: si se rompía, no había de dónde sacarlo.

   · historial_v2 — el registro contable que escribe el cierre de las 23:30 y
     del que salen los cobros y el pago a los profes. Reemplaza a historial_v1,
     que venía de la planilla y quedó congelado el 10/08/2026. */
var RESPFB_NODOS = [
  { k: 'calendario_v2' },
  { k: 'padron_v1' },
  { k: 'alumnos_v1' },
  { k: 'alumnos_v2' },
  { k: 'historial_v1' },
  { k: 'historial_v2' },
  { k: 'niveles_v1', hijos: ['evaluaciones', 'aprobados', 'auditoria'] },
  { k: 'usuarios' },
  { k: 'tipos_v1' },
  { k: 'columnas_v1' },
  { k: 'agente_v1', hijos: ['anotaciones', 'enviados', 'salud'] },
  { k: 'reservas_v1' },
  { k: 'atrasadas_v1' },
  { k: 'pausas_v1' },
  { k: 'inventario_v1' },
  { k: 'cobros_diego_v1' },
  { k: 'bloc_notas' },
  { k: 'dia',          grande: true },
  { k: 'ops_v1',       grande: true },
  { k: 'ops_admin',    grande: true },
  { k: 'log_ops',      grande: true },
  { k: 'snapshots',    grande: true },
  { k: 'backups_auto', grande: true }
];

/* Cuánto puede pesar un archivo antes de partirlo en dos. Cuatro megas entran
   cómodos en memoria y siguen siendo fáciles de abrir después. */
var RESPFB_CORTE_ARCHIVO = 4000000;

/* Apps Script mata la ejecución a los seis minutos, sin aviso y sin guardar.
   A los cinco se corta por las buenas, se anota qué quedó afuera y se avisa,
   así el respaldo nunca queda mudo a medio hacer. */
var RESPFB_MINUTOS_MAXIMO = 5;

/* A partir de cuántas claves conviene pedir de a lotes en vez de de a una.
   No es lo mismo un nodo con cuatro días adentro, donde cada día pesa, que
   log_ops con doscientas treinta mil anotaciones de un renglón cada una:
   pedirlas de a una serían doscientas treinta mil llamadas y no termina más. */
var RESPFB_MUCHAS_CLAVES = 500;
var RESPFB_CLAVES_POR_LOTE = 5000;

/* ====================== lo que corre todas las noches ====================== */

function respFB_respaldarDiario() {
  var arranque = new Date().getTime();
  var hastaCuando = arranque + RESPFB_MINUTOS_MAXIMO * 60 * 1000;

  var hoy = respFB_hoyAsuncion();
  var carpeta = respFB_carpetaDelDia(hoy);
  var resumen = { fecha: hoy, nodos: {}, errores: [], incompletos: [] };
  var total = 0;

  for (var i = 0; i < RESPFB_NODOS.length; i++) {
    var nd = RESPFB_NODOS[i];
    try {
      if (nd.grande) {
        // Los pesados se bajan clave por clave, para no pedir 40 MB de un saque.
        var g = respFB_guardarGrande(carpeta, nd, hastaCuando);
        total += g.bytes;
        resumen.nodos[nd.k] = { registros: g.registros, bytes: g.bytes,
                                via: 'clave por clave',
                                partes: g.partes };
        if (g.faltaron.length) {
          resumen.nodos[nd.k].faltaron = g.faltaron.length;
          resumen.incompletos.push(nd.k + ': quedaron ' + g.faltaron.length +
                                   ' sin copiar (primera: ' + g.faltaron[0] + ')');
        }
      } else {
        var r = respFB_leerNodo(nd);
        var txt = JSON.stringify(r.val);
        carpeta.createFile(nd.k + '.json', txt, 'application/json');
        total += txt.length;
        resumen.nodos[nd.k] = {
          registros: respFB_contar(nd.k, r.val),
          bytes: txt.length,
          via: r.via
        };
        if (r.via === 'por partes') {
          Logger.log(nd.k + ': leído por partes' +
            (r.fallaron.length ? ' (sin ' + r.fallaron.join(', ') + ')' : ''));
        }
      }
    } catch (e) {
      // Un nodo que falla NO corta el respaldo: se anota y se sigue con los
      // demás. Es preferible una copia incompleta y avisada, a ninguna copia.
      resumen.errores.push(nd.k + ': ' + e.message);
      Logger.log('ERROR en ' + nd.k + ': ' + e.message);
    }
  }
  resumen.minutos = Math.round((new Date().getTime() - arranque) / 600) / 100;

  resumen.bytesTotal = total;

  // Se compara contra el respaldo de la noche anterior ANTES de guardar el de
  // hoy, así el de hoy no se compara consigo mismo.
  var caidas = respFB_compararConAyer(resumen);
  resumen.caidas = caidas;

  respFB_borrarLosViejos();

  var msg = 'Respaldo ' + hoy + ': ' + Object.keys(resumen.nodos).length +
            ' nodos, ' + Math.round(total / 1048576 * 10) / 10 + ' MB en ' +
            resumen.minutos + ' min' +
            (resumen.errores.length ? ', ' + resumen.errores.length + ' con error' : '') +
            (resumen.incompletos.length ? ', ' + resumen.incompletos.length + ' incompleto(s)' : '') +
            (caidas.length ? ', ' + caidas.length + ' nodo(s) con menos que ayer' : '');
  Logger.log(msg);

  // Se avisa por correo en dos casos: si algo no se pudo leer, o si algún nodo
  // tiene bastante menos que ayer. Un respaldo que se rompe callado es peor que
  // no tenerlo, porque da tranquilidad falsa.
  if (resumen.errores.length || caidas.length || resumen.incompletos.length) {
    var cuerpo = 'Respaldo del ' + hoy + '.\n\n';
    if (resumen.incompletos.length) {
      cuerpo += 'NO SE ALCANZÓ A COPIAR TODO (se acabó el tiempo):\n\n  ' +
                resumen.incompletos.join('\n  ') +
                '\n\nEl resto quedó guardado. Si esto se repite todos los días, ' +
                'hay que partir el respaldo en dos activadores.\n\n';
    }
    if (caidas.length) {
      cuerpo += 'HAY NODOS CON MENOS REGISTROS QUE AYER:\n\n';
      for (var c = 0; c < caidas.length; c++) {
        cuerpo += '  ' + caidas[c].nodo + ': ayer ' + caidas[c].antes +
                  ', hoy ' + caidas[c].ahora + '  (' + caidas[c].dif + ')\n';
      }
      cuerpo += '\nPuede ser normal (una limpieza, alumnos dados de baja) o puede ' +
                'ser que se haya perdido algo. La copia de ayer sigue en Drive.\n\n';
    }
    if (resumen.errores.length) {
      cuerpo += 'NODOS QUE NO SE PUDIERON LEER:\n\n  ' +
                resumen.errores.join('\n  ') + '\n\n';
    }
    cuerpo += 'Está todo en Drive, en ' + RESPFB_CARPETA_RAIZ + ' / ' +
              RESPFB_CARPETA + ' / ' + hoy + '.';
    resumen.aviso = respFB_avisar('Respaldo de Firebase — revisar (' + hoy + ')', cuerpo);
  } else {
    resumen.aviso = { enviado: false, motivo: 'no hizo falta: salió todo bien' };
  }

  // El resumen se escribe AL FINAL, cuando ya se sabe si el aviso salió. Si el
  // correo falla, queda escrito acá: es la única forma de enterarse, porque el
  // registro de una corrida automática no lo mira nadie.
  carpeta.createFile('_resumen.json', JSON.stringify(resumen, null, 1),
                     'application/json');

  return msg;
}

/**
 * Busca el _resumen.json más reciente anterior a hoy y compara los conteos.
 * Devuelve los nodos que bajaron más del 20%.
 *
 * El 20% es a propósito: que un alumno se dé de baja no tiene que despertar a
 * nadie, pero que desaparezca un quinto del padrón sí.
 */
function respFB_compararConAyer(resumen) {
  var caidas = [];
  try {
    var raiz = respFB_carpeta(DriveApp.getRootFolder(), RESPFB_CARPETA_RAIZ);
    var fb = respFB_carpeta(raiz, RESPFB_CARPETA);

    var mejor = null;
    var it = fb.getFolders();
    while (it.hasNext()) {
      var c = it.next(), n = c.getName();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(n)) continue;
      if (n >= resumen.fecha) continue;               // hoy o futuro, no sirve
      if (!mejor || n > mejor.getName()) mejor = c;
    }
    if (!mejor) return caidas;                        // es el primer respaldo

    var arch = mejor.getFilesByName('_resumen.json');
    if (!arch.hasNext()) return caidas;
    var ayer = JSON.parse(arch.next().getBlob().getDataAsString());

    for (var k in resumen.nodos) {
      var a = ayer.nodos && ayer.nodos[k];
      if (!a || typeof a.registros !== 'number' || a.registros <= 0) continue;
      var ahora = resumen.nodos[k].registros;
      if (ahora < a.registros * 0.8) {
        caidas.push({ nodo: k, antes: a.registros, ahora: ahora,
                      dif: (ahora - a.registros) });
      }
    }
  } catch (e) {
    // Si la comparación falla, el respaldo igual se guarda: es un extra, no
    // puede ser el motivo de quedarse sin copia.
    Logger.log('No se pudo comparar con el respaldo anterior: ' + e.message);
  }
  return caidas;
}

/* ============================ para probar a mano =========================== */

/**
 * Lee todo pero NO escribe nada en Drive. Sirve para ver que los permisos
 * están bien y qué cantidad trae cada nodo, antes de dejarlo automático.
 */
function respFB_probar() {
  var t0 = new Date().getTime();
  var lineas = ['PRUEBA de lectura — no se guardó nada en Drive', ''];
  var total = 0;
  for (var i = 0; i < RESPFB_NODOS.length; i++) {
    var nd = RESPFB_NODOS[i];
    try {
      if (nd.grande) {
        // De los pesados no se baja el contenido: solo se cuentan las claves.
        // Bajarlos acá tardaría lo mismo que el respaldo de verdad, y esta
        // prueba tiene que poder correrse cuantas veces haga falta.
        var claves = respFB_get(nd.k, 'shallow=true');
        var n = claves ? Object.keys(claves).length : 0;
        lineas.push(respFB_rellenar(nd.k, 18) + respFB_rellenar(n, 8) +
                    '(se copia clave por clave)');
      } else {
        var r = respFB_leerNodo(nd);
        var bytes = JSON.stringify(r.val).length;
        total += bytes;
        lineas.push(respFB_rellenar(nd.k, 18) + respFB_rellenar(respFB_contar(nd.k, r.val), 8) +
                    Math.round(bytes / 1024) + ' KB' +
                    (r.via === 'por partes' ? '   (leído por partes)' : ''));
      }
    } catch (e) {
      lineas.push(respFB_rellenar(nd.k, 18) + 'ERROR: ' + e.message);
    }
  }
  lineas.push('');
  lineas.push('Livianos: ' + Math.round(total / 1024) + ' KB');
  lineas.push('Los marcados "clave por clave" se copian enteros igual, de a una');
  lineas.push('clave por vez. Su tamaño se ve recién en el primer respaldo.');
  lineas.push('Tardó ' + Math.round((new Date().getTime() - t0) / 100) / 10 + ' seg');
  var txt = lineas.join('\n');
  Logger.log(txt);
  return txt;
}

function respFB_instalarActivador() {
  // Primero se sacan los que ya estén, para no terminar con el respaldo
  // corriendo tres veces por noche si esto se ejecuta más de una vez.
  var viejos = ScriptApp.getProjectTriggers();
  var sacados = 0;
  for (var i = 0; i < viejos.length; i++) {
    if (viejos[i].getHandlerFunction() === 'respFB_respaldarDiario') {
      ScriptApp.deleteTrigger(viejos[i]);
      sacados++;
    }
  }
  ScriptApp.newTrigger('respFB_respaldarDiario')
    .timeBased().atHour(2).everyDays(1).create();

  var msg = 'Activador instalado: todas las noches entre las 2 y las 3 de la ' +
            'madrugada' + (sacados ? ' (se sacaron ' + sacados + ' repetidos)' : '') + '.';
  Logger.log(msg);
  return msg;
}

/* ================================ auxiliares ============================== */

/**
 * Lee un nodo por REST, firmando con el token del dueño del script. Es la
 * misma forma en que los otros scripts del proyecto hablan con Firebase, y es
 * lo que permite que la base esté cerrada al público.
 */
function respFB_leerNodo(nd) {
  try {
    return { val: respFB_get(nd.k), via: 'entero' };
  } catch (e) {
    if (!nd.hijos) throw e;
    // El permiso de lectura baja de padre a hijo, pero nunca sube de hijo a
    // padre: hay nodos donde pedir el padre entero da permiso denegado aunque
    // cada hijo se lea perfecto.
    var val = {}, leidos = 0, fallaron = [];
    for (var i = 0; i < nd.hijos.length; i++) {
      try {
        var v = respFB_get(nd.k + '/' + nd.hijos[i]);
        if (v !== null) val[nd.hijos[i]] = v;
        leidos++;
      } catch (e2) {
        fallaron.push(nd.hijos[i]);
      }
    }
    if (!leidos) throw e;
    return { val: val, via: 'por partes', fallaron: fallaron };
  }
}

function respFB_get(ruta, params) {
  var url = RESPFB_URL + '/' + ruta + '.json' + (params ? '?' + params : '');
  var resp = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  var codigo = resp.getResponseCode();
  if (codigo !== 200) {
    throw new Error('Firebase respondió ' + codigo + ': ' +
                    resp.getContentText().slice(0, 200));
  }
  return JSON.parse(resp.getContentText());
}

/**
 * Baja un nodo grande sin cargarlo entero en memoria.
 *
 * Primero se le pide a Firebase la lista de claves de arriba (shallow=true,
 * que devuelve las llaves y no el contenido). Después se baja una por una y se
 * van escribiendo archivos de cuatro megas. Así dia/, con cientos de fechas
 * adentro, se guarda completo sin pedirle a Firebase 40 MB de un saque.
 *
 * Se guarda TODO: no se saltea ninguna clave ni se recorta por antigüedad.
 */
function respFB_guardarGrande(carpeta, nd, hastaCuando) {
  var claves = respFB_get(nd.k, 'shallow=true');
  if (claves === null) {
    carpeta.createFile(nd.k + '.json', 'null', 'application/json');
    return { registros: 0, bytes: 4, partes: 1, faltaron: [] };
  }
  var lista = Object.keys(claves).sort();

  // Muchísimas claves chicas: se piden de a lotes. Es el caso de log_ops.
  if (lista.length > RESPFB_MUCHAS_CLAVES) {
    return respFB_guardarPorLotes(carpeta, nd, lista, hastaCuando);
  }

  var lote = {}, enLote = 0, bytesLote = 0;
  var parte = 0, bytesTotal = 0, guardadas = 0, faltaron = [];

  function escribirLote() {
    if (!enLote) return;
    parte++;
    var txt = JSON.stringify(lote);
    // Si hay una sola parte se llama como el nodo, sin numerito: es lo normal
    // y así el archivo se busca igual que los demás.
    var nombre = nd.k + '.json';
    carpeta.createFile(nombre, txt, 'application/json');
    bytesTotal += txt.length;
    lote = {}; enLote = 0; bytesLote = 0;
  }
  function escribirParte() {
    if (!enLote) return;
    parte++;
    var txt = JSON.stringify(lote);
    carpeta.createFile(nd.k + '.parte' + parte + '.json', txt, 'application/json');
    bytesTotal += txt.length;
    lote = {}; enLote = 0; bytesLote = 0;
  }

  for (var i = 0; i < lista.length; i++) {
    if (new Date().getTime() > hastaCuando) {
      // Se acabó el tiempo: se anota lo que faltó en vez de morir callado.
      faltaron = lista.slice(i);
      break;
    }
    var k = lista[i];
    try {
      var v = respFB_get(nd.k + '/' + encodeURIComponent(k));
      lote[k] = v;
      enLote++;
      bytesLote += JSON.stringify(v).length;
      guardadas++;
    } catch (e) {
      faltaron.push(k);
    }
    if (bytesLote > RESPFB_CORTE_ARCHIVO) escribirParte();
  }

  // Lo que queda: si nunca hubo que partir, va con el nombre simple.
  if (parte === 0) escribirLote(); else escribirParte();

  return { registros: guardadas, bytes: bytesTotal,
           partes: parte, faltaron: faltaron };
}

/**
 * Baja un nodo de muchísimas claves chicas, pidiéndolas de a lotes.
 *
 * Se le pide a Firebase que ordene por clave y devuelva las primeras N a
 * partir de una: es la forma de recorrer doscientas mil anotaciones en unas
 * pocas decenas de llamadas en vez de doscientas mil.
 *
 * Cada lote pide una clave de más y la descarta, porque startAt incluye la
 * clave desde la que arranca y si no se descartara quedaría repetida.
 */
function respFB_guardarPorLotes(carpeta, nd, lista, hastaCuando) {
  var acumulado = {}, bytesAcum = 0;
  var parte = 0, bytesTotal = 0, guardadas = 0, faltaron = [];
  var desde = lista[0], primera = true;

  function escribirParte() {
    if (!guardadasEnAcum()) return;
    parte++;
    var txt = JSON.stringify(acumulado);
    carpeta.createFile(nd.k + '.parte' + parte + '.json', txt, 'application/json');
    bytesTotal += txt.length;
    acumulado = {}; bytesAcum = 0;
  }
  function guardadasEnAcum() {
    for (var x in acumulado) return true;
    return false;
  }

  while (true) {
    if (new Date().getTime() > hastaCuando) {
      faltaron.push('se acabó el tiempo en la clave ' + desde);
      break;
    }
    var params = 'orderBy=' + encodeURIComponent('"$key"') +
                 '&startAt=' + encodeURIComponent('"' + desde + '"') +
                 '&limitToFirst=' + (RESPFB_CLAVES_POR_LOTE + (primera ? 0 : 1));
    var trozo;
    try {
      trozo = respFB_get(nd.k, params);
    } catch (e) {
      faltaron.push('lote desde ' + desde + ': ' + e.message);
      break;
    }
    if (!trozo) break;

    var ks = Object.keys(trozo).sort();
    if (!primera) {
      // La primera del lote es la última del anterior: ya está guardada.
      ks = ks.filter(function (k) { return k !== desde; });
    }
    if (!ks.length) break;

    for (var i = 0; i < ks.length; i++) {
      acumulado[ks[i]] = trozo[ks[i]];
      guardadas++;
    }
    bytesAcum += JSON.stringify(trozo).length;
    if (bytesAcum > RESPFB_CORTE_ARCHIVO) escribirParte();

    var ultima = ks[ks.length - 1];
    if (ultima === desde) break;            // no avanzó: se corta para no ciclar
    desde = ultima;
    primera = false;
    if (guardadas >= lista.length) break;   // ya se recorrió todo
  }

  escribirParte();
  return { registros: guardadas, bytes: bytesTotal,
           partes: parte, faltaron: faltaron };
}

/**
 * Cuenta lo que le importa a una persona, no las cajas de arriba.
 *
 * Contar las claves de primer nivel sirve para casi todos los nodos, pero para
 * dos no dice nada: calendario_v2 tiene siempre unas trece cajas (madre,
 * semana, profesores, borrados...) y alumnos_v1 tiene siempre csv y
 * actualizado. Con ese numero, la MADRE podria quedarse sin un solo alumno y
 * el resumen seguiria diciendo 13.
 *
 * Como el resumen de cada noche es lo que despues avisa si se perdio algo,
 * tiene que contar lo que se puede perder.
 */
function respFB_contar(clave, val) {
  if (val === null || val === undefined) return 0;

  if (clave === 'calendario_v2') {
    var m = (val.madre && val.madre.alumnos) ? Object.keys(val.madre.alumnos).length : 0;
    var s = (val.semana && val.semana.alumnos) ? Object.keys(val.semana.alumnos).length : 0;
    return m + s;
  }

  if (clave === 'alumnos_v1' || clave === 'historial_v1') {
    if (!val.csv) return 0;
    // parseCsv es el de Google: respeta las comillas, asi que un comentario
    // con una coma adentro no corre las columnas.
    var filas = Utilities.parseCsv(String(val.csv));
    if (clave === 'alumnos_v1') {
      // La hoja ALUMNOS trae el titulo en la fila 1 y los encabezados en la 2.
      // Se busca la fila que dice "alumnos" y se cuentan las que tienen nombre.
      var hr = -1, iNom = -1;
      for (var r = 0; r < Math.min(6, filas.length); r++) {
        for (var c = 0; c < filas[r].length; c++) {
          if (String(filas[r][c]).trim().toLowerCase() === 'alumnos') { hr = r; iNom = c; break; }
        }
        if (hr >= 0) break;
      }
      if (hr < 0) return 0;
      var n = 0;
      for (var r2 = hr + 1; r2 < filas.length; r2++) {
        if (filas[r2][iNom] && String(filas[r2][iNom]).trim()) n++;
      }
      return n;
    }
    // HISTORIAL: encabezado en la primera fila, y solo valen las filas con
    // fecha de verdad y con alumno.
    var nh = 0;
    for (var i = 1; i < filas.length; i++) {
      var f = String(filas[i][0] || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) continue;
      if (!String(filas[i][1] || '').trim()) continue;
      nh++;
    }
    return nh;
  }

  // niveles_v1 y agente_v1 guardan una caja por tema: se cuenta lo de adentro.
  if (clave === 'niveles_v1' || clave === 'agente_v1') {
    var t = 0;
    for (var k in val) {
      if (val[k] && typeof val[k] === 'object') t += Object.keys(val[k]).length;
    }
    return t;
  }

  if (typeof val === 'object') return Object.keys(val).length;
  return 1;
}

/** La fecha de la academia, no la del servidor. */
function respFB_hoyAsuncion() {
  return Utilities.formatDate(new Date(), 'America/Asuncion', 'yyyy-MM-dd');
}

function respFB_carpetaDelDia(hoy) {
  var raiz = respFB_carpeta(DriveApp.getRootFolder(), RESPFB_CARPETA_RAIZ);
  var fb = respFB_carpeta(raiz, RESPFB_CARPETA);
  // Si ya existe la del día (porque se corrió dos veces), se usa esa misma.
  return respFB_carpeta(fb, hoy);
}

function respFB_carpeta(padre, nombre) {
  var it = padre.getFoldersByName(nombre);
  return it.hasNext() ? it.next() : padre.createFolder(nombre);
}

/**
 * Manda a la papelera las carpetas de más de RESPFB_DIAS_QUE_SE_GUARDAN días.
 * Van a la PAPELERA, no se borran de verdad: si un día hace falta una vieja,
 * está ahí por treinta días más.
 */
function respFB_borrarLosViejos() {
  var raiz = respFB_carpeta(DriveApp.getRootFolder(), RESPFB_CARPETA_RAIZ);
  var fb = respFB_carpeta(raiz, RESPFB_CARPETA);
  var corte = new Date();
  corte.setDate(corte.getDate() - RESPFB_DIAS_QUE_SE_GUARDAN);
  var corteTxt = Utilities.formatDate(corte, 'America/Asuncion', 'yyyy-MM-dd');

  var it = fb.getFolders();
  while (it.hasNext()) {
    var c = it.next();
    var n = c.getName();
    // Solo se tocan las carpetas con nombre de fecha. Cualquier otra cosa que
    // alguien haya dejado ahí a mano se respeta.
    if (/^\d{4}-\d{2}-\d{2}$/.test(n) && n < corteTxt) {
      c.setTrashed(true);
      Logger.log('A la papelera: ' + n);
    }
  }
}

/**
 * Manda el aviso y DEVUELVE si pudo. Antes se tragaba el error y solo lo
 * escribía en el registro, que nadie mira: la noche del 12 de agosto el
 * respaldo quedó incompleto, el correo no salió y no quedó rastro en ningún
 * lado. El aviso es lo único que avisa cuando esto corre a las 2 de la mañana,
 * así que si falla el aviso, eso también tiene que quedar escrito.
 *
 * Corriendo por activador, Session.getEffectiveUser() a veces vuelve vacío.
 * Por eso se prueban las dos formas, y si igual no hay correo se puede poner
 * uno a mano en RESPFB_AVISAR_A.
 */
function respFB_avisar(asunto, cuerpo) {
  var destino = RESPFB_AVISAR_A;
  if (!destino) { try { destino = Session.getEffectiveUser().getEmail(); } catch (e) {} }
  if (!destino) { try { destino = Session.getActiveUser().getEmail(); } catch (e) {} }
  if (!destino) {
    Logger.log('AVISO NO ENVIADO: no pude averiguar a qué correo mandarlo. ' +
               'Poné uno a mano en RESPFB_AVISAR_A, arriba del archivo.');
    return { enviado: false, motivo: 'no se pudo averiguar el correo del dueño' };
  }
  try {
    MailApp.sendEmail(destino, asunto, cuerpo);
    Logger.log('Aviso enviado a ' + destino);
    return { enviado: true, a: destino };
  } catch (e) {
    Logger.log('AVISO NO ENVIADO a ' + destino + ': ' + e.message);
    return { enviado: false, a: destino, motivo: e.message };
  }
}

/**
 * Manda un correo de prueba. Sirve para saber si los avisos funcionan sin
 * tener que esperar a que algo salga mal de madrugada.
 */
function respFB_probarCorreo() {
  var r = respFB_avisar('Prueba de aviso — Respaldo Academia DG',
    'Si estás leyendo esto, los avisos del respaldo funcionan.\n\n' +
    'Es el mismo camino que se usa cuando el respaldo queda incompleto o ' +
    'cuando un nodo pierde registros.');
  var txt = r.enviado
    ? 'Correo enviado a ' + r.a + '. Revisá la bandeja (y el spam).'
    : 'NO se pudo enviar: ' + r.motivo +
      '\nPoné tu correo a mano en RESPFB_AVISAR_A, arriba del archivo.';
  Logger.log(txt);
  return txt;
}

function respFB_rellenar(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}
