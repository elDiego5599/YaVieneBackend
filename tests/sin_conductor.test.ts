// No hay app de conductor: el GPS es un equipo en el bus (D2). Quedaban restos
// de cuando la había: el alias `/api/drivers/register`, el token viejo con
// rol `driver`, el nombre del «conductor» en la flota del panel (que el panel
// ya no pintaba) y textos que hablaban de él. Esta prueba los mantiene fuera.
// `/api/auth/login` con línea y PIN se queda: es el camino del equipo (D2).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import jwt from 'jsonwebtoken';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-sin-conductor-'));
process.env.YA_VIENE_DB_PATH = join(tmp, 'test.db');
// Valores de usar y tirar para esta base temporal; no son de nadie.
process.env.ADMIN_API_KEY = 'sin-conductor-admin-key';
process.env.JWT_SECRET = 'sin-conductor-jwt-secret';

// require y no import: estos módulos leen el entorno al evaluarse.
const { handleAPI } = require('../src/api/routes') as typeof import('../src/api/routes');
const { verifyToken } = require('../src/auth/tokens') as typeof import('../src/auth/tokens');

const servidor: Server = createServer((req, res) => {
  if (!handleAPI(req, res)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});
let base = '';

test.before(async () => {
  await new Promise<void>((listo) => servidor.listen(0, '127.0.0.1', listo));
  const dir = servidor.address();
  base = `http://127.0.0.1:${typeof dir === 'object' && dir ? dir.port : 0}`;
});

test.after(async () => {
  await new Promise<void>((listo) => servidor.close(() => listo()));
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows */ }
});

test('el alias /api/drivers/register ya no existe', async () => {
  const r = await fetch(`${base}/api/drivers/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': 'sin-conductor-admin-key' },
    body: '{}',
  });
  assert.equal(r.status, 404);
});

test('un token con rol driver ya no vale', () => {
  const viejo = jwt.sign({
    sub: 'device-1', driverId: 'device-1', phoneNumber: 'gps-001', role: 'driver',
    companyId: 'EMP-01', busId: 'BUS-WFK042', routeId: 'R-101', sessionId: 'session-1',
  }, process.env.JWT_SECRET!, {
    algorithm: 'HS256', issuer: 'ya-viene-backend', audience: 'ya-viene-mqtt', expiresIn: '24h',
  });
  assert.equal(verifyToken(viejo), null);
});

test('la flota del panel no lleva nombre de conductor', () => {
  const carpeta = join(__dirname, 'fixtures', 'contrato');
  for (const nombre of readdirSync(carpeta).filter((n) => n.endsWith('.json'))) {
    assert.doesNotMatch(readFileSync(join(carpeta, nombre), 'utf8'), /driverName/, nombre);
  }
  assert.doesNotMatch(readFileSync(join(__dirname, '..', 'src', 'data', 'bus_types.ts'), 'utf8'), /driverName/);
});

test('los textos hablan del equipo, no del conductor', () => {
  const rutas = readFileSync(join(__dirname, '..', 'src', 'api', 'routes.ts'), 'utf8');
  assert.doesNotMatch(rutas, /por el conductor/);
  assert.doesNotMatch(rutas, /Invalid driver credentials/);
  assert.doesNotMatch(rutas, /The driver is not assigned/);
  const demo = readFileSync(join(__dirname, '..', 'src', 'demo', 'flota_demo.ts'), 'utf8');
  assert.doesNotMatch(demo, /`Conductor \$\{/);
});
