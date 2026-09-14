import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import test from 'node:test';

import jwt from 'jsonwebtoken';
import { io, Socket } from 'socket.io-client';

// Puertos propios: los archivos de test corren en paralelo.
const HTTP_PORT = 3151;
const MQTT_PORT = 8921;
const ADMIN_API_KEY = 'socket-abuso-admin-key';
const JWT_SECRET = 'socket-abuso-jwt-secret';
// Clave de las cuentas admin que estas pruebas crean en su base temporal.
// No es de nadie; va en una constante porque gitleaks marca como secreto
// cualquier `password: '...'` escrito tal cual.
const CLAVE_PRUEBA = 'secret123-de-prueba';
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
async function conectar(auth?: Record<string, string>): Promise<Socket> {
  const socket = io(BASE, { path: '/ws', transports: ['websocket'], reconnection: false, auth });
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
      // La revisión de los paneles conectados va cada 60 s; aquí cada 200 ms
      // para no esperar un minuto por prueba.
      YA_VIENE_REVISION_PANEL_MS: '200',
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
        body: JSON.stringify({ username: 'salas', password: CLAVE_PRUEBA }),
      });
      assert.equal(creada.status, 201);
      const login = await fetch(`${BASE}/api/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'salas', password: CLAVE_PRUEBA }),
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

    // El token del panel se miraba solo al conectar: con la sala de la flota
    // ya abierta, ni caducar ni cambiar la contraseña lo sacaban. Y la
    // contraseña también cambia desde otro proceso
    // (scripts/crear-admin-empresa.mjs), así que el servidor no se entera
    // por evento: lo ve en la revisión periódica.
    await t.test('el panel sale cuando su token caduca o cambia la contraseña, y solo entonces', async () => {
      const cuenta = (usuario: string, clave: string) => fetch(`${BASE}/api/admin/empresas/EMP-PANEL/admin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_API_KEY },
        body: JSON.stringify({ username: usuario, password: clave }),
      });
      const entrar = async (usuario: string): Promise<string> => {
        assert.equal((await cuenta(usuario, CLAVE_PRUEBA)).status, 201);
        const res = await fetch(`${BASE}/api/admin/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: usuario, password: CLAVE_PRUEBA }),
        });
        return ((await res.json()) as { token: string }).token;
      };
      const panel = async (token: string): Promise<Socket> => {
        const socket = await conectar({ token });
        sockets.push(socket);
        const lote = new Promise((resolve) => socket.once('fleet:batch', resolve));
        socket.emit('subscribe:fleet');
        await lote;
        return socket;
      };

      const sano = await panel(await entrar('panel-sano'));
      const rotado = await panel(await entrar('panel-rotado'));
      // El mismo token, pero caducando en 3 s: firmarlo a mano es la única
      // forma de no esperar las 8 horas de verdad.
      const { iat: _iat, exp: _exp, ...claims } = jwt.decode(await entrar('panel-vence')) as Record<string, unknown>;
      const vence = await panel(jwt.sign(claims, JWT_SECRET, { expiresIn: 3 }));
      const fueraVence = esperarDesconexion(vence, 8_000);

      const fueraRotado = esperarDesconexion(rotado);
      assert.equal((await cuenta('panel-rotado', 'otra-clave-de-prueba')).status, 201);
      assert.equal(await fueraRotado, 'io server disconnect');
      assert.equal(await fueraVence, 'io server disconnect');

      // Decenas de revisiones después, el que está en regla sigue dentro.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      assert.equal(sano.connected, true);
    });
  } finally {
    for (const socket of sockets) socket.close();
    await stopProcess(backend);
  }
});
