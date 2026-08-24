import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// La ruta de la base se lee al cargar el módulo: hay que fijarla ANTES del
// primer import de database.ts para no tocar la base real de desarrollo.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaviene-outbox-'));
process.env.YA_VIENE_DB_PATH = path.join(tmpDir, 'outbox-test.db');
process.env.JWT_SECRET = 'test-jwt-secret';

type DatabaseModule = typeof import('../src/data/database');
type LifecycleEvents = typeof import('../src/data/lifecycle_events');
let database: DatabaseModule;
let outbox: LifecycleEvents;

test('setup: abre la base temporal y carga el outbox', async () => {
  database = await import('../src/data/database');
  outbox = await import('../src/data/lifecycle_events');
  database.getDb();
  assert.ok(outbox.MAX_ATTEMPTS >= 1);
});

test('outbox: un evento que entrega sale de la cola con delivered_at', () => {
  const db = database.getDb();
  outbox.queueLifecycleEvent(db, 'bus:left', 'RUTA-1', { busId: 'B-1' });
  let entregados = 0;
  outbox.dispatchLifecycleEvents(() => {
    entregados += 1;
  });
  assert.equal(entregados, 1);
  const row = db.prepare(
    'SELECT delivered_at, dead_at FROM lifecycle_events WHERE route_id = ?',
  ).get('RUTA-1') as { delivered_at: number | null; dead_at: number | null };
  assert.ok(row.delivered_at, 'debe quedar entregado');
  assert.equal(row.dead_at, null);
});

test('outbox: un evento venenoso muere tras MAX_ATTEMPTS y deja de reclamarse', () => {
  const db = database.getDb();
  outbox.queueLifecycleEvent(db, 'bus:hidden', 'RUTA-2', { busId: 'B-2' });

  const lanzarSiempre = (): void => {
    throw new Error('suscriptor roto');
  };
  for (let i = 0; i < outbox.MAX_ATTEMPTS; i += 1) {
    assert.doesNotThrow(() => outbox.dispatchLifecycleEvents(lanzarSiempre));
  }

  const muerto = db.prepare(
    'SELECT attempts, dead_at, last_error, delivered_at FROM lifecycle_events WHERE route_id = ?',
  ).get('RUTA-2') as {
    attempts: number;
    dead_at: number | null;
    last_error: string | null;
    delivered_at: number | null;
  };
  assert.equal(muerto.attempts, outbox.MAX_ATTEMPTS, 'intentos exactamente al techo');
  assert.ok(muerto.dead_at, 'debe quedar marcado como muerto');
  assert.ok(muerto.last_error?.includes('suscriptor roto'), 'conserva el error');
  assert.equal(muerto.delivered_at, null);

  // Ya no se reclama: otro despacho no lo toca ni reintenta.
  let procesados = 0;
  outbox.dispatchLifecycleEvents(() => {
    procesados += 1;
  });
  assert.equal(procesados, 0);
  const sigue = db.prepare(
    'SELECT attempts FROM lifecycle_events WHERE route_id = ?',
  ).get('RUTA-2') as { attempts: number };
  assert.equal(sigue.attempts, outbox.MAX_ATTEMPTS);
});

test('outbox: un venenoso no revienta el despacho del lote', () => {
  const db = database.getDb();
  outbox.queueLifecycleEvent(db, 'bus:visible', 'RUTA-3', { busId: 'B-3' });
  const entregadas: string[] = [];
  assert.doesNotThrow(() =>
    outbox.dispatchLifecycleEvents((event) => {
      if (event.routeId === 'RUTA-3') throw new Error('solo esta ruta falla');
      entregadas.push(event.routeId);
    }),
  );
  assert.ok(Array.isArray(entregadas));
  // Un solo fallo NO mata el evento: queda con last_error y volverá a
  // reclamarse hasta el techo de intentos (ver test anterior).
  const herido = db.prepare(
    'SELECT dead_at, last_error, delivered_at FROM lifecycle_events WHERE route_id = ?',
  ).get('RUTA-3') as { dead_at: number | null; last_error: string | null; delivered_at: number | null };
  assert.ok(herido.last_error?.includes('solo esta ruta falla'), 'el fallo queda registrado');
  assert.equal(herido.dead_at, null, 'aún tiene intentos por delante');
  assert.equal(herido.delivered_at, null);
});

test('cleanup', () => {
  database.closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
