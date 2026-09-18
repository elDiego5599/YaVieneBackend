// Qué recibe un cliente que manda por el socket un evento que no existe.
//
// Las apps solo mandan tres eventos (pasajero: subscribe/unsubscribe:route;
// panel: subscribe:fleet) y ninguna escucha `server:error`: nunca les llega.
// Ese aviso es para un cliente ajeno o roto, y le dice por qué se le cierra
// el socket en vez de dejarlo adivinando. Esta prueba fija las dos cosas: el
// aviso llega, y llega antes del cierre.
//
// Puertos propios, HTTP 3170 y MQTT 8940: node --test corre los archivos en
// paralelo (el reparto de los demás está en arranque.test.ts).
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import test from 'node:test';

import { io } from 'socket.io-client';

const HTTP_PORT = 3170;
const MQTT_PORT = 8940;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const DB_PATH = `/tmp/yaviene-evento-prohibido-${process.pid}-${Date.now()}.db`;

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

test('un evento que no existe recibe server:error y luego el cierre', { timeout: 30_000 }, async () => {
  const backend = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      HTTP_PORT: String(HTTP_PORT),
      MQTT_PORT: String(MQTT_PORT),
      // Valores de usar y tirar para esta base temporal; no son de nadie.
      JWT_SECRET: 'evento-prohibido-jwt-secret',
      ADMIN_API_KEY: 'evento-prohibido-admin-key',
      MQTT_DEBUG_LOGS: 'false',
      YA_VIENE_FLOTA_DEMO: '0',
      YA_VIENE_DB_PATH: DB_PATH,
    },
    stdio: 'ignore',
  });
  // Sin reconexión: aquí se quiere ver que el servidor corta, no que el
  // cliente vuelve solo.
  const socket = io(BASE, { path: '/ws', transports: ['websocket'], reconnection: false, autoConnect: false });

  try {
    await waitForReady();
    const orden: string[] = [];
    let aviso: unknown;
    const cerrado = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('El servidor no cortó la conexión')), 5_000);
      socket.on('server:error', (payload) => {
        orden.push('server:error');
        aviso = payload;
      });
      socket.once('disconnect', (reason) => {
        clearTimeout(timer);
        orden.push(`disconnect:${reason}`);
        resolve();
      });
    });
    socket.connect();
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });

    socket.emit('bogus:event', { hacked: true });
    await cerrado;

    assert.deepEqual(orden, ['server:error', 'disconnect:io server disconnect']);
    assert.deepEqual(aviso, { message: 'Forbidden event' });
  } finally {
    socket.close();
    await stopProcess(backend);
    for (const sufijo of ['', '-wal', '-shm']) rmSync(`${DB_PATH}${sufijo}`, { force: true });
  }
});
