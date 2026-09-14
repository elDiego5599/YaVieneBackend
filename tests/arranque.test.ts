import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import test from 'node:test';

import Database from 'better-sqlite3';
import { io } from 'socket.io-client';

import { validateConfig } from '../src/config';

const JWT_LARGO = 'j'.repeat(64);
const CLAVE_LARGA = 'k'.repeat(48);

test('validateConfig: el arranque local de siempre (local.env) no da errores', () => {
  const { errores, avisos } = validateConfig({ JWT_SECRET: JWT_LARGO, ADMIN_API_KEY: CLAVE_LARGA });
  assert.deepEqual(errores, []);
  assert.deepEqual(avisos, []);
});

test('validateConfig: el arranque de Fly (producción, sin CORS, MQTT en loopback) no da errores', () => {
  const { errores, avisos } = validateConfig({
    NODE_ENV: 'production',
    JWT_SECRET: JWT_LARGO,
    ADMIN_API_KEY: CLAVE_LARGA,
    YA_VIENE_DB_PATH: '/data/yaviene.db',
    // fly.toml lo declara: el TLS lo termina el proxy de Fly.
    HTTP_TLS_EXTERNO: '1',
  });
  assert.deepEqual(errores, []);
  assert.deepEqual(avisos, []);
});

test('validateConfig: secretos ausentes o en blanco', () => {
  assert.equal(validateConfig({}).errores.length, 1);
  assert.match(validateConfig({ JWT_SECRET: '   ' }).errores[0], /JWT_SECRET/);
  assert.match(validateConfig({ JWT_SECRET: 'x', ADMIN_API_KEY: '  ' }).errores[0], /ADMIN_API_KEY/);
  assert.match(
    validateConfig({ NODE_ENV: 'production', JWT_SECRET: JWT_LARGO }).errores[0],
    /ADMIN_API_KEY es obligatoria/,
  );
  // La clave de admin corta en producción avisa; el JWT corto ya no (abajo).
  const cortos = validateConfig({
    NODE_ENV: 'production', JWT_SECRET: JWT_LARGO, ADMIN_API_KEY: 'corta', HTTP_TLS_EXTERNO: '1',
  });
  assert.deepEqual(cortos.errores, []);
  assert.equal(cortos.avisos.length, 1);
});

// Con un JWT_SECRET corto cualquiera que vea un token puede probar secretos
// por fuerza bruta sin conexión y firmarse uno de admin. Avisar no bastaba:
// el aviso se pierde en el log y el servidor sigue firmando con él.
test('validateConfig: JWT_SECRET de menos de 32 caracteres no arranca en producción', () => {
  const prod = { NODE_ENV: 'production', ADMIN_API_KEY: CLAVE_LARGA, HTTP_TLS_EXTERNO: '1' };
  assert.match(validateConfig({ ...prod, JWT_SECRET: 'j'.repeat(31) }).errores[0], /JWT_SECRET/);
  assert.deepEqual(validateConfig({ ...prod, JWT_SECRET: 'j'.repeat(32) }).errores, []);
  // Fuera de producción (ngrok, tests) sigue valiendo uno corto.
  assert.deepEqual(validateConfig({ JWT_SECRET: 'corto' }).errores, []);
});

test('validateConfig: TLS a medias no arranca en claro sin avisar', () => {
  assert.match(
    validateConfig({ JWT_SECRET: 'x', HTTP_TLS_CERT_PATH: '/c.pem' }).errores[0],
    /HTTP_TLS_CERT_PATH y HTTP_TLS_KEY_PATH/,
  );
  assert.match(
    validateConfig({ JWT_SECRET: 'x', MQTT_TLS_KEY_PATH: '/k.pem' }).errores[0],
    /MQTT_TLS_CERT_PATH y MQTT_TLS_KEY_PATH/,
  );
  assert.deepEqual(
    validateConfig({ JWT_SECRET: 'x', HTTP_TLS_CERT_PATH: '/c.pem', HTTP_TLS_KEY_PATH: '/k.pem' }).errores,
    [],
  );
});

test('validateConfig: MQTT por TCP fuera de loopback exige TLS en producción', () => {
  const dev = validateConfig({ JWT_SECRET: 'x', MQTT_HOST: '0.0.0.0' });
  assert.deepEqual(dev.errores, []);
  assert.equal(dev.avisos.length, 1);
  const prod = {
    NODE_ENV: 'production', JWT_SECRET: JWT_LARGO, ADMIN_API_KEY: CLAVE_LARGA, HTTP_TLS_EXTERNO: '1', MQTT_HOST: '0.0.0.0',
  };
  assert.match(validateConfig(prod).errores[0], /MQTT_HOST/);
  assert.deepEqual(
    validateConfig({ ...prod, MQTT_TLS_CERT_PATH: '/c.pem', MQTT_TLS_KEY_PATH: '/k.pem' }).errores,
    [],
  );
});

test('validateConfig: CORS solo con orígenes exactos, y https en producción', () => {
  assert.deepEqual(validateConfig({ JWT_SECRET: 'x', CORS_ORIGINS: 'http://localhost:8091' }).errores, []);
  assert.equal(validateConfig({ JWT_SECRET: 'x', CORS_ORIGINS: '*' }).errores.length, 1);
  assert.equal(
    validateConfig({ JWT_SECRET: 'x', CORS_ORIGINS: 'https://yaviene.co/' }).errores.length,
    1,
    'con barra final no coincide nunca con la cabecera Origin',
  );
  const prod = { NODE_ENV: 'production', JWT_SECRET: JWT_LARGO, ADMIN_API_KEY: CLAVE_LARGA, HTTP_TLS_EXTERNO: '1' };
  assert.deepEqual(validateConfig({ ...prod, CORS_ORIGINS: 'https://yaviene.co, https://www.yaviene.co' }).errores, []);
  assert.match(validateConfig({ ...prod, CORS_ORIGINS: 'http://yaviene.co' }).errores[0], /https/);
});

// Por el HTTP pasan la contraseña del panel y el PIN del conductor. En
// producción arrancaba en claro sin avisar; ahora hace falta el par TLS o
// declarar que lo termina un proxy delante.
test('validateConfig: en producción el HTTP no arranca en claro sin decirlo', () => {
  const prod = { NODE_ENV: 'production', JWT_SECRET: JWT_LARGO, ADMIN_API_KEY: CLAVE_LARGA };
  assert.match(validateConfig(prod).errores[0], /HTTP_TLS_EXTERNO/);
  assert.equal(validateConfig({ ...prod, HTTP_TLS_EXTERNO: 'true' }).errores.length, 1, 'solo vale «1»');
  assert.deepEqual(validateConfig({ ...prod, HTTP_TLS_EXTERNO: '1' }).errores, []);
  assert.deepEqual(
    validateConfig({ ...prod, HTTP_TLS_CERT_PATH: '/c.pem', HTTP_TLS_KEY_PATH: '/k.pem' }).errores,
    [],
  );
  // El arranque local con ngrok no es producción: sigue sin pedir nada.
  assert.deepEqual(validateConfig({ JWT_SECRET: JWT_LARGO }).errores, []);
});

test('validateConfig: puertos que no son puertos', () => {
  assert.match(validateConfig({ JWT_SECRET: 'x', HTTP_PORT: 'abc' }).errores[0], /HTTP_PORT/);
  assert.match(validateConfig({ JWT_SECRET: 'x', MQTT_PORT: '70000' }).errores[0], /MQTT_PORT/);
});

// ── Arranque real ─────────────────────────────────────────────────────
// Entorno mínimo a propósito: nada heredado del de quien corre los tests,
// así se ve qué necesita el backend para arrancar y qué lo detiene.
function arrancar(env: Record<string, string>): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      YA_VIENE_FLOTA_DEMO: '0',
      MQTT_DEBUG_LOGS: 'false',
      ...env,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

function esperarSalida(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; stderr: string }> {
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`El proceso no terminó en ${timeoutMs} ms. stderr:\n${stderr}`));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

function borrarBase(dbPath: string): void {
  for (const sufijo of ['', '-wal', '-shm']) rmSync(`${dbPath}${sufijo}`, { force: true });
}

test('arranque: una configuración insegura no llega a levantar el servidor', { timeout: 60_000 }, async () => {
  const dbPath = `/tmp/yaviene-arranque-rechazo-${process.pid}.db`;
  const comunes = { HTTP_PORT: '3153', MQTT_PORT: '8923', YA_VIENE_DB_PATH: dbPath };
  const casos: Record<string, string>[] = [
    { JWT_SECRET: '   ' },
    { JWT_SECRET: JWT_LARGO, HTTP_TLS_CERT_PATH: '/no/existe/cert.pem' },
    { JWT_SECRET: JWT_LARGO, ADMIN_API_KEY: CLAVE_LARGA, NODE_ENV: 'production', CORS_ORIGINS: '*' },
  ];
  try {
    for (const caso of casos) {
      const { code, stderr } = await esperarSalida(arrancar({ ...comunes, ...caso }), 20_000);
      assert.notEqual(code, 0, `debió negarse a arrancar con ${JSON.stringify(caso)}`);
      assert.match(stderr, /\[Config\]/, 'el motivo sale en el registro');
    }
  } finally {
    borrarBase(dbPath);
  }
});

test('arranque: humo con base temporal, y el apagado guarda métricas y sale limpio', { timeout: 60_000 }, async () => {
  const port = 3152;
  const dbPath = `/tmp/yaviene-arranque-humo-${process.pid}-${Date.now()}.db`;
  const backend = arrancar({
    JWT_SECRET: 'humo-jwt-secret',
    HTTP_PORT: String(port),
    MQTT_PORT: '8922',
    YA_VIENE_DB_PATH: dbPath,
  });
  const salida = esperarSalida(backend, 45_000);

  try {
    const deadline = Date.now() + 15_000;
    let listo = false;
    while (!listo && Date.now() < deadline) {
      try {
        listo = (await fetch(`http://127.0.0.1:${port}/api/ready`)).status === 200;
      } catch {}
      if (!listo) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(listo, '/api/ready debe responder 200');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);

    // Algo que deje una métrica en memoria: un socket que se pasa del
    // presupuesto de eventos y al que el servidor echa.
    const socket = io(`http://127.0.0.1:${port}`, { path: '/ws', transports: ['websocket'], reconnection: false });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    const echado = new Promise<void>((resolve) => socket.once('disconnect', () => resolve()));
    for (let i = 0; i < 40; i++) socket.emit('subscribe:route', 'R-101');
    await echado;
    socket.close();

    const inicio = Date.now();
    backend.kill('SIGTERM');
    const { code, stderr } = await salida;
    assert.equal(code, 0, `el apagado ordenado sale con 0. stderr:\n${stderr}`);
    assert.ok(Date.now() - inicio < 10_000, 'el apagado no se cuelga');

    // Las métricas se vuelcan cada 30 s: sin el volcado al apagar, esta se
    // habría perdido.
    const db = new Database(dbPath);
    try {
      const fila = db.prepare("SELECT value FROM metrics WHERE name = 'socket.flood.kicked'").get() as
        | { value: number }
        | undefined;
      assert.ok(fila && fila.value >= 1, 'la métrica llegó a disco');
    } finally {
      db.close();
    }
  } finally {
    if (backend.exitCode === null) backend.kill('SIGKILL');
    borrarBase(dbPath);
  }
});
