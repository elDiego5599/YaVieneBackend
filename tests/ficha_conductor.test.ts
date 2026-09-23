// Quién puede leer `GET /api/drivers/:phone`, rol por rol.
//
// La regla: cada token lee solo su propia ficha, y todo lo demás recibe el
// mismo 403, exista el teléfono o no. Si la respuesta cambiara según exista,
// cualquiera podría barrer números y saber cuáles están dados de alta. La
// clave de administración tampoco abre fichas aquí, ni sola ni mezclada con
// un token de conductor: la administración lee con el panel de flota.
//
// Igual que `api_rutas.test.ts`, no se levanta el backend entero: el mismo
// manejador sobre un servidor de usar y tirar, con base temporal y el
// puerto que dé el sistema.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-ficha-'));
process.env.YA_VIENE_DB_PATH = join(tmp, 'test.db');
// Valores de usar y tirar para esta base temporal; no son de nadie.
const CLAVE_ADMIN = 'ficha-admin-key';
process.env.ADMIN_API_KEY = CLAVE_ADMIN;
process.env.JWT_SECRET = 'ficha-jwt-secret';

// require y no import: estos módulos leen el entorno y abren la base al
// evaluarse, y un import se izaría por encima de las líneas de arriba.
const { handleAPI } = require('../src/api/routes') as typeof import('../src/api/routes');
const { getDb } = require('../src/data/database') as typeof import('../src/data/database');

const servidor: Server = createServer((req, res) => {
  if (!handleAPI(req, res)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

let base = '';
const PROPIO = '3001112233';
const AJENO = '3004445566';
const INVENTADO = '3990000000';
let tokenPropio = '';

async function alta(phoneNumber: string, busId: string): Promise<void> {
  const r = await fetch(`${base}/api/admin/drivers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': CLAVE_ADMIN },
    body: JSON.stringify({
      phoneNumber,
      name: busId,
      pin: '2468',
      companyId: 'EMP-FICHA',
      busId,
      routeId: 'R-101',
    }),
  });
  assert.equal(r.status, 201);
}

test.before(async () => {
  await new Promise<void>((listo) => servidor.listen(0, '127.0.0.1', listo));
  const dir = servidor.address();
  base = `http://127.0.0.1:${typeof dir === 'object' && dir ? dir.port : 0}`;

  await alta(PROPIO, 'FICHA-1');
  await alta(AJENO, 'FICHA-2');
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phoneNumber: PROPIO, pin: '2468' }),
  });
  assert.equal(login.status, 200);
  tokenPropio = ((await login.json()) as { token: string }).token;
});

test.after(async () => {
  await new Promise<void>((listo) => servidor.close(() => listo()));
  // En Windows un archivo abierto no se borra: la base sigue con el
  // descriptor de este proceso y `rmSync` falla con EBUSY. Se cierra antes.
  try {
    getDb().close();
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

async function ficha(
  phone: string,
  headers: Record<string, string> = {},
): Promise<{ estado: number; cuerpo: unknown }> {
  const r = await fetch(`${base}/api/drivers/${phone}`, { headers });
  return { estado: r.status, cuerpo: await r.json() };
}

test('conductor: lee su ficha y nada más', async () => {
  const conToken = { authorization: `Bearer ${tokenPropio}` };
  const propia = await ficha(PROPIO, conToken);
  assert.equal(propia.estado, 200);
  assert.equal((propia.cuerpo as { phoneNumber: string }).phoneNumber, PROPIO);

  // La ajena y la que no existe responden lo mismo, palabra por palabra.
  const ajena = await ficha(AJENO, conToken);
  const inventada = await ficha(INVENTADO, conToken);
  assert.equal(ajena.estado, 403);
  assert.equal(inventada.estado, 403);
  assert.deepEqual(ajena.cuerpo, inventada.cuerpo);
});

test('admin: la clave no abre fichas, ni sola ni junto a un token', async () => {
  const soloClave = { 'x-admin-key': CLAVE_ADMIN };
  assert.equal((await ficha(AJENO, soloClave)).estado, 403);

  // Token de conductor y clave juntos siguen siendo solo ese conductor: ni
  // la ficha ajena ni un 404 que delate al teléfono inexistente.
  const mezcla = { ...soloClave, authorization: `Bearer ${tokenPropio}` };
  const ajena = await ficha(AJENO, mezcla);
  const inventada = await ficha(INVENTADO, mezcla);
  assert.equal(ajena.estado, 403);
  assert.equal(inventada.estado, 403);
  assert.deepEqual(ajena.cuerpo, inventada.cuerpo);
});

test('anónimo: el mismo 403 exista el teléfono o no', async () => {
  const existente = await ficha(PROPIO);
  const inventada = await ficha(INVENTADO);
  assert.equal(existente.estado, 403);
  assert.equal(inventada.estado, 403);
  assert.deepEqual(existente.cuerpo, inventada.cuerpo);
});
