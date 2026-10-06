// `GET /api/drivers/:phone` ya no existe (T3.5, 2026-10-06). Leía la ficha
// del conductor con su propio token, pero no hay app de conductor (el GPS
// es un equipo en el bus) y ningún cliente la llamaba: era superficie de
// ataque sin uso. Ahora contesta como cualquier ruta que no existe, para
// todos y exista o no el teléfono, así que tampoco sirve para barrer
// números.
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

async function pedir(
  ruta: string,
  headers: Record<string, string> = {},
): Promise<{ estado: number; cuerpo: unknown }> {
  const r = await fetch(`${base}${ruta}`, { headers });
  return { estado: r.status, cuerpo: await r.json() };
}

test('la ficha del conductor ya no se sirve, ni con su propio token', async () => {
  const nada = await pedir('/api/no-existe');
  assert.equal(nada.estado, 404);
  const conToken = { authorization: `Bearer ${tokenPropio}` };
  for (const [telefono, headers] of [
    [PROPIO, conToken],
    [AJENO, conToken],
    [INVENTADO, conToken],
    [AJENO, { 'x-admin-key': CLAVE_ADMIN }],
    [PROPIO, {}],
  ] as const) {
    assert.deepEqual(await pedir(`/api/drivers/${telefono}`, headers), nada, telefono);
  }
});
