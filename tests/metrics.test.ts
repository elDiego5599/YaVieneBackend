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

// T3.11: la memoria de los limitadores está acotada por el barrido, pero
// nadie la veía. Cada volcado de métricas publica cuántas claves recuerda
// cada uno y avisa en el log una vez cuando alguno pasa de 10 000, que es
// cuando un túnel con una IP por visitante empieza a pesar de verdad.
test('las métricas publican el tamaño de cada limitador', async () => {
  const limitadores = await import('../src/security/rate_limiter');
  limitadores.readRateLimiter.allow('203.0.113.1:read');
  limitadores.readRateLimiter.allow('203.0.113.2:read');

  limitadores.registrarTamanosLimitadores();

  const gauges = metrics.getMetrics().gauges;
  assert.equal(gauges['ratelimit.read.claves'], limitadores.readRateLimiter.size);
  assert.ok(gauges['ratelimit.read.claves'] >= 2);
  for (const nombre of ['login', 'loginIp', 'admin', 'read', 'fleetWrite']) {
    assert.equal(typeof gauges[`ratelimit.${nombre}.claves`], 'number', nombre);
  }
});

test('un limitador con más de 10 000 claves avisa una vez por subida', async () => {
  const { SlidingWindowRateLimiter, registrarTamanosLimitadores } =
    await import('../src/security/rate_limiter');
  // sweepEvery enorme: aquí el barrido lo decide la prueba.
  const grande = new SlidingWindowRateLimiter(1, 60_000, Number.MAX_SAFE_INTEGER);
  const avisos: string[] = [];
  const avisar = (mensaje: string) => avisos.push(mensaje);
  for (let i = 0; i < 10_000; i++) grande.allow(`k${i}`, 0);

  registrarTamanosLimitadores({ grande }, avisar);
  assert.equal(avisos.length, 0, 'justo en 10 000 no avisa');

  grande.allow('k-extra', 0);
  registrarTamanosLimitadores({ grande }, avisar);
  registrarTamanosLimitadores({ grande }, avisar);
  assert.equal(avisos.length, 1, 'avisa al pasar, no en cada volcado');
  assert.match(avisos[0], /grande/);
  assert.match(avisos[0], /10001/);
  assert.equal(metrics.getMetrics().gauges['ratelimit.grande.claves'], 10_001);

  // Tras el barrido baja, y una nueva subida vuelve a avisar.
  grande.sweep(120_000);
  registrarTamanosLimitadores({ grande }, avisar);
  for (let i = 0; i < 10_001; i++) grande.allow(`j${i}`, 120_000);
  registrarTamanosLimitadores({ grande }, avisar);
  assert.equal(avisos.length, 2);
});
