// El contrato entre el backend y las apps, escrito en archivos (T8.5).
//
// Las apps leen lo que el backend manda por REST y por el socket, y hasta
// ahora cada lado probaba contra la forma que creía que tenía el otro: los
// mapas de las pruebas de Flutter los escribía a mano quien escribía la
// prueba. Aquí se levanta el backend de verdad, sobre una base temporal, y se
// guarda lo que sale por cada puerta que usan el pasajero y el panel en
// `tests/fixtures/contrato/`. Las pruebas de Flutter parsean esos mismos
// archivos (`tool/sincronizar-contrato.sh` los copia a ya_viene_core).
//
// Lo que cambia de corrida a corrida (horas, tokens, eventId) se reemplaza
// por un valor fijo del mismo tipo antes de comparar. Si la forma cambia, la
// prueba falla; si el cambio es a propósito, se regeneran con
// `npm run contrato:actualizar` y se copian a las apps.
//
// Puertos propios, HTTP 3230 y MQTT 9010: node --test corre los archivos en
// paralelo. El FCM falso (D13) toma el que le dé el sistema.
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import mqtt, { MqttClient } from 'mqtt';
import { io, Socket } from 'socket.io-client';

const HTTP_PORT = 3230;
const MQTT_PORT = 9010;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const EMPRESA = 'EMP-01';
const RUTA = 'R-101';
const CARPETA = join(__dirname, 'fixtures', 'contrato');
const ACTUALIZAR = process.env.ACTUALIZAR_CONTRATO === '1';

// Valores fijos para lo que cambia en cada corrida. Mismo tipo que el real:
// quien parsea tiene que poder leerlos igual.
const INSTANTE_MS = 1_767_225_600_000; // 2026-01-01T00:00:00Z
const INSTANTE_ISO = new Date(INSTANTE_MS).toISOString();
const FIJOS: Record<string, unknown> = {
  capturedAt: INSTANTE_MS,
  receivedAt: INSTANTE_MS,
  emittedAt: INSTANTE_MS,
  timestamp: INSTANTE_ISO,
  token: '<token>',
  eventId: '<eventId>',
};

function normalizar(valor: unknown): unknown {
  if (Array.isArray(valor)) {
    const lista = valor.map(normalizar);
    // El orden de un lote es el de llegada; lo que importa es qué trae.
    if (lista.every((x) => typeof (x as { busId?: unknown })?.busId === 'string')) {
      lista.sort((a, b) => String((a as { busId: string }).busId)
        .localeCompare(String((b as { busId: string }).busId)));
    }
    return lista;
  }
  if (valor && typeof valor === 'object') {
    return Object.fromEntries(Object.entries(valor).map(([k, v]) => [
      k,
      k in FIJOS && v !== null && v !== undefined ? FIJOS[k] : normalizar(v),
    ]));
  }
  return valor;
}

/** Los objetos de bus de un payload: los que traen `capturedAt`. */
function objetosDeBus(valor: unknown): Record<string, unknown>[] {
  if (Array.isArray(valor)) return valor.flatMap(objetosDeBus);
  if (valor && typeof valor === 'object') {
    const obj = valor as Record<string, unknown>;
    const hijos = Object.values(obj).flatMap(objetosDeBus);
    return 'capturedAt' in obj ? [obj, ...hijos] : hijos;
  }
  return [];
}

/** Busca una clave en cualquier nivel del payload. */
function tieneClave(valor: unknown, clave: string): boolean {
  if (Array.isArray(valor)) return valor.some((x) => tieneClave(x, clave));
  if (valor && typeof valor === 'object') {
    return Object.entries(valor).some(([k, v]) => k === clave || tieneClave(v, clave));
  }
  return false;
}

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/api/ready`)).status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Backend did not become ready');
}

function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once('exit', finish);
    child.kill('SIGTERM');
    setTimeout(() => {
      child.kill('SIGKILL');
      finish();
    }, 3000);
  });
}

/** Un socket que guarda todo lo que recibe, para esperarlo por nombre. */
class Oyente {
  readonly socket: Socket;
  private recibidos: { evento: string; datos: unknown }[] = [];
  private esperas: { evento: string; resolver: (d: unknown) => void }[] = [];

  constructor(readonly nombre: string, auth?: Record<string, string>) {
    this.socket = io(BASE, {
      path: '/ws',
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth,
    });
    this.socket.onAny((evento: string, datos: unknown) => {
      const i = this.esperas.findIndex((e) => e.evento === evento);
      if (i >= 0) {
        this.esperas.splice(i, 1)[0].resolver(datos);
        return;
      }
      this.recibidos.push({ evento, datos });
    });
  }

  conectado(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket.connected) return resolve();
      this.socket.once('connect', () => resolve());
      this.socket.once('connect_error', reject);
    });
  }

  /** El siguiente `evento` (o uno que ya llegó y nadie pidió). */
  siguiente(evento: string, ms = 5000): Promise<unknown> {
    const i = this.recibidos.findIndex((r) => r.evento === evento);
    if (i >= 0) return Promise.resolve(this.recibidos.splice(i, 1)[0].datos);
    return new Promise((resolve, reject) => {
      const espera = { evento, resolver: (d: unknown) => {
        clearTimeout(reloj);
        resolve(d);
      } };
      const reloj = setTimeout(() => {
        this.esperas.splice(this.esperas.indexOf(espera), 1);
        reject(new Error(`Al ${this.nombre} no le llegó ${evento} en ${ms} ms`));
      }, ms);
      this.esperas.push(espera);
    });
  }

  olvidar(): void {
    this.recibidos = [];
  }
}

interface Equipo {
  busId: string;
  telefono: string;
  token: string;
  cliente?: MqttClient;
  secuencia: number;
}

function conectar(equipo: Equipo): Promise<void> {
  return new Promise((resolve, reject) => {
    const cliente = mqtt.connect(`mqtt://127.0.0.1:${MQTT_PORT}`, {
      clientId: `contrato_${equipo.busId}`,
      username: equipo.telefono,
      password: equipo.token,
      reconnectPeriod: 0,
    });
    cliente.once('connect', () => {
      equipo.cliente = cliente;
      cliente.subscribe(`empresa/${EMPRESA}/bus/${equipo.busId}/ack`, { qos: 1 }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    cliente.once('error', reject);
  });
}

/** Publica una posición y espera a que el backend diga que la aceptó. */
function publicar(
  equipo: Equipo,
  lat: number,
  lon: number,
  capturedAt = Date.now(),
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cliente = equipo.cliente!;
    const alAck = (topic: string, payload: Buffer) => {
      if (!topic.endsWith('/ack')) return;
      cliente.off('message', alAck);
      const ack = JSON.parse(payload.toString()) as { accepted?: boolean; reason?: string };
      if (ack.accepted === false) reject(new Error(`posición rechazada: ${ack.reason}`));
      else resolve();
    };
    cliente.on('message', alAck);
    cliente.publish(`empresa/${EMPRESA}/bus/${equipo.busId}/posicion`, JSON.stringify({
      protocolVersion: 1,
      lat,
      lon,
      heading: 90,
      speedKmh: 25,
      sentido: 'ida',
      capturedAt,
      sequence: ++equipo.secuencia,
    }));
  });
}

test('lo que el backend manda a las apps tiene la forma guardada', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yaviene-contrato-'));
  const DB_PATH = join(dir, 'contrato.db');
  const JWT_SECRET = randomBytes(32).toString('hex');
  // Una cuenta de panel de usar y tirar para esta base; no es de nadie.
  const USUARIO = `contrato-${randomBytes(4).toString('hex')}`;
  const CLAVE = randomBytes(18).toString('base64url');
  process.env.YA_VIENE_DB_PATH = DB_PATH;
  process.env.JWT_SECRET = JWT_SECRET;

  // Dos buses con placa en la misma ruta, y un equipo GPS en cada uno.
  const { getDb, closeDb } = await import('../src/data/database');
  const { createBus } = await import('../src/data/fleet_admin');
  const { registerDriver } = await import('../src/data/drivers_store');
  const { createDeviceSession } = await import('../src/data/sessions');
  const { signToken } = await import('../src/auth/tokens');
  const { createOrUpdateCompanyAdmin } = await import('../src/data/empresas');
  const { hashSecret } = await import('../src/auth/passwords');
  getDb();
  createOrUpdateCompanyAdmin(EMPRESA, USUARIO, hashSecret(CLAVE));
  const equipos: Equipo[] = ['ABC123', 'DEF456'].map((placa, i) => {
    const bus = createBus(EMPRESA, placa, RUTA, String(i + 1).padStart(3, '0'));
    if (typeof bus === 'string') throw new Error(`alta de ${placa}: ${bus}`);
    const telefono = `399000000${i + 1}`;
    registerDriver(telefono, `Conductor ${i + 1}`, RUTA, { companyId: EMPRESA, busId: bus.busId });
    const sessionId = randomUUID();
    createDeviceSession({
      sessionId, deviceId: telefono, identifier: telefono,
      companyId: EMPRESA, busId: bus.busId, routeId: RUTA,
    });
    const token = signToken({
      sub: telefono, deviceId: telefono, identifier: telefono, role: 'device',
      companyId: EMPRESA, busId: bus.busId, routeId: RUTA, sessionId,
    });
    return { busId: bus.busId, telefono, token, secuencia: 0 };
  });
  closeDb();
  const [uno, dos] = equipos;

  // Un FCM falso en este proceso: da un token de acceso a quien lo pida y
  // guarda los mensajes que el backend manda, que son lo que la app recibe
  // con la app cerrada (D13). La cuenta de servicio es de usar y tirar.
  const mensajesPush: unknown[] = [];
  let alPush: (() => void) | null = null;
  const fcm = createServer((req, res) => {
    let cuerpo = '';
    req.on('data', (parte) => { cuerpo += parte; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/token') {
        res.end(JSON.stringify({ access_token: 'acceso-falso', expires_in: 3600 }));
        return;
      }
      mensajesPush.push((JSON.parse(cuerpo) as { message: unknown }).message);
      alPush?.();
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => fcm.listen(0, '127.0.0.1', resolve));
  const FCM = `http://127.0.0.1:${(fcm.address() as AddressInfo).port}`;
  const CREDENCIALES = join(dir, 'fcm-credenciales.json');
  writeFileSync(CREDENCIALES, JSON.stringify({
    project_id: 'contrato',
    client_email: 'contrato@contrato.iam.gserviceaccount.com',
    private_key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
      .export({ type: 'pkcs8', format: 'pem' }),
    token_uri: `${FCM}/token`,
  }));

  const backend = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      HTTP_PORT: String(HTTP_PORT),
      MQTT_PORT: String(MQTT_PORT),
      JWT_SECRET,
      ADMIN_API_KEY: randomBytes(24).toString('hex'),
      MQTT_DEBUG_LOGS: 'false',
      YA_VIENE_FLOTA_DEMO: '0',
      YA_VIENE_DB_PATH: DB_PATH,
      YA_VIENE_FCM_CREDENCIALES: CREDENCIALES,
      YA_VIENE_FCM_API: FCM,
    },
    stdio: 'ignore',
  });
  const sockets: Oyente[] = [];
  const oyente = (nombre: string, auth?: Record<string, string>) => {
    const o = new Oyente(nombre, auth);
    sockets.push(o);
    return o;
  };
  const capturas = new Map<string, unknown>();
  const guardar = (nombre: string, datos: unknown) => capturas.set(nombre, normalizar(datos));

  try {
    await waitForReady();

    const pedir = async (metodo: string, ruta: string, cuerpo?: unknown, token?: string) => {
      const respuesta = await fetch(`${BASE}${ruta}`, {
        method: metodo,
        headers: {
          ...(cuerpo === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
      });
      assert.ok(respuesta.ok, `${metodo} ${ruta} respondió ${respuesta.status}`);
      return respuesta.json() as Promise<unknown>;
    };

    // ── Panel: entrar ─────────────────────────────────────────────────
    const login = await pedir('POST', '/api/admin/login', { username: USUARIO, password: CLAVE }) as {
      token: string;
    };
    guardar('rest-admin-login', login);
    const admin = login.token;

    const pasajero = oyente('pasajero');
    const panel = oyente('panel', { token: admin });
    await Promise.all([pasajero.conectado(), panel.conectado()]);
    pasajero.socket.emit('subscribe:route', RUTA);
    await pasajero.siguiente('positions:batch');
    panel.socket.emit('subscribe:fleet');
    await panel.siguiente('fleet:batch');

    // Los buses nacen ocultos; el panel los deja ver a todos de una vez. Sin
    // posición todavía, el aviso no tiene ruta: le llega al panel y a ningún
    // pasajero. Se esperan los dos para que no se confundan con los de más
    // abajo.
    guardar('rest-fleet-visibility-all',
      await pedir('POST', '/api/fleet/buses/visibility', { visible: true }, admin));
    const avisos = [await panel.siguiente('bus:visible'), await panel.siguiente('bus:visible')];
    // Salen en cualquier orden; se guarda siempre el del mismo bus.
    guardar('socket-panel-bus-visible-sin-posicion',
      avisos.find((a) => (a as { busId?: string }).busId === uno.busId));
    pasajero.olvidar();
    panel.olvidar();

    // ── Un bus publica ────────────────────────────────────────────────
    await Promise.all(equipos.map(conectar));
    // Cinco segundos antes: el segundo punto queda a 30 m, y a esa distancia
    // en milisegundos el backend lo rechazaría por velocidad imposible.
    await publicar(uno, 10.9878, -74.7889, Date.now() - 5000);
    guardar('socket-pasajero-bus-position', await pasajero.siguiente('bus:position'));
    const posicionPanel = await panel.siguiente('bus:position');
    guardar('socket-panel-bus-position', posicionPanel);

    // ── Los dos en la misma ventana: el pasajero los recibe en lote ───
    await Promise.all([publicar(uno, 10.9880, -74.7887), publicar(dos, 10.9890, -74.7900)]);
    guardar('socket-pasajero-positions-update', await pasajero.siguiente('positions:update'));
    await panel.siguiente('bus:position');
    await panel.siguiente('bus:position');

    // ── Quien llega después recibe la foto ────────────────────────────
    const tarde = oyente('pasajero que llega tarde');
    await tarde.conectado();
    tarde.socket.emit('subscribe:route', RUTA);
    guardar('socket-pasajero-positions-batch', await tarde.siguiente('positions:batch'));
    panel.socket.emit('subscribe:fleet');
    guardar('socket-panel-fleet-batch', await panel.siguiente('fleet:batch'));

    // ── REST que leen las apps ────────────────────────────────────────
    guardar('rest-companies', await pedir('GET', '/api/companies'));
    guardar('rest-company-routes', await pedir('GET', `/api/companies/${EMPRESA}/routes`));
    guardar('rest-route-positions', await pedir('GET', `/api/routes/${RUTA}/positions`));
    const busqueda = await fetch(`${BASE}/api/busquedas`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ routeId: RUTA, celda: { lat: 10.99035, lng: -74.78967 } }),
    });
    assert.equal(busqueda.status, 204);
    guardar('rest-busqueda-registrada', { status: busqueda.status });
    guardar('rest-fleet-positions', await pedir('GET', '/api/fleet/positions', undefined, admin));
    guardar('rest-fleet-routes', await pedir('GET', '/api/fleet/routes', undefined, admin));

    // ── Aviso con la app cerrada (D13) ────────────────────────────────
    // El pasajero espera a unos 300 m del bus y pidió el aviso a 500 m, la
    // distancia más corta que deja elegir la app. El servidor lo revisa cada
    // 5 s; el mensaje llega al FCM falso en la vuelta siguiente.
    const llegoPush = new Promise<void>((resolve, reject) => {
      const reloj = setTimeout(() => reject(new Error('el push no llegó en 12 s')), 12_000);
      alPush = () => {
        clearTimeout(reloj);
        resolve();
      };
    });
    const aviso = await pedir('POST', '/api/avisos', {
      token: 'fcm-token-del-contrato-0123456789',
      busId: uno.busId,
      routeId: RUTA,
      lat: 10.9907,
      lon: -74.7887,
      radioM: 500,
    }) as { id: string };
    guardar('rest-aviso-creado', { ...aviso, id: '<avisoId>' });
    await llegoPush;
    const mensaje = mensajesPush[0] as { data: Record<string, string> };
    assert.equal(mensaje.data.avisoId, aviso.id);
    guardar('push-bus-cerca', { ...mensaje, data: { ...mensaje.data, avisoId: '<avisoId>' } });
    // El latido que llega después del push: la app se entera de que el
    // servidor ya avisó y no avisa otra vez.
    const tarde410 = await fetch(`${BASE}/api/avisos/${aviso.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'fcm-token-del-contrato-0123456789', lat: 10.9907, lon: -74.7887 }),
    });
    assert.equal(tarde410.status, 410);
    guardar('rest-aviso-enviado', await tarde410.json());
    assert.equal(mensajesPush.length, 1, 'el aviso se mandó más de una vez');

    // ── Ocultar y volver a mostrar un bus ─────────────────────────────
    guardar('rest-fleet-visibility',
      await pedir('POST', `/api/fleet/buses/${uno.busId}/visibility`, { visible: false }, admin));
    guardar('socket-pasajero-bus-hidden', await pasajero.siguiente('bus:hidden'));
    guardar('socket-panel-bus-hidden', await panel.siguiente('bus:hidden'));
    await pedir('POST', `/api/fleet/buses/${uno.busId}/visibility`, { visible: true }, admin);
    guardar('socket-pasajero-bus-visible', await pasajero.siguiente('bus:visible'));
    guardar('socket-panel-bus-visible', await panel.siguiente('bus:visible'));

    // ── Alta y edición de un bus desde el panel ───────────────────────
    const alta = await pedir('POST', '/api/fleet/buses', { placa: 'XYZ987', routeId: 'R-102', interno: '' }, admin) as {
      busId: string;
    };
    guardar('rest-fleet-bus-created', alta);
    guardar('rest-fleet-bus-updated',
      await pedir('PATCH', `/api/fleet/buses/${alta.busId}`, { interno: '77' }, admin));

    // ── El equipo del bus se despide ──────────────────────────────────
    await pedir('POST', `/api/buses/${uno.busId}/offline`, undefined, uno.token);
    guardar('socket-pasajero-bus-left', await pasajero.siguiente('bus:left'));
    guardar('socket-panel-bus-left', await panel.siguiente('bus:left'));

    // ── El panel borra un bus ─────────────────────────────────────────
    await pedir('DELETE', `/api/fleet/buses/${dos.busId}`, undefined, admin);
    guardar('socket-pasajero-bus-removed', await pasajero.siguiente('bus:removed'));
    guardar('socket-panel-bus-removed', await panel.siguiente('bus:removed'));

    // ── Reglas que el contrato no puede perder ────────────────────────
    for (const [nombre, datos] of capturas) {
      if (!nombre.startsWith('socket-pasajero-') && !nombre.startsWith('rest-route')) continue;
      // El pasajero no ve con qué teléfono publica el equipo ni de qué
      // empresa es el bus.
      assert.equal(tieneClave(datos, 'driverPhone'), false, `${nombre} trae driverPhone`);
      assert.equal(tieneClave(datos, 'companyId'), false, `${nombre} trae companyId`);
    }
    // T7.6: todo bus que sale por el socket dice cuándo salió. Con eso la
    // app mide lo que tardó en llegarle sin tener que creerle al reloj del
    // equipo que capturó la posición.
    for (const [nombre, datos] of capturas) {
      if (!nombre.startsWith('socket-')) continue;
      const buses = objetosDeBus(datos);
      for (const bus of buses) {
        assert.equal(typeof bus.emittedAt, 'number', `${nombre} sin emittedAt`);
      }
    }
    // Las posiciones en vivo son las que importan: que ninguna se escape.
    for (const nombre of [
      'socket-pasajero-bus-position',
      'socket-pasajero-positions-update',
      'socket-pasajero-positions-batch',
      'socket-panel-bus-position',
      'socket-panel-fleet-batch',
    ]) {
      assert.ok(objetosDeBus(capturas.get(nombre)).length > 0, `${nombre} sin buses`);
    }

    // T1.1: la posición del panel es la posición y nada más; la placa sale
    // del catálogo (fleet:batch o REST) y el panel la fusiona.
    assert.equal(tieneClave(posicionPanel, 'placa'), false);
    for (const nombre of ['socket-panel-fleet-batch', 'rest-fleet-positions']) {
      const { buses } = capturas.get(nombre) as { buses: { placa?: unknown }[] };
      assert.ok(buses.length >= 2);
      for (const bus of buses) assert.equal(typeof bus.placa, 'string', `${nombre} sin placa`);
    }

    // ── Comparar con lo guardado ──────────────────────────────────────
    if (ACTUALIZAR) {
      rmSync(CARPETA, { recursive: true, force: true });
      mkdirSync(CARPETA, { recursive: true });
      for (const [nombre, datos] of capturas) {
        writeFileSync(join(CARPETA, `${nombre}.json`), `${JSON.stringify(datos, null, 2)}\n`);
      }
      return;
    }
    assert.ok(existsSync(CARPETA), 'Faltan los fixtures: npm run contrato:actualizar');
    assert.deepEqual(
      readdirSync(CARPETA).filter((f) => f.endsWith('.json')).sort(),
      [...capturas.keys()].map((n) => `${n}.json`).sort(),
    );
    for (const [nombre, datos] of capturas) {
      const guardado = JSON.parse(readFileSync(join(CARPETA, `${nombre}.json`), 'utf8'));
      assert.deepEqual(datos, guardado,
        `${nombre} cambió de forma; si es a propósito: npm run contrato:actualizar`);
    }
  } finally {
    for (const o of sockets) o.socket.close();
    for (const e of equipos) e.cliente?.end(true);
    await stopProcess(backend);
    await new Promise((resolve) => fcm.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
