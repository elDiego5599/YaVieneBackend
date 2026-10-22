import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';

const simulador = join(process.cwd(), 'scripts', 'simulate-bus.mjs');

test('el simulador se niega a mandar secretos por HTTP a un backend remoto', () => {
  const resultado = spawnSync(process.execPath, [simulador], {
    env: {
      PATH: process.env.PATH ?? '',
      BACKEND_URL: 'http://backend.example.test:3000',
      DEVICE_SECRET: 'prueba-local',
      ADMIN_API_KEY: 'clave-local',
    },
    encoding: 'utf8',
  });
  assert.notEqual(resultado.status, 0);
  assert.match(resultado.stderr, /BACKEND_URL remoto debe usar https/);
});

test('el simulador usa fetch para REST y TLS para MQTT cuando el backend es HTTPS', () => {
  const codigo = readFileSync(simulador, 'utf8');
  assert.match(codigo, /await fetch\(new URL\(path, BACKEND_URL\)/);
  assert.match(codigo, /tls\.connect\(/);
  assert.doesNotMatch(codigo, /http\.request\(/);
});

test('el simulador provisiona cada equipo con secreto propio y entra por la API de dispositivos', () => {
  const codigo = readFileSync(simulador, 'utf8');
  assert.match(codigo, /randomBytes\(32\)\.toString\('hex'\)/);
  assert.match(codigo, /process\.env\.DEVICE_SECRET/);
  assert.match(codigo, /postJson\('\/api\/admin\/drivers'/);
  assert.match(codigo, /postJson\('\/api\/devices\/login'/);
  assert.doesNotMatch(codigo, /process\.env\.PIN|\/api\/auth\/login|\/api\/drivers\/register/);
});
