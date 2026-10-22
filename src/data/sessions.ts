import { getDb } from './database';

export interface DeviceSession {
  sessionId: string;
  deviceId: string;
  identifier: string;
  companyId: string;
  busId: string;
  routeId: string;
  clientId: string | null;
  status: 'active' | 'revoked';
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
}

interface CachedSession extends DeviceSession {
  persistedSeenAt: number;
}

const sessionCache = new Map<string, CachedSession>();
export function invalidateSessionCache(): void {
  sessionCache.clear();
}
const LAST_SEEN_FLUSH_MS = 15_000;

export function createDeviceSession(input: {
  sessionId: string;
  deviceId: string;
  identifier: string;
  companyId: string;
  busId: string;
  routeId: string;
}): void {
  const db = getDb();
  const now = Date.now();

  const create = db.transaction(() => {
    db.prepare(`
      UPDATE device_sessions
      SET status = 'revoked', revoked_at = ?, client_id = NULL
      WHERE status = 'active'
        AND (device_id = ? OR (company_id = ? AND bus_id = ?))
    `).run(now, input.deviceId, input.companyId, input.busId);

    db.prepare(`
      INSERT INTO device_sessions (
        session_id, device_id, identifier, company_id, bus_id, route_id,
        status, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      input.sessionId,
      input.deviceId,
      input.identifier,
      input.companyId,
      input.busId,
      input.routeId,
      now,
      now,
    );
  });

  create();
  sessionCache.clear();
}

export function claimSession(sessionId: string, clientId: string): boolean {
  const db = getDb();
  const cached = sessionCache.get(sessionId);
  if (cached && cached.status === 'active') {
    if (!sessionDeviceIsCurrent(cached)) {
      revokeSession(sessionId);
      return false;
    }
    if (cached.clientId != null && cached.clientId !== clientId) return false;
    const now = Date.now();
    const result = db.prepare(`
      UPDATE device_sessions
      SET client_id = ?, last_seen_at = ?
      WHERE session_id = ? AND status = 'active'
    `).run(clientId, now, sessionId);
    if (result.changes !== 1) {
      sessionCache.delete(sessionId);
      return false;
    }
    cached.clientId = clientId;
    cached.lastSeenAt = now;
    cached.persistedSeenAt = now;
    return true;
  }

  const result = db.prepare(`
    UPDATE device_sessions
    SET client_id = ?, last_seen_at = ?
    WHERE session_id = ?
      AND status = 'active'
      AND (client_id IS NULL OR client_id = ?)
  `).run(clientId, Date.now(), sessionId, clientId);
  if (result.changes !== 1) return false;
  const session = getSession(sessionId);
  if (!session) return false;
  if (!sessionDeviceIsCurrent(session)) {
    revokeSession(sessionId);
    return false;
  }
  sessionCache.set(sessionId, { ...session, persistedSeenAt: Date.now() });
  return true;
}

export function isSessionAuthorized(sessionId: string, clientId: string): boolean {
  const db = getDb();
  const cached = sessionCache.get(sessionId);
  const now = Date.now();
  if (cached && cached.status === 'active' && cached.clientId === clientId) {
    if (!sessionDeviceIsCurrent(cached)) {
      revokeSession(sessionId);
      return false;
    }
    cached.lastSeenAt = now;
    if (now - cached.persistedSeenAt >= LAST_SEEN_FLUSH_MS) {
      const result = db.prepare(`
        UPDATE device_sessions
        SET last_seen_at = ?
        WHERE session_id = ? AND status = 'active' AND client_id = ?
      `).run(now, sessionId, clientId);
      if (result.changes !== 1) {
        sessionCache.delete(sessionId);
        return false;
      }
      cached.persistedSeenAt = now;
    }
    return true;
  }

  const session = getSession(sessionId);
  if (session?.status === 'active' && !sessionDeviceIsCurrent(session)) {
    revokeSession(sessionId);
    return false;
  }
  if (!session || session.status !== 'active' || session.clientId !== clientId) {
    sessionCache.delete(sessionId);
    return false;
  }
  sessionCache.set(sessionId, { ...session, persistedSeenAt: now });
  return true;
}

export function releaseSession(sessionId: string, clientId: string): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE device_sessions
    SET client_id = NULL, last_seen_at = ?
    WHERE session_id = ?
      AND status = 'active'
      AND client_id = ?
  `).run(Date.now(), sessionId, clientId);
  sessionCache.delete(sessionId);
  return result.changes === 1;
}

export function revokeSession(sessionId: string): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE device_sessions
    SET status = 'revoked', revoked_at = ?, client_id = NULL
    WHERE session_id = ?
      AND status = 'active'
  `).run(Date.now(), sessionId);
  sessionCache.delete(sessionId);
  return result.changes === 1;
}

export function getSession(sessionId: string): DeviceSession | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT session_id, device_id, identifier, company_id, bus_id, route_id,
           client_id, status, created_at, last_seen_at, revoked_at
    FROM device_sessions
    WHERE session_id = ?
  `).get(sessionId) as {
    session_id: string;
    device_id: string;
    identifier: string;
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
    deviceId: row.device_id,
    identifier: row.identifier,
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

export function cleanupRevokedSessions(retentionMs = 7 * 24 * 60 * 60 * 1000): number {
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM device_sessions
    WHERE status = 'revoked'
      AND revoked_at IS NOT NULL
      AND revoked_at < ?
  `).run(Date.now() - retentionMs);
  for (const [sessionId, session] of sessionCache) {
    if (session.status === 'revoked') sessionCache.delete(sessionId);
  }
  return result.changes;
}

export function revokeSessionsForDevice(deviceId: string): number {
  const db = getDb();
  const result = db.prepare(`
    UPDATE device_sessions
    SET status = 'revoked', revoked_at = ?, client_id = NULL
    WHERE device_id = ? AND status = 'active'
  `).run(Date.now(), deviceId);
  sessionCache.clear();
  return result.changes;
}

/**
 * Revoca las sesiones activas de un bus. Borrar un bus del catálogo no
 * tocaba sus sesiones: el teléfono seguía autorizado en MQTT y su siguiente
 * posición volvía a crear la fila en `positions` de un bus que ya no
 * existe, a la vista del pasajero. Con la sesión revocada el broker le
 * niega la publicación en el acto (`authorizePublish` consulta la base al
 * vaciarse la caché) y lo desconecta en el siguiente barrido.
 */
export function revokeSessionsForBus(companyId: string, busId: string): number {
  const db = getDb();
  const result = db.prepare(`
    UPDATE device_sessions
    SET status = 'revoked', revoked_at = ?, client_id = NULL
    WHERE company_id = ? AND bus_id = ? AND status = 'active'
  `).run(Date.now(), companyId, busId);
  sessionCache.clear();
  return result.changes;
}

function sessionDeviceIsCurrent(session: DeviceSession): boolean {
  return getDb().prepare(`
    SELECT 1 FROM gps_devices
    WHERE device_id = ? AND status = 'active'
      AND company_id = ? AND bus_id = ?
  `).get(session.deviceId, session.companyId, session.busId) !== undefined;
}
