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
type Posiciones = typeof import('../src/data/positions_store');
type Despacho = typeof import('../src/data/despacho');
let database: DatabaseModule;
let outbox: LifecycleEvents;
let posiciones: Posiciones;
let despacho: Despacho;

test('setup: abre la base temporal y carga el outbox', async () => {
  database = await import('../src/data/database');
  outbox = await import('../src/data/lifecycle_events');
  posiciones = await import('../src/data/positions_store');
  despacho = await import('../src/data/despacho');
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

// El payload se parseaba dentro de la transacción que reclama el lote: una
// sola fila con JSON roto hacía lanzar al reclamo, la transacción se
// deshacía (sin sumar intentos) y el despacho entero moría cada 250 ms para
// siempre, con todos los eventos detrás de ella atascados.
test('outbox: una fila con payload corrupto muere sola y no atasca el lote', () => {
  const db = database.getDb();
  db.prepare(`
    INSERT INTO lifecycle_events (event_id, event_type, route_id, payload, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('ev-corrupto', 'bus:left', 'RUTA-4', '{"busId": "B-4"', Date.now());
  outbox.queueLifecycleEvent(db, 'bus:left', 'RUTA-5', { busId: 'B-5' });

  const entregadas: string[] = [];
  assert.doesNotThrow(() =>
    outbox.dispatchLifecycleEvents((event) => {
      entregadas.push(event.routeId);
    }),
  );

  // RUTA-3 (el herido del test anterior) también vuelve a salir: solo
  // importan la corrupta y la de detrás.
  assert.ok(entregadas.includes('RUTA-5'), 'el evento sano de detrás se entrega');
  assert.ok(!entregadas.includes('RUTA-4'), 'la corrupta no llega al suscriptor');
  const corrupto = db.prepare(
    'SELECT dead_at, last_error, delivered_at FROM lifecycle_events WHERE route_id = ?',
  ).get('RUTA-4') as { dead_at: number | null; last_error: string | null; delivered_at: number | null };
  assert.ok(corrupto.dead_at, 'un payload ilegible no mejora reintentando: muere al primer intento');
  assert.ok(corrupto.last_error?.includes('payload corrupto'));
  assert.equal(corrupto.delivered_at, null);
});

// El barrido marca sin señal a un bus callado y encola el aviso; el despacho
// lo manda hasta 250 ms después. Si en ese hueco el bus vuelve a publicar, el
// aviso viejo salía igual y llegaba detrás de la posición viva: el pasajero
// veía en gris, como «sin señal», un bus que acababa de reportar, y así se
// quedaba hasta la siguiente posición.
const EQUIPO = '3009990002';

function busDePrueba(busId: string, routeId: string): void {
  const db = database.getDb();
  const ahora = Date.now();
  db.prepare(
    'INSERT OR IGNORE INTO empresas (company_id, name, created_at) VALUES (?, ?, ?)',
  ).run('EMP-OUT', 'Empresa outbox', ahora);
  db.prepare(`
    INSERT OR IGNORE INTO buses (bus_id, company_id, plate_number, created_at, updated_at, visible, route_id)
    VALUES (?, 'EMP-OUT', ?, ?, ?, 1, ?)
  `).run(busId, busId, ahora, ahora, routeId);
  // `positions.device_id` apunta al equipo GPS del bus: sin esa fila la
  // inserción de la posición se cae por clave foránea.
  db.prepare(`
    INSERT OR IGNORE INTO drivers (phone_number, name, route_id, company_id, bus_id, registered_at)
    VALUES (?, ?, ?, 'EMP-OUT', ?, ?)
  `).run(EQUIPO, `GPS ${busId}`, routeId, busId, ahora);
}

/** Publica una posición y le pone el reloj de recepción que haga falta. */
function publicar(busId: string, routeId: string, recibidaEn: number): void {
  const posicion = posiciones.upsertPosition(EQUIPO, {
    busId, routeId, lat: 10.98, lon: -74.79, sequence: recibidaEn,
    capturedAt: recibidaEn, driverValidated: true, companyId: 'EMP-OUT',
  });
  assert.ok(posicion, `no se pudo publicar la posición de ${busId}`);
  // `timestamp` es la hora de recepción y la pone el propio store; el barrido
  // mira esa columna, así que para simular un bus callado hay que atrasarla.
  database.getDb().prepare('UPDATE positions SET timestamp = ? WHERE bus_id = ?')
    .run(recibidaEn, busId);
}

test('outbox: un fantasma encolado no se emite si el bus volvió antes del despacho', () => {
  const db = database.getDb();
  const ahora = Date.now();
  busDePrueba('BUS-FANT', 'R-701');
  publicar('BUS-FANT', 'R-701', ahora - 400_000);

  // El bus lleva más de lo permitido sin publicar: el barrido lo marca y
  // encola el aviso, que es el que se queda esperando en la cola.
  assert.equal(posiciones.sweepPositions(300_000).toGhost.length, 1, 'el barrido tenía que marcarlo');

  // Y entonces el bus vuelve a publicar, antes de que el aviso salga.
  publicar('BUS-FANT', 'R-701', ahora);

  const emitidos: string[] = [];
  despacho.dispatchBusEvents((event) => {
    if (event.eventType === 'bus:position') emitidos.push(event.payload.busId as string);
  });
  assert.deepEqual(emitidos, [], 'el fantasma caducado no debe llegar al suscriptor');

  // Sale de la cola como entregado: no se emite, pero tampoco se queda dando
  // vueltas ni suma intentos hasta morir.
  const fila = db.prepare(
    "SELECT delivered_at, dead_at FROM lifecycle_events WHERE event_type = 'bus:position'",
  ).get() as { delivered_at: number | null; dead_at: number | null };
  assert.ok(fila.delivered_at, 'el aviso caducado sale de la cola');
  assert.equal(fila.dead_at, null);
});

test('outbox: un fantasma que sigue siéndolo sí se emite', () => {
  busDePrueba('BUS-MUDO', 'R-702');
  publicar('BUS-MUDO', 'R-702', Date.now() - 400_000);
  assert.equal(posiciones.sweepPositions(300_000).toGhost.length, 1);

  const emitidos: string[] = [];
  despacho.dispatchBusEvents((event) => {
    if (event.eventType === 'bus:position') emitidos.push(event.payload.busId as string);
  });
  assert.deepEqual(emitidos, ['BUS-MUDO'], 'el bus callado sí tiene que avisar');
});

test('cleanup', () => {
  database.closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
