// El buzón de problemas y sugerencias (D14): la validación, la cola, el
// envío por SMTP y la ruta, en proceso y contra un servidor SMTP falso que
// escucha en 127.0.0.1. Nada sale a internet ni llega a ningún correo.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { createServer as crearServidorTcp, Server as ServidorTcp, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-buzon-'));
process.env.YA_VIENE_DB_PATH = join(tmp, 'test.db');
process.env.JWT_SECRET = randomBytes(32).toString('hex');

// require y no import: abren la base y leen el env al evaluarse.
const { handleAPI } = require('../src/api/routes') as typeof import('../src/api/routes');
const { getDb } = require('../src/data/database') as typeof import('../src/data/database');
const { getMetrics } = require('../src/observability/metrics') as typeof import('../src/observability/metrics');
const { validateConfig } = require('../src/config') as typeof import('../src/config');
const correo = require('../src/buzon/correo') as typeof import('../src/buzon/correo');
const reportes = require('../src/data/reportes') as typeof import('../src/data/reportes');

const USUARIO = 'buzon@ejemplo.com';
const DESTINO = 'equipo@ejemplo.com';
// Como la muestra Google: cuatro grupos con espacios.
const CLAVE_PEGADA = 'abcd efgh ijkl mnop';
const CLAVE = 'abcdefghijklmnop';

// ── El SMTP falso ────────────────────────────────────────────────────
type Modo = 'ok' | 'auth535' | 'mudo' | 'cortar';
const smtp = {
  modo: 'ok' as Modo,
  auths: [] as string[],
  comandos: [] as string[],
  correos: [] as string[],
};

const servidorSmtp: ServidorTcp = crearServidorTcp((s: Socket) => {
  s.on('error', () => {});
  if (smtp.modo === 'mudo') return;
  if (smtp.modo === 'cortar') {
    s.destroy();
    return;
  }
  s.setEncoding('utf8');
  s.write('220 smtp.falso ESMTP\r\n');
  let bufer = '';
  let enDatos = false;
  s.on('data', (trozo: string) => {
    bufer += trozo;
    for (;;) {
      if (enDatos) {
        const fin = bufer.indexOf('\r\n.\r\n');
        if (fin < 0) return;
        smtp.correos.push(bufer.slice(0, fin));
        bufer = bufer.slice(fin + 5);
        enDatos = false;
        s.write('250 2.0.0 OK aceptado\r\n');
        continue;
      }
      const i = bufer.indexOf('\r\n');
      if (i < 0) return;
      const linea = bufer.slice(0, i);
      bufer = bufer.slice(i + 2);
      smtp.comandos.push(linea);
      if (linea.startsWith('EHLO ')) {
        // Varias líneas, como Gmail: solo la última lleva espacio tras el código.
        s.write('250-smtp.falso\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
      } else if (linea.startsWith('AUTH PLAIN ')) {
        smtp.auths.push(Buffer.from(linea.slice(11), 'base64').toString('utf8'));
        s.write(smtp.modo === 'auth535'
          ? '535-5.7.8 Username and Password not accepted\r\n535 5.7.8 https://support.google.com\r\n'
          : '235 2.7.0 Accepted\r\n');
      } else if (linea.startsWith('MAIL FROM:') || linea.startsWith('RCPT TO:')) {
        s.write('250 2.1.0 OK\r\n');
      } else if (linea === 'DATA') {
        enDatos = true;
        s.write('354 Go ahead\r\n');
      } else if (linea === 'QUIT') {
        s.end('221 2.0.0 adiós\r\n');
      } else {
        s.write('502 5.5.1 no\r\n');
      }
    }
  });
});

let puertoSmtp = 0;
function configFalsa(): import('../src/buzon/correo').ConfigCorreo {
  const config = correo.configCorreoDesdeEntorno({
    YA_VIENE_CORREO_USUARIO: USUARIO,
    YA_VIENE_CORREO_CLAVE: CLAVE_PEGADA,
    YA_VIENE_CORREO_DESTINO: DESTINO,
    YA_VIENE_SMTP: `smtp://127.0.0.1:${puertoSmtp}`,
  });
  assert.ok(config);
  return config;
}

/** Cabeceras y cuerpo (ya decodificado) de un correo recibido. */
function abrir(crudo: string): { cabeceras: Record<string, string>; cuerpo: string; lineas: string[] } {
  const [cabeza, ...resto] = crudo.split('\r\n\r\n');
  const cabeceras: Record<string, string> = {};
  for (const linea of cabeza.split('\r\n')) {
    const i = linea.indexOf(': ');
    cabeceras[linea.slice(0, i)] = linea.slice(i + 2);
  }
  const base64 = resto.join('\r\n\r\n').split('\r\n').join('');
  return { cabeceras, cuerpo: Buffer.from(base64, 'base64').toString('utf8'), lineas: crudo.split('\r\n') };
}

function asunto(cabecera: string): string {
  const m = /^=\?UTF-8\?B\?(.+)\?=$/.exec(cabecera);
  assert.ok(m, cabecera);
  return Buffer.from(m[1], 'base64').toString('utf8');
}

// ── El backend en proceso ────────────────────────────────────────────
let base = '';
const servidor: Server = createServer((req, res) => {
  if (!handleAPI(req, res)) {
    res.writeHead(404);
    res.end();
  }
});

async function llamar(cuerpo: unknown): Promise<{ estado: number; cuerpo: Record<string, unknown> }> {
  const r = await fetch(`${base}/api/reportes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  return { estado: r.status, cuerpo: texto ? (JSON.parse(texto) as Record<string, unknown>) : {} };
}

function contador(nombre: string): number {
  return getMetrics().counters[nombre] ?? 0;
}

function limpiar(): void {
  getDb().prepare('DELETE FROM reportes').run();
  smtp.modo = 'ok';
  smtp.auths.length = 0;
  smtp.comandos.length = 0;
  smtp.correos.length = 0;
}

function filas(): Array<{ id: string; tipo: string; texto: string; intentos: number; proximo_intento: number }> {
  return getDb().prepare('SELECT id, tipo, texto, intentos, proximo_intento FROM reportes ORDER BY creado').all() as never;
}

test.before(async () => {
  await new Promise<void>((listo) => servidorSmtp.listen(0, '127.0.0.1', listo));
  const dirSmtp = servidorSmtp.address();
  puertoSmtp = typeof dirSmtp === 'object' && dirSmtp ? dirSmtp.port : 0;
  await new Promise<void>((listo) => servidor.listen(0, '127.0.0.1', listo));
  const dir = servidor.address();
  base = `http://127.0.0.1:${typeof dir === 'object' && dir ? dir.port : 0}`;
});

test.after(async () => {
  await new Promise<void>((listo) => servidor.close(() => listo()));
  await new Promise<void>((listo) => servidorSmtp.close(() => listo()));
  try {
    getDb().close();
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

// ── Configuración ────────────────────────────────────────────────────

test('configCorreoDesdeEntorno: apagado sin cuenta; Gmail por TLS; la clave sin espacios', () => {
  assert.equal(correo.configCorreoDesdeEntorno({}), null);
  assert.equal(correo.configCorreoDesdeEntorno({ YA_VIENE_CORREO_USUARIO: USUARIO }), null);
  assert.equal(correo.configCorreoDesdeEntorno({ YA_VIENE_CORREO_CLAVE: CLAVE }), null);

  assert.deepEqual(correo.configCorreoDesdeEntorno({
    YA_VIENE_CORREO_USUARIO: ` ${USUARIO} `,
    YA_VIENE_CORREO_CLAVE: CLAVE_PEGADA,
  }), { host: 'smtp.gmail.com', puerto: 465, tls: true, usuario: USUARIO, clave: CLAVE, destino: USUARIO });

  // El servidor falso solo fuera de producción: en producción va a Gmail.
  const prueba = { YA_VIENE_CORREO_USUARIO: USUARIO, YA_VIENE_CORREO_CLAVE: CLAVE, YA_VIENE_SMTP: 'smtp://127.0.0.1:2525' };
  assert.deepEqual(correo.configCorreoDesdeEntorno(prueba),
    { host: '127.0.0.1', puerto: 2525, tls: false, usuario: USUARIO, clave: CLAVE, destino: USUARIO });
  assert.equal(correo.configCorreoDesdeEntorno({ ...prueba, NODE_ENV: 'production' })?.host, 'smtp.gmail.com');
});

test('esDireccion: nada que rompa un comando SMTP', () => {
  assert.equal(correo.esDireccion('equipo@ejemplo.com'), true);
  assert.equal(correo.esDireccion('nombre.apellido+buzon@gmail.com'), true);
  for (const mala of ['', 'sin-arroba', 'a@b', 'a b@c.co', '<a@b.co>', 'a@b.co\r\nRCPT TO:<x@y.z>', 'a@@b.co']) {
    assert.equal(correo.esDireccion(mala), false, JSON.stringify(mala));
  }
});

test('validateConfig: media cuenta, direcciones malas o SMTP fuera de esta máquina detienen el arranque', () => {
  const secreta = 'clave-que-no-se-ve';
  const del = (env: NodeJS.ProcessEnv): { errores: string[]; avisos: string[] } => {
    const r = validateConfig({ JWT_SECRET: 'x'.repeat(40), ...env });
    for (const m of [...r.errores, ...r.avisos]) assert.ok(!m.includes(secreta), m);
    return { errores: r.errores.filter((e) => e.startsWith('Buzón:')), avisos: r.avisos };
  };
  assert.deepEqual(del({}).errores, []);
  assert.deepEqual(del({ YA_VIENE_CORREO_USUARIO: USUARIO, YA_VIENE_CORREO_CLAVE: secreta }).errores, []);
  assert.match(del({ YA_VIENE_CORREO_USUARIO: USUARIO }).errores.join(), /van juntas/);
  assert.match(del({ YA_VIENE_CORREO_CLAVE: secreta }).errores.join(), /van juntas/);
  assert.match(del({ YA_VIENE_CORREO_USUARIO: 'buzon', YA_VIENE_CORREO_CLAVE: secreta }).errores.join(),
    /YA_VIENE_CORREO_USUARIO no es una dirección/);
  assert.match(del({ YA_VIENE_CORREO_USUARIO: USUARIO, YA_VIENE_CORREO_CLAVE: secreta, YA_VIENE_CORREO_DESTINO: 'a b@c' })
    .errores.join(), /YA_VIENE_CORREO_DESTINO no es una dirección/);
  for (const smtpMalo of ['smtp://10.0.0.5:25', 'smtp://127.0.0.1', 'http://127.0.0.1:25', 'no es url']) {
    assert.match(del({ YA_VIENE_SMTP: smtpMalo }).errores.join(), /YA_VIENE_SMTP solo admite/, smtpMalo);
  }
  assert.deepEqual(del({ YA_VIENE_SMTP: 'smtp://127.0.0.1:2525' }).errores, []);
  // En producción se ignora, y lo dice.
  const prod = del({ NODE_ENV: 'production', YA_VIENE_SMTP: 'smtp://10.0.0.5:25' });
  assert.deepEqual(prod.errores, []);
  assert.ok(prod.avisos.some((a) => a.includes('YA_VIENE_SMTP se ignora en producción')));
});

// ── Validación ───────────────────────────────────────────────────────

test('leerReporte: tipo, texto de 3 a 1000, sin controles, plataforma y versión opcionales', () => {
  assert.deepEqual(reportes.leerReporte({ tipo: 'problema', texto: '  El bus 12 no aparece \r\n en el mapa  ' }),
    { tipo: 'problema', texto: 'El bus 12 no aparece \n en el mapa' });
  assert.deepEqual(reportes.leerReporte({ tipo: 'sugerencia', texto: 'Modo\tnoche', plataforma: 'ios', version: '1.4.0+12' }),
    { tipo: 'sugerencia', texto: 'Modo\tnoche', plataforma: 'ios', version: '1.4.0+12' });
  // Mil caracteres de verdad, no mil unidades de UTF-16: los emoji cuentan uno.
  assert.ok(!('error' in reportes.leerReporte({ tipo: 'problema', texto: '🚌'.repeat(1000) })));
  // Los separadores de Unicode son saltos de línea; los controles de dirección
  // (que pintan al revés lo que sigue en el correo) y el BOM se van sin
  // rechazar el reporte. El ZWJ se queda: junta la familia del emoji.
  assert.deepEqual(reportes.leerReporte({ tipo: 'problema', texto: 'uno dos tres' }),
    { tipo: 'problema', texto: 'uno\ndos\ntres' });
  assert.deepEqual(
    reportes.leerReporte({ tipo: 'problema', texto: '﻿ruta ‮atrás‬ ⁦aislado⁩ ‪a‫b‭c' }),
    { tipo: 'problema', texto: 'ruta atrás aislado abc' });
  assert.deepEqual(reportes.leerReporte({ tipo: 'sugerencia', texto: 'Para 👨‍👩‍👧' }),
    { tipo: 'sugerencia', texto: 'Para 👨‍👩‍👧' });
  // Solo invisibles no es un reporte: tras quitarlos no quedan 3 caracteres.
  const vacio = reportes.leerReporte({ tipo: 'problema', texto: 'a‮‮‮b' });
  assert.ok('error' in vacio && vacio.error.includes('entre 3 y 1000'));

  for (const [malo, mensaje] of [
    [null, 'objeto'],
    [[1], 'objeto'],
    ['texto', 'objeto'],
    [{ texto: 'hola mundo' }, 'tipo'],
    [{ tipo: 'queja', texto: 'hola mundo' }, 'tipo'],
    [{ tipo: 'problema' }, 'Falta el texto'],
    [{ tipo: 'problema', texto: 42 }, 'Falta el texto'],
    [{ tipo: 'problema', texto: '  ab  ' }, 'entre 3 y 1000'],
    [{ tipo: 'problema', texto: 'a'.repeat(1001) }, 'entre 3 y 1000'],
    [{ tipo: 'problema', texto: 'hola\u0000mundo' }, 'caracteres no válidos'],
    [{ tipo: 'problema', texto: 'hola\u001bmundo' }, 'caracteres no válidos'],
    [{ tipo: 'problema', texto: 'hola mundo', plataforma: 'windows' }, 'plataforma'],
    [{ tipo: 'problema', texto: 'hola mundo', version: 'v 1' }, 'version'],
    [{ tipo: 'problema', texto: 'hola mundo', version: 3 }, 'version'],
    [{ tipo: 'problema', texto: 'hola mundo', version: '1'.repeat(33) }, 'version'],
  ] as const) {
    const r = reportes.leerReporte(malo);
    assert.ok('error' in r && r.error.includes(mensaje), `${JSON.stringify(malo)} → ${JSON.stringify(r)}`);
  }
});

// ── El correo ────────────────────────────────────────────────────────

test('enviarCorreo: AUTH PLAIN con la clave sin espacios; asunto y cuerpo en UTF-8; nada del pasajero en las cabeceras', async () => {
  limpiar();
  const texto = 'Línea uno: ñandú, acentos y 🚌.\nTo: intruso@ejemplo.com\r\n.\r\nRCPT TO:<x@y.z>\n' + 'x'.repeat(300);
  await correo.enviarCorreo(configFalsa(), { id: 'abc-123', asunto: 'Ya Viene · Sugerencia', texto });

  assert.deepEqual(smtp.auths, [`\0${USUARIO}\0${CLAVE}`]);
  assert.deepEqual(smtp.comandos.slice(0, 1), ['EHLO yaviene']);
  assert.ok(smtp.comandos.includes(`MAIL FROM:<${USUARIO}>`));
  assert.ok(smtp.comandos.includes(`RCPT TO:<${DESTINO}>`));
  assert.equal(smtp.comandos.filter((c) => c.startsWith('RCPT')).length, 1, 'el texto no agrega destinatarios');
  assert.equal(smtp.correos.length, 1);

  const { cabeceras, cuerpo, lineas } = abrir(smtp.correos[0]);
  assert.equal(cabeceras.From, `Ya Viene <${USUARIO}>`);
  assert.equal(cabeceras.To, `<${DESTINO}>`);
  assert.equal(asunto(cabeceras.Subject), 'Ya Viene · Sugerencia');
  assert.equal(cabeceras['Message-ID'], '<abc-123@ejemplo.com>');
  assert.equal(cabeceras['Content-Type'], 'text/plain; charset=UTF-8');
  assert.equal(cabeceras['Content-Transfer-Encoding'], 'base64');
  assert.ok(!Number.isNaN(Date.parse(cabeceras.Date)));
  assert.equal(cabeceras.To, `<${DESTINO}>`, 'el «To:» del texto no se vuelve cabecera');
  assert.equal(cuerpo, texto);
  for (const linea of lineas) assert.ok(linea.length <= 78, `línea de ${linea.length}`);
  for (const linea of lineas.slice(lineas.indexOf('') + 1)) assert.ok(!linea.startsWith('.'));
});

test('enviarCorreo: 535 dice el paso y el código, nunca la clave', async () => {
  limpiar();
  smtp.modo = 'auth535';
  await assert.rejects(
    correo.enviarCorreo(configFalsa(), { id: 'x', asunto: 'a', texto: 'b' }),
    (e: Error) => e.message === 'AUTH: el servidor de correo respondió 535' && !e.message.includes(CLAVE),
  );
  assert.equal(smtp.correos.length, 0);
});

test('enviarCorreo: servidor mudo o que cuelga no deja la vuelta esperando', async () => {
  limpiar();
  smtp.modo = 'mudo';
  await assert.rejects(
    correo.enviarCorreo(configFalsa(), { id: 'x', asunto: 'a', texto: 'b' }, 150),
    /no respondió a tiempo/,
  );
  smtp.modo = 'cortar';
  await assert.rejects(correo.enviarCorreo(configFalsa(), { id: 'x', asunto: 'a', texto: 'b' }), /cerró la conexión|sin conexión/);
  // Nadie escuchando en el puerto.
  const cerrado = crearServidorTcp();
  await new Promise<void>((listo) => cerrado.listen(0, '127.0.0.1', listo));
  const dir = cerrado.address();
  await new Promise<void>((listo) => cerrado.close(() => listo()));
  await assert.rejects(
    correo.enviarCorreo({ ...configFalsa(), puerto: typeof dir === 'object' && dir ? dir.port : 1 }, { id: 'x', asunto: 'a', texto: 'b' }),
    /sin conexión con el servidor de correo/,
  );
});

test('mensajeDeReporte: asunto fijo por tipo; desde dónde y a qué hora de Colombia', () => {
  const creado = Date.UTC(2026, 9, 2, 17, 30);
  const uno = reportes.mensajeDeReporte({
    id: 'r1', tipo: 'problema', texto: 'No carga', plataforma: 'ios', version: '1.4.0', creado, intentos: 0,
  });
  assert.equal(uno.asunto, 'Ya Viene · Problema reportado');
  assert.match(uno.texto, /^Tipo: Problema\nDesde: iPhone · app 1\.4\.0\nRecibido: .*12:30.*\(hora de Colombia\)\n\nNo carga\n/);
  const dos = reportes.mensajeDeReporte({
    id: 'r2', tipo: 'sugerencia', texto: 'Más rutas', plataforma: null, version: null, creado, intentos: 0,
  });
  assert.equal(dos.asunto, 'Ya Viene · Sugerencia');
  assert.match(dos.texto, /Desde: sin dato/);
  const tres = reportes.mensajeDeReporte({
    id: 'r3', tipo: 'problema', texto: 'x', plataforma: 'android', version: null, creado, intentos: 0,
  });
  assert.match(tres.texto, /Desde: Android\n/);
});

// ── La cola ──────────────────────────────────────────────────────────

test('enviarReportes: salen de cinco en cinco, en orden, y cada uno enviado se borra', async () => {
  limpiar();
  const antes = contador('buzon.enviados');
  for (let i = 0; i < 7; i++) {
    reportes.crearReporte({ tipo: 'sugerencia', texto: `Reporte número ${i}` }, 1_000 + i);
  }
  await reportes.enviarReportes(configFalsa());
  assert.equal(smtp.correos.length, 5);
  assert.deepEqual(smtp.correos.map((c) => /Reporte número (\d)/.exec(abrir(c).cuerpo)?.[1]), ['0', '1', '2', '3', '4']);
  assert.deepEqual(filas().map((f) => f.texto), ['Reporte número 5', 'Reporte número 6']);
  await reportes.enviarReportes(configFalsa());
  assert.equal(filas().length, 0);
  assert.equal(contador('buzon.enviados') - antes, 7);
});

test('enviarReportes: Gmail rechaza, la fila se queda y espera 1, 2, 4… minutos, hasta 6 h', async () => {
  limpiar();
  smtp.modo = 'auth535';
  const fallidos = contador('buzon.fallidos');
  reportes.crearReporte({ tipo: 'problema', texto: 'primero' }, 1);
  reportes.crearReporte({ tipo: 'problema', texto: 'segundo' }, 2);
  let ahora = 10_000;
  await reportes.enviarReportes(configFalsa(), undefined, () => ahora);
  assert.equal(smtp.auths.length, 1, 'el primer rechazo corta la vuelta');
  assert.deepEqual(filas().map((f) => [f.texto, f.intentos, f.proximo_intento]), [
    ['primero', 1, ahora + 60_000],
    ['segundo', 0, 2],
  ]);

  // Antes de su hora el primero no se intenta, pero el segundo sí.
  ahora += 30_000;
  await reportes.enviarReportes(configFalsa(), undefined, () => ahora);
  assert.equal(filas()[1].intentos, 1);
  assert.equal(filas()[0].intentos, 1);

  getDb().prepare("UPDATE reportes SET intentos = 20, proximo_intento = 0 WHERE texto = 'primero'").run();
  await reportes.enviarReportes(configFalsa(), undefined, () => ahora);
  assert.equal(filas()[0].proximo_intento, ahora + 6 * 60 * 60 * 1000);
  assert.equal(contador('buzon.fallidos') - fallidos, 3);

  // Gmail vuelve: salen los dos.
  smtp.modo = 'ok';
  ahora += 7 * 60 * 60 * 1000;
  await reportes.enviarReportes(configFalsa(), undefined, () => ahora);
  assert.equal(filas().length, 0);
  assert.equal(smtp.correos.length, 2);
});

test('enviarReportes: una vuelta no se pisa con la anterior', async () => {
  limpiar();
  reportes.crearReporte({ tipo: 'problema', texto: 'uno solo' }, 1);
  let soltar = (): void => {};
  const llamadas: string[] = [];
  const lento = (_c: unknown, m: { id: string }): Promise<void> => {
    llamadas.push(m.id);
    return new Promise<void>((listo) => {
      soltar = listo;
    });
  };
  const primera = reportes.enviarReportes(configFalsa(), lento);
  await reportes.enviarReportes(configFalsa(), lento);
  assert.equal(llamadas.length, 1);
  soltar();
  await primera;
  assert.equal(filas().length, 0);
  assert.equal(llamadas.length, 1);
});

// ── La ruta ──────────────────────────────────────────────────────────

test('POST /api/reportes: valida, encola sin datos de más, 503 con la cola llena y 429 al sexto', async () => {
  limpiar();
  const recibidos = contador('buzon.recibidos');
  const lleno = contador('buzon.lleno');

  const malo = await llamar({ tipo: 'queja', texto: 'hola mundo' });
  assert.equal(malo.estado, 400);
  assert.equal((malo.cuerpo.error as { code: string }).code, 'INVALID_INPUT');

  const bueno = await llamar({ tipo: 'problema', texto: ' El bus no se mueve ', plataforma: 'android', version: '1.4.0', nombre: 'Ana' });
  assert.equal(bueno.estado, 201);
  assert.deepEqual(bueno.cuerpo, { recibido: true });
  const fila = getDb().prepare('SELECT * FROM reportes').get() as Record<string, unknown>;
  assert.deepEqual(
    { tipo: fila.tipo, texto: fila.texto, plataforma: fila.plataforma, version: fila.version, intentos: fila.intentos },
    { tipo: 'problema', texto: 'El bus no se mueve', plataforma: 'android', version: '1.4.0', intentos: 0 },
  );
  assert.ok(!Object.values(fila).includes('Ana'), 'lo que no está en el contrato no se guarda');
  assert.equal(contador('buzon.recibidos') - recibidos, 1);

  const insertar = getDb().prepare(`
    INSERT INTO reportes (id, tipo, texto, creado, proximo_intento) VALUES (?, 'sugerencia', 'x', 0, 9e15)
  `);
  getDb().transaction(() => {
    for (let i = 1; i < reportes.MAX_REPORTES; i++) insertar.run(`relleno-${i}`);
  })();
  const sinSitio = await llamar({ tipo: 'sugerencia', texto: 'Una más' });
  assert.equal(sinSitio.estado, 503);
  assert.equal((sinSitio.cuerpo.error as { code: string }).code, 'BUZON_LLENO');
  assert.equal(contador('buzon.lleno') - lleno, 1);
  limpiar();

  assert.equal((await llamar({ tipo: 'sugerencia', texto: 'cuarta' })).estado, 201);
  assert.equal((await llamar({ tipo: 'sugerencia', texto: 'quinta' })).estado, 201);
  const sexta = await llamar({ tipo: 'sugerencia', texto: 'sexta' });
  assert.equal(sexta.estado, 429);
  assert.equal(filas().length, 2);
});
