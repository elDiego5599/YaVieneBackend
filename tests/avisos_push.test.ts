// Avisos con la app cerrada (D13): la tabla, la vuelta del servidor, el
// emisor de FCM y las tres rutas, en proceso y contra un FCM falso que
// verifica el JWT firmado con una clave RSA de usar y tirar. Nada sale a
// internet.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, IncomingMessage, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import jwt from 'jsonwebtoken';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-avisos-'));
process.env.YA_VIENE_DB_PATH = join(tmp, 'test.db');
process.env.JWT_SECRET = randomBytes(32).toString('hex');
const RUTA_CREDENCIALES = join(tmp, 'fcm-credenciales.json');
process.env.YA_VIENE_FCM_CREDENCIALES = RUTA_CREDENCIALES;

// require y no import: abren la base y leen el env al evaluarse.
const { handleAPI } = require('../src/api/routes') as typeof import('../src/api/routes');
const { getDb } = require('../src/data/database') as typeof import('../src/data/database');
const { createBus, setBusVisibility } = require('../src/data/fleet_admin') as typeof import('../src/data/fleet_admin');
const { registerDriver } = require('../src/data/drivers_store') as typeof import('../src/data/drivers_store');
const { upsertPosition } = require('../src/data/positions_store') as typeof import('../src/data/positions_store');
const { hashSecret } = require('../src/auth/passwords') as typeof import('../src/auth/passwords');
const { getMetrics } = require('../src/observability/metrics') as typeof import('../src/observability/metrics');
const { validateConfig } = require('../src/config') as typeof import('../src/config');
const fcm = require('../src/push/fcm') as typeof import('../src/push/fcm');
const avisos = require('../src/data/avisos_push') as typeof import('../src/data/avisos_push');
const { MAX_AVISOS_ARMADOS_POR_IP } = require('../src/security/rate_limiter') as typeof import('../src/security/rate_limiter');

const PROYECTO = 'yaviene-prueba';
const EMPRESA = 'AVI-01';
const RUTA = 'R-AV1';
// Un punto del centro de Barranquilla y el bus a ~550 m al norte (dentro
// del radio) o a ~2,2 km (fuera).
const PASAJERO = { lat: 10.98, lon: -74.79 };
const CERCA = { lat: 10.985, lon: -74.79 };
const LEJOS = { lat: 11.0, lon: -74.79 };
const TOKEN = 'tok-bueno-' + 'a'.repeat(40);

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// ── El FCM falso ─────────────────────────────────────────────────────
const falso = {
  tokensPedidos: 0,
  fallarToken: false,
  revocarUnaVez: false,
  enviados: [] as Array<{ autorizacion: string; message: Record<string, unknown> }>,
  vigente: '',
};

function leer(req: IncomingMessage): Promise<string> {
  return new Promise((listo) => {
    const trozos: Buffer[] = [];
    req.on('data', (t: Buffer) => trozos.push(t));
    req.on('end', () => listo(Buffer.concat(trozos).toString('utf8')));
  });
}

let baseFcm = '';
const servidorFcm: Server = createServer(async (req, res) => {
  const cuerpo = await leer(req);
  const responder = (estado: number, json: unknown): void => {
    res.writeHead(estado, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(json));
  };
  if (req.url === '/token') {
    falso.tokensPedidos += 1;
    if (falso.fallarToken) return responder(500, { error: 'caido' });
    const form = new URLSearchParams(cuerpo);
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    // Firmado con la clave de la cuenta de servicio, para Google y con el
    // alcance de FCM: si no, Google no da el token.
    const reclamos = jwt.verify(form.get('assertion') ?? '', publicKey, {
      algorithms: ['RS256'],
      audience: `${baseFcm}/token`,
    }) as Record<string, unknown>;
    assert.equal(reclamos.iss, 'push@yaviene-prueba.iam.gserviceaccount.com');
    assert.equal(reclamos.scope, 'https://www.googleapis.com/auth/firebase.messaging');
    assert.equal((reclamos.exp as number) - (reclamos.iat as number), 3600);
    falso.vigente = `acceso-${falso.tokensPedidos}`;
    return responder(200, { access_token: falso.vigente, expires_in: 3599, token_type: 'Bearer' });
  }
  if (req.url === `/v1/projects/${PROYECTO}/messages:send`) {
    const autorizacion = req.headers.authorization ?? '';
    if (falso.revocarUnaVez || autorizacion !== `Bearer ${falso.vigente}`) {
      falso.revocarUnaVez = false;
      return responder(401, { error: { status: 'UNAUTHENTICATED' } });
    }
    const { message } = JSON.parse(cuerpo) as { message: Record<string, unknown> };
    falso.enviados.push({ autorizacion, message });
    const token = String(message.token);
    if (token.startsWith('tok-desinstalado')) {
      return responder(404, {
        error: {
          status: 'NOT_FOUND',
          details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }],
        },
      });
    }
    if (token.startsWith('tok-invalido')) return responder(400, { error: { status: 'INVALID_ARGUMENT' } });
    if (token.startsWith('tok-caido')) return responder(503, { error: { status: 'UNAVAILABLE' } });
    if (token.startsWith('tok-roto')) return responder(500, 'no es json');
    return responder(200, { name: `projects/${PROYECTO}/messages/1` });
  }
  responder(404, {});
});

// ── El backend en proceso ────────────────────────────────────────────
let base = '';
const servidor: Server = createServer((req, res) => {
  if (!handleAPI(req, res)) {
    res.writeHead(404);
    res.end();
  }
});

async function llamar(metodo: string, ruta: string, cuerpo?: unknown): Promise<{ estado: number; cuerpo: Record<string, unknown> }> {
  const r = await fetch(`${base}${ruta}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  return { estado: r.status, cuerpo: texto ? (JSON.parse(texto) as Record<string, unknown>) : {} };
}

function credenciales(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'service_account',
    project_id: PROYECTO,
    client_email: 'push@yaviene-prueba.iam.gserviceaccount.com',
    private_key: privateKey,
    token_uri: `${baseFcm}/token`,
    ...extra,
  };
}

let busId = '';
let busOculto = '';
const TELEFONO = '+57700';

function ponerBus(punto: { lat: number; lon: number }): void {
  upsertPosition(TELEFONO, { busId, routeId: RUTA, ...punto, driverValidated: true });
}

function limpiar(): void {
  getDb().prepare('DELETE FROM avisos_push').run();
  falso.enviados.length = 0;
  falso.fallarToken = false;
  falso.revocarUnaVez = false;
}

function armar(token = TOKEN, punto = PASAJERO, ahora = Date.now()): string {
  const creado = avisos.crearAviso({ token, busId, routeId: RUTA, ...punto, vidaMs: avisos.VIDA_MAXIMA_MS, radioM: avisos.RADIO_AVISO_M }, ahora);
  assert.equal(typeof creado, 'object');
  return (creado as { id: string }).id;
}

function contador(nombre: string): number {
  return getMetrics().counters[nombre] ?? 0;
}

test.before(async () => {
  await new Promise<void>((listo) => servidorFcm.listen(0, '127.0.0.1', listo));
  const dirFcm = servidorFcm.address();
  baseFcm = `http://127.0.0.1:${typeof dirFcm === 'object' && dirFcm ? dirFcm.port : 0}`;
  process.env.YA_VIENE_FCM_API = baseFcm;
  writeFileSync(RUTA_CREDENCIALES, JSON.stringify(credenciales()));

  await new Promise<void>((listo) => servidor.listen(0, '127.0.0.1', listo));
  const dir = servidor.address();
  base = `http://127.0.0.1:${typeof dir === 'object' && dir ? dir.port : 0}`;

  getDb().prepare('INSERT OR IGNORE INTO empresas (company_id, name, created_at) VALUES (?, ?, ?)')
    .run(EMPRESA, 'Avisos', Date.now());
  const bus = createBus(EMPRESA, 'AVI001', RUTA);
  if (typeof bus === 'string') throw new Error(`alta AVI001: ${bus}`);
  busId = bus.busId;
  setBusVisibility(busId, true);
  const oculto = createBus(EMPRESA, 'AVI002', RUTA);
  if (typeof oculto === 'string') throw new Error(`alta AVI002: ${oculto}`);
  busOculto = oculto.busId;
  setBusVisibility(busOculto, false);
  registerDriver(TELEFONO, 'Avisos', RUTA, { companyId: EMPRESA, busId, pinHash: hashSecret('1234') });
  ponerBus(LEJOS);
});

test.after(async () => {
  await new Promise<void>((listo) => servidor.close(() => listo()));
  await new Promise<void>((listo) => servidorFcm.close(() => listo()));
  try {
    getDb().close();
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

// ── Credenciales y configuración ─────────────────────────────────────
test('leerCredencialesFcm: dice qué falta y nunca enseña la clave', () => {
  const ruta = join(tmp, 'mala.json');
  assert.throws(() => fcm.leerCredencialesFcm(join(tmp, 'no-existe.json')), /no se pudo leer/);
  writeFileSync(ruta, 'no es json');
  assert.throws(() => fcm.leerCredencialesFcm(ruta), /no se pudo leer/);
  writeFileSync(ruta, 'null');
  assert.throws(() => fcm.leerCredencialesFcm(ruta), /project_id/);
  writeFileSync(ruta, JSON.stringify(credenciales({ client_email: '' })));
  assert.throws(() => fcm.leerCredencialesFcm(ruta), /client_email/);
  writeFileSync(ruta, JSON.stringify(credenciales({ token_uri: 'http://oauth2.example.com/token' })));
  assert.throws(
    () => fcm.leerCredencialesFcm(ruta),
    (e: Error) => /no es https/.test(e.message) && !e.message.includes('PRIVATE KEY'),
  );
  writeFileSync(ruta, JSON.stringify(credenciales({ token_uri: 'https://oauth2.googleapis.com/token' })));
  assert.equal(fcm.leerCredencialesFcm(ruta).project_id, PROYECTO);
});

test('validateConfig: cuenta de servicio rota detiene el arranque; sin ella no avisa', () => {
  const baseEnv = { JWT_SECRET: 'x'.repeat(40), YA_VIENE_FLOTA_DEMO: '0' };
  const roto = validateConfig({ ...baseEnv, YA_VIENE_FCM_CREDENCIALES: join(tmp, 'no-existe.json') });
  assert.ok(roto.errores.some((e) => e.startsWith('YA_VIENE_FCM_CREDENCIALES:')));
  assert.deepEqual(
    validateConfig({ ...baseEnv, YA_VIENE_FCM_CREDENCIALES: RUTA_CREDENCIALES }).errores,
    [],
  );
  const prod = validateConfig({
    ...baseEnv, NODE_ENV: 'production', ADMIN_API_KEY: 'k'.repeat(30), HTTP_TLS_EXTERNO: '1',
    YA_VIENE_FLOTA_DEMO: '0', YA_VIENE_FCM_API: 'http://127.0.0.1:1',
  });
  // Sin cuenta el push está apagado a propósito: solo avisa el API falso.
  assert.deepEqual(prod.avisos, ['YA_VIENE_FCM_API se ignora en producción: el push va siempre a fcm.googleapis.com']);
});

test('emisorDesdeEntorno: sin cuenta no hay push; en producción el API falso no cuenta', () => {
  assert.equal(fcm.emisorDesdeEntorno({}), null);
  const api = (e: unknown): string => (e as { api: string }).api;
  const env = { YA_VIENE_FCM_CREDENCIALES: RUTA_CREDENCIALES, YA_VIENE_FCM_API: baseFcm };
  assert.equal(api(fcm.emisorDesdeEntorno(env)), baseFcm);
  assert.equal(api(fcm.emisorDesdeEntorno({ ...env, NODE_ENV: 'production' })), 'https://fcm.googleapis.com');
});

// ── El emisor ────────────────────────────────────────────────────────
test('emisor: un solo token de acceso para varios envíos, también a la vez', async () => {
  limpiar();
  const emisor = new fcm.EmisorFcm(fcm.leerCredencialesFcm(RUTA_CREDENCIALES), baseFcm);
  const antes = falso.tokensPedidos;
  const datos = { tipo: 'bus_cerca' };
  const resultados = await Promise.all([emisor.enviar(TOKEN, datos), emisor.enviar(TOKEN, datos)]);
  assert.deepEqual(resultados, ['enviado', 'enviado']);
  assert.equal(await emisor.enviar(TOKEN, datos), 'enviado');
  assert.equal(falso.tokensPedidos - antes, 1);
  // El mensaje: solo datos, prioridad alta, diez minutos de vida.
  assert.deepEqual(falso.enviados[0].message, {
    token: TOKEN, data: datos, android: { priority: 'HIGH', ttl: '600s' },
  });
  // A la hora menos un minuto se pide otro.
  assert.equal(await emisor.enviar(TOKEN, datos, Date.now() + 3600_000), 'enviado');
  assert.equal(falso.tokensPedidos - antes, 2);
});

test('emisor: 401 tira el token de acceso y el siguiente envío pide otro', async () => {
  limpiar();
  const emisor = new fcm.EmisorFcm(fcm.leerCredencialesFcm(RUTA_CREDENCIALES), baseFcm);
  assert.equal(await emisor.enviar(TOKEN, {}), 'enviado');
  const antes = falso.tokensPedidos;
  falso.revocarUnaVez = true;
  assert.equal(await emisor.enviar(TOKEN, {}), 'reintentar');
  assert.equal(await emisor.enviar(TOKEN, {}), 'enviado');
  assert.equal(falso.tokensPedidos - antes, 1);
});

test('emisor: qué es token inválido y qué se reintenta', async () => {
  limpiar();
  const emisor = new fcm.EmisorFcm(fcm.leerCredencialesFcm(RUTA_CREDENCIALES), baseFcm);
  assert.equal(await emisor.enviar('tok-desinstalado-1', {}), 'token_invalido');
  assert.equal(await emisor.enviar('tok-invalido-1', {}), 'token_invalido');
  assert.equal(await emisor.enviar('tok-caido-1', {}), 'reintentar');
  assert.equal(await emisor.enviar('tok-roto-1', {}), 'reintentar');
  const sinToken = new fcm.EmisorFcm(fcm.leerCredencialesFcm(RUTA_CREDENCIALES), baseFcm);
  falso.fallarToken = true;
  assert.equal(await sinToken.enviar(TOKEN, {}), 'reintentar');
  // FCM que no contesta (puerto cerrado).
  const cerrado = new fcm.EmisorFcm(fcm.leerCredencialesFcm(RUTA_CREDENCIALES), 'http://127.0.0.1:1');
  falso.fallarToken = false;
  assert.equal(await cerrado.enviar(TOKEN, {}), 'reintentar');
});

// ── La tabla ─────────────────────────────────────────────────────────
test('crearAviso: el mismo teléfono y bus reemplaza; uno por teléfono; tope de la tabla', () => {
  limpiar();
  const primero = armar();
  const segundo = armar();
  assert.notEqual(primero, segundo);
  const filas = getDb().prepare('SELECT id FROM avisos_push').all() as { id: string }[];
  assert.deepEqual(filas.map((f) => f.id), [segundo]);

  const comun = { token: TOKEN, routeId: RUTA, ...PASAJERO, vidaMs: 1000, radioM: avisos.RADIO_AVISO_M };
  assert.equal(avisos.crearAviso({ ...comun, busId: busOculto }), 'tope_token');
  assert.equal(avisos.crearAviso({ ...comun, busId: 'BUS-OTRO' }), 'tope_token');

  // La vida se recorta a tres horas.
  const ahora = 5_000;
  const largo = avisos.crearAviso({ ...comun, token: 'tok-largo-' + 'b'.repeat(30), busId, vidaMs: 10 * 3600_000 }, ahora);
  const { vence } = getDb().prepare('SELECT vence FROM avisos_push WHERE id = ?').get((largo as { id: string }).id) as { vence: number };
  assert.equal(vence, ahora + avisos.VIDA_MAXIMA_MS);

  limpiar();
  const insertar = getDb().prepare(`
    INSERT INTO avisos_push (id, token, bus_id, route_id, lat, lon, creado, vence)
    VALUES (?, ?, 'B', 'R', 0, 0, 0, 9e15)
  `);
  getDb().transaction(() => {
    for (let i = 0; i < avisos.MAX_AVISOS; i += 1) insertar.run(`relleno-${i}`, `tok-${i}`);
  })();
  assert.equal(avisos.crearAviso({ ...comun, token: 'tok-nuevo-' + 'c'.repeat(30), busId }), 'lleno');
  limpiar();
});

test('renovarAviso: pone al día punto y token; dice si ya se envió o venció', () => {
  limpiar();
  const ahora = 1_000_000;
  const id = armar(TOKEN, PASAJERO, ahora);
  const nuevo = 'tok-nuevo-' + 'd'.repeat(30);
  assert.equal(avisos.renovarAviso(id, { token: nuevo, ...CERCA }, ahora + 30_000), 'renovado');
  const fila = getDb().prepare('SELECT token, lat FROM avisos_push WHERE id = ?')
    .get(id) as { token: string; lat: number };
  assert.deepEqual(fila, { token: nuevo, lat: CERCA.lat });
  assert.equal(avisos.marcarEnviado(id, ahora + 31_000), true);
  assert.equal(avisos.marcarEnviado(id, ahora + 31_000), false);
  assert.equal(avisos.renovarAviso(id, { token: nuevo, ...CERCA }, ahora + 32_000), 'enviado');
  assert.equal(avisos.renovarAviso(id, { token: nuevo, ...CERCA }, ahora + avisos.VIDA_MAXIMA_MS), 'no_existe');
  assert.equal(avisos.renovarAviso('no-existe', { token: nuevo, ...CERCA }), 'no_existe');
  assert.equal(avisos.barrerVencidos(ahora + avisos.VIDA_MAXIMA_MS), 1);
});

// ── La vuelta del servidor ───────────────────────────────────────────
test('revisarAvisos: avisa en cuanto el bus entra al kilómetro, y una sola vez', async () => {
  limpiar();
  const emisor = new fcm.EmisorFcm(fcm.leerCredencialesFcm(RUTA_CREDENCIALES), baseFcm);
  const ahora = Date.now();
  const id = armar(TOKEN, PASAJERO, ahora);

  ponerBus(LEJOS);
  await avisos.revisarAvisos(emisor, ahora + 1_000);
  assert.equal(falso.enviados.length, 0, 'bus lejos: nada');

  // La app acaba de latir y el servidor avisa igual. Antes esperaba a que
  // los latidos llevaran un minuto sin llegar, y con la app recién cerrada
  // el aviso salía con el bus ya a 700 m (dueño, 2026-10-02).
  assert.equal(avisos.renovarAviso(id, { token: TOKEN, ...PASAJERO }, ahora + 2_000), 'renovado');
  ponerBus(CERCA);
  const enviadosAntes = contador('push.enviados');
  await avisos.revisarAvisos(emisor, ahora + 2_500);
  assert.equal(falso.enviados.length, 1);
  const { data } = falso.enviados[0].message as { data: Record<string, string> };
  assert.equal(data.tipo, 'bus_cerca');
  assert.equal(data.avisoId, id);
  assert.equal(data.busId, busId);
  assert.equal(data.routeId, RUTA);
  // ~556 m: FCM solo acepta textos en `data`.
  assert.match(data.distancia, /^5[45]\d$/);
  assert.equal(contador('push.enviados') - enviadosAntes, 1);

  await avisos.revisarAvisos(emisor, ahora + 7_500);
  assert.equal(falso.enviados.length, 1, 'no se repite');
  assert.equal(avisos.renovarAviso(id, { token: TOKEN, ...PASAJERO }, ahora + 8_000), 'enviado');
  ponerBus(LEJOS);
});

test('revisarAvisos: avisa a la distancia que eligió el pasajero, no a un kilómetro fijo', async () => {
  limpiar();
  const emisor = new fcm.EmisorFcm(fcm.leerCredencialesFcm(RUTA_CREDENCIALES), baseFcm);
  const ahora = Date.now();
  const corto = 'tok-corto-' + 'g'.repeat(30);
  const largo = 'tok-largo-' + 'h'.repeat(30);
  avisos.crearAviso({ token: corto, busId, routeId: RUTA, ...PASAJERO, vidaMs: 60_000, radioM: 500 }, ahora);
  avisos.crearAviso({ token: largo, busId, routeId: RUTA, ...PASAJERO, vidaMs: 60_000, radioM: 3000 }, ahora);

  // ~2,2 km: fuera de 500 m, dentro de 3 km.
  ponerBus(LEJOS);
  await avisos.revisarAvisos(emisor, ahora + 1_000);
  assert.deepEqual(falso.enviados.map((e) => e.message.token), [largo]);
  assert.match((falso.enviados[0].message.data as Record<string, string>).distancia, /^22\d\d$/);

  // ~556 m: todavía fuera de 500 m.
  ponerBus(CERCA);
  await avisos.revisarAvisos(emisor, ahora + 2_000);
  assert.equal(falso.enviados.length, 1, 'a 556 m el de 500 m no suena');
  ponerBus(LEJOS);
});

test('revisarAvisos: bus oculto, sin señal o en otra ruta no avisa', async () => {
  limpiar();
  const emisor = new fcm.EmisorFcm(fcm.leerCredencialesFcm(RUTA_CREDENCIALES), baseFcm);
  const ahora = Date.now();
  armar(TOKEN, PASAJERO, ahora);
  const despues = ahora + 1_000;

  // La ruta de la posición la pone el catálogo; el panel la cambia así.
  ponerBus(CERCA);
  getDb().prepare("UPDATE positions SET route_id = 'R-OTRA' WHERE bus_id = ?").run(busId);
  await avisos.revisarAvisos(emisor, despues);
  assert.equal(falso.enviados.length, 0, 'otra ruta');

  ponerBus(CERCA);
  getDb().prepare('UPDATE positions SET is_ghost = 1 WHERE bus_id = ?').run(busId);
  await avisos.revisarAvisos(emisor, despues);
  assert.equal(falso.enviados.length, 0, 'sin señal');

  ponerBus(CERCA);
  getDb().prepare('UPDATE buses SET visible = 0 WHERE bus_id = ?').run(busId);
  await avisos.revisarAvisos(emisor, despues);
  assert.equal(falso.enviados.length, 0, 'oculto');
  getDb().prepare('UPDATE buses SET visible = 1 WHERE bus_id = ?').run(busId);
  ponerBus(LEJOS);
});

test('revisarAvisos: FCM caído se reintenta; token muerto borra todos sus avisos', async () => {
  limpiar();
  const emisor = new fcm.EmisorFcm(fcm.leerCredencialesFcm(RUTA_CREDENCIALES), baseFcm);
  const ahora = Date.now();
  const despues = ahora + 1_000;
  ponerBus(CERCA);

  const caido = 'tok-caido-' + 'e'.repeat(30);
  const id = armar(caido, PASAJERO, ahora);
  const fallidos = contador('push.fallidos');
  await avisos.revisarAvisos(emisor, despues);
  assert.equal(contador('push.fallidos') - fallidos, 1);
  const fila = getDb().prepare('SELECT enviado_en FROM avisos_push WHERE id = ?').get(id) as { enviado_en: number | null };
  assert.equal(fila.enviado_en, null, 'queda para la vuelta siguiente');
  await avisos.revisarAvisos(emisor, despues + 5_000);
  assert.equal(falso.enviados.length, 2, 'la vuelta siguiente lo reintenta');

  limpiar();
  const muerto = 'tok-desinstalado-' + 'f'.repeat(30);
  armar(muerto, PASAJERO, ahora);
  getDb().prepare(`
    INSERT INTO avisos_push (id, token, bus_id, route_id, lat, lon, creado, vence)
    VALUES ('otro-del-mismo', ?, 'BUS-X', ?, 0, 0, 0, 9e15)
  `).run(muerto, RUTA);
  const invalidos = contador('push.token_invalido');
  await avisos.revisarAvisos(emisor, despues);
  assert.equal(contador('push.token_invalido') - invalidos, 1);
  const quedan = getDb().prepare('SELECT COUNT(*) AS n FROM avisos_push WHERE token = ?').get(muerto) as { n: number };
  assert.equal(quedan.n, 0);
  ponerBus(LEJOS);
});

test('revisarAvisos: un envío que revienta se cuenta como fallido y se reintenta', async () => {
  limpiar();
  const ahora = Date.now();
  const id = armar(TOKEN, PASAJERO, ahora);
  ponerBus(CERCA);
  const revienta = { enviar: () => Promise.reject(new Error('boom')) } as unknown as import('../src/push/fcm').EmisorFcm;
  const fallidos = contador('push.fallidos');
  await avisos.revisarAvisos(revienta, ahora + 1_000);
  assert.equal(contador('push.fallidos') - fallidos, 1);
  const fila = getDb().prepare('SELECT enviado_en FROM avisos_push WHERE id = ?').get(id) as { enviado_en: number | null };
  assert.equal(fila.enviado_en, null);
  ponerBus(LEJOS);
});

test('revisarAvisos: barre los vencidos', async () => {
  limpiar();
  const emisor = new fcm.EmisorFcm(fcm.leerCredencialesFcm(RUTA_CREDENCIALES), baseFcm);
  const ahora = Date.now();
  armar(TOKEN, PASAJERO, ahora);
  await avisos.revisarAvisos(emisor, ahora + avisos.VIDA_MAXIMA_MS);
  const { n } = getDb().prepare('SELECT COUNT(*) AS n FROM avisos_push').get() as { n: number };
  assert.equal(n, 0);
});

test('revisarAvisos: limita cada vuelta a 500 avisos', async () => {
  limpiar();
  ponerBus(CERCA);
  for (let i = 0; i < 501; i++) armar(`lote-${i}`, PASAJERO, Date.now());
  let envios = 0;
  const emisor = { enviar: async () => { envios++; return 'enviado' as const; } } as unknown as import('../src/push/fcm').EmisorFcm;
  await avisos.revisarAvisos(emisor);
  assert.equal(envios, 500);
  await avisos.revisarAvisos(emisor);
  assert.equal(envios, 501, 'la vuelta siguiente continúa con el aviso que quedó pendiente');
});

test('revisarAvisos: nunca mantiene más de 20 envíos FCM en curso', async () => {
  limpiar();
  ponerBus(CERCA);
  for (let i = 0; i < 40; i++) armar(`paralelo-${i}`, PASAJERO, Date.now());
  let activos = 0;
  let maximo = 0;
  let iniciados = 0;
  const pendientes: Array<() => void> = [];
  const emisor = {
    enviar: () => {
      activos++;
      iniciados++;
      maximo = Math.max(maximo, activos);
      return new Promise<'enviado'>((resolver) => pendientes.push(() => { activos--; resolver('enviado'); }));
    },
  } as unknown as import('../src/push/fcm').EmisorFcm;
  const revision = avisos.revisarAvisos(emisor);
  while (iniciados < 40) {
    await new Promise<void>((resolver) => setImmediate(resolver));
    const tanda = pendientes.splice(0);
    for (const resolver of tanda) resolver();
  }
  await revision;
  assert.equal(maximo, 20);
});

test('el temporizador de avisos salta la vuelta si la anterior sigue activa', () => {
  const codigo = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  assert.match(codigo, /let avisoEnCurso = false;[\s\S]*?if \(avisoEnCurso\) return;/);
  assert.match(codigo, /\.finally\(\(\) => \{\s*avisoEnCurso = false;/);
});

// ── Las rutas ────────────────────────────────────────────────────────
test('POST /api/avisos valida todo y arma', async () => {
  limpiar();
  const bueno = { token: TOKEN, busId, routeId: RUTA, ...PASAJERO };
  for (const [malo, mensaje] of [
    [{ ...bueno, token: 'corto' }, 'token inválido'],
    [{ ...bueno, token: 'a b'.repeat(10) }, 'token inválido'],
    [{ ...bueno, lat: '10.98' }, 'lat y lon tienen que ser números'],
    [{ ...bueno, lat: 4.6, lon: -74.08 }, 'el punto está fuera de la zona de servicio'],
    [{ ...bueno, routeId: 'ruta con espacios' }, 'routeId inválido'],
    [{ ...bueno, vidaMs: -1 }, 'vidaMs tiene que ser un entero positivo'],
    [{ ...bueno, vidaMs: 1.5 }, 'vidaMs tiene que ser un entero positivo'],
    [{ ...bueno, radioM: 499 }, 'radioM tiene que ser un entero entre 500 y 3000'],
    [{ ...bueno, radioM: 3001 }, 'radioM tiene que ser un entero entre 500 y 3000'],
    [{ ...bueno, radioM: 750.5 }, 'radioM tiene que ser un entero entre 500 y 3000'],
    [{ ...bueno, radioM: '1000' }, 'radioM tiene que ser un entero entre 500 y 3000'],
  ] as const) {
    const r = await llamar('POST', '/api/avisos', malo);
    assert.equal(r.estado, 400, JSON.stringify(malo));
    assert.deepEqual(r.cuerpo.error, { code: 'INVALID_INPUT', message: mensaje });
  }
  assert.equal((await llamar('POST', '/api/avisos', { ...bueno, busId: 'BUS-NOEXISTE' })).estado, 404);
  assert.equal((await llamar('POST', '/api/avisos', { ...bueno, busId: busOculto })).estado, 404);
  assert.equal((await llamar('POST', '/api/avisos', { ...bueno, busId: 7 })).estado, 404);

  const creado = await llamar('POST', '/api/avisos', bueno);
  assert.equal(creado.estado, 201);
  assert.match(String(creado.cuerpo.id), /^[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(creado.cuerpo), ['id']);
  const { vence, creado: en } = getDb().prepare('SELECT vence, creado FROM avisos_push WHERE id = ?')
    .get(creado.cuerpo.id) as { vence: number; creado: number };
  assert.equal(vence - en, avisos.VIDA_MAXIMA_MS, 'sin vidaMs vive lo máximo');
  const radio = (id: unknown): number =>
    (getDb().prepare('SELECT radio_m FROM avisos_push WHERE id = ?').get(id) as { radio_m: number }).radio_m;
  // Una app de antes no manda radioM: su aviso sigue sonando a 1 km.
  assert.equal(radio(creado.cuerpo.id), 1000, 'sin radioM, el kilómetro de antes');
  for (const radioM of [500, 3000]) {
    const conRadio = await llamar('POST', '/api/avisos', { ...bueno, radioM });
    assert.equal(conRadio.estado, 201);
    assert.equal(radio(conRadio.cuerpo.id), radioM);
  }

  getDb().prepare(`
    INSERT INTO avisos_push (id, token, bus_id, route_id, lat, lon, creado, vence)
    VALUES ('tercero', ?, 'BUS-Y', ?, 0, 0, 0, 9e15), ('cuarto', ?, 'BUS-Z', ?, 0, 0, 0, 9e15)
  `).run(TOKEN, RUTA, TOKEN, RUTA);
  const tope = await llamar('POST', '/api/avisos', { ...bueno, busId: busId, token: TOKEN });
  assert.equal(tope.estado, 429);
  assert.equal((tope.cuerpo.error as { code: string }).code, 'DEMASIADOS_AVISOS');
  limpiar();
});

test('POST /api/avisos con la tabla llena responde 503', async () => {
  limpiar();
  const insertar = getDb().prepare(`
    INSERT INTO avisos_push (id, token, bus_id, route_id, lat, lon, creado, vence)
    VALUES (?, ?, 'B', 'R', 0, 0, 0, 9e15)
  `);
  getDb().transaction(() => {
    for (let i = 0; i < avisos.MAX_AVISOS; i += 1) insertar.run(`relleno-${i}`, `tok-${i}`);
  })();
  const r = await llamar('POST', '/api/avisos', { token: TOKEN, busId, routeId: RUTA, ...PASAJERO });
  assert.equal(r.estado, 503);
  assert.equal((r.cuerpo.error as { code: string }).code, 'AVISOS_LLENOS');
  limpiar();
});

// AUD29-02: con 120 por minuto, una sola IP llenaba las 10.000 filas en
// hora y media y dejaba sin avisos a todos. Armar tiene su propio cupo, que
// solo gastan los avisos que de verdad se arman (los inválidos no).
test('POST /api/avisos: una IP arma como mucho 30 avisos cada 10 minutos', async () => {
  limpiar();
  const armar = (i: number, ip: string) => fetch(`${base}/api/avisos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ token: `tok-ip-${i}-${'b'.repeat(30)}`, busId, routeId: RUTA, ...PASAJERO }),
  });
  for (let i = 0; i < 5; i += 1) {
    const malo = await fetch(`${base}/api/avisos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.7' },
      body: JSON.stringify({ token: 'x', busId, routeId: RUTA, ...PASAJERO }),
    });
    assert.equal(malo.status, 400);
  }
  for (let i = 0; i < MAX_AVISOS_ARMADOS_POR_IP; i += 1) {
    assert.equal((await armar(i, '198.51.100.7')).status, 201, `aviso ${i}`);
  }
  const tope = await armar(99, '198.51.100.7');
  assert.equal(tope.status, 429);
  assert.equal(((await tope.json()) as { error: { code: string } }).error.code, 'DEMASIADOS_AVISOS_IP');
  assert.equal((await armar(100, '198.51.100.8')).status, 201, 'otra IP no comparte el cupo');
  limpiar();
});

test('PUT y DELETE /api/avisos/:id', async () => {
  limpiar();
  const { cuerpo } = await llamar('POST', '/api/avisos', { token: TOKEN, busId, routeId: RUTA, ...PASAJERO, vidaMs: 60_000 });
  const id = String(cuerpo.id);
  const latido = { token: TOKEN, ...CERCA };

  assert.equal((await llamar('PUT', `/api/avisos/${id}`, latido)).estado, 204);
  assert.equal((await llamar('PUT', '/api/avisos/no-es-uuid', latido)).estado, 400);
  assert.equal((await llamar('PUT', `/api/avisos/${id}`, { ...latido, token: 'x' })).estado, 400);
  assert.equal((await llamar('PUT', '/api/avisos/00000000-0000-4000-8000-000000000000', latido)).estado, 404);

  avisos.marcarEnviado(id);
  const ya = await llamar('PUT', `/api/avisos/${id}`, latido);
  assert.equal(ya.estado, 410);
  assert.equal((ya.cuerpo.error as { code: string }).code, 'AVISO_ENVIADO');

  assert.equal((await llamar('DELETE', `/api/avisos/${id}`)).estado, 204);
  assert.equal((await llamar('DELETE', `/api/avisos/${id}`)).estado, 204, 'idempotente');
  assert.equal((await llamar('DELETE', '/api/avisos/no-es-uuid')).estado, 400);
  assert.equal((await llamar('PUT', `/api/avisos/${id}`, latido)).estado, 404);
});
