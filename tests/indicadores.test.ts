// Los indicadores de servicio de una ruta, sacados del historial de
// posiciones: cuántos buses andan y a qué velocidad en cada hora de
// Barranquilla, y cada cuánto pasa un bus por la mitad de la ruta en cada
// sentido (el intervalo, o headway). Las muestras se escriben a mano en
// `posiciones_historial` para que cada número de la prueba se pueda
// sacar con lápiz.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-indicadores-'));
process.env.YA_VIENE_DB_PATH = join(tmp, 'test.db');
process.env.JWT_SECRET = randomBytes(32).toString('hex');
const { handleAPI } = require('../src/api/routes') as typeof import('../src/api/routes');
const { getDb } = require('../src/data/database') as typeof import('../src/data/database');
const { addCompanyRoute } = require('../src/data/routes_store') as typeof import('../src/data/routes_store');
const { createOrUpdateCompanyAdmin } = require('../src/data/empresas') as typeof import('../src/data/empresas');
const { signToken } = require('../src/auth/tokens') as typeof import('../src/auth/tokens');
const { hashSecret } = require('../src/auth/passwords') as typeof import('../src/auth/passwords');
const { indicadoresDeRuta, indicadoresCsv } = require('../src/data/indicadores') as typeof import('../src/data/indicadores');
const { consolidarDia } = require('../src/data/consolidacion') as typeof import('../src/data/consolidacion');

const server = createServer((req, res) => { if (!handleAPI(req, res)) { res.writeHead(404); res.end(); } });
let base = '';
test.before(async () => {
  for (const [empresa, ruta] of [['EMP-IND', 'R-IND'], ['EMP-IND', 'R-IND2'], ['EMP-IND', 'R-IND3'], ['EMP-IND', 'R-IND4'], ['EMP-IND', 'R-IND5'], ['EMP-IND', 'R-IND6'], ['EMP-IND', 'R-IND7'], ['EMP-OTRA', 'R-OTRA']]) {
    addCompanyRoute(empresa, ruta, `Ruta ${ruta}`);
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  getDb().close();
  rmSync(tmp, { recursive: true, force: true });
});

const MIN = 60_000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;
// 07:00 en Barranquilla (UTC-5) del viernes 20 de noviembre de 2026.
const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);
const DESDE = Date.UTC(2026, 10, 20, 5);
const HASTA = Date.UTC(2026, 10, 22, 5);

function muestra(m: {
  bus: string; t: number; ruta?: string; fraccion?: number | null; sentido?: 'ida' | 'venida' | null;
  velocidad?: number; simulado?: boolean;
}): void {
  getDb().prepare(`
    INSERT INTO posiciones_historial (
      bus_id, route_id, company_id, lat, lon, speed_kmh, heading, sentido,
      fraccion_ruta, sentido_ruta, captured_at, received_at, simulado
    ) VALUES (?, ?, 'EMP-IND', 10.96, -74.79, ?, NULL, NULL, ?, ?, ?, ?, ?)
  `).run(m.bus, m.ruta ?? 'R-IND', m.velocidad ?? 20, m.fraccion ?? null, m.sentido ?? null, m.t, m.t, m.simulado ? 1 : 0);
}

/** Un bus que cruza la mitad de la ruta a los 15 s de [t]: 0,4 → 0,6 de ida, o al revés de venida. */
function cruce(bus: string, t: number, sentido: 'ida' | 'venida', ruta = 'R-IND'): void {
  const [antes, despues] = sentido === 'ida' ? [0.4, 0.6] : [0.6, 0.4];
  muestra({ bus, t, ruta, fraccion: antes, sentido });
  muestra({ bus, t: t + 30_000, ruta, fraccion: despues, sentido });
}

test('una ruta que no es de la empresa no tiene indicadores', () => {
  assert.equal(indicadoresDeRuta('EMP-IND', 'R-OTRA', DESDE, HASTA), null);
  assert.equal(indicadoresDeRuta('EMP-IND', 'R-NO-EXISTE', DESDE, HASTA), null);
});

test('por hora de Barranquilla: buses que andan en promedio por día y velocidad en marcha', () => {
  // Las 7: dos buses el viernes y uno el sábado → 1,5 buses en promedio.
  // Velocidad: 20 y 30 en marcha; el de 2 km/h está parado y no cuenta.
  muestra({ bus: 'A', t: T0, ruta: 'R-IND2', velocidad: 20 });
  muestra({ bus: 'A', t: T0 + MIN, ruta: 'R-IND2', velocidad: 2 });
  muestra({ bus: 'B', t: T0 + 10 * MIN, ruta: 'R-IND2', velocidad: 30 });
  muestra({ bus: 'A', t: T0 + DIA, ruta: 'R-IND2', velocidad: 25 });
  // Fuera del rango: no cuenta.
  muestra({ bus: 'C', t: HASTA + HORA, ruta: 'R-IND2', velocidad: 90 });

  const r = indicadoresDeRuta('EMP-IND', 'R-IND2', DESDE, HASTA);
  assert.ok(r);
  assert.equal(r.porHora.length, 24);
  assert.deepEqual(r.porHora[7], { hora: 7, busesPromedio: 1.5, velocidadPromedioKmh: 25, intervaloIda: null, intervaloVenida: null });
  assert.deepEqual(r.porHora[8], { hora: 8, busesPromedio: 0, velocidadPromedioKmh: null, intervaloIda: null, intervaloVenida: null });
  assert.equal(r.horaPico, 7);
  assert.equal(r.simulado, false);
});

test('intervalo de ida: cada cuánto cruza un bus la mitad de la ruta, con mediana y p90', () => {
  // Cruces a T0+15 s, +10 min y +25 min → intervalos de 10 y 15 minutos;
  // y de venida, uno solo: sin intervalo todavía.
  cruce('A', T0, 'ida');
  cruce('B', T0 + 10 * MIN, 'ida');
  cruce('C', T0 + 25 * MIN, 'ida');
  cruce('A', T0 + 40 * MIN, 'venida');

  const r = indicadoresDeRuta('EMP-IND', 'R-IND', DESDE, HASTA);
  assert.ok(r);
  assert.deepEqual(r.intervalos.ida, { medianaMin: 12.5, p90Min: 15, pasos: 3 });
  assert.equal(r.intervalos.venida, null);
});

test('el intervalo también sale hora por hora: cada hueco cuenta en la hora en que llega el bus', () => {
  // Ida a las 7:00:15 y 7:50:15 (50 min), 8:05:15 (15 min) y 8:15:15 (10 min).
  for (const [bus, min] of [['L', 0], ['M', 50], ['N', 65], ['O', 75]] as const) cruce(bus, T0 + min * MIN, 'ida', 'R-IND5');
  const r = indicadoresDeRuta('EMP-IND', 'R-IND5', DESDE, HASTA);
  assert.ok(r);
  assert.deepEqual(r.porHora[7].intervaloIda, { medianaMin: 50, p90Min: 50, pasos: 2 });
  assert.deepEqual(r.porHora[8].intervaloIda, { medianaMin: 12.5, p90Min: 15, pasos: 2 });
  assert.equal(r.porHora[9].intervaloIda, null);
  assert.equal(r.porHora[8].intervaloVenida, null);
});

test('indicadoresCsv: una fila por hora, con cabecera fija, punto y coma y decimal coma (Excel en español)', () => {
  cruce('P', T0, 'venida', 'R-IND6');
  cruce('Q', T0 + 20 * MIN, 'venida', 'R-IND6');
  const r = indicadoresDeRuta('EMP-IND', 'R-IND6', DESDE, HASTA);
  assert.ok(r);
  const lineas = indicadoresCsv('R-IND6', r).split('\r\n');
  assert.equal(lineas[0], 'ruta;hora;buses_promedio;velocidad_promedio_kmh;intervalo_ida_mediana_min;intervalo_ida_p90_min;intervalo_venida_mediana_min;intervalo_venida_p90_min;simulado');
  assert.equal(lineas.length, 1 + 24 + 1);
  assert.equal(lineas[25], '');
  assert.equal(lineas[1], 'R-IND6;0;0;;;;;;false');
  // A las 7 anduvieron dos buses a 20 km/h y de venida pasaron con 20 min.
  assert.equal(lineas[8], 'R-IND6;7;2;20;;;20;20;false');
});
test('indicadoresCsv: un decimal sale con coma, como lo lee Excel en español de Colombia', () => {
  const r = indicadoresDeRuta('EMP-IND', 'R-IND6', HASTA, HASTA + HORA);
  assert.ok(r);
  r.porHora[7].busesPromedio = 2.5;
  r.porHora[7].velocidadPromedioKmh = 18.3;
  assert.equal(indicadoresCsv('R-IND6', r).split('\r\n')[8], 'R-IND6;7;2,5;18,3;;;;;false');
});

test('indicadoresCsv: un campo con punto y coma, comilla o salto va entre comillas', () => {
  const vacio = indicadoresDeRuta('EMP-IND', 'R-IND6', HASTA, HASTA + HORA);
  assert.ok(vacio);
  assert.ok(indicadoresCsv('R "1";\nx', vacio).split('\r\n')[1].startsWith('"R ""1"";\nx";0;'));
});

test('el cruce se interpola: no se redondea a la muestra', () => {
  // 0,2 → 0,7 en 30 s: la mitad se cruza a los 18 s. 0,45 → 0,55: a los 15 s.
  muestra({ bus: 'D', t: T0, ruta: 'R-IND3', fraccion: 0.2, sentido: 'ida' });
  muestra({ bus: 'D', t: T0 + 30_000, ruta: 'R-IND3', fraccion: 0.7, sentido: 'ida' });
  muestra({ bus: 'E', t: T0 + 3 * MIN, ruta: 'R-IND3', fraccion: 0.45, sentido: 'ida' });
  muestra({ bus: 'E', t: T0 + 3 * MIN + 30_000, ruta: 'R-IND3', fraccion: 0.55, sentido: 'ida' });
  const r = indicadoresDeRuta('EMP-IND', 'R-IND3', DESDE, HASTA);
  assert.ok(r);
  // (3 min + 15 s) − 18 s = 2 min 57 s = 2,95 min.
  assert.deepEqual(r.intervalos.ida, { medianaMin: 2.95, p90Min: 2.95, pasos: 2 });
});

test('no cuentan los saltos sin señal, el sentido al revés ni las pausas largas del servicio', () => {
  cruce('F', T0, 'ida', 'R-IND4');
  // Cuatro minutos sin muestras entre 0,4 y 0,6: no se sabe cuándo cruzó.
  muestra({ bus: 'G', t: T0 + 5 * MIN, ruta: 'R-IND4', fraccion: 0.4, sentido: 'ida' });
  muestra({ bus: 'G', t: T0 + 9 * MIN, ruta: 'R-IND4', fraccion: 0.6, sentido: 'ida' });
  // Sube la fracción pero va de venida: no es un cruce de ida.
  muestra({ bus: 'H', t: T0 + 6 * MIN, ruta: 'R-IND4', fraccion: 0.4, sentido: 'venida' });
  muestra({ bus: 'H', t: T0 + 6 * MIN + 30_000, ruta: 'R-IND4', fraccion: 0.6, sentido: 'venida' });
  // Sin fracción (fuera del recorrido): no cuenta.
  muestra({ bus: 'I', t: T0 + 7 * MIN, ruta: 'R-IND4' });
  muestra({ bus: 'I', t: T0 + 7 * MIN + 30_000, ruta: 'R-IND4' });
  cruce('J', T0 + 12 * MIN, 'ida', 'R-IND4');
  // Tres horas después: es otro turno, no un intervalo de 3 h.
  cruce('K', T0 + 3 * HORA + 12 * MIN, 'ida', 'R-IND4');

  const r = indicadoresDeRuta('EMP-IND', 'R-IND4', DESDE, HASTA);
  assert.ok(r);
  assert.deepEqual(r.intervalos.ida, { medianaMin: 12, p90Min: 12, pasos: 3 });
});

test('dice si lo medido viene de la flota de ejemplo', () => {
  muestra({ bus: 'S', t: T0 + 2 * HORA, ruta: 'R-IND2', simulado: true });
  const r = indicadoresDeRuta('EMP-IND', 'R-IND2', DESDE, HASTA);
  assert.equal(r?.simulado, true);
});

test('los días ya consolidados salen del resumen: siguen ahí cuando la retención borra lo crudo', () => {
  // Medianoche del sábado 31 de octubre: tres semanas antes, ya sin crudo.
  const VIEJO = DESDE - 20 * DIA;
  // A las 7: A a 20 y 40 km/h, B parado y un bus de ejemplo a 10.
  muestra({ bus: 'A', t: VIEJO + 7 * HORA, ruta: 'R-IND7', velocidad: 20 });
  muestra({ bus: 'A', t: VIEJO + 7 * HORA + MIN, ruta: 'R-IND7', velocidad: 40 });
  muestra({ bus: 'B', t: VIEJO + 7 * HORA + 2 * MIN, ruta: 'R-IND7', velocidad: 0 });
  muestra({ bus: 'S', t: VIEJO + 7 * HORA, ruta: 'R-IND7', velocidad: 10, simulado: true });
  consolidarDia(VIEJO);
  getDb().prepare(`DELETE FROM posiciones_historial WHERE route_id = 'R-IND7'`).run();
  // El domingo 1, consolidado y con lo crudo aún guardado: cuenta una vez.
  muestra({ bus: 'D', t: VIEJO + DIA + 7 * HORA, ruta: 'R-IND7', velocidad: 30 });
  consolidarDia(VIEJO + DIA);
  // El viernes 20, sin consolidar todavía: sale de lo crudo.
  muestra({ bus: 'C', t: T0, ruta: 'R-IND7', velocidad: 25 });

  const r = indicadoresDeRuta('EMP-IND', 'R-IND7', VIEJO, HASTA);
  assert.ok(r);
  // Buses: 3, 1 y 1 en tres días → 1,7. Velocidad en marcha, muestra a
  // muestra como en lo crudo: (20 + 40 + 10 + 30 + 25) / 5 = 25.
  assert.deepEqual(r.porHora[7], { hora: 7, busesPromedio: 1.7, velocidadPromedioKmh: 25, intervaloIda: null, intervaloVenida: null });
  assert.equal(r.simulado, true);
  // Solo el sábado: los días de la semana también filtran el resumen.
  assert.equal(indicadoresDeRuta('EMP-IND', 'R-IND7', VIEJO, HASTA, [6])?.porHora[7].busesPromedio, 3);
});

test('GET /api/panel/indicadores/:routeId pide administrador, rango válido y ruta propia', async () => {
  const url = (ruta: string, query = '') => `${base}/api/panel/indicadores/${ruta}${query}`;
  assert.equal((await fetch(url('R-IND'))).status, 401);

  getDb().prepare('INSERT OR IGNORE INTO empresas (company_id, name, created_at) VALUES (?, ?, ?)').run('EMP-IND', 'Empresa', Date.now());
  const admin = createOrUpdateCompanyAdmin('EMP-IND', 'indadmin', hashSecret('password123456'));
  const token = signToken({ sub: admin.adminId, role: 'admin', companyId: 'EMP-IND', username: admin.username, tv: admin.tokenVersion });
  const headers = { authorization: `Bearer ${token}` };
  const rango = `?desde=${new Date(DESDE).toISOString()}&hasta=${new Date(HASTA).toISOString()}`;

  assert.equal((await fetch(url('R-OTRA', rango), { headers })).status, 404);
  assert.equal((await fetch(url('R-IND', '?desde=nada'), { headers })).status, 400);
  const ok = await fetch(url('R-IND', rango), { headers });
  assert.equal(ok.status, 200);
  const cuerpo = await ok.json() as { routeId: string; intervalos: { ida: unknown }; porHora: unknown[] };
  assert.equal(cuerpo.routeId, 'R-IND');
  assert.deepEqual(cuerpo.intervalos.ida, { medianaMin: 12.5, p90Min: 15, pasos: 3 });
  assert.equal(cuerpo.porHora.length, 24);

  // Con ?formato=csv baja como archivo, con su nombre, y el mismo filtro.
  const csv = await fetch(url('R-IND', `${rango}&formato=csv`), { headers });
  assert.equal(csv.status, 200);
  assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.equal(csv.headers.get('content-disposition'), 'attachment; filename="indicadores-R-IND-2026-11-20-a-2026-11-21.csv"');
  const texto = await csv.text();
  assert.ok(texto.startsWith('ruta;hora;'));
  assert.equal(texto.split('\r\n').length, 26);
  assert.equal((await fetch(url('R-IND', `${rango}&formato=xml`), { headers })).status, 400);
});
