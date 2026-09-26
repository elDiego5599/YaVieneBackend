// Qué pasa cuando SQLite no puede responder dentro de un listener del socket.
//
// Sin red de seguridad, una excepción de base en `subscribe:route` o en el
// handshake del panel sale del listener como excepción síncrona: no hay
// uncaughtException que la recoja y el proceso entero muere (un solo toque
// de la base y caen todos los clientes). Aquí se provoca el fallo real —se
// renombra la tabla que se consulta, desde otra conexión— y se exige lo
// mínimo: el servidor sigue vivo, el fallo queda anotado en el log, el
// cliente no recibe sala ni lote (mismo trato que una ruta inexistente) y,
// cuando la tabla vuelve, el mismo cliente sigue funcionando sin reconectar.
//
// Puertos propios, HTTP 3250 y MQTT 8980 (el reparto está en arranque.test.ts).
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import test from 'node:test';

import Database from 'better-sqlite3';
import { io, Socket } from 'socket.io-client';

import { signToken } from '../src/auth/tokens';

const HTTP_PORT = 3250;
const MQTT_PORT = 8980;
const ADMIN_API_KEY = 'socket-falla-base-admin-key';
// Valores de usar y tirar para esta base temporal; no son de nadie.
const JWT_SECRET = 'socket-falla-base-jwt-secret';
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const DB_PATH = `/tmp/yaviene-socket-falla-base-${process.pid}-${Date.now()}.db`;

// `signToken` lee el secreto del entorno del proceso de la prueba.
process.env.JWT_SECRET = JWT_SECRET;

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

async function conectar(auth?: Record<string, string>): Promise<Socket> {
  const socket = io(BASE, { path: '/ws', transports: ['websocket'], reconnection: false, auth });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('El servidor no aceptó la conexión')), 5_000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return socket;
}

function esperarLote(socket: Socket, routeId: string, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('positions:batch', listener);
      reject(new Error(`No llegó positions:batch de ${routeId}`));
    }, timeoutMs);
    const listener = (payload: { routeId?: string }) => {
      if (payload?.routeId !== routeId) return;
      clearTimeout(timer);
      socket.off('positions:batch', listener);
      resolve();
    };
    socket.on('positions:batch', listener);
  });
}

function esperarFlota(socket: Socket, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('fleet:batch', listener);
      reject(new Error('No llegó fleet:batch'));
    }, timeoutMs);
    const listener = () => {
      clearTimeout(timer);
      socket.off('fleet:batch', listener);
      resolve();
    };
    socket.on('fleet:batch', listener);
  });
}

const dormir = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('una base que no responde dentro de un listener no tumba el socket', { timeout: 60_000 }, async (t) => {
  const backend = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      HTTP_PORT: String(HTTP_PORT),
      MQTT_PORT: String(MQTT_PORT),
      JWT_SECRET,
      ADMIN_API_KEY,
      MQTT_DEBUG_LOGS: 'false',
      YA_VIENE_FLOTA_DEMO: '0',
      YA_VIENE_DB_PATH: DB_PATH,
    },
    // La salida de errores se guarda: la prueba busca ahí el aviso del fallo.
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let salidaErrores = '';
  backend.stderr?.on('data', (chunk) => {
    salidaErrores += String(chunk);
  });
  const sockets: Socket[] = [];
  const base = new Database(DB_PATH);
  base.pragma('busy_timeout = 5000');

  try {
    await waitForReady();

    await t.test('subscribe:route con la tabla caída: vivo, sin lote y con recuperación', async () => {
      base.exec('ALTER TABLE company_routes RENAME TO company_routes_off');
      const socket = await conectar();
      sockets.push(socket);
      const lotes: string[] = [];
      socket.on('positions:batch', (payload: { routeId?: string }) => lotes.push(payload?.routeId ?? ''));

      socket.emit('subscribe:route', 'ZZ-999');
      await dormir(500);

      assert.equal(backend.exitCode, null, 'un fallo de base no debe matar el proceso');
      assert.equal(socket.connected, true, 'el fallo no es motivo para echar al cliente');
      assert.deepEqual(lotes, [], 'sin base no hay sala ni lote');

      base.exec('ALTER TABLE company_routes_off RENAME TO company_routes');
      const lote = esperarLote(socket, 'R-101');
      socket.emit('subscribe:route', 'R-101');
      await lote;
      socket.disconnect();
    });

    await t.test('handshake del panel con empresa_admins caída: vivo y se recupera', async () => {
      // La fila existe de verdad (misma empresa y versión que el token): lo
      // que se rompe es poder leerla, no la identidad del panel.
      const ahora = Date.now();
      base.prepare('INSERT OR IGNORE INTO empresas (company_id, name, created_at) VALUES (?, ?, ?)')
        .run('EMP-FALLA', 'Empresa Falla', ahora);
      base.prepare(
        `INSERT OR IGNORE INTO empresa_admins
           (admin_id, company_id, username, password_hash, created_at, token_version)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('admin-falla-base', 'EMP-FALLA', 'falla-base', 'hash-de-prueba', ahora, 1);
      const token = signToken({
        sub: 'admin-falla-base',
        role: 'admin',
        companyId: 'EMP-FALLA',
        username: 'falla-base',
        tv: 1,
      });
      base.exec('ALTER TABLE empresa_admins RENAME TO empresa_admins_off');

      // Con la tabla fuera: la conexión y el primer lote siguen llegando
      // (falla abierta, igual que la revisión de paneles), no matan al proceso.
      const socket = await conectar({ token });
      sockets.push(socket);
      assert.equal(backend.exitCode, null, 'un fallo de base no debe matar el proceso');
      assert.equal(socket.connected, true, 'la autenticación no se tumba con la base');
      const primerLote = esperarFlota(socket);
      socket.emit('subscribe:fleet');
      await primerLote;

      // Con la tabla de vuelta: el chequeo se reanuda y el panel completo
      // (fila válida incluida) recibe su lote sin reconectar.
      base.exec('ALTER TABLE empresa_admins_off RENAME TO empresa_admins');
      const segundoLote = esperarFlota(socket);
      socket.emit('subscribe:fleet');
      await segundoLote;
      socket.disconnect();
    });

    assert.match(
      salidaErrores,
      /la base no respondi/,
      'el fallo debe quedar anotado, no tragarse en silencio',
    );
    assert.equal(backend.exitCode, null, 'el proceso sigue vivo hasta el final');
  } finally {
    for (const socket of sockets) socket.disconnect();
    try {
      base.close();
    } catch {}
    await stopProcess(backend);
    for (const sufijo of ['', '-wal', '-shm']) {
      rmSync(`${DB_PATH}${sufijo}`, { force: true });
    }
  }
});
