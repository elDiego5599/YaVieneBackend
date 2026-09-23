// Tipología y aforo a nivel de funciones puras (cuenta para cobertura:
// los tests con backend hijo ejercitan `dist`, no `src`).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-tipo-store-'));
process.env.YA_VIENE_DB_PATH = join(tmp, 'test.db');

// Ver fleet_store.test.ts: require y no import porque la ruta se fija arriba.
const {
  createBus, updateBus, getFleetPositions,
  normalizeTipologia, normalizeCapacidad,
  CAPACIDAD_POR_TIPOLOGIA, MIN_CAPACIDAD, MAX_CAPACIDAD,
} = require('../src/data/fleet_admin') as typeof import('../src/data/fleet_admin');
const { addCompanyRoute } =
  require('../src/data/routes_store') as typeof import('../src/data/routes_store');
const { getDb } = require('../src/data/database') as typeof import('../src/data/database');

test.after(() => {
  try {
    getDb().close();
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

function nuevaEmpresa(id: string): void {
  getDb().prepare(
    'INSERT OR IGNORE INTO empresas (company_id, name, created_at) VALUES (?, ?, ?)',
  ).run(id, `Empresa ${id}`, Date.now());
}

test('tipologia: lista cerrada, sin tildes y case-insensitive', () => {
  assert.equal(normalizeTipologia('SENCILLO'), 'SENCILLO');
  assert.equal(normalizeTipologia('padron'), 'PADRON');
  assert.equal(normalizeTipologia('  Articulado  '), 'ARTICULADO');
  assert.equal(normalizeTipologia('BUSETA'), null);
  assert.equal(normalizeTipologia('PADRÓN'), null);
  assert.equal(normalizeTipologia(''), null);
  assert.equal(normalizeTipologia(undefined), null);
  assert.equal(normalizeTipologia(42), null);
  assert.deepEqual({ ...CAPACIDAD_POR_TIPOLOGIA }, { SENCILLO: 30, PADRON: 60, ARTICULADO: 80 });
  assert.ok(MIN_CAPACIDAD <= 30 && MAX_CAPACIDAD >= 80);
});

test('capacidad: entero en rango, número o texto numérico', () => {
  assert.equal(normalizeCapacidad(30), 30);
  assert.equal(normalizeCapacidad('60'), 60);
  assert.equal(normalizeCapacidad(' 80 '), 80);
  assert.equal(normalizeCapacidad(0), null);
  assert.equal(normalizeCapacidad(-5), null);
  assert.equal(normalizeCapacidad(3.5), null);
  assert.equal(normalizeCapacidad(301), null);
  assert.equal(normalizeCapacidad('mucha'), null);
  assert.equal(normalizeCapacidad(''), null);
  assert.equal(normalizeCapacidad(undefined), null);
  assert.equal(normalizeCapacidad(null), null);
});

test('alta: defaults, explícitos e inválidos a nivel de store', () => {
  const empresa = 'EMP-TS';
  nuevaEmpresa(empresa);
  addCompanyRoute(empresa, 'R-950', 'Ruta tipo');

  const d = createBus(empresa, 'TSA111', 'R-950');
  assert.notEqual(typeof d, 'string');
  if (typeof d === 'string') return;
  assert.equal(d.tipologia, 'SENCILLO');
  assert.equal(d.capacidad, 30);

  const p = createBus(empresa, 'TSB222', 'R-950', undefined, { tipologia: 'PADRON', capacidad: 60 });
  assert.notEqual(typeof p, 'string');
  if (typeof p === 'string') return;
  assert.equal(p.tipologia, 'PADRON');
  assert.equal(p.capacidad, 60);

  assert.equal(createBus(empresa, 'TSC333', 'R-950', undefined, { tipologia: 'BUSETA' }), 'invalid');
  assert.equal(createBus(empresa, 'TSD444', 'R-950', undefined, { capacidad: 0 }), 'invalid');

  // Renovar sin mandar nada conserva; con tipología nueva no pisa la manual.
  const r1 = createBus(empresa, 'TSB222', 'R-950');
  assert.notEqual(typeof r1, 'string');
  if (typeof r1 === 'string') return;
  assert.equal(r1.tipologia, 'PADRON');
  assert.equal(r1.capacidad, 60);
  const r2 = createBus(empresa, 'TSB222', 'R-950', undefined, { tipologia: 'ARTICULADO' });
  assert.notEqual(typeof r2, 'string');
  if (typeof r2 === 'string') return;
  assert.equal(r2.tipologia, 'ARTICULADO');
  assert.equal(r2.capacidad, 60);
});

test('edición directa: cambia, valida y conserva la manual', () => {
  const empresa = 'EMP-TS2';
  nuevaEmpresa(empresa);
  addCompanyRoute(empresa, 'R-951', 'Otra');
  const b = createBus(empresa, 'TSE555', 'R-951', undefined, { tipologia: 'PADRON', capacidad: 55 });
  assert.notEqual(typeof b, 'string');
  if (typeof b === 'string') return;

  const e1 = updateBus(b.busId, { tipologia: 'ARTICULADO', capacidad: 80 });
  assert.notEqual(e1, null);
  assert.notEqual(e1, 'taken');
  if (!e1 || e1 === 'taken') return;
  assert.equal(e1.tipologia, 'ARTICULADO');
  assert.equal(e1.capacidad, 80);

  const e2 = updateBus(b.busId, { tipologia: 'SENCILLO' });
  assert.notEqual(e2, null);
  assert.notEqual(e2, 'taken');
  if (!e2 || e2 === 'taken') return;
  assert.equal(e2.tipologia, 'SENCILLO');
  assert.equal(e2.capacidad, 80);

  assert.equal(updateBus(b.busId, { tipologia: 'NOPE' }), null);
  assert.equal(updateBus(b.busId, { capacidad: -1 }), null);

  const flota = getFleetPositions(empresa).find((x) => x.busId === b.busId);
  assert.equal(flota?.tipologia, 'SENCILLO');
  assert.equal(flota?.capacidad, 80);
});

test('migración 23: columna tipologia con default y capacity adoptada', () => {
  const columnas = getDb().prepare('PRAGMA table_info(buses)').all() as {
    name: string; dflt_value: unknown; notnull: number;
  }[];
  const tipo = columnas.find((c) => c.name === 'tipologia');
  const cap = columnas.find((c) => c.name === 'capacity');
  assert.ok(tipo, 'existe tipologia');
  assert.equal(tipo?.dflt_value, "'SENCILLO'");
  assert.ok(cap, 'existe capacity');
});
