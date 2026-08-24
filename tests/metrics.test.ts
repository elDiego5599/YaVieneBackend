import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// La ruta de la base se lee al cargar el módulo: hay que fijarla ANTES del
// primer import de database.ts para no tocar la base real de desarrollo.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaviene-metrics-'));
process.env.YA_VIENE_DB_PATH = path.join(tmpDir, 'metrics-test.db');
process.env.JWT_SECRET = 'test-jwt-secret';

type DatabaseModule = typeof import('../src/data/database');
type MetricsModule = typeof import('../src/observability/metrics');
let db: ReturnType<DatabaseModule['getDb']>;
let metrics: MetricsModule;

test('setup: abre la base temporal y carga las métricas', async () => {
  const database = await import('../src/data/database');
  metrics = await import('../src/observability/metrics');
  db = database.getDb();
  assert.ok(db);
});

test('las métricas sobreviven al reinicio: persistidas + en memoria', async () => {
  // Simula un ciclo anterior que dejó contadores en disco.
  db.prepare(
    "INSERT INTO metrics (name, value) VALUES ('position.accepted', 10)",
  ).run();

  metrics.restoreMetrics();
  assert.equal(metrics.getMetrics().counters['position.accepted'], 10);

  // Tráfico nuevo sobre la línea base restaurada.
  metrics.incrementMetric('position.accepted', 3);
  assert.equal(metrics.getMetrics().counters['position.accepted'], 13);

  metrics.flushMetrics();

  const persisted = db.prepare(
    "SELECT value FROM metrics WHERE name = 'position.accepted'",
  ).get() as { value: number };
  assert.equal(persisted.value, 13);
});

test('un restore tardío no duplica la línea base', () => {
  // El flag restored evita re-sumar lo ya cargado.
  metrics.restoreMetrics();
  metrics.flushMetrics();
  const persisted = db.prepare(
    "SELECT value FROM metrics WHERE name = 'position.accepted'",
  ).get() as { value: number };
  assert.equal(persisted.value, 13);
});
