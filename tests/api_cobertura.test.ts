// Cobertura de los manejadores HTTP vía handleAPI en proceso: cada addRoute
// cuenta como función para el trinquete 92/79/92 y la mayoría solo se
// ejercía vía hijo (spawn). Servidor efímero en puerto 0 como api_rutas.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-api-cob-'));
process.env.YA_VIENE_DB_PATH = join(tmp, 'test.db');
process.env.JWT_SECRET = randomBytes(32).toString('hex');
process.env.ADMIN_API_KEY = 'api-cob-admin-key-1234567890';

// require y no import: estos módulos abren la base y leen el env al
// evaluarse, y un import se izaría por encima de las líneas de arriba.
const { handleAPI, metodosHttpRegistrados } = require('../src/api/routes') as typeof import('../src/api/routes');
const { getDb } = require('../src/data/database') as typeof import('../src/data/database');
const { createBus } = require('../src/data/fleet_admin') as typeof import('../src/data/fleet_admin');
const { registerDriver } = require('../src/data/drivers_store') as typeof import('../src/data/drivers_store');
const { createOrUpdateCompanyAdmin } = require('../src/data/empresas') as typeof import('../src/data/empresas');
const { addCompanyRoute } = require('../src/data/routes_store') as typeof import('../src/data/routes_store');
const { upsertPosition } = require('../src/data/positions_store') as typeof import('../src/data/positions_store');
const { signToken } = require('../src/auth/tokens') as typeof import('../src/auth/tokens');
const { hashSecret } = require('../src/auth/passwords') as typeof import('../src/auth/passwords');

const EMPRESA = 'API-COB';
const TELEFONO = '+57800';
const PIN = '1234';

const servidor: Server = createServer((req, res) => {
  if (!handleAPI(req, res)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

let base = '';
let tokenAdmin = '';
let tokenConductor = '';

async function llamar(
  metodo: string,
  ruta: string,
  cuerpo?: unknown,
  cabeceras: Record<string, string> = {},
): Promise<{ estado: number; cuerpo: Record<string, unknown> }> {
  const r = await fetch(`${base}${ruta}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...cabeceras },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  return { estado: r.status, cuerpo: texto ? (JSON.parse(texto) as Record<string, unknown>) : {} };
}

const comoAdmin = (t: string): Record<string, string> => ({ authorization: `Bearer ${t}` });
const conClave = (): Record<string, string> => ({ 'x-admin-key': 'api-cob-admin-key-1234567890' });

test.before(async () => {
  await new Promise<void>((listo) => servidor.listen(0, '127.0.0.1', listo));
  const dir = servidor.address();
  base = `http://127.0.0.1:${typeof dir === 'object' && dir ? dir.port : 0}`;

  getDb().prepare(
    'INSERT OR IGNORE INTO empresas (company_id, name, created_at) VALUES (?, ?, ?)',
  ).run(EMPRESA, 'Empresa Cob', Date.now());
  const admin = createOrUpdateCompanyAdmin(EMPRESA, 'apiadmin', hashSecret('password123456'));
  tokenAdmin = signToken({
    sub: admin.adminId, role: 'admin', companyId: EMPRESA,
    username: admin.username, tv: admin.tokenVersion,
  });
  const bus = createBus(EMPRESA, 'API001', 'R-900');
  if (typeof bus === 'string') throw new Error(`alta API001: ${bus}`);
  addCompanyRoute(EMPRESA, 'R-900', 'Cobertura');
  registerDriver(TELEFONO, 'Cob', 'R-900', {
    companyId: EMPRESA, busId: bus.busId, pinHash: hashSecret(PIN),
  });
  // Viva pero invisible: el pasajero ve {visible:false}; el offline la usa.
  upsertPosition(TELEFONO, {
    busId: 'BUS-API001', routeId: 'R-900', lat: 10.9, lon: -74.8, driverValidated: true,
  });
  // Placa de otra empresa para el choque 409 del alta.
  getDb().prepare(
    'INSERT OR IGNORE INTO empresas (company_id, name, created_at) VALUES (?, ?, ?)',
  ).run('API-OTRA', 'Otra', Date.now());
  const ajeno = createBus('API-OTRA', 'DUP001', 'R-900');
  if (typeof ajeno === 'string') throw new Error(`alta DUP001: ${ajeno}`);
});

test.after(async () => {
  await new Promise<void>((listo) => servidor.close(() => listo()));
  try {
    getDb().close();
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

test('la cabecera de métodos sale del registro, no de una lista a mano', () => {
  const metodos = metodosHttpRegistrados();
  assert.ok(metodos.includes('GET'));
  assert.ok(metodos.includes('POST'));
  assert.ok(metodos.includes('PATCH'));
  assert.ok(metodos.includes('DELETE'));
});

test('lecturas públicas del catálogo y del bus', async () => {
  const empresas = await llamar('GET', '/api/companies');
  assert.equal(empresas.estado, 200);
  assert.ok((empresas.cuerpo as unknown[]).some(
    (e) => (e as { id: string }).id === EMPRESA,
  ));

  assert.equal((await llamar('GET', `/api/companies/${EMPRESA}/routes`)).estado, 200);
  assert.equal((await llamar('GET', `/api/companies/${EMPRESA}/buses`)).estado, 200);

  // Sin posición no hay bus; con el alta invisible se dice visible:false.
  assert.equal((await llamar('GET', '/api/buses/BUS-NO')).estado, 404);
  const oculto = await llamar('GET', '/api/buses/BUS-API001');
  assert.equal(oculto.estado, 200);
  assert.equal(oculto.cuerpo.visible, false);

  assert.equal((await llamar('POST', '/api/gps', {})).estado, 410);
});

test('métricas solo con clave de admin', async () => {
  assert.equal((await llamar('GET', '/api/metrics')).estado, 401);
  const ok = await llamar('GET', '/api/metrics', undefined, conClave());
  assert.equal(ok.estado, 200);
  assert.equal(typeof ok.cuerpo.counters, 'object');
});

test('login de conductor: faltantes, malo y bueno', async () => {
  assert.equal((await llamar('POST', '/api/auth/login', {})).estado, 400);
  assert.equal(
    (await llamar('POST', '/api/auth/login', { phoneNumber: '+57000', pin: 'x' })).estado,
    401,
  );
  const bueno = await llamar('POST', '/api/auth/login', { phoneNumber: TELEFONO, pin: PIN });
  assert.equal(bueno.estado, 200);
  assert.equal(typeof bueno.cuerpo.token, 'string');
  tokenConductor = bueno.cuerpo.token as string;
});

test('ficha y offline del conductor', async () => {
  const ficha = await llamar('GET', `/api/drivers/${TELEFONO}`, undefined, comoAdmin(tokenConductor));
  assert.equal(ficha.estado, 200);
  assert.equal((await llamar('GET', '/api/drivers/+57000', undefined, comoAdmin(tokenConductor))).estado, 403);
  assert.equal((await llamar('GET', `/api/drivers/${TELEFONO}`)).estado, 403);

  const fuera = await llamar(
    'POST', '/api/buses/BUS-API001/offline', {}, comoAdmin(tokenConductor),
  );
  assert.equal(fuera.estado, 200);
  assert.equal(
    (await llamar('POST', '/api/buses/BUS-API001/offline', {})).estado,
    403,
  );
});

test('login de panel: faltantes, malo y bueno', async () => {
  assert.equal((await llamar('POST', '/api/admin/login', {})).estado, 400);
  assert.equal(
    (await llamar('POST', '/api/admin/login', { username: 'apiadmin', password: 'mala' })).estado,
    401,
  );
  const bueno = await llamar(
    'POST', '/api/admin/login', { username: 'apiadmin', password: 'password123456' },
  );
  assert.equal(bueno.estado, 200);
  assert.equal(typeof bueno.cuerpo.token, 'string');
});

test('flota: posiciones y visibilidad', async () => {
  assert.equal((await llamar('GET', '/api/fleet/positions')).estado, 401);
  const pos = await llamar('GET', '/api/fleet/positions', undefined, comoAdmin(tokenAdmin));
  assert.equal(pos.estado, 200);
  assert.equal(pos.cuerpo.companyId, EMPRESA);

  const vis = await llamar(
    'POST', '/api/fleet/buses/BUS-API001/visibility', { visible: true }, comoAdmin(tokenAdmin),
  );
  assert.equal(vis.estado, 200);
  assert.equal(
    (await llamar('POST', '/api/fleet/buses/BUS-API001/visibility', {}, comoAdmin(tokenAdmin))).estado,
    400,
  );
  assert.equal(
    (await llamar('POST', '/api/fleet/buses/BUS-NO/visibility', { visible: true }, comoAdmin(tokenAdmin))).estado,
    404,
  );

  // Visible y con posición viva: el pasajero ve la posición, no el aviso.
  upsertPosition(TELEFONO, {
    busId: 'BUS-API001', routeId: 'R-900', lat: 10.9, lon: -74.8, driverValidated: true,
  });
  const visto = await llamar('GET', '/api/buses/BUS-API001');
  assert.equal(visto.estado, 200);
  assert.equal(visto.cuerpo.busId, 'BUS-API001');

  const todas = await llamar(
    'POST', '/api/fleet/buses/visibility', { visible: false }, comoAdmin(tokenAdmin),
  );
  assert.equal(todas.estado, 200);
  assert.equal(todas.cuerpo.count, 1);
});

test('flota: rutas alta, duplicado, renombre y borrado', async () => {
  const rutas = await llamar('GET', '/api/fleet/routes', undefined, comoAdmin(tokenAdmin));
  assert.equal(rutas.estado, 200);

  const alta = await llamar(
    'POST', '/api/fleet/routes', { routeId: 'R-910', name: 'Nueva' }, comoAdmin(tokenAdmin),
  );
  assert.equal(alta.estado, 201);
  assert.equal(
    (await llamar('POST', '/api/fleet/routes', { routeId: 'R-911', name: 'Nueva' }, comoAdmin(tokenAdmin))).estado,
    400,
  );
  assert.equal(
    (await llamar('POST', '/api/fleet/routes', { routeId: 'R-911', name: '' }, comoAdmin(tokenAdmin))).estado,
    400,
  );

  const renombre = await llamar(
    'PATCH', '/api/fleet/routes/R-910', { name: 'Otra' }, comoAdmin(tokenAdmin),
  );
  assert.equal(renombre.estado, 200);
  assert.equal(
    (await llamar('PATCH', '/api/fleet/routes/R-999', { name: 'Nada' }, comoAdmin(tokenAdmin))).estado,
    404,
  );

  const borrada = await llamar('DELETE', '/api/fleet/routes/R-910', undefined, comoAdmin(tokenAdmin));
  assert.equal(borrada.estado, 200);
  assert.equal(
    (await llamar('DELETE', '/api/fleet/routes/R-910', undefined, comoAdmin(tokenAdmin))).estado,
    404,
  );
});

test('flota: buses alta, choques, edición y borrado', async () => {
  const alta = await llamar(
    'POST', '/api/fleet/buses',
    { placa: 'API002', routeId: 'R-900', tipologia: 'PADRON' },
    comoAdmin(tokenAdmin),
  );
  assert.equal(alta.estado, 201);

  assert.equal(
    (await llamar('POST', '/api/fleet/buses', { placa: '!!', routeId: 'R-900' }, comoAdmin(tokenAdmin))).estado,
    400,
  );
  assert.equal(
    (await llamar('POST', '/api/fleet/buses', { placa: 'DUP001', routeId: 'R-900' }, comoAdmin(tokenAdmin))).estado,
    409,
  );
  assert.equal(
    (await llamar('POST', '/api/fleet/buses', { placa: 'API002', routeId: 'R-900', tipologia: 'COLECTIVO' }, comoAdmin(tokenAdmin))).estado,
    400,
  );
  assert.equal(
    (await llamar('POST', '/api/fleet/buses', { placa: 'API002', routeId: 'R-900', capacidad: 'xx' }, comoAdmin(tokenAdmin))).estado,
    400,
  );

  const edicion = await llamar(
    'PATCH', '/api/fleet/buses/BUS-API002', { interno: '009' }, comoAdmin(tokenAdmin),
  );
  assert.equal(edicion.estado, 200);
  assert.equal(
    (await llamar('PATCH', '/api/fleet/buses/BUS-API002', { routeId: '<mal>' }, comoAdmin(tokenAdmin))).estado,
    400,
  );
  assert.equal(
    (await llamar('PATCH', '/api/fleet/buses/BUS-NO', { interno: '1' }, comoAdmin(tokenAdmin))).estado,
    404,
  );

  const borrado = await llamar('DELETE', '/api/fleet/buses/BUS-API002', undefined, comoAdmin(tokenAdmin));
  assert.equal(borrado.estado, 200);
  assert.equal(
    (await llamar('DELETE', '/api/fleet/buses/BUS-API002', undefined, comoAdmin(tokenAdmin))).estado,
    404,
  );
});

test('admin por clave, borrado total y cierre de sesión', async () => {
  assert.equal(
    (await llamar('POST', `/api/admin/empresas/${EMPRESA}/admin`, { username: 'otro', password: 'corta' })).estado,
    401,
  );
  const creado = await llamar(
    'POST', `/api/admin/empresas/${EMPRESA}/admin`,
    { username: 'otro-panel', password: 'password123456' }, conClave(),
  );
  assert.equal(creado.estado, 201);

  assert.equal(
    (await llamar('DELETE', '/api/fleet/buses', undefined, comoAdmin(tokenAdmin))).estado,
    400,
  );
  const vaciado = await llamar(
    'DELETE', `/api/fleet/buses?confirm=${EMPRESA}`, undefined, comoAdmin(tokenAdmin),
  );
  assert.equal(vaciado.estado, 200);
  assert.ok((vaciado.cuerpo.count as number) >= 1);

  // El cierre revoca: el token que sirvió arriba ya no entra.
  assert.equal((await llamar('POST', '/api/fleet/logout', undefined, comoAdmin(tokenAdmin))).estado, 204);
  assert.equal((await llamar('GET', '/api/fleet/positions', undefined, comoAdmin(tokenAdmin))).estado, 401);
});

test('headers de seguridad presentes y param malformado da 400 sin tumbar', async () => {
  const r = await fetch(`${base}/api/health`);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  await r.text();

  // %E0%A4 incompleto: URL válida pero decodeURIComponent lanza -> 400, no 500.
  const mala = await llamar('POST', '/api/fleet/buses/%E0%A4/visibility', { visible: true }, comoAdmin(tokenAdmin));
  assert.equal(mala.estado, 400);
  const mala2 = await fetch(`${base}/api/admin/empresas/%E0%A4/admin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...conClave() },
    body: JSON.stringify({ username: 'x', password: 'password123456' }),
  });
  assert.equal(mala2.status, 400);
  await mala2.text();
});
