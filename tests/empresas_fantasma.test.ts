// Prueba de `eliminarEmpresasFantasma`, la limpieza que corre la migración 17.
//
// El caso real: en la base local había una fila `EMP-02` cuyo nombre era su
// propio identificador. Como el catálogo público ordena por nombre, "EMP-02"
// salía delante de "Sobusa" y era la primera empresa que veía el pasajero al
// abrir la app. Lo que se prueba aquí es que la limpieza se lleva esa fila con
// todo lo que colgaba de ella, y que no toca una empresa de verdad.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-fantasma-'));
process.env.YA_VIENE_DB_PATH = join(tmp, 'test.db');

// require y no import: estos módulos abren la base al evaluarse, y un import
// se izaría por encima de la línea que fija la ruta.
const { getDb, eliminarEmpresasFantasma } =
  require('../src/data/database') as typeof import('../src/data/database');
const { getEmpresas } = require('../src/data/empresas') as typeof import('../src/data/empresas');

test.after(() => rmSync(tmp, { recursive: true, force: true }));

function sembrarFantasma(id: string): void {
  const d = getDb();
  const ahora = Date.now();
  d.prepare('INSERT OR IGNORE INTO empresas (company_id, name, created_at) VALUES (?, ?, ?)')
    .run(id, id, ahora);
  d.prepare('INSERT OR IGNORE INTO company_routes (company_id, route_id, name, created_at) VALUES (?, ?, ?, ?)')
    .run(id, 'R-101', 'Ruta vieja', ahora);
  d.prepare(`INSERT OR IGNORE INTO buses (bus_id, company_id, plate_number, capacity, status, created_at, updated_at)
             VALUES (?, ?, ?, 40, 'active', ?, ?)`)
    .run(`${id}-BUS`, id, 'XXX000', ahora, ahora);
  d.prepare(`INSERT OR IGNORE INTO drivers (phone_number, driver_id, name, route_id, company_id, bus_id, registered_at)
             VALUES (?, ?, ?, 'R-101', ?, ?, ?)`)
    .run(`300${id}`, `drv-${id}`, 'Fleet Driver', id, `${id}-BUS`, ahora);
  d.prepare(`INSERT OR IGNORE INTO turn_assignments (assignment_id, driver_id, bus_id, company_id, route_id, started_at, status)
             VALUES (?, ?, ?, ?, 'R-101', ?, 'active')`)
    .run(`turno-${id}`, `drv-${id}`, `${id}-BUS`, id, ahora);
}

test('la empresa fantasma desaparece del catálogo con todo lo que colgaba de ella', () => {
  const d = getDb();
  sembrarFantasma('EMP-FANTASMA');

  // Antes: sale en el catálogo público, y encima de primera — es justo el
  // síntoma que veía el usuario, no un detalle de la base.
  assert.ok(getEmpresas().some((e) => e.companyId === 'EMP-FANTASMA'));

  assert.deepEqual(eliminarEmpresasFantasma(d), ['EMP-FANTASMA']);

  assert.equal(getEmpresas().some((e) => e.companyId === 'EMP-FANTASMA'), false);
  for (const tabla of ['buses', 'drivers', 'company_routes', 'turn_assignments']) {
    const { n } = d.prepare(`SELECT COUNT(*) AS n FROM ${tabla} WHERE company_id = ?`)
      .get('EMP-FANTASMA') as { n: number };
    assert.equal(n, 0, `quedaron ${n} filas huérfanas en ${tabla}`);
  }
});

test('una empresa con nombre propio no se toca', () => {
  const d = getDb();
  const ahora = Date.now();
  d.prepare('INSERT OR IGNORE INTO empresas (company_id, name, created_at) VALUES (?, ?, ?)')
    .run('EMP-REAL', 'Transporte Real', ahora);

  assert.deepEqual(eliminarEmpresasFantasma(d), []);
  assert.ok(getEmpresas().some((e) => e.companyId === 'EMP-REAL'));
});

test('una empresa sin nombre pero con cuenta de panel tampoco se toca', () => {
  const d = getDb();
  const ahora = Date.now();
  d.prepare('INSERT OR IGNORE INTO empresas (company_id, name, created_at) VALUES (?, ?, ?)')
    .run('EMP-CONPANEL', 'EMP-CONPANEL', ahora);
  d.prepare(`INSERT OR IGNORE INTO empresa_admins (admin_id, company_id, username, password_hash, created_at)
             VALUES (?, ?, ?, ?, ?)`)
    .run('adm-1', 'EMP-CONPANEL', 'jefe', 'hash', ahora);

  assert.deepEqual(eliminarEmpresasFantasma(d), []);
  assert.ok(getEmpresas().some((e) => e.companyId === 'EMP-CONPANEL'));
});
