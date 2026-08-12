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

/**
 * Los nodos que se respaldan.
 *
 * Están SOLO los que son fuente de verdad. Quedan afuera a propósito:
 *   dia/           se vuelve a generar publicando el día desde el calendario
 *   ops_v1         bitácora de quién hizo qué, no es un dato del negocio
 *   ops_admin      ídem, y se borra sola a la semana
 *   log_ops        ídem
 *   snapshots      copias que el calendario ya hace y borra a las 48 h
 *   backups_auto   ídem
 *
 * Ese recorte no es por prolijidad: es lo que hace que el respaldo pese
 * alrededor de un mega en vez de 55, y que entre cómodo en los seis minutos
 * que Apps Script da por ejecución. Lo que se deja afuera es derivado o es
 * registro; lo que se guarda es lo que no se puede reconstruir.
 *
 * 'hijos' es para los nodos donde el permiso de lectura está puesto en los
 * hijos y no en el padre: si el padre se niega, se arma pedazo por pedazo.
 */
var RESPFB_NODOS = [
  { k: 'calendario_v2' },
  { k: 'alumnos_v1' },
  { k: 'alumnos_v2' },
  { k: 'historial_v1' },
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
  { k: 'bloc_notas' }
];

/* ====================== lo que corre todas las noches ====================== */

function respFB_respaldarDiario() {
  var hoy = respFB_hoyAsuncion();
  var carpeta = respFB_carpetaDelDia(hoy);
  var resumen = { fecha: hoy, nodos: {}, errores: [] };
  var total = 0;

  for (var i = 0; i < RESPFB_NODOS.length; i++) {
    var nd = RESPFB_NODOS[i];
    try {
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
    } catch (e) {
      // Un nodo que falla NO corta el respaldo: se anota y se sigue con los
      // demás. Es preferible una copia incompleta y avisada, a ninguna copia.
      resumen.errores.push(nd.k + ': ' + e.message);
      Logger.log('ERROR en ' + nd.k + ': ' + e.message);
    }
  }

  resumen.bytesTotal = total;

  // Se compara contra el respaldo de la noche anterior ANTES de guardar el de
  // hoy, así el de hoy no se compara consigo mismo.
  var caidas = respFB_compararConAyer(resumen);

  carpeta.createFile('_resumen.json', JSON.stringify(resumen, null, 1),
                     'application/json');

  respFB_borrarLosViejos();

  var msg = 'Respaldo ' + hoy + ': ' + Object.keys(resumen.nodos).length +
            ' nodos, ' + Math.round(total / 1024) + ' KB' +
            (resumen.errores.length ? ', ' + resumen.errores.length + ' con error' : '') +
            (caidas.length ? ', ' + caidas.length + ' nodo(s) con menos que ayer' : '');
  Logger.log(msg);

  // Se avisa por correo en dos casos: si algo no se pudo leer, o si algún nodo
  // tiene bastante menos que ayer. Un respaldo que se rompe callado es peor que
  // no tenerlo, porque da tranquilidad falsa.
  if (resumen.errores.length || caidas.length) {
    var cuerpo = 'Respaldo del ' + hoy + '.\n\n';
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
    respFB_avisar('Respaldo de Firebase — revisar (' + hoy + ')', cuerpo);
  }
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
  var lineas = ['PRUEBA de lectura — no se guardó nada en Drive', ''];
  var total = 0;
  for (var i = 0; i < RESPFB_NODOS.length; i++) {
    var nd = RESPFB_NODOS[i];
    try {
      var r = respFB_leerNodo(nd);
      var bytes = JSON.stringify(r.val).length;
      total += bytes;
      lineas.push(respFB_rellenar(nd.k, 18) + respFB_rellenar(respFB_contar(nd.k, r.val), 8) +
                  Math.round(bytes / 1024) + ' KB' +
                  (r.via === 'por partes' ? '   (leído por partes)' : ''));
    } catch (e) {
      lineas.push(respFB_rellenar(nd.k, 18) + 'ERROR: ' + e.message);
    }
  }
  lineas.push('');
  lineas.push('Total: ' + Math.round(total / 1024) + ' KB');
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

function respFB_get(ruta) {
  var resp = UrlFetchApp.fetch(RESPFB_URL + '/' + ruta + '.json', {
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

function respFB_avisar(asunto, cuerpo) {
  try {
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(), asunto, cuerpo);
  } catch (e) {
    Logger.log('No se pudo mandar el aviso: ' + e.message);
  }
}

function respFB_rellenar(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}
