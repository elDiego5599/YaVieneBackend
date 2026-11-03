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

// AUD29-01: el umbral k=5 se miraba sobre la suma de todo el rango, y el
// rango iba al milisegundo. Restando dos rangos solapados salían las
// búsquedas de una celda aunque fueran 2. Ahora cada día de Bogotá y celda
// pasa el umbral por su cuenta, y el rango va en días enteros.
test('dos rangos solapados no dejan ver una celda con menos de 5 en un día', async () => {
  getDb().prepare('DELETE FROM busquedas WHERE route_id = ?').run('R-777');
  const lat = 10.99035, lng = -74.78967;
  const dia1 = Date.parse('2026-10-20T05:00:00.000Z'); // 20 oct, medianoche en Barranquilla
  const dia2 = dia1 + 24 * 60 * 60_000;
  const dia3 = dia2 + 24 * 60 * 60_000;
  for (let i = 0; i < 5; i += 1) registrarBusqueda('R-777', lat, lng, dia1 + 11 * 60 * 60_000);
  registrarBusqueda('R-777', lat, lng, dia2 + 11 * 60 * 60_000);
  registrarBusqueda('R-777', lat, lng, dia2 + 11 * 60 * 60_000);
  const cuenta = (desde: number, hasta: number, hora?: number) =>
    (calorBusquedas('EMP-BUSQUEDAS', 'R-777', desde, hasta, hora) as { count: number }[])
      .reduce((suma, celda) => suma + celda.count, 0);
  assert.equal(cuenta(dia1, dia3) - cuenta(dia1, dia2), 0);
  assert.equal(cuenta(dia1, dia3, 6) - cuenta(dia1, dia2, 6), 0);
  assert.equal(cuenta(dia1, dia3), 5);

  const admin = createOrUpdateCompanyAdmin('EMP-BUSQUEDAS', 'busquedasadmin', hashSecret('password123456'));
  const token = signToken({
    sub: admin.adminId, role: 'admin', companyId: 'EMP-BUSQUEDAS', username: admin.username, tv: admin.tokenVersion,
  });
  const calor = async (desde: string, hasta: string) => {
    const respuesta = await fetch(`${base}/api/panel/busquedas/R-777/calor?desde=${desde}&hasta=${hasta}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: respuesta.status, celdas: respuesta.ok ? (await respuesta.json() as { celdas: { count: number }[] }).celdas : [] };
  };
  // Un corte a media mañana del día 2 se lleva a días enteros: da lo mismo
  // que el rango de los dos días, sin partir un día en dos.
  const partido = await calor('2026-10-20T05:00:00.000Z', '2026-10-21T16:00:00.000Z');
  const entero = await calor('2026-10-20T05:00:00.000Z', '2026-10-22T05:00:00.000Z');
  assert.equal(partido.status, 200);
  assert.deepEqual(partido.celdas, entero.celdas);
  // Más largo que lo que se guarda (13 meses) no tiene nada que contar.
  assert.equal((await calor('2025-01-01T05:00:00.000Z', '2026-10-22T05:00:00.000Z')).status, 400);
});

// Reportes recorta el rango a unos días de la semana («todos los lunes de
// los dos últimos meses», dueño, 2026-11-02). El día es el de Barranquilla:
// el lunes a las 11 p. m. allá ya es martes en UTC y cuenta como lunes.
test('el panel cuenta solo los días de la semana pedidos, en hora de Barranquilla', async () => {
  getDb().prepare('DELETE FROM busquedas WHERE route_id = ?').run('R-777');
  getDb().prepare(
    'INSERT OR IGNORE INTO empresas (company_id, name, created_at) VALUES (?, ?, ?)',
  ).run('EMP-BUSQUEDAS', 'Empresa búsquedas', Date.now());
  const admin = createOrUpdateCompanyAdmin('EMP-BUSQUEDAS', 'busquedasadmin', hashSecret('password123456'));
  const token = signToken({
    sub: admin.adminId, role: 'admin', companyId: 'EMP-BUSQUEDAS', username: admin.username, tv: admin.tokenVersion,
  });
  const lat = 10.99035, lng = -74.78967;
  const lunes = Date.parse('2026-10-19T05:00:00.000Z'); // lunes 19 oct, medianoche allá
  const dia = 24 * 60 * 60_000;
  for (let i = 0; i < 5; i += 1) registrarBusqueda('R-777', lat, lng, lunes + 23 * 60 * 60_000); // lunes, 11 p. m.
  for (let i = 0; i < 6; i += 1) registrarBusqueda('R-777', lat, lng, lunes + dia + 8 * 60 * 60_000); // martes
  for (let i = 0; i < 7; i += 1) registrarBusqueda('R-777', lat, lng, lunes + 6 * dia + 9 * 60 * 60_000); // domingo
  const desde = lunes, hasta = lunes + 7 * dia;
  const total = (dias: number[], hora?: number) =>
    rankingBusquedas('EMP-BUSQUEDAS', desde, hasta, hora, dias).find(({ routeId }) => routeId === 'R-777')?.total;
  const calor = (dias: number[], hora?: number) =>
    (calorBusquedas('EMP-BUSQUEDAS', 'R-777', desde, hasta, hora, dias) as { count: number }[])
      .reduce((suma, celda) => suma + celda.count, 0);
  assert.equal(total([1]), 5);
  assert.equal(total([1, 7]), 12);
  assert.equal(total([3]), 0);
  assert.equal(calor([2]), 6);
  assert.equal(calor([7, 1]), 12);
  // Con la hora también: el martes a las 8 a. m. sí, el lunes a esa hora no.
  assert.equal(total([1, 2], 8), 6);
  assert.equal(calor([1, 2], 8), 6);

  // Las lecturas del panel comparten un tope por minuto (abajo): pocas aquí.
  const pedir = (ruta: string, dias: string) => fetch(
    `${base}${ruta}?desde=${new Date(desde).toISOString()}&hasta=${new Date(hasta).toISOString()}&dias=${dias}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const { rutas } = await (await pedir('/api/panel/busquedas', '7,1')).json() as { rutas: { routeId: string; total: number }[] };
  assert.equal(rutas.find(({ routeId }) => routeId === 'R-777')?.total, 12);
  const { celdas } = await (await pedir('/api/panel/busquedas/R-777/calor', '2')).json() as { celdas: { count: number }[] };
  assert.deepEqual(celdas.map(({ count }) => count), [6]);
  for (const malo of ['', '0', '8', 'x', '1,1', '1.5', '1,,2']) {
    assert.equal((await pedir('/api/panel/busquedas', malo)).status, 400, `dias=${malo}`);
  }
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
