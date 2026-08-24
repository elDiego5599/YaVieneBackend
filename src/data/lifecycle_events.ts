import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { getDb } from './database';

export interface LifecycleEvent {
  id: number;
  eventId: string;
  eventType: 'bus:position' | 'bus:left' | 'bus:hidden' | 'bus:visible' | 'bus:removed';
  routeId: string;
  payload: Record<string, unknown>;
  createdAt: number;
  attempts: number;
}

/**
 * Un evento que falla más de MAX_ATTEMPTS veces se marca como muerto
 * (dead_at) y sale de la cola: sin techo, un evento venenoso —payload
 * corrupto, suscriptor que siempre lanza— se reclamaba, fallaba y volvía
 * a entrar en bucle para siempre, ocupando el lote de cada despacho.
 */
export const MAX_ATTEMPTS = 5;

// Purga de historia: los entregados no sirven para nada después de una
// semana y los muertos se conservan un mes para autopsia, no para siempre.
const DELIVERED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PURGE_EVERY_MS = 60 * 60 * 1000;
let lastPurgeAt = 0;

export function queueLifecycleEvent(
  db: Database.Database,
  eventType: LifecycleEvent['eventType'],
  routeId: string,
  payload: Record<string, unknown>,
): string {
  const eventId = randomUUID();
  db.prepare(`
    INSERT INTO lifecycle_events (
      event_id, event_type, route_id, payload, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(eventId, eventType, routeId, JSON.stringify({ ...payload, eventId }), Date.now());
  return eventId;
}

function claimPendingEvents(limit: number): LifecycleEvent[] {
  const db = getDb();
  const now = Date.now();
  const staleClaim = now - 30_000;
  const claim = db.transaction(() => {
    const rows = db.prepare(`
      SELECT id, event_id, event_type, route_id, payload, created_at, attempts
      FROM lifecycle_events
      WHERE delivered_at IS NULL
        AND dead_at IS NULL
        AND (claimed_at IS NULL OR claimed_at < ?)
      ORDER BY id ASC
      LIMIT ?
    `).all(staleClaim, limit) as {
      id: number;
      event_id: string;
      event_type: LifecycleEvent['eventType'];
      route_id: string;
      payload: string;
      created_at: number;
      attempts: number;
    }[];

    for (const row of rows) {
      db.prepare(`
        UPDATE lifecycle_events
        SET claimed_at = ?, attempts = attempts + 1
        WHERE id = ? AND delivered_at IS NULL
      `).run(now, row.id);
    }

    return rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      eventType: row.event_type,
      routeId: row.route_id,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      createdAt: row.created_at,
      attempts: row.attempts + 1,
    }));
  });

  return claim();
}

export function dispatchLifecycleEvents(emit: (event: LifecycleEvent) => void): void {
  const db = getDb();
  maybePurge(db);
  for (const event of claimPendingEvents(100)) {
    try {
      emit(event);
      db.prepare(`
        UPDATE lifecycle_events
        SET delivered_at = ?, claimed_at = NULL
        WHERE id = ?
      `).run(Date.now(), event.id);
    } catch (error) {
      const agotado = event.attempts >= MAX_ATTEMPTS;
      db.prepare(`
        UPDATE lifecycle_events
        SET claimed_at = NULL, last_error = ?, dead_at = ?
        WHERE id = ?
      `).run(
        String(error),
        agotado ? Date.now() : null,
        event.id,
      );
    }
  }
}

/**
 * Entregados de más de una semana y muertos de más de un mes fuera: sin
 * esto la tabla crece para siempre (los entregados nunca se borran y los
 * muertos, desde que existe el techo, se acumulan). Se corre como máximo
 * una vez por hora; con el índice de created_at es una pasada indexada.
 */
function maybePurge(db: Database.Database): void {
  const now = Date.now();
  if (now - lastPurgeAt < PURGE_EVERY_MS) return;
  lastPurgeAt = now;
  try {
    db.prepare(
      'DELETE FROM lifecycle_events WHERE delivered_at IS NOT NULL AND delivered_at < ?',
    ).run(now - DELIVERED_TTL_MS);
    db.prepare(
      'DELETE FROM lifecycle_events WHERE dead_at IS NOT NULL AND dead_at < ?',
    ).run(now - DEAD_TTL_MS);
  } catch {
    // La purga es mantenimiento, no negocio: si falla, el despacho sigue.
    lastPurgeAt = now - PURGE_EVERY_MS + 60_000; // reintentar en un minuto
  }
}
