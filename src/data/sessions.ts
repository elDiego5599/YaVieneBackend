import { getDb } from './database';

export interface DriverSession {
  sessionId: string;
  driverId: string;
  phoneNumber: string;
  companyId: string;
  busId: string;
  routeId: string;
  clientId: string | null;
  status: 'active' | 'revoked';
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
}

export function createDriverSession(input: {
  sessionId: string;
  driverId: string;
  phoneNumber: string;
  companyId: string;
  busId: string;
  routeId: string;
}): void {
  const db = getDb();
  const now = Date.now();

  const create = db.transaction(() => {
    db.prepare(`
      UPDATE driver_sessions
      SET status = 'revoked', revoked_at = ?, client_id = NULL
      WHERE status = 'active'
        AND (driver_id = ? OR bus_id = ?)
    `).run(now, input.driverId, input.busId);

    db.prepare(`
      INSERT INTO driver_sessions (
        session_id, driver_id, phone_number, company_id, bus_id, route_id,
        status, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      input.sessionId,
      input.driverId,
      input.phoneNumber,
      input.companyId,
      input.busId,
      input.routeId,
      now,
      now,
    );
  });

  create();
}

export function claimSession(sessionId: string, clientId: string): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE driver_sessions
    SET client_id = ?, last_seen_at = ?
    WHERE session_id = ?
      AND status = 'active'
      AND (client_id IS NULL OR client_id = ?)
  `).run(clientId, Date.now(), sessionId, clientId);
  return result.changes === 1;
}

export function isSessionAuthorized(sessionId: string, clientId: string): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE driver_sessions
    SET last_seen_at = ?
    WHERE session_id = ?
      AND status = 'active'
      AND client_id = ?
  `).run(Date.now(), sessionId, clientId);
  return result.changes === 1;
}

export function releaseSession(sessionId: string, clientId: string): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE driver_sessions
    SET client_id = NULL, last_seen_at = ?
    WHERE session_id = ?
      AND status = 'active'
      AND client_id = ?
  `).run(Date.now(), sessionId, clientId);
  return result.changes === 1;
}

export function revokeSession(sessionId: string): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE driver_sessions
    SET status = 'revoked', revoked_at = ?, client_id = NULL
    WHERE session_id = ?
      AND status = 'active'
  `).run(Date.now(), sessionId);
  return result.changes === 1;
}

export function getSession(sessionId: string): DriverSession | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT session_id, driver_id, phone_number, company_id, bus_id, route_id,
           client_id, status, created_at, last_seen_at, revoked_at
    FROM driver_sessions
    WHERE session_id = ?
  `).get(sessionId) as {
    session_id: string;
    driver_id: string;
    phone_number: string;
    company_id: string;
    bus_id: string;
    route_id: string;
    client_id: string | null;
    status: 'active' | 'revoked';
    created_at: number;
    last_seen_at: number;
    revoked_at: number | null;
  } | undefined;

  if (!row) return null;
  return {
    sessionId: row.session_id,
    driverId: row.driver_id,
    phoneNumber: row.phone_number,
    companyId: row.company_id,
    busId: row.bus_id,
    routeId: row.route_id,
    clientId: row.client_id,
    status: row.status,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}
