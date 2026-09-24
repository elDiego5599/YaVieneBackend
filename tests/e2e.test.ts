import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import test from 'node:test';

import { io, Socket } from 'socket.io-client';

// Puertos propios: HTTP 3120-3129, MQTT 8890-8899. node --test corre los
// archivos en paralelo; si dos comparten puerto, uno no arranca y sus pruebas
// le hablan al backend del otro. Reparto: e2e 312x, chaos 313x, fleet 314x,
// arranque 315x, socket_abuso 316x.
const HTTP_PORT = 3120;
const MQTT_PORT = 8890;
const ADMIN_API_KEY = 'e2e-admin-key';
const JWT_SECRET = 'e2e-jwt-secret';

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/ready`);
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
    }, 3000);
  });
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

test('conductor -> MQTT -> backend -> Socket.io -> bus queda "sin señal" (is_ghost) sin desaparecer', { timeout: 90_000 }, async () => {
  const suffix = Date.now().toString().slice(-6);
  const phone = `300${suffix}`;
  const busId = `E2E-${suffix}`;
  const backend = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      HTTP_PORT: String(HTTP_PORT),
      MQTT_PORT: String(MQTT_PORT),
      JWT_SECRET,
      ADMIN_API_KEY,
      MQTT_DEBUG_LOGS: 'false',
      // Los buses de demostración son del backend de verdad, no de un
      // test: doce simuladores publicando encima de este vuelven ruido
      // cada aserción sobre la flota.
      YA_VIENE_FLOTA_DEMO: '0',
      YA_VIENE_DB_PATH: `/tmp/yaviene-e2e-${process.pid}.db`,
      YA_VIENE_GHOST_MS: '2000',
    },
    stdio: 'ignore',
  });
  let simulator: ChildProcess | undefined;
  let socket: Socket | undefined;

  try {
    await waitForReady();

    const provision = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/admin/drivers`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-key': ADMIN_API_KEY,
      },
      body: JSON.stringify({
        phoneNumber: phone,
        name: 'E2E Driver',
        pin: '2468',
        companyId: 'EMP-01',
        busId,
        routeId: 'R-101',
      }),
    });
    assert.equal(provision.status, 201);

    socket = io(`http://127.0.0.1:${HTTP_PORT}`, {
      path: '/ws',
      transports: ['websocket'],
      autoConnect: false,
    });
    const connected = new Promise<void>((resolve, reject) => {
      socket!.once('connect', () => resolve());
      socket!.once('connect_error', reject);
    });
    socket.connect();
    await connected;

    const positionEvent = waitForSocketEvent(
      socket,
      'bus:position',
      (payload) => payload?.busId === busId,
    );
    const leftEvent = waitForSocketEvent(
      socket,
      'bus:position',
      (payload) => payload?.busId === busId && payload?.isGhost === true,
      60_000,
    );
    // Una ruta bien escrita que no existe no abre sala ni trae carga
    // inicial. Los eventos del socket llegan en orden, así que si la
    // inventada hubiera respondido, su lote llegaría antes que el de R-101.
    const lotes: string[] = [];
    const anotarLote = (payload: any) => lotes.push(payload?.routeId);
    socket.on('positions:batch', anotarLote);
    const loteReal = waitForSocketEvent(
      socket,
      'positions:batch',
      (payload) => payload?.routeId === 'R-101',
    );
    socket.emit('subscribe:route', 'ZZ-999');
    socket.emit('subscribe:route', 'R-101');
    await loteReal;
    socket.off('positions:batch', anotarLote);
    assert.deepEqual(lotes, ['R-101']);

    simulator = spawn(process.execPath, ['scripts/simulate-bus.mjs'], {
      env: {
        ...process.env,
        BACKEND_URL: `http://127.0.0.1:${HTTP_PORT}`,
        MQTT_PORT: String(MQTT_PORT),
        ADMIN_API_KEY,
        PHONE: phone,
        PIN: '2468',
        BUS_ID: busId,
        ROUTE_ID: 'R-101',
        EMPRESA_ID: 'EMP-01',
        CAPTURE_INTERVAL_MS: '10000',
        CAPTURE_BASE_LAG_MS: '60000',
      },
      stdio: 'ignore',
    });

    const position = await positionEvent;
    assert.equal(position.busId, busId);
    assert.equal(position.routeId, 'R-101');
    assert.equal(typeof position.sequence, 'number');
    assert.equal(typeof position.capturedAt, 'number');
    assert.equal('driverPhone' in position, false);

    await stopProcess(simulator);
    simulator = undefined;
    const left = await leftEvent;
    assert.equal(left.busId, busId);
    assert.equal(left.routeId, 'R-101');
    assert.equal(left.isGhost, true);
  } finally {
    socket?.close();
    await stopProcess(simulator);
    await stopProcess(backend);
  }
});
