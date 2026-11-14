// Los viajes de origen a destino (D20): la intención del planificador, que la
// app manda al tocar «Ir». Sin cuenta, sin IP ni dispositivo: solo el par de
// zonas de 600 m, la franja de 3 horas y la empresa de las rutas del plan.
// Todo contra una base temporal y un servidor en proceso.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-viajes-'));
process.env.YA_VIENE_DB_PATH = join(tmp, 'test.db');
process.env.JWT_SECRET = randomBytes(32).toString('hex');

const { handleAPI } = require('../src/api/routes') as typeof import('../src/api/routes');
const { getDb } = require('../src/data/database') as typeof import('../src/data/database');
const { addCompanyRoute } = require('../src/data/routes_store') as typeof import('../src/data/routes_store');
const { createOrUpdateCompanyAdmin } = require('../src/data/empresas') as typeof import('../src/data/empresas');
const { signToken } = require('../src/auth/tokens') as typeof import('../src/auth/tokens');
const { hashSecret } = require('../src/auth/passwords') as typeof import('../src/auth/passwords');
const { viajesRateLimiter } = require('../src/security/rate_limiter') as typeof import('../src/security/rate_limiter');
const { PASO_LAT, PASO_LNG } = require('../src/data/busquedas') as typeof import('../src/data/busquedas');
const viajes = require('../src/data/viajes_od') as typeof import('../src/data/viajes_od');

const AHORA = Date.parse('2026-11-10T17:40:00.000Z'); // 12:40 p. m. en Barranquilla
const DIA = 24 * 60 * 60_000;
// Cinco zonas de 4 × 4 celdas, una al lado de otra hacia el norte.
const zona = (i: number, j = 0) => viajes.centroZona(10.99 + i * 4 * PASO_LAT, -74.79 + j * 4 * PASO_LNG);
const A = zona(0); const B = zona(1); const C = zona(2); const D = zona(0, 3);

// El reloj de prueba de las rutas solo vale con NODE_ENV=test (entorno.ts lo borra).
function reloj(ms: number) { process.env.NODE_ENV = 'test'; process.env.YA_VIENE_TEST_NOW_MS = String(ms); }
let base = '';
const servidor: Server = createServer((req, res) => { if (!handleAPI(req, res)) { res.writeHead(404); res.end(); } });

function tokenDe(companyId: string): string {
  getDb().prepare('INSERT OR IGNORE INTO empresas (company_id, name, created_at) VALUES (?, ?, ?)').run(companyId, companyId, 0);
  const admin = createOrUpdateCompanyAdmin(companyId, `admin-${companyId.toLowerCase()}`, hashSecret('una clave cualquiera de prueba'));
  return signToken({ sub: admin.adminId, role: 'admin', companyId, username: admin.username, tv: admin.tokenVersion });
}

/** Vacía el limitador: un barrido desde más allá de su ventana. */
const olvidarLimitador = () => viajesRateLimiter.sweep(Date.now() + 10 * 60_000 + 1);

async function enviar(cuerpo: unknown, { limpio = true }: { limpio?: boolean } = {}) {
  if (limpio) olvidarLimitador();
  return fetch(`${base}/api/viajes`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo),
  });
}
const plan = (origen: object, destino: object, rutas: string[]) => ({ origen, destino, rutas });
const filas = () => getDb().prepare('SELECT * FROM viajes_od').all() as Record<string, unknown>[];

test.before(async () => {
  addCompanyRoute('EMP-VIAJES', 'R-V1', 'Ruta uno');
  addCompanyRoute('EMP-VIAJES', 'R-V2', 'Ruta dos');
  addCompanyRoute('EMP-OTRA', 'R-V3', 'Ruta ajena');
  await new Promise<void>((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  const address = servidor.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
test.beforeEach(() => { getDb().prepare('DELETE FROM viajes_od').run(); });
test.after(async () => {
  delete process.env.NODE_ENV; delete process.env.YA_VIENE_TEST_NOW_MS;
  await new Promise<void>((resolve) => servidor.close(() => resolve()));
  getDb().close();
  rmSync(tmp, { recursive: true, force: true });
});

test('centroZona lleva cualquier punto al centro de su zona de 4 × 4 celdas', () => {
  const z = viajes.centroZona(10.9912, -74.7903);
  assert.ok(Math.abs(z.lat / (4 * PASO_LAT) - Math.round(z.lat / (4 * PASO_LAT))) < 1e-8);
  assert.ok(Math.abs(z.lng / (4 * PASO_LNG) - Math.round(z.lng / (4 * PASO_LNG))) < 1e-8);
  assert.deepEqual(viajes.centroZona(z.lat, z.lng), z);
  assert.ok(Math.abs(z.lat - 10.9912) <= 2 * PASO_LAT + 1e-9);
});

test('guarda el par y la empresa, sin nada que identifique a nadie', async () => {
  reloj(AHORA);
  assert.equal((await enviar(plan(A, B, ['R-V1']))).status, 204);
  const columnas = (getDb().prepare('PRAGMA table_info(viajes_od)').all() as { name: string }[]).map(({ name }) => name);
  assert.deepEqual(columnas, ['franja', 'o_lat', 'o_lng', 'd_lat', 'd_lng', 'company_id', 'count']);
  const [fila] = filas();
  assert.equal(fila.company_id, 'EMP-VIAJES');
  assert.equal(fila.count, 1);
  // 12:40 p. m. cae en la franja de 12 m. a 3 p. m. (hora de Bogotá).
  assert.equal(new Date(Number(fila.franja)).toISOString(), '2026-11-10T17:00:00.000Z');
  await enviar(plan(A, B, ['R-V1']));
  assert.equal(filas()[0].count, 2);
});

test('el servidor pone la hora: la que mande la app es un error', async () => {
  const r = await enviar({ ...plan(A, B, ['R-V1']), hora: '2026-11-10T17:00:00Z' });
  assert.equal(r.status, 400);
  assert.equal(filas().length, 0);
});

test('un plan con dos rutas de una empresa cuenta una vez; con dos empresas, una por empresa', async () => {
  await enviar(plan(A, B, ['R-V1', 'R-V2']));
  assert.deepEqual(filas().map((f) => f.company_id), ['EMP-VIAJES']);
  assert.equal(filas()[0].count, 1);
  await enviar(plan(A, C, ['R-V1', 'R-V3']));
  assert.deepEqual(filas().map((f) => f.company_id).sort(), ['EMP-OTRA', 'EMP-VIAJES', 'EMP-VIAJES']);
});

test('rechaza en la frontera lo que no es un plan de zonas', async () => {
  const celdaFina = { lat: 10.99035, lng: -74.78967 }; // centro de una celda de 150 m, no de una zona
  const casos: [string, unknown][] = [
    ['sin cuerpo', null],
    ['arreglo', []],
    ['origen que no es zona', plan(celdaFina, B, ['R-V1'])],
    ['destino que no es zona', plan(A, celdaFina, ['R-V1'])],
    ['fuera del área', plan({ lat: 4, lng: -74.08 }, B, ['R-V1'])],
    ['no finitos', plan({ lat: 'NaN', lng: A.lng }, B, ['R-V1'])],
    ['sin origen', { destino: B, rutas: ['R-V1'] }],
    ['misma zona', plan(A, A, ['R-V1'])],
    ['sin rutas', plan(A, B, [])],
    ['tres rutas', plan(A, B, ['R-V1', 'R-V2', 'R-V3'])],
    ['ruta repetida', plan(A, B, ['R-V1', 'R-V1'])],
    ['ruta que no es texto', plan(A, B, [7])],
    ['ruta que no existe', plan(A, B, ['R-NO'])],
    ['ruta demasiado larga', plan(A, B, ['R'.repeat(65)])],
    ['campo de más', { ...plan(A, B, ['R-V1']), dispositivo: 'abc' }],
    ['campo de más en la zona', plan({ ...A, precision: 5 }, B, ['R-V1'])],
  ];
  for (const [nombre, cuerpo] of casos) {
    assert.equal((await enviar(cuerpo)).status, 400, nombre);
  }
  assert.equal(filas().length, 0);
  const grande = await fetch(`${base}/api/viajes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: ' '.repeat(33_000) });
  assert.equal(grande.status, 413);
});

test('el limitador corta a quien manda demasiado, y solo cuenta lo que se guarda', async () => {
  olvidarLimitador();
  for (let i = 0; i < 30; i += 1) assert.equal((await enviar(plan(A, B, ['R-V1']), { limpio: false })).status, 204);
  assert.equal((await enviar(plan(A, B, ['R-V1']), { limpio: false })).status, 429);
  olvidarLimitador();
  assert.equal((await enviar(plan(A, B, ['R-V1']))).status, 204);
});

test('el tope diario de filas nuevas protege la tabla; sumar a una fila que existe sigue valiendo', async () => {
  reloj(AHORA);
  await enviar(plan(A, B, ['R-V1']));
  const franja = Number(filas()[0].franja);
  const poner = getDb().prepare('INSERT INTO viajes_od(franja, o_lat, o_lng, d_lat, d_lng, company_id, count) VALUES (?, ?, ?, ?, ?, ?, 1)');
  getDb().transaction(() => {
    for (let i = 1; i < viajes.MAX_FILAS_POR_DIA; i += 1) poner.run(franja, 1, i, 2, 3, 'EMP-VIAJES');
  })();
  assert.equal((await enviar(plan(A, C, ['R-V1']))).status, 503);
  assert.equal((await enviar(plan(A, B, ['R-V1']))).status, 204);
  assert.equal(filas().find((f) => f.o_lat === A.lat && f.d_lat === B.lat)?.count, 2);
});

function poner(veces: number, origen: object, destino: object, empresa: string, cuando: number) {
  for (let i = 0; i < veces; i += 1) viajes.registrarViaje(origen as never, destino as never, [empresa], cuando);
}
const DIA1 = Date.parse('2026-10-20T05:00:00.000Z'); // 20 oct, medianoche en Barranquilla

test('k ≥ 5 por día de Bogotá, par y empresa: cuatro no salen', () => {
  poner(5, A, B, 'EMP-VIAJES', DIA1 + 11 * 3_600_000);
  poner(4, A, C, 'EMP-VIAJES', DIA1 + 11 * 3_600_000);
  const pares = viajes.viajesDeEmpresa('EMP-VIAJES', DIA1, DIA1 + DIA, {});
  assert.deepEqual(pares, [{ origen: A, destino: B, total: 5 }]);
});

test('lo de otra empresa nunca sale, ni sumado', () => {
  poner(5, A, B, 'EMP-OTRA', DIA1 + 11 * 3_600_000);
  poner(3, A, B, 'EMP-VIAJES', DIA1 + 11 * 3_600_000);
  assert.deepEqual(viajes.viajesDeEmpresa('EMP-VIAJES', DIA1, DIA1 + DIA, {}), []);
  assert.equal(viajes.viajesDeEmpresa('EMP-OTRA', DIA1, DIA1 + DIA, {}).length, 1);
});

// AUD29-01 otra vez: el umbral va por cubeta, no por la suma del rango.
test('dos rangos solapados no dejan ver un día con menos de 5', () => {
  poner(5, A, B, 'EMP-VIAJES', DIA1 + 11 * 3_600_000);
  poner(2, A, B, 'EMP-VIAJES', DIA1 + DIA + 11 * 3_600_000);
  const suma = (hasta: number) => viajes.viajesDeEmpresa('EMP-VIAJES', DIA1, hasta, {}).reduce((s, p) => s + p.total, 0);
  assert.equal(suma(DIA1 + 3 * DIA) - suma(DIA1 + DIA), 0);
  assert.equal(suma(DIA1 + 3 * DIA), 5);
});

test('un día suma al otro cuando cada uno pasa el umbral', () => {
  poner(5, A, B, 'EMP-VIAJES', DIA1 + 11 * 3_600_000);
  poner(6, A, B, 'EMP-VIAJES', DIA1 + DIA + 11 * 3_600_000);
  assert.deepEqual(viajes.viajesDeEmpresa('EMP-VIAJES', DIA1, DIA1 + 2 * DIA, {}), [{ origen: A, destino: B, total: 11 }]);
});

test('el filtro de franja y de días se aplica antes del umbral', () => {
  poner(3, A, B, 'EMP-VIAJES', DIA1 + 3_600_000); // 1 a. m., franja 0
  poner(5, A, B, 'EMP-VIAJES', DIA1 + 6 * 3_600_000); // 6 a. m., franja 2
  assert.equal(viajes.viajesDeEmpresa('EMP-VIAJES', DIA1, DIA1 + DIA, { franja: 2 })[0].total, 5);
  assert.deepEqual(viajes.viajesDeEmpresa('EMP-VIAJES', DIA1, DIA1 + DIA, { franja: 0 }), []);
  assert.equal(viajes.viajesDeEmpresa('EMP-VIAJES', DIA1, DIA1 + DIA, {})[0].total, 8);
  // 20 oct 2026 fue martes: ISO 2.
  assert.equal(viajes.viajesDeEmpresa('EMP-VIAJES', DIA1, DIA1 + DIA, { dias: [2] }).length, 1);
  assert.equal(viajes.viajesDeEmpresa('EMP-VIAJES', DIA1, DIA1 + DIA, { dias: [3] }).length, 0);
});

test('ordena por total y corta en los 200 pares más fuertes', () => {
  poner(5, A, B, 'EMP-VIAJES', DIA1 + 11 * 3_600_000);
  poner(9, A, D, 'EMP-VIAJES', DIA1 + 11 * 3_600_000);
  assert.deepEqual(viajes.viajesDeEmpresa('EMP-VIAJES', DIA1, DIA1 + DIA, {}).map((p) => p.total), [9, 5]);
});

test('retención: lo de más de 13 meses se borra', () => {
  poner(1, A, B, 'EMP-VIAJES', AHORA - 397 * DIA);
  poner(1, A, B, 'EMP-VIAJES', AHORA);
  assert.equal(viajes.limpiarViajes(AHORA), 1);
  assert.equal(filas().length, 1);
});

test('GET /api/panel/viajes: sin sesión 401, con rango malo 400, y solo lo de su empresa', async () => {
  poner(5, A, B, 'EMP-VIAJES', DIA1 + 11 * 3_600_000);
  poner(5, A, C, 'EMP-OTRA', DIA1 + 11 * 3_600_000);
  const rango = `desde=${new Date(DIA1).toISOString()}&hasta=${new Date(DIA1 + DIA).toISOString()}`;
  const pedir = (consulta: string, token?: string) => fetch(`${base}/api/panel/viajes?${consulta}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  assert.equal((await pedir(rango)).status, 401);
  const token = tokenDe('EMP-VIAJES');
  assert.equal((await pedir('desde=2026-10-21T00:00:00Z&hasta=2026-10-20T00:00:00Z', token)).status, 400);
  assert.equal((await pedir(`${rango}&franja=8`, token)).status, 400);
  assert.equal((await pedir(`${rango}&dias=0`, token)).status, 400);
  const r = await pedir(`${rango}&franja=4`, token);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { pares: [] }); // 11 a. m. es la franja 3, no la 4
  const ok = await pedir(rango, token);
  assert.deepEqual(await ok.json(), { pares: [{ origen: A, destino: B, total: 5 }] });
});
