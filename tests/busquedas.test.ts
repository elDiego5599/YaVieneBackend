import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-busquedas-'));
process.env.YA_VIENE_DB_PATH = join(tmp, 'test.db');
process.env.JWT_SECRET = randomBytes(32).toString('hex');
const { handleAPI } = require('../src/api/routes') as typeof import('../src/api/routes');
const { getDb } = require('../src/data/database') as typeof import('../src/data/database');
const { addCompanyRoute } = require('../src/data/routes_store') as typeof import('../src/data/routes_store');
const { createOrUpdateCompanyAdmin } = require('../src/data/empresas') as typeof import('../src/data/empresas');
const { signToken } = require('../src/auth/tokens') as typeof import('../src/auth/tokens');
const { hashSecret } = require('../src/auth/passwords') as typeof import('../src/auth/passwords');
const { calorBusquedas, horaBogota, limpiarBusquedas, PASO_LAT, PASO_LNG, rankingBusquedas, registrarBusqueda } = require('../src/data/busquedas') as typeof import('../src/data/busquedas');
const server = createServer((req, res) => { if (!handleAPI(req, res)) { res.writeHead(404); res.end(); } });
let base = '';
test.before(async () => {
  addCompanyRoute('EMP-BUSQUEDAS', 'R-777', 'Ruta de prueba');
  addCompanyRoute('EMP-AJENA', 'R-778', 'Ruta ajena');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  getDb().close();
  rmSync(tmp, { recursive: true, force: true });
});

test('registra búsquedas en celdas y rechaza ruta desconocida, coordenadas fuera y no finitas', async () => {
  const send = (body: unknown) => fetch(`${base}/api/busquedas`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await send({ routeId: 'R-777', celda: { lat: 10.99035, lng: -74.78967 } })).status, 204);
  assert.equal((await send({ routeId: 'R-NO-EXISTE' })).status, 400);
  assert.equal((await send({ routeId: 'R-777', celda: { lat: 4, lng: -74.79 } })).status, 400);
  assert.equal((await send({ routeId: 'R-777', celda: { lat: 'NaN', lng: -74.79 } })).status, 400);
  const raw = await fetch(`${base}/api/busquedas`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: ' '.repeat(33_000) });
  assert.equal(raw.status, 413);
  const columnas = getDb().prepare('PRAGMA table_info(busquedas)').all() as { name: string }[];
  assert.deepEqual(columnas.map(({ name }) => name), [
    'route_id', 'hora', 'celda_key', 'celda_lat', 'celda_lng', 'count',
  ]);
  const row = getDb().prepare('SELECT celda_lat, celda_lng FROM busquedas').get() as { celda_lat: number; celda_lng: number };
  assert.ok(Math.abs(row.celda_lat / PASO_LAT - Math.round(row.celda_lat / PASO_LAT)) < 1e-8);
  assert.ok(Math.abs(row.celda_lng / PASO_LNG - Math.round(row.celda_lng / PASO_LNG)) < 1e-8);
});

test('el agregado incrementa y usa hora local de Barranquilla', async () => {
  const enviar = () => fetch(`${base}/api/busquedas`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ routeId: 'R-777', celda: { lat: 10.99035, lng: -74.78967 } }) });
  await enviar(); await enviar();
  const row = getDb().prepare('SELECT count FROM busquedas WHERE route_id = ?').get('R-777') as { count: number };
  assert.equal(row.count, 3);
});

test('ranking por hora local, aislamiento, k=5 y retención de 13 meses', () => {
  getDb().prepare('DELETE FROM busquedas WHERE route_id = ?').run('R-777');
  const instante = Date.parse('2026-10-25T11:30:00.000Z'); // 6:30 a. m. en Barranquilla
  assert.equal(new Date(horaBogota(instante)).toISOString(), '2026-10-25T11:00:00.000Z');
  for (let i = 0; i < 5; i += 1) registrarBusqueda('R-777', 10.99035, -74.78967, instante);
  registrarBusqueda('R-777', null, null, instante);
  registrarBusqueda('R-778', 10.99035, -74.78967, instante);
  const desde = Date.parse('2026-10-25T00:00:00.000Z');
  const hasta = Date.parse('2026-10-26T00:00:00.000Z');
  const [ruta] = rankingBusquedas('EMP-BUSQUEDAS', desde, hasta, 6);
  assert.equal(ruta.total, 6);
  assert.equal(ruta.porHora[6], 6);
  assert.deepEqual(rankingBusquedas('EMP-AJENA', desde, hasta).map((item) => item.routeId), ['R-778']);
  assert.deepEqual(calorBusquedas('EMP-AJENA', 'R-777', desde, hasta), null);
  assert.equal(calorBusquedas('EMP-BUSQUEDAS', 'R-777', desde, hasta)?.length, 1);
  assert.equal(calorBusquedas('EMP-AJENA', 'R-778', desde, hasta)?.length, 0);
  registrarBusqueda('R-777', null, null, instante - 397 * 24 * 60 * 60_000);
  assert.ok(limpiarBusquedas(instante) >= 1);
});

test('el panel cuenta un rango de varios días, sin lo de fuera, y rechaza uno invertido', async () => {
  getDb().prepare('DELETE FROM busquedas WHERE route_id = ?').run('R-777');
  getDb().prepare(
    'INSERT OR IGNORE INTO empresas (company_id, name, created_at) VALUES (?, ?, ?)',
  ).run('EMP-BUSQUEDAS', 'Empresa búsquedas', Date.now());
  const admin = createOrUpdateCompanyAdmin('EMP-BUSQUEDAS', 'busquedasadmin', hashSecret('password123456'));
  const token = signToken({
    sub: admin.adminId, role: 'admin', companyId: 'EMP-BUSQUEDAS', username: admin.username, tv: admin.tokenVersion,
  });
  // Del 20 al 25 de octubre en Barranquilla: medianoche local = 05:00 UTC.
  registrarBusqueda('R-777', null, null, Date.parse('2026-10-19T23:00:00.000Z')); // 19 oct, fuera
  registrarBusqueda('R-777', null, null, Date.parse('2026-10-20T06:00:00.000Z')); // 20 oct, 1 a. m.
  registrarBusqueda('R-777', null, null, Date.parse('2026-10-22T17:00:00.000Z'));
  registrarBusqueda('R-777', null, null, Date.parse('2026-10-26T04:30:00.000Z')); // 25 oct, 11 p. m.
  registrarBusqueda('R-777', null, null, Date.parse('2026-10-26T05:00:00.000Z')); // 26 oct, fuera
  const pedir = (desde: string, hasta: string) => fetch(
    `${base}/api/panel/busquedas?desde=${desde}&hasta=${hasta}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const respuesta = await pedir('2026-10-20T05:00:00.000Z', '2026-10-26T05:00:00.000Z');
  assert.equal(respuesta.status, 200);
  const { rutas } = await respuesta.json() as { rutas: { routeId: string; total: number }[] };
  assert.deepEqual(rutas.map(({ routeId, total }) => ({ routeId, total })), [{ routeId: 'R-777', total: 3 }]);
  assert.equal((await pedir('2026-10-26T05:00:00.000Z', '2026-10-20T05:00:00.000Z')).status, 400);
});

// AUD29-14: las dos lecturas del panel no tenían tope y un token de empresa
// podía pedir el calor sin freno. Comparten el de las lecturas de flota (120
// por minuto) con su propia cuenta, para que leer el calor no gaste la flota.
test('las lecturas de búsquedas del panel tienen tope por minuto', async () => {
  const admin = createOrUpdateCompanyAdmin('EMP-BUSQUEDAS', 'busquedasadmin', hashSecret('password123456'));
  const token = signToken({
    sub: admin.adminId, role: 'admin', companyId: 'EMP-BUSQUEDAS', username: admin.username, tv: admin.tokenVersion,
  });
  const leer = (ruta: string) => fetch(`${base}${ruta}`, { headers: { authorization: `Bearer ${token}` } });
  // La prueba de arriba ya gastó dos lecturas del mismo cupo: a las 121 a
  // más tardar tiene que cerrarse, y luego para las dos rutas.
  let lecturas = 0;
  while (lecturas < 121 && (await leer(lecturas % 2 ? '/api/panel/busquedas' : '/api/panel/busquedas/R-777/calor')).status === 200) lecturas += 1;
  assert.ok(lecturas >= 100 && lecturas < 121, `se cerró tras ${lecturas} lecturas`);
  assert.equal((await leer('/api/panel/busquedas/R-777/calor')).status, 429);
  assert.equal((await leer('/api/panel/busquedas')).status, 429);
});
