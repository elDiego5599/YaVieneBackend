import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-busquedas-'));
process.env.YA_VIENE_DB_PATH = join(tmp, 'test.db');
const { handleAPI } = require('../src/api/routes') as typeof import('../src/api/routes');
const { getDb } = require('../src/data/database') as typeof import('../src/data/database');
const { addCompanyRoute } = require('../src/data/routes_store') as typeof import('../src/data/routes_store');
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
