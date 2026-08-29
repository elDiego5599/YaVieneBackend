// Pruebas de las funciones puras de flota y catálogo sobre una base de datos
// desechable. Cubren los tres arreglos de la auditoría del 29/08/2026: el
// número interno que se repetía tras borrar un bus, el identificador de ruta
// que aceptaba guiones sueltos, y el fallback 'R-101' inventado al borrar la
// última ruta de una empresa.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-fleet-'));
process.env.YA_VIENE_DB_PATH = join(tmp, 'test.db');

// Los módulos se cargan con require y no con import porque abren la base al
// evaluarse: el import se izaría por encima de la línea que fija la ruta.
const { createBus, deleteBus, getCompanyBuses } =
  require('../src/data/fleet_admin') as typeof import('../src/data/fleet_admin');
const { addCompanyRoute, removeCompanyRoute, getCompanyRoutes } =
  require('../src/data/routes_store') as typeof import('../src/data/routes_store');
const { getDb } = require('../src/data/database') as typeof import('../src/data/database');

test.after(() => rmSync(tmp, { recursive: true, force: true }));

function nuevaEmpresa(id: string): void {
  getDb().prepare(
    'INSERT OR IGNORE INTO empresas (company_id, name, created_at) VALUES (?, ?, ?)',
  ).run(id, `Empresa ${id}`, Date.now());
}

test('el interno no se repite después de borrar un bus del medio', () => {
  const empresa = 'EMP-INT';
  nuevaEmpresa(empresa);
  addCompanyRoute(empresa, 'R-900', 'Ruta de prueba');

  const uno = createBus(empresa, 'AAA111', 'R-900');
  const dos = createBus(empresa, 'BBB222', 'R-900');
  const tres = createBus(empresa, 'CCC333', 'R-900');
  assert.deepEqual([uno?.interno, dos?.interno, tres?.interno], ['001', '002', '003']);

  // Con COUNT(*)+1 el contador volvía a 2 y el siguiente nacía como '003',
  // chocando con un bus que sigue vivo.
  deleteBus(dos!.busId);
  const cuatro = createBus(empresa, 'DDD444', 'R-900');
  assert.equal(cuatro?.interno, '004');

  const internos = getCompanyBuses(empresa).map((b) => b.interno);
  assert.equal(new Set(internos).size, internos.length, `internos repetidos: ${internos}`);
});

test('el interno explícito manda y no lo pisa el automático', () => {
  const empresa = 'EMP-INT2';
  nuevaEmpresa(empresa);
  addCompanyRoute(empresa, 'R-901', 'Otra');
  assert.equal(createBus(empresa, 'EEE555', 'R-901', '042')?.interno, '042');
  // El siguiente automático continúa desde el mayor, no desde el conteo.
  assert.equal(createBus(empresa, 'FFF666', 'R-901')?.interno, '043');
});

test('el identificador de ruta rechaza guiones sueltos', () => {
  const empresa = 'EMP-RUTA';
  nuevaEmpresa(empresa);
  assert.equal(addCompanyRoute(empresa, '---', 'Ruta rara'), null);
  assert.equal(addCompanyRoute(empresa, '-R-', 'Ruta rara'), null);
  assert.equal(addCompanyRoute(empresa, 'R-', 'Ruta rara'), null);
  assert.equal(addCompanyRoute(empresa, 'R', 'Muy corta'), null);
  assert.equal(addCompanyRoute(empresa, 'R-106', 'Buena')?.routeId, 'R-106');
  assert.equal(addCompanyRoute(empresa, 'RUTA-1A', 'Buena')?.routeId, 'RUTA-1A');
});

test('borrar la última ruta deja los buses sin ruta, no en una inventada', () => {
  const empresa = 'EMP-SOLA';
  nuevaEmpresa(empresa);
  addCompanyRoute(empresa, 'R-950', 'Única');
  const bus = createBus(empresa, 'GGG777', 'R-950');

  assert.equal(removeCompanyRoute(empresa, 'R-950'), true);
  assert.equal(getCompanyRoutes(empresa).length, 0);

  const guardado = getCompanyBuses(empresa).find((b) => b.busId === bus!.busId);
  // Antes quedaba apuntando a 'R-101', una ruta de otra empresa o de ninguna.
  assert.equal(guardado?.routeId ?? null, null);
});

test('borrar una ruta con otra viva mueve los buses a la que queda', () => {
  const empresa = 'EMP-DOS';
  nuevaEmpresa(empresa);
  addCompanyRoute(empresa, 'R-960', 'Primera');
  addCompanyRoute(empresa, 'R-961', 'Segunda');
  const bus = createBus(empresa, 'HHH888', 'R-961');

  assert.equal(removeCompanyRoute(empresa, 'R-961'), true);
  const guardado = getCompanyBuses(empresa).find((b) => b.busId === bus!.busId);
  assert.equal(guardado?.routeId, 'R-960');
});
