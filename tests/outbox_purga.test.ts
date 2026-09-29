import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// La purga del outbox y el techo de intentos son política con número
// (`lifecycle_events.ts`): entregados fuera a los 7 días, muertos a los 30,
// una pasada por hora como mucho y 5 intentos antes de morir. La auditoría
// del 2026-09-27 (R-05) cambió cada número —y quitó cada purga— y la suite
// seguía en verde: `outbox.test.ts` usa `MAX_ATTEMPTS` como variable y
// ninguna prueba movía el reloj. Aquí el reloj es falso y cada fila vive a
// 1 ms del borde, por dentro o por fuera.
//
// Archivo propio: `maybePurge` recuerda la última pasada en el módulo y
// este archivo necesita estrenarlo.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaviene-outbox-purga-'));
process.env.YA_VIENE_DB_PATH = path.join(tmpDir, 'outbox-purga.db');
process.env.JWT_SECRET = 'test-jwt-secret';

const DIA = 24 * 60 * 60 * 1000;
const HORA = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 27, 12);

type DatabaseModule = typeof import('../src/data/database');
type LifecycleEvents = typeof import('../src/data/lifecycle_events');
let database: DatabaseModule;
let outbox: LifecycleEvents;

test.before(async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 });
  database = await import('../src/data/database');
  outbox = await import('../src/data/lifecycle_events');
  database.getDb();
});

test.after(() => {
  mock.timers.reset();
  database.closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Mete un evento ya cerrado, entregado o muerto en el instante dado. */
function cerrado(ruta: string, columna: 'delivered_at' | 'dead_at', en: number): void {
  database.getDb().prepare(`
    INSERT INTO lifecycle_events (event_id, event_type, route_id, payload, created_at, ${columna})
    VALUES (?, 'bus:left', ?, '{}', ?, ?)
  `).run(`ev-${ruta}`, ruta, en, en);
}

function quedan(): string[] {
  return (database.getDb()
    .prepare('SELECT route_id FROM lifecycle_events ORDER BY route_id')
    .all() as Array<{ route_id: string }>).map((fila) => fila.route_id);
}

function despachar(): void {
  outbox.dispatchLifecycleEvents(() => {});
}

test('purga: entregados a 7 días y muertos a 30, con el borde exacto', () => {
  cerrado('ENTREGADO-DENTRO', 'delivered_at', T0 - 7 * DIA + 1);
  cerrado('ENTREGADO-FUERA', 'delivered_at', T0 - 7 * DIA - 1);
  cerrado('MUERTO-DENTRO', 'dead_at', T0 - 30 * DIA + 1);
  cerrado('MUERTO-FUERA', 'dead_at', T0 - 30 * DIA - 1);

  despachar();

  assert.deepEqual(quedan(), ['ENTREGADO-DENTRO', 'MUERTO-DENTRO']);
});

test('purga: como mucho una pasada por hora', () => {
  // Envejecen justo después de la pasada anterior (en T0).
  cerrado('VIEJO', 'delivered_at', T0 - 8 * DIA);

  mock.timers.setTime(T0 + HORA - 1);
  despachar();
  assert.ok(quedan().includes('VIEJO'), 'antes de la hora no se vuelve a purgar');

  mock.timers.setTime(T0 + HORA);
  despachar();
  assert.ok(!quedan().includes('VIEJO'), 'cumplida la hora, la purga vuelve a pasar');
});

test('techo: un evento que siempre falla muere exactamente en el 5.º intento', () => {
  const db = database.getDb();
  outbox.queueLifecycleEvent(db, 'bus:hidden', 'VENENO', { busId: 'B-V' });
  const fallar = (): void => {
    throw new Error('suscriptor roto');
  };
  const leer = () => db.prepare(
    'SELECT attempts, dead_at FROM lifecycle_events WHERE route_id = ?',
  ).get('VENENO') as { attempts: number; dead_at: number | null };

  for (let intento = 1; intento <= 4; intento += 1) {
    outbox.dispatchLifecycleEvents(fallar);
    assert.equal(leer().dead_at, null, `tras el intento ${intento} sigue vivo`);
  }
  outbox.dispatchLifecycleEvents(fallar);
  const fila = leer();
  assert.equal(fila.attempts, 5);
  assert.ok(fila.dead_at, 'el 5.º fallo lo mata');
});
