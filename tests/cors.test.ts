// Lo que el servidor le dice al navegador que puede pedir.
//
// El panel de flota corre en el navegador y vive en otro origen que el
// backend, así que antes de un PATCH o un DELETE el navegador manda un
// preflight y sólo deja pasar la petición si la respuesta nombra ese
// método. La cabecera anunciaba `GET, POST, OPTIONS` mientras la API ya
// registraba rutas PATCH y DELETE de flota: en cuanto el panel se sirva
// desde un origen distinto al del backend, apagar un bus o borrarlo se
// queda en el preflight y el navegador ni siquiera manda la petición.
//
// Se levanta el backend de verdad —no basta con el manejador de la API,
// porque la cabecera la pone `index.ts`— en un decenio de puertos que no
// usa ninguna otra prueba, con base temporal y sin flota simulada.
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { HOST_PRUEBAS } from './red_pruebas';

const HTTP_PORT = '3180';
const MQTT_PORT = '8950';
const ORIGEN = 'http://localhost:8091';
// La landing (D15): solo puede la lista de «Avísame cuando salga».
const WEB = 'https://landing.example';
const BASE = `http://127.0.0.1:${HTTP_PORT}`;

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-cors-'));
let servidor: ChildProcess | undefined;

async function esperarVivo(limiteMs: number): Promise<void> {
  const hasta = Date.now() + limiteMs;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      // todavía no escucha
    }
    if (Date.now() > hasta) throw new Error('el backend no levantó a tiempo');
    await new Promise((sigue) => setTimeout(sigue, 100));
  }
}

test.before(async () => {
  servidor = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      YA_VIENE_FLOTA_DEMO: '0',
      MQTT_DEBUG_LOGS: 'false',
      // El entorno limpio no hereda el HTTP_HOST de tests/entorno.ts.
      HTTP_HOST: HOST_PRUEBAS,
      JWT_SECRET: 'cors-jwt-secret',
      HTTP_PORT,
      MQTT_PORT,
      CORS_ORIGINS: ORIGEN,
      WEB_ORIGINS: WEB,
      YA_VIENE_DB_PATH: join(tmp, 'test.db'),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await esperarVivo(30_000);
});

test.after(async () => {
  // En Windows matar no es instantáneo: borrar la base con el hijo todavía
  // soltando el descriptor falla con EBUSY. Se espera la salida primero.
  if (servidor && servidor.exitCode === null) {
    await new Promise<void>((listo) => {
      servidor!.once('exit', () => listo());
      servidor!.kill('SIGKILL');
      setTimeout(() => listo(), 5000);
    });
  }
  rmSync(tmp, { recursive: true, force: true });
});

test('el preflight nombra todos los métodos que la API atiende', { timeout: 60_000 }, async () => {
  const r = await fetch(`${BASE}/api/fleet/buses/BUS-1`, {
    method: 'OPTIONS',
    headers: {
      Origin: ORIGEN,
      'Access-Control-Request-Method': 'DELETE',
      'Access-Control-Request-Headers': 'authorization',
    },
  });

  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), ORIGEN);
  // Los cinco que registra `routes.ts` —el panel usa PATCH para apagar un
  // bus y DELETE para sacarlo; PUT es el latido de un aviso (D13)— más el
  // del propio preflight.
  assert.equal(
    r.headers.get('access-control-allow-methods'),
    'GET, POST, PATCH, DELETE, PUT, OPTIONS',
  );
  // ngrok-skip-browser-warning: sin ella, ngrok le contesta al fetch de la
  // landing con su página de aviso en HTML y no con la API (D15).
  assert.equal(
    r.headers.get('access-control-allow-headers'),
    'Authorization, Content-Type, ngrok-skip-browser-warning',
  );
});

test('un origen que no está en la lista no recibe permiso', { timeout: 60_000 }, async () => {
  const r = await fetch(`${BASE}/api/health`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://ajeno.example', 'Access-Control-Request-Method': 'GET' },
  });

  assert.equal(r.status, 204);
  // Sin esta cabecera el navegador descarta la respuesta, diga lo que diga
  // la lista de métodos.
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});

test('la landing solo puede la lista de lanzamiento, y sin credenciales', { timeout: 60_000 }, async () => {
  const preflight = await fetch(`${BASE}/api/lanzamiento`, {
    method: 'OPTIONS',
    headers: {
      Origin: WEB,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type, ngrok-skip-browser-warning',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), WEB);
  // La landing no es el panel: su página no lleva la cookie del panel.
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);

  // Cualquier otra puerta de la API sigue cerrada para ella.
  for (const ruta of ['/api/admin/lanzamiento', '/api/fleet/buses', '/api/health', '/api/lanzamientox']) {
    const r = await fetch(`${BASE}${ruta}`, {
      method: 'OPTIONS',
      headers: { Origin: WEB, 'Access-Control-Request-Method': 'GET' },
    });
    assert.equal(r.headers.get('access-control-allow-origin'), null, ruta);
  }
});

// AUD29-12: las cabeceras de seguridad salen de un solo sitio, así que
// valen igual para la API, el preflight y el 404, y HSTS solo va cuando la
// petición llegó por HTTPS al túnel.
test('las cabeceras de seguridad cubren toda respuesta y HSTS solo por HTTPS', { timeout: 60_000 }, async () => {
  const respuestas = [
    await fetch(`${BASE}/api/health`),
    await fetch(`${BASE}/api/health`, { method: 'OPTIONS' }),
    await fetch(`${BASE}/no-existe`),
  ];
  for (const r of respuestas) {
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', r.url);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', r.url);
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer', r.url);
    assert.equal(r.headers.get('strict-transport-security'), null, r.url);
    await r.text();
  }

  const cifrada = await fetch(`${BASE}/api/health`, { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(cifrada.headers.get('strict-transport-security'), 'max-age=31536000');
  await cifrada.text();
});
