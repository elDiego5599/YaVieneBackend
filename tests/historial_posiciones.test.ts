// El historial de posiciones: `positions` guarda solo la última de cada bus,
// y lo que se quiere medir (intervalos, velocidades, horas pico) necesita
// el recorrido. Cada posición aceptada deja una muestra, como mucho una
// cada MUESTREO_HISTORIAL_MS por bus, y la limpieza borra lo que pasó la
// retención. Patrón require-tras-env de stores_cobertura.test.ts.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-historial-'));
process.env.YA_VIENE_DB_PATH = join(tmp, 'test.db');
process.env.ADMIN_API_KEY = 'historial-admin-key';
process.env.JWT_SECRET = 'historial-jwt-secret';

const { getDb } = require('../src/data/database') as typeof import('../src/data/database');
const empresas = require('../src/data/empresas') as typeof import('../src/data/empresas');
const conductores = require('../src/data/drivers_store') as typeof import('../src/data/drivers_store');
const posiciones = require('../src/data/positions_store') as typeof import('../src/data/positions_store');
const historial = require('../src/data/historial') as typeof import('../src/data/historial');

test.after(() => {
  try {
    getDb().close();
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

interface Muestra {
  bus_id: string; route_id: string; company_id: string; lat: number; lon: number;
  speed_kmh: number; heading: number | null; sentido: string | null;
  captured_at: number; received_at: number; simulado: number;
}

function muestras(busId: string): Muestra[] {
  return getDb().prepare(
    'SELECT * FROM posiciones_historial WHERE bus_id = ? ORDER BY captured_at',
  ).all(busId) as Muestra[];
}

function busConConductor(phone: string, busId: string, simulado = false): void {
  const companyId = 'HIS-E';
  empresas.ensureEmpresa(companyId);
  getDb().prepare(`
    INSERT OR IGNORE INTO buses (bus_id, company_id, route_id, is_demo, created_at, updated_at)
    VALUES (?, ?, 'R-900', ?, ?, ?)
  `).run(busId, companyId, simulado ? 1 : 0, Date.now(), Date.now());
  conductores.registerDriver(phone, `N ${busId}`, 'R-900', { driverId: `D-${busId}`, companyId, busId });
}

const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);

test('cada posición aceptada deja su muestra, con lo que se midió', () => {
  busConConductor('+57301', 'BUS-HIS1');
  const viva = posiciones.upsertPosition('+57301', {
    busId: 'BUS-HIS1', lat: 10.96, lon: -74.79, heading: 90, speedKmh: 23.5,
    sentido: 'ida', sessionId: 's1', capturedAt: T0, sequence: 1, driverValidated: true,
  });
  assert.ok(viva);

  const [m] = muestras('BUS-HIS1');
  assert.equal(muestras('BUS-HIS1').length, 1);
  assert.equal(m.route_id, 'R-900');
  assert.equal(m.company_id, 'HIS-E');
  assert.equal(m.lat, 10.96);
  assert.equal(m.lon, -74.79);
  assert.equal(m.speed_kmh, 23.5);
  assert.equal(m.heading, 90);
  assert.equal(m.captured_at, T0);
  assert.equal(m.received_at, viva.receivedAt);
  assert.equal(m.simulado, 0);
});

test('una posición rechazada (secuencia repetida o vieja) no deja muestra', () => {
  busConConductor('+57302', 'BUS-HIS2');
  const base = { busId: 'BUS-HIS2', lat: 10.96, lon: -74.79, sessionId: 's2', driverValidated: true };
  posiciones.upsertPosition('+57302', { ...base, capturedAt: T0, sequence: 5 });
  assert.equal(posiciones.upsertPosition('+57302', { ...base, capturedAt: T0 + 60_000, sequence: 5 }), null);
  assert.equal(posiciones.upsertPosition('+57302', { ...base, capturedAt: T0 + 90_000, sequence: 4 }), null);
  assert.equal(muestras('BUS-HIS2').length, 1);
});

test('un bus fuera del catálogo no deja muestra', () => {
  assert.equal(posiciones.upsertPosition('+57309', {
    busId: 'BUS-NO-EXISTE', routeId: 'R-900', lat: 10.9, lon: -74.8, driverValidated: true,
  }), null);
  assert.equal(muestras('BUS-NO-EXISTE').length, 0);
});

test('como mucho una muestra por bus cada MUESTREO_HISTORIAL_MS', () => {
  busConConductor('+57303', 'BUS-HIS3');
  const base = { busId: 'BUS-HIS3', lat: 10.96, lon: -74.79, sessionId: 's3', driverValidated: true };
  const paso = historial.MUESTREO_HISTORIAL_MS;
  posiciones.upsertPosition('+57303', { ...base, capturedAt: T0, sequence: 1 });
  // Aceptada en `positions` (la última se actualiza) pero muy pronto para el historial.
  assert.ok(posiciones.upsertPosition('+57303', { ...base, capturedAt: T0 + paso - 1, sequence: 2 }));
  assert.ok(posiciones.upsertPosition('+57303', { ...base, capturedAt: T0 + paso, sequence: 3 }));
  assert.deepEqual(muestras('BUS-HIS3').map((m) => m.captured_at), [T0, T0 + paso]);
});

test('la muestra de un bus de la flota de ejemplo va marcada como simulada', () => {
  busConConductor('+57304', 'BUS-HIS4', true);
  posiciones.upsertPosition('+57304', {
    busId: 'BUS-HIS4', lat: 10.96, lon: -74.79, sessionId: 's4', capturedAt: T0, sequence: 1, driverValidated: true,
  });
  assert.equal(muestras('BUS-HIS4')[0].simulado, 1);
});

test('limpiarHistorial borra lo que pasó la retención y deja lo demás', () => {
  busConConductor('+57305', 'BUS-HIS5');
  const ahora = T0 + 30 * 24 * 60 * 60 * 1000;
  const base = { busId: 'BUS-HIS5', lat: 10.96, lon: -74.79, sessionId: 's5', driverValidated: true };
  posiciones.upsertPosition('+57305', { ...base, capturedAt: ahora - historial.RETENCION_HISTORIAL_MS - historial.MUESTREO_HISTORIAL_MS, sequence: 1 });
  posiciones.upsertPosition('+57305', { ...base, capturedAt: ahora - historial.RETENCION_HISTORIAL_MS, sequence: 2 });

  const borradas = historial.limpiarHistorial(ahora);
  assert.ok(borradas >= 1);
  assert.deepEqual(muestras('BUS-HIS5').map((m) => m.captured_at), [ahora - historial.RETENCION_HISTORIAL_MS]);
});

test('la muestra guarda dónde iba el bus en su ruta (fracción y sentido)', () => {
  assert.ok(historial.registrarMuestra({
    busId: 'BUS-HIS6', routeId: 'R-900', companyId: 'HIS-E', lat: 10.96, lon: -74.79,
    speedKmh: 18, heading: null, sentido: null, capturedAt: T0, receivedAt: T0,
    simulado: false, fraccionRuta: 0.42, sentidoRuta: 'venida',
  }));
  const fila = getDb().prepare(
    'SELECT fraccion_ruta, sentido_ruta FROM posiciones_historial WHERE bus_id = ?',
  ).get('BUS-HIS6') as { fraccion_ruta: number | null; sentido_ruta: string | null };
  assert.deepEqual({ ...fila }, { fraccion_ruta: 0.42, sentido_ruta: 'venida' });
});

test('al entrar por el ingreso, la muestra lleva la fracción que calculó la visibilidad', () => {
  // R-101 tiene recorrido en rutas.json; a mitad de sus puntos el bus no
  // está en ninguna terminal y la fracción queda entre 0 y 1.
  const companyId = 'HIS-E';
  empresas.ensureEmpresa(companyId);
  getDb().prepare(`
    INSERT OR IGNORE INTO buses (bus_id, company_id, route_id, is_demo, created_at, updated_at)
    VALUES ('BUS-HIS7', ?, 'R-101', 0, ?, ?)
  `).run(companyId, Date.now(), Date.now());
  conductores.registerDriver('+57307', 'N BUS-HIS7', 'R-101', { driverId: 'D-BUS-HIS7', companyId, busId: 'BUS-HIS7' });
  assert.ok(posiciones.upsertPosition('+57307', {
    busId: 'BUS-HIS7', lat: 11.03324281268486, lon: -74.8730856244276, speedKmh: 20,
    sentido: 'ida', sessionId: 's7', capturedAt: T0, sequence: 1, driverValidated: true,
  }));
  const viva = getDb().prepare('SELECT route_fraction FROM positions WHERE bus_id = ?')
    .get('BUS-HIS7') as { route_fraction: number };
  const fila = getDb().prepare('SELECT fraccion_ruta, sentido_ruta FROM posiciones_historial WHERE bus_id = ?')
    .get('BUS-HIS7') as { fraccion_ruta: number; sentido_ruta: string };
  assert.ok(fila.fraccion_ruta > 0 && fila.fraccion_ruta < 1);
  assert.equal(fila.fraccion_ruta, viva.route_fraction);
  assert.equal(fila.sentido_ruta, 'ida');
});
