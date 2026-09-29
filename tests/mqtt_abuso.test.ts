// Auditoría 2026-09, P1-1: el MQTT por WebSocket (`/mqtt`, el canal público
// del equipo del bus) guardaba en memoria lo que le mandaran antes de pedir
// credenciales. El parser junta el paquete entero que anuncia la cabecera,
// hasta 256 MB, y el `maxPayload` de `ws` solo acota cada mensaje WebSocket,
// no el paquete MQTT. Un cliente anónimo subió el backend de 106 a 275 MB en
// 8 s, y no había tope de conexiones sin autenticar por dirección ni más
// plazo para el CONNECT que los 30 s de aedes.
//
// Aquí se exige, contra el backend de verdad:
// - un paquete que anuncia más del tope (16 KB) cierra la conexión en el
//   acto, sin esperar a que llegue;
// - los paquetes de tamaño normal siguen pasando;
// - una misma dirección tiene como mucho 20 conexiones abiertas sin
//   autenticar; la 21 recibe 429, y una que se cierra o se autentica deja
//   su sitio libre;
// - una conexión que no manda CONNECT se cierra a los 10 s, no a los 30.
//
// Los números son los de `src/mqtt/guardia.ts`; se repiten aquí a propósito,
// para que cambiarlos sea una decisión que también toca esta prueba.
//
// Puertos propios, HTTP 3260 y MQTT 9030: node --test corre los archivos en
// paralelo (el reparto de los demás está en arranque.test.ts).
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { after, before, test } from 'node:test';

import mqtt from 'mqtt';
import WebSocket from 'ws';

const HTTP_PORT = 3260;
const MQTT_PORT = 9030;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const URL_MQTT = `ws://127.0.0.1:${HTTP_PORT}/mqtt`;
const ADMIN_API_KEY = 'mqtt-abuso-admin-key';
const DB_PATH = `/tmp/yaviene-mqtt-abuso-${process.pid}-${Date.now()}.db`;

const TOPE_PAQUETE = 16 * 1024;
const ANONIMAS_POR_IP = 20;
const PLAZO_CONNECT_MS = 10_000;

let backend: ChildProcess;

async function esperarListo(): Promise<void> {
  const limite = Date.now() + 15_000;
  while (Date.now() < limite) {
    try {
      if ((await fetch(`${BASE}/api/ready`)).status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('el backend no llegó a estar listo');
}

function parar(hijo: ChildProcess): Promise<void> {
  if (hijo.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const matar = setTimeout(() => hijo.kill('SIGKILL'), 3000);
    hijo.once('exit', () => {
      clearTimeout(matar);
      resolve();
    });
    hijo.kill('SIGTERM');
  });
}

/** Abre un WebSocket a /mqtt sin mandar nada. Devuelve el socket, o el código HTTP con que se rechazó. */
function abrirCruda(): Promise<WebSocket | number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL_MQTT, 'mqtt');
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (req, res) => {
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    ws.once('error', reject);
  });
}

/** Si el servidor cierra el socket antes de `ms`. */
function cierraAntesDe(ws: WebSocket, ms: number): Promise<boolean> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve(true);
  return new Promise((resolve) => {
    const reloj = setTimeout(() => resolve(false), ms);
    ws.once('close', () => {
      clearTimeout(reloj);
      resolve(true);
    });
  });
}

/** Reintenta abrir hasta que entre: el cierre de otra tarda un momento en llegar al servidor. */
async function abrirCuandoHayaSitio(ms = 3000): Promise<WebSocket | number> {
  const limite = Date.now() + ms;
  let ultimo: WebSocket | number = 0;
  while (Date.now() < limite) {
    ultimo = await abrirCruda();
    if (ultimo instanceof WebSocket) return ultimo;
    await new Promise((r) => setTimeout(r, 100));
  }
  return ultimo;
}

/** Largo restante MQTT (entero de longitud variable, 1 a 4 bytes). */
function largoMqtt(n: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    bytes.push(byte);
  } while (n > 0);
  return bytes;
}

async function tokenDeConductor(): Promise<string> {
  const phoneNumber = '3007770001';
  const alta = await fetch(`${BASE}/api/admin/drivers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_API_KEY },
    body: JSON.stringify({
      phoneNumber, name: 'Equipo WS', pin: '2468', companyId: 'EMP-01', busId: 'B-MQTTWS', routeId: 'R-101',
    }),
  });
  assert.equal(alta.status, 201);
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phoneNumber, pin: '2468' }),
  });
  assert.equal(login.status, 200);
  return ((await login.json()) as { token: string }).token;
}

before(async () => {
  backend = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      HTTP_PORT: String(HTTP_PORT),
      MQTT_PORT: String(MQTT_PORT),
      JWT_SECRET: 'mqtt-abuso-jwt-secret',
      ADMIN_API_KEY,
      MQTT_DEBUG_LOGS: 'false',
      YA_VIENE_FLOTA_DEMO: '0',
      YA_VIENE_DB_PATH: DB_PATH,
    },
    stdio: 'ignore',
  });
  await esperarListo();
});

after(async () => {
  await parar(backend);
  for (const sufijo of ['', '-wal', '-shm']) rmSync(`${DB_PATH}${sufijo}`, { force: true });
});

test('mqtt: una dirección no tiene más de 20 conexiones abiertas sin autenticar', { timeout: 30_000 }, async () => {
  const abiertas: WebSocket[] = [];
  let conductor: mqtt.MqttClient | undefined;
  try {
    for (let i = 1; i <= ANONIMAS_POR_IP; i++) {
      const ws = await abrirCruda();
      assert.ok(ws instanceof WebSocket, `la conexión ${i} entra`);
      abiertas.push(ws);
    }
    assert.equal(await abrirCruda(), 429, `la ${ANONIMAS_POR_IP + 1} se rechaza antes del WebSocket`);

    // Una que se cierra deja su sitio.
    abiertas.pop()!.terminate();
    const otra = await abrirCuandoHayaSitio();
    assert.ok(otra instanceof WebSocket, 'al cerrarse una, entra otra');
    abiertas.push(otra);

    // Una que se autentica deja de contar como anónima: con 19 abiertas, el
    // equipo entra, y después todavía cabe una anónima más.
    abiertas.pop()!.terminate();
    const token = await tokenDeConductor();
    conductor = await new Promise<mqtt.MqttClient>((resolve, reject) => {
      const intentar = (quedan: number) => {
        const c = mqtt.connect(URL_MQTT, {
          username: '', password: token, clientId: 'equipo-ws', reconnectPeriod: 0, connectTimeout: 5000,
        });
        c.once('connect', () => resolve(c));
        c.once('error', (e) => {
          c.end(true);
          // El cierre de la anterior puede no haber llegado aún al servidor.
          if (quedan > 0) setTimeout(() => intentar(quedan - 1), 200);
          else reject(e);
        });
      };
      intentar(10);
    });
    const vigesima = await abrirCruda();
    assert.ok(vigesima instanceof WebSocket, 'la conexión autenticada no ocupa sitio de anónima');
    abiertas.push(vigesima);
    assert.equal(await abrirCruda(), 429);
  } finally {
    conductor?.end(true);
    for (const ws of abiertas) ws.terminate();
  }
  // Que la siguiente prueba encuentre sitio.
  const libre = await abrirCuandoHayaSitio();
  assert.ok(libre instanceof WebSocket);
  libre.terminate();
});

test('mqtt: un paquete que anuncia más de 16 KB cierra la conexión sin esperar a que llegue', { timeout: 20_000 }, async () => {
  for (const cabecera of [
    // CONNECT que anuncia ~200 MB: el caso de la auditoría.
    [0x10, 0xff, 0xff, 0xff, 0x5f],
    // PUBLISH de un byte más que el tope.
    [0x30, ...largoMqtt(TOPE_PAQUETE + 1)],
  ]) {
    const ws = await abrirCuandoHayaSitio();
    assert.ok(ws instanceof WebSocket);
    const cerrada = cierraAntesDe(ws, 2000);
    ws.send(Buffer.from(cabecera));
    // Relleno detrás, como haría quien quiere llenar la memoria. El servidor
    // no tiene que esperarlo para cortar.
    const trozo = Buffer.alloc(16 * 1024, 0x41);
    for (let i = 0; i < 16 && ws.readyState === WebSocket.OPEN; i++) ws.send(trozo);
    assert.equal(await cerrada, true, `la cabecera ${Buffer.from(cabecera).toString('hex')} cierra la conexión`);
  }
});

test('mqtt: los paquetes de tamaño normal siguen llegando a la autenticación', { timeout: 20_000 }, async () => {
  // Un CONNECT con una contraseña de 2 KB (un JWT real ronda 400 bytes) pasa
  // la guardia y llega a aedes, que lo rechaza por credenciales, no por tamaño.
  const error = await new Promise<Error & { code?: number }>((resolve) => {
    const c = mqtt.connect(URL_MQTT, {
      username: '', password: 'x'.repeat(2048), clientId: 'sin-token', reconnectPeriod: 0, connectTimeout: 5000,
    });
    c.once('connect', () => {
      c.end(true);
      resolve(new Error('entró sin token'));
    });
    c.once('error', (e) => {
      c.end(true);
      resolve(e as Error & { code?: number });
    });
  });
  assert.equal(error.code, 5, `CONNACK «no autorizado», no un corte: ${error.message}`);
});

test('mqtt: una conexión que no manda CONNECT se cierra a los 10 s', { timeout: 30_000 }, async () => {
  const ws = await abrirCuandoHayaSitio();
  assert.ok(ws instanceof WebSocket);
  const inicio = Date.now();
  const cerrada = await cierraAntesDe(ws, PLAZO_CONNECT_MS + 3000);
  ws.terminate();
  assert.equal(cerrada, true, `sigue abierta ${Date.now() - inicio} ms después sin CONNECT`);
});

test('mqtt: cada corte queda contado en /api/metrics', async () => {
  // Las pruebas de arriba rechazaron dos 429 y cortaron dos paquetes
  // grandes: quien mire las métricas tiene que poder ver que alguien lo
  // está intentando.
  const res = await fetch(`${BASE}/api/metrics`, { headers: { 'x-admin-key': ADMIN_API_KEY } });
  assert.equal(res.status, 200);
  const { counters } = (await res.json()) as { counters: Record<string, number> };
  assert.ok((counters['mqtt.rechazado.anonimas_ip'] ?? 0) >= 2, JSON.stringify(counters));
  assert.ok((counters['mqtt.rechazado.paquete_grande'] ?? 0) >= 2, JSON.stringify(counters));
});
