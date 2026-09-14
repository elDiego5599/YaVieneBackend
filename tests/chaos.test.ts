import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import test from 'node:test';
import net from 'node:net';

import Database from 'better-sqlite3';
import { io, Socket } from 'socket.io-client';
import mqtt from 'mqtt';

interface Ctx {
  httpPort: number;
  mqttPort: number;
  dbName: string;
}

const ADMIN_API_KEY = 'chaos-admin-key';
const JWT_SECRET = 'chaos-jwt-secret';

let backend: ChildProcess | undefined;
let ctx: Ctx = { httpPort: 3130, mqttPort: 8900, dbName: 'x' };
const healthUrl = (): string => `http://127.0.0.1:${ctx.httpPort}/api/health`;
const dbPathFor = (file: string): string => `/tmp/yaviene-chaos-${file}-${process.pid}.db`;

async function waitForReady(ctx: Ctx): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.httpPort}/api/ready`);
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Backend did not become ready');
}

function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return Promise.resolve();
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
    }, 2500);
  });
}

async function withBackend(file: string, httpPort: number, mqttPort: number, fn: () => Promise<void>, timeoutMs = 60_000, env: Record<string, string> = {}): Promise<void> {
  ctx = { httpPort, mqttPort, dbName: file };
  backend = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      HTTP_PORT: String(httpPort),
      MQTT_PORT: String(mqttPort),
      JWT_SECRET,
      ADMIN_API_KEY,
      MQTT_DEBUG_LOGS: 'false',
      // Los buses de demostración son del backend de verdad, no de un
      // test: doce simuladores publicando encima de este vuelven ruido
      // cada aserción sobre la flota.
      YA_VIENE_FLOTA_DEMO: '0',
      YA_VIENE_DB_PATH: dbPathFor(file),
      YA_VIENE_GHOST_MS: '2000',
      ...env,
    },
    stdio: 'ignore',
  });
  try {
    await waitForReady(ctx);
    await withTimeout(fn(), timeoutMs);
  } finally {
    const child = backend;
    backend = undefined;
    await stopProcess(child);
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout de teste de ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}

function waitForSocketEvent(
  socket: Socket,
  event: string,
  predicate: (payload: any) => boolean,
  timeoutMs = 15_000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Timed out waiting for Socket.io event ${event}`));
    }, timeoutMs);
    const listener = (payload: any) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(payload);
    };
    socket.on(event, listener);
  });
}

async function esperar<T>(leer: () => T | undefined, ms: number, que: string): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const valor = leer();
    if (valor !== undefined) return valor;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out esperando ${que}`);
}

test('basura en el puerto MQTT no tumba el broker y el cliente real sigue entrando', async () => {
  await withBackend('garbage', 3131, 8901, async () => {
    const garbage = Buffer.from([0x10, 0x80, 0xff, 0x00, 0x01, 0xde, 0xad, 0xbe, 0xef, 0x00]);
    await new Promise<void>((resolve) => {
      const sock = net.connect(ctx.mqttPort, '127.0.0.1');
      sock.on('error', () => {});
      sock.on('connect', () => {
        sock.write(garbage);
        sock.write('GET / HTTP/1.1\r\n\r\n'.substring(0, 40));
        setTimeout(() => {
          sock.destroy();
          resolve();
        }, 400);
      });
    });

    const health = await fetch(healthUrl());
    assert.equal(health.status, 200);

    const provision = await fetch(`http://127.0.0.1:${ctx.httpPort}/api/admin/drivers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_API_KEY },
      body: JSON.stringify({ phoneNumber: '3000000001', name: 'Survivor', pin: '2468', companyId: 'EMP-01', busId: 'B-SOBRE-VIVE', routeId: 'R-101' }),
    });
    assert.equal(provision.status, 201);
  });
});

test('payloads corruptos por MQTT: basura, NaN, velocidad 999, teleportacion y reloj del futuro', async () => {
  await withBackend('malformed', 3132, 8902, async () => {
    const phone = '3000000002';
    await fetch(`http://127.0.0.1:${ctx.httpPort}/api/admin/drivers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_API_KEY },
      body: JSON.stringify({ phoneNumber: phone, name: 'Garbage Thrower', pin: '2468', companyId: 'EMP-01', busId: 'B-BASURA', routeId: 'R-101' }),
    });
    const login = await fetch(`http://127.0.0.1:${ctx.httpPort}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phoneNumber: phone, pin: '2468' }),
    });
    const { token } = (await login.json()) as { token: string };
    const client = await connectDriver(token, 'chaos-thrower');

    const topic = 'empresa/EMP-01/bus/B-BASURA/posicion';
    const cases: Array<Record<string, unknown>> = [
      { lat: 10.94, lon: -74.78, speedKmh: 999999, capturedAt: Date.now() },
      { lat: 10.94, lon: -74.78, speedKmh: 0, capturedAt: Date.now() + 60_000 },
      { lat: 10.94, lon: -74.78, speedKmh: -5, capturedAt: Date.now() },
      { lat: 'diez', lon: -74.78, speedKmh: 30, capturedAt: Date.now() },
      { lat: 10.94 + 0.5, lon: -74.78 + 0.5, speedKmh: 30, capturedAt: Date.now() },
      JSON.parse('{"lat":10.94,"lon":-74.78,"speedKmh":30}'),
    ];
    for (const payload of cases) {
      client.publish(topic, JSON.stringify(payload));
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    client.publish(topic, 'esto no es json {{');
    await new Promise((resolve) => setTimeout(resolve, 150));

    const health = await fetch(healthUrl());
    assert.equal(health.status, 200);
    client.end(true);
  });
});

test('DAST-lite: SQLi/XSS/JSON gigante/verbos raros nunca producen 5xx', async () => {
  await withBackend('dast', 3133, 8903, async () => {
    const probes: Array<[string, string, string | null]> = [
      ['POST', '/api/admin/login', JSON.stringify({ username: "' OR 1=1 --", password: "' OR '1'='1" })],
      ['POST', '/api/admin/login', JSON.stringify({ username: '<script>alert(1)</script>', password: String({ a: 1 }) })],
      ['POST', '/api/auth/login', '{"phoneNumber":"3000000000!","pin":"1234"}'],
      ['POST', '/api/auth/login', '{'.repeat(500_000)],
      ['POST', '/api/fleet/buses', JSON.stringify({ companyId: '$ne', routeId: "''" })],
      ['GET', `/api/company/routes?companyId=${encodeURIComponent("EMP-01' OR 1=1")}`, null],
      ['GET', `/api/drivers/${encodeURIComponent('../../etc/passwd')}`, null],
      ['PATCH', '/api/health', JSON.stringify({ x: 1 })],
    ];
    for (const [method, path, body] of probes) {
      const init: RequestInit = { method };
      if (body !== null) {
        init.headers = { 'content-type': 'application/json' };
        init.body = body;
      }
      // El cuerpo de 500 KB cortaba la conexion (socket reset) y el cliente
      // veia un error de red en vez de una respuesta. Ahora sale el 413 con
      // su JSON y el socket se cierra despues: si vuelve a lanzar, el
      // arreglo se deshizo y este test lo dice.
      const response = await fetch(`http://127.0.0.1:${ctx.httpPort}${path}`, init);
      assert.ok(response.status < 500, `${method} ${path} exploto con ${response.status} en vez de 4xx`);
      if (body !== null && body.length > 32 * 1024) {
        assert.equal(response.status, 413, `${method} ${path} deberia responder 413`);
        const payload = await response.json() as { error?: { code?: string } };
        assert.equal(payload.error?.code, 'REQUEST_TOO_LARGE');
      }
    }
    const health = await fetch(healthUrl());
    assert.equal(health.status, 200);
  });
});

test('reinicio del backend en plena sesion: el cliente socket se auto-recupera', async () => {
  await withBackend('restart', 3134, 8904, async () => {
    const socket = io(`http://127.0.0.1:${ctx.httpPort}`, {
      path: '/ws',
      transports: ['websocket'],
      autoConnect: false,
    });
    socket.connect();
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    socket.emit('subscribe:route', 'R-101');

    await stopProcess(backend);
    backend = undefined;
    await spawnBackendOnly();
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 20_000;
      const poller = setInterval(() => {
        if (socket.connected) {
          clearInterval(poller);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(poller);
          reject(new Error('socket no se reconecto'));
        }
      }, 100);
    });

    const batch = waitForSocketEvent(socket, 'positions:batch', () => true, 10_000);
    socket.emit('subscribe:route', 'R-101');
    await batch;
    socket.close();
  }, 120_000);
});

test('tormenta de suscripciones socket + publicaciones mientras se mueve', async () => {
  await withBackend('storm', 3135, 8905, async () => {
    const phone = '3000000003';
    await fetch(`http://127.0.0.1:${ctx.httpPort}/api/admin/drivers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_API_KEY },
      body: JSON.stringify({ phoneNumber: phone, name: 'Storm Driver', pin: '2468', companyId: 'EMP-01', busId: 'B-TORMENTA', routeId: 'R-101' }),
    });
    const login = await fetch(`http://127.0.0.1:${ctx.httpPort}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phoneNumber: phone, pin: '2468' }),
    });
    const { token } = (await login.json()) as { token: string };
    const client = await connectDriver(token, 'chaos-stormer');

    const sockets: Socket[] = [];
    for (let i = 0; i < 10; i++) {
      const s = io(`http://127.0.0.1:${ctx.httpPort}`, { path: '/ws', transports: ['websocket'], autoConnect: false });
      s.on('server:error', () => {});
      s.connect();
      await new Promise<void>((resolve, reject) => {
        s.once('connect', resolve);
        s.once('connect_error', reject);
      });
      sockets.push(s);
    }

    const topic = 'empresa/EMP-01/bus/B-TORMENTA/posicion';
    for (let round = 0; round < 20; round++) {
      for (const s of sockets) {
        s.emit('subscribe:route', round % 2 === 0 ? 'R-101' : 'R-102');
        s.emit('unsubscribe:route', round % 2 === 0 ? 'R-102' : 'R-101');
        s.emit('bogus:event', { hacked: true });
      }
      client.publish(topic, JSON.stringify({ lat: 10.94 + round * 0.0001, lon: -74.78 + round * 0.0001, speedKmh: 30, capturedAt: Date.now() }));
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));

    const health = await fetch(healthUrl());
    assert.equal(health.status, 200);
    for (const s of sockets) s.close();
    client.end(true);
  });
});

// T1.4 protegió el barrido y el despacho del outbox, pero la limpieza de
// sesiones y el volcado de métricas también escriben en SQLite desde un
// setInterval, y ahí una excepción no tenía quien la atrapara: el proceso
// moría y no volvía. Con el servidor entero, entra una fila corrupta al
// outbox y la base rechaza el volcado (un trigger hace de disco que falla).
// El proceso tiene que seguir vivo, contar el fallo y volcar en cuanto la
// base vuelve a aceptar.
test('fila corrupta en el outbox y volcado de métricas que falla: el proceso sigue vivo', async () => {
  await withBackend('volcado', 3136, 8906, async () => {
    const db = new Database(dbPathFor('volcado'));
    try {
      db.pragma('busy_timeout = 5000');
      db.exec(`
        CREATE TRIGGER metrics_falla_insert BEFORE INSERT ON metrics
        BEGIN SELECT RAISE(ABORT, 'volcado rechazado por la prueba'); END;
        CREATE TRIGGER metrics_falla_update BEFORE UPDATE ON metrics
        BEGIN SELECT RAISE(ABORT, 'volcado rechazado por la prueba'); END;
      `);
      db.prepare(`
        INSERT INTO lifecycle_events (event_id, event_type, route_id, payload, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('ev-caos', 'bus:left', 'R-CAOS', '{"busId": "B-CAOS"', Date.now());

      // La corrupta muere sola (T1.4) y deja `outbox.corrupto` en memoria:
      // desde ahí cada volcado tiene algo que escribir y choca con el trigger.
      await esperar(() => {
        const fila = db.prepare('SELECT dead_at FROM lifecycle_events WHERE event_id = ?')
          .get('ev-caos') as { dead_at: number | null } | undefined;
        return fila?.dead_at ? true : undefined;
      }, 5_000, 'que la fila corrupta quede muerta');
      // Varias vueltas del volcado (cada 200 ms aquí) fallando seguidas.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      assert.equal(backend?.exitCode, null, 'el proceso murió con el volcado fallando');
      assert.equal((await fetch(healthUrl())).status, 200);

      // La base vuelve a aceptar: la siguiente vuelta vuelca, y con ella el
      // contador de los fallos de antes.
      db.exec('DROP TRIGGER metrics_falla_insert; DROP TRIGGER metrics_falla_update;');
      const fallos = await esperar(() => {
        const fila = db.prepare("SELECT value FROM metrics WHERE name = 'metrics.flush.error'")
          .get() as { value: number } | undefined;
        return fila?.value;
      }, 5_000, 'el volcado después de quitar el trigger');
      assert.ok(fallos >= 1, 'los volcados rechazados quedan contados');
      const corruptas = db.prepare("SELECT value FROM metrics WHERE name = 'outbox.corrupto'")
        .get() as { value: number } | undefined;
      assert.ok((corruptas?.value ?? 0) >= 1, 'la fila corrupta queda contada');
      assert.equal((await fetch(healthUrl())).status, 200);
    } finally {
      db.close();
    }
  }, 60_000, { YA_VIENE_METRICS_FLUSH_MS: '200' });
});

async function spawnBackendOnly(): Promise<void> {
  backend = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      HTTP_PORT: String(ctx.httpPort),
      MQTT_PORT: String(ctx.mqttPort),
      JWT_SECRET,
      ADMIN_API_KEY,
      MQTT_DEBUG_LOGS: 'false',
      // Los buses de demostración son del backend de verdad, no de un
      // test: doce simuladores publicando encima de este vuelven ruido
      // cada aserción sobre la flota.
      YA_VIENE_FLOTA_DEMO: '0',
      YA_VIENE_DB_PATH: `/tmp/yaviene-chaos-restart-${process.pid}-2.db`,
      YA_VIENE_GHOST_MS: '2000',
    },
    stdio: 'ignore',
  });
  await waitForReady(ctx);
}

async function connectDriver(token: string, clientId: string): Promise<mqtt.MqttClient> {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(`mqtt://127.0.0.1:${ctx.mqttPort}`, {
      username: 'chaos-driver',
      password: token,
      clientId,
      clean: true,
      connectTimeout: 5000,
    });
    client.once('connect', () => resolve(client));
    client.once('error', reject);
  });
}