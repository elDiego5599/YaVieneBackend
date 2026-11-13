// La posición pública dice si el bus es de la flota de ejemplo.
//
// La app del pasajero saca la hora de llegada (D24) de lo que de verdad
// avanzan los buses de la ruta. Con la flota de ejemplo ese avance lo dibuja
// el simulador, así que el rango tiene que salir con la etiqueta
// «Simulación», y la app no tenía cómo saberlo: `buses.is_demo` no salía
// del servidor.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-posicion-simulada-'));
process.env.YA_VIENE_DB_PATH = join(tmp, 'test.db');

// require y no import: estos módulos abren la base al evaluarse.
const { getDb } = require('../src/data/database') as typeof import('../src/data/database');
const posiciones = require('../src/data/positions_store') as typeof import('../src/data/positions_store');

test.after(() => {
  try {
    getDb().close();
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

function darDeAlta(busId: string, deEjemplo: boolean): void {
  const ahora = Date.now();
  getDb().prepare(`INSERT INTO buses (bus_id, company_id, route_id, is_demo, created_at, updated_at)
                   VALUES (?, 'EMP-01', 'R-101', ?, ?, ?)`)
    .run(busId, deEjemplo ? 1 : 0, ahora, ahora);
}

function publicar(busId: string) {
  const posicion = posiciones.upsertPosition(`tel-${busId}`, {
    busId, lat: 10.9878, lon: -74.7889, speedKmh: 25, sequence: 1,
    sessionId: `sesion-${busId}`, driverValidated: true, companyId: 'EMP-01',
  });
  assert.ok(posicion, `${busId} no publicó`);
  return posicion;
}

test('un bus de la flota de ejemplo publica su posición como simulada, y uno de verdad no', () => {
  darDeAlta('BUS-EJE001', true);
  darDeAlta('BUS-REA001', false);

  assert.equal(posiciones.toPublicPosition(publicar('BUS-EJE001')).simulado, true);
  assert.equal(posiciones.toPublicPosition(publicar('BUS-REA001')).simulado, false);
});

test('lo que se lee de la base lo dice igual: la ruta, el bus y el que quedó sin señal', () => {
  const deLaRuta = new Map(posiciones.getPositionsByRoute('R-101').map((p) => [p.busId, p.simulado]));
  assert.deepEqual([...deLaRuta].sort(), [['BUS-EJE001', true], ['BUS-REA001', false]]);
  assert.equal(posiciones.getPosition('BUS-EJE001')?.simulado, true);
  assert.equal(posiciones.getPosition('BUS-REA001')?.simulado, false);

  // El barrido lee con RETURNING, sin el catálogo al lado.
  getDb().prepare('UPDATE positions SET timestamp = timestamp - 600000').run();
  const sinSenal = new Map(posiciones.sweepPositions(60_000).toGhost.map((p) => [p.busId, p.simulado]));
  assert.deepEqual([...sinSenal].sort(), [['BUS-EJE001', true], ['BUS-REA001', false]]);
});
