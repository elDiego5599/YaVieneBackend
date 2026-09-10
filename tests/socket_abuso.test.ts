import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import test from 'node:test';

import { io, Socket } from 'socket.io-client';

// Puertos propios: los archivos de test corren en paralelo.
const HTTP_PORT = 3151;
const MQTT_PORT = 8921;
const ADMIN_API_KEY = 'socket-abuso-admin-key';
const JWT_SECRET = 'socket-abuso-jwt-secret';
const BASE = `http://127.0.0.1:${HTTP_PORT}`;

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/ready`);
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

// Sin reconexión: aquí se quiere ver que el servidor corta, no que el
// cliente vuelve solo.
async function conectar(): Promise<Socket> {
  const socket = io(BASE, { path: '/ws', transports: ['websocket'], reconnection: false });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  return socket;
}

function esperarLote(socket: Socket, routeId: string, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('positions:batch', listener);
      reject(new Error(`No llegó positions:batch de ${routeId}`));
    }, timeoutMs);
    const listener = (payload: any) => {
      if (payload?.routeId !== routeId) return;
      clearTimeout(timer);
      socket.off('positions:batch', listener);
      resolve();
    };
    socket.on('positions:batch', listener);
  });
}

function esperarDesconexion(socket: Socket, timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('El servidor no cortó la conexión')), timeoutMs);
    socket.once('disconnect', (reason) => {
      clearTimeout(timer);
      resolve(reason);
    });
  });
}

test('socket: payloads inválidos, tope de salas y abuso de frecuencia', { timeout: 60_000 }, async (t) => {
  const backend = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      HTTP_PORT: String(HTTP_PORT),
      MQTT_PORT: String(MQTT_PORT),
      JWT_SECRET,
      ADMIN_API_KEY,
      MQTT_DEBUG_LOGS: 'false',
      YA_VIENE_FLOTA_DEMO: '0',
      YA_VIENE_DB_PATH: `/tmp/yaviene-socket-abuso-${process.pid}-${Date.now()}.db`,
    },
    stdio: 'ignore',
  });
  const sockets: Socket[] = [];

  try {
    await waitForReady();

    await t.test('lo que no es una ruta existente se descarta sin tumbar al cliente', async () => {
      const socket = await conectar();
      sockets.push(socket);
      const lotes: string[] = [];
      socket.on('positions:batch', (payload: any) => lotes.push(payload?.routeId));

      socket.emit('subscribe:route', { routeId: 'R-101' });
      socket.emit('subscribe:route', 42);
      socket.emit('subscribe:route', null);
      socket.emit('subscribe:route', 'R'.repeat(5_000));
      socket.emit('subscribe:route', '../R-101');
      socket.emit('subscribe:route', 'ZZ-999');
      socket.emit('unsubscribe:route', { a: 1 });
      socket.emit('unsubscribe:route', 'U'.repeat(5_000));
      // Los eventos llegan en orden: si alguno de los de arriba hubiera
      // respondido, su lote estaría antes que este.
      const real = esperarLote(socket, 'R-101');
      socket.emit('subscribe:route', 'R-101');
      await real;

      assert.deepEqual(lotes, ['R-101']);
      assert.equal(socket.connected, true, 'un payload inválido no es motivo para echar al cliente');
    });

    await t.test('una conexión no sigue más de 12 rutas a la vez', async () => {
      // Seis rutas de la demo más siete de catálogo: trece que existen.
      const creada = await fetch(`${BASE}/api/admin/empresas/EMP-SALAS/admin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_API_KEY },
        body: JSON.stringify({ username: 'salas', password: 'secret123-de-prueba' }),
      });
      assert.equal(creada.status, 201);
      const login = await fetch(`${BASE}/api/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'salas', password: 'secret123-de-prueba' }),
      });
      const { token } = (await login.json()) as { token: string };
      const extra = ['R-401', 'R-402', 'R-403', 'R-404', 'R-405', 'R-406', 'R-407'];
      for (const routeId of extra) {
        const res = await fetch(`${BASE}/api/fleet/routes`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ routeId, name: `Ruta ${routeId}` }),
        });
        assert.equal(res.status, 201);
      }

      const socket = await conectar();
      sockets.push(socket);
      const lotes: string[] = [];
      socket.on('positions:batch', (payload: any) => lotes.push(payload?.routeId));

      const doce = ['R-101', 'R-102', 'R-103', 'R-104', 'R-105', 'R-106', ...extra.slice(0, 6)];
      for (const routeId of doce) socket.emit('subscribe:route', routeId);
      socket.emit('subscribe:route', 'R-407');
      // Volver a pedir una ruta ya seguida sí responde: el tope es de salas
      // nuevas, no de consultas.
      const repetida = new Promise<void>((resolve) => {
        let vistos = 0;
        const listener = (payload: any) => {
          if (payload?.routeId !== 'R-101') return;
          if (++vistos === 2) {
            socket.off('positions:batch', listener);
            resolve();
          }
        };
        socket.on('positions:batch', listener);
      });
      socket.emit('subscribe:route', 'R-101');
      await repetida;

      assert.equal(lotes.includes('R-407'), false, 'la decimotercera sala no se abre');
      assert.deepEqual(lotes, [...doce, 'R-101']);
    });

    await t.test('quien inunda de eventos queda fuera y los demás siguen', async () => {
      const inundador = await conectar();
      sockets.push(inundador);
      const desconexion = esperarDesconexion(inundador);
      for (let i = 0; i < 200; i++) inundador.emit('subscribe:route', 'R-101');
      assert.equal(await desconexion, 'io server disconnect');

      const sano = await conectar();
      sockets.push(sano);
      const lote = esperarLote(sano, 'R-101');
      sano.emit('subscribe:route', 'R-101');
      await lote;
      assert.equal(sano.connected, true);
    });

    await t.test('un mensaje de más de 16 KB corta la conexión', async () => {
      const grande = await conectar();
      sockets.push(grande);
      const desconexion = esperarDesconexion(grande);
      grande.emit('subscribe:route', 'x'.repeat(20_000));
      const reason = await desconexion;
      assert.notEqual(reason, 'io client disconnect');

      const sano = await conectar();
      sockets.push(sano);
      const lote = esperarLote(sano, 'R-102');
      sano.emit('subscribe:route', 'R-102');
      await lote;
    });
  } finally {
    for (const socket of sockets) socket.close();
    await stopProcess(backend);
  }
});
