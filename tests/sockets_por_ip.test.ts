// Cuántos sockets puede tener abiertos una misma dirección a la vez.
//
// Había tope de eventos por socket y de salas por socket, pero no de
// sockets: un solo equipo podía abrir miles y dejar al servidor sin memoria
// ni descriptores sin mandar un solo evento. Ahora pasan 100 por dirección
// (la misma clave que el limitador del HTTP, `requestKey`), y el 101 recibe
// `connect_error` con el motivo. Cuando uno se cierra, su sitio queda libre.
//
// Puertos propios, HTTP 3210 y MQTT 8990: node --test corre los archivos en
// paralelo (el reparto de los demás está en arranque.test.ts).
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import test from 'node:test';

import { io, Socket } from 'socket.io-client';

const HTTP_PORT = 3210;
const MQTT_PORT = 8990;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const DB_PATH = `/tmp/yaviene-sockets-ip-${process.pid}-${Date.now()}.db`;

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

/** Abre un socket y dice si entró o con qué motivo lo rechazaron. */
function abrir(abiertos: Socket[]): Promise<string> {
  const s = io(BASE, {
    path: '/ws',
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  abiertos.push(s);
  return new Promise((resolve) => {
    s.once('connect', () => resolve('dentro'));
    s.once('connect_error', (error) => resolve(error.message));
  });
}

test('una dirección abre 100 sockets a la vez, no más', { timeout: 60_000 }, async () => {
  const backend = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      HTTP_PORT: String(HTTP_PORT),
      MQTT_PORT: String(MQTT_PORT),
      // Valores de usar y tirar para esta base temporal; no son de nadie.
      JWT_SECRET: 'sockets-ip-jwt-secret',
      ADMIN_API_KEY: 'sockets-ip-admin-key',
      MQTT_DEBUG_LOGS: 'false',
      YA_VIENE_FLOTA_DEMO: '0',
      YA_VIENE_DB_PATH: DB_PATH,
    },
    stdio: 'ignore',
  });
  const abiertos: Socket[] = [];

  try {
    await waitForReady();
    const resultados = await Promise.all(Array.from({ length: 200 }, () => abrir(abiertos)));

    const dentro = resultados.filter((r) => r === 'dentro').length;
    const fuera = resultados.filter((r) => r === 'Demasiadas conexiones').length;
    assert.equal(dentro, 100);
    assert.equal(fuera, 100);

    // Al cerrar uno, el siguiente entra.
    const uno = abiertos.find((s) => s.connected)!;
    const cerrado = new Promise<void>((resolve) => uno.once('disconnect', () => resolve()));
    uno.close();
    await cerrado;
    // El servidor se entera del cierre un instante después que el cliente.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await abrir(abiertos), 'dentro');
    assert.equal(await abrir(abiertos), 'Demasiadas conexiones');
  } finally {
    for (const s of abiertos) s.close();
    await stopProcess(backend);
    for (const sufijo of ['', '-wal', '-shm']) rmSync(`${DB_PATH}${sufijo}`, { force: true });
  }
});
