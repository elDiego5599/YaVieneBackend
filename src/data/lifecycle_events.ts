import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { getDb } from './database';

export interface LifecycleEvent {
  id: number;
  eventId: string;
  eventType: 'bus:position' | 'bus:left' | 'bus:hidden' | 'bus:visible';
  routeId: string;
  payload: Record<string, unknown>;
  createdAt: number;
  attempts: number;
}

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
  for (const event of claimPendingEvents(100)) {
    const db = getDb();
    try {
      emit(event);
      db.prepare(`
        UPDATE lifecycle_events
        SET delivered_at = ?, claimed_at = NULL
        WHERE id = ?
      `).run(Date.now(), event.id);
    } catch (error) {
      db.prepare(`
        UPDATE lifecycle_events
        SET claimed_at = NULL, last_error = ?
        WHERE id = ?
      `).run(String(error), event.id);
    }
  }
}
