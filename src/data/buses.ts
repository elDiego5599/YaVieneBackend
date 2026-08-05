import { randomUUID } from 'crypto';
import { getDb } from './database';
import { queueLifecycleEvent } from './lifecycle_events';

export interface BusPosition {
  busId: string;
  routeId: string;
  lat: number;
  lon: number;
  heading: number;
  speedKmh: number;
  timestamp: string;
  capturedAt: number;
  receivedAt: number;
  sequence: number | null;
  eventId?: string;
  driverPhone: string;
  isGhost: boolean;
}

export interface DriverInfo {
  driverId: string;
  phoneNumber: string;
  name: string;
  routeId: string;
  registeredAt: string;
  companyId: string | null;
  busId: string | null;
  pinHash: string | null;
}

interface PositionRow {
  bus_id: string;
  route_id: string;
  lat: number;
  lon: number;
  heading: number;
  speed_kmh: number;
  timestamp: number;
  driver_phone: string;
  session_id: string | null;
  captured_at: number | null;
  sequence: number | null;
  is_ghost: number;
}

const driverCache = new Map<string, DriverInfo>();

function rowToPosition(row: PositionRow): BusPosition {
  return {
    busId: row.bus_id,
    routeId: row.route_id,
    lat: row.lat,
    lon: row.lon,
    heading: row.heading,
    speedKmh: row.speed_kmh,
    timestamp: new Date(row.timestamp).toISOString(),
    capturedAt: row.captured_at ?? row.timestamp,
    receivedAt: row.timestamp,
    sequence: row.sequence,
    driverPhone: row.driver_phone,
    isGhost: row.is_ghost === 1,
  };
}

export function toPublicPosition(position: BusPosition): Omit<BusPosition, 'driverPhone'> {
  const { driverPhone: _driverPhone, ...publicPosition } = position;
  return publicPosition;
}

export function upsertPosition(phoneNumber: string, data: {
  busId: string;
  routeId?: string;
  lat: number;
  lon: number;
  heading?: number;
  speedKmh?: number;
  sessionId?: string;
  capturedAt?: number;
  sequence?: number;
  driverValidated?: boolean;
}): BusPosition | null {
  const db = getDb();

  const driver = data.driverValidated ? undefined : getDriver(phoneNumber);
  if (!data.driverValidated && !driver) return null;

  const now = Date.now();
  const routeId = data.routeId || driver?.routeId;
  if (!routeId) return null;
  const heading = data.heading ?? 0;
  const speedKmh = data.speedKmh ?? 0;

  const result = db.prepare(`
    INSERT INTO positions (
      bus_id, route_id, lat, lon, heading, speed_kmh, timestamp, driver_phone,
      session_id, captured_at, sequence, is_ghost
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(bus_id) DO UPDATE SET
      lat = excluded.lat,
      lon = excluded.lon,
      heading = excluded.heading,
      speed_kmh = excluded.speed_kmh,
      timestamp = excluded.timestamp,
      driver_phone = excluded.driver_phone,
      session_id = excluded.session_id,
      captured_at = excluded.captured_at,
      sequence = excluded.sequence,
      is_ghost = 0
    WHERE positions.session_id IS NOT excluded.session_id
       OR positions.sequence IS NULL
       OR excluded.sequence > positions.sequence
  `).run(
    data.busId,
    routeId,
    data.lat,
    data.lon,
    heading,
    speedKmh,
    now,
    phoneNumber,
    data.sessionId ?? null,
    data.capturedAt ?? now,
    data.sequence ?? null,
  );

  if (result.changes !== 1) return null;

  return {
    busId: data.busId,
    routeId,
    lat: data.lat,
    lon: data.lon,
    heading,
    speedKmh,
    timestamp: new Date(now).toISOString(),
    capturedAt: data.capturedAt ?? now,
    receivedAt: now,
    sequence: data.sequence ?? null,
    driverPhone: phoneNumber,
    isGhost: false,
  };
}

export function getPositionsByRoute(routeId: string): BusPosition[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM positions WHERE route_id = ?')
    .all(routeId) as PositionRow[];
  return rows.map(rowToPosition);
}

export function sweepPositions(ghostMs: number, removeMs: number): {
  toGhost: BusPosition[];
  toRemove: { busId: string; routeId: string }[];
} {
  const db = getDb();
  const now = Date.now();
  const removeTime = now - removeMs;
  const ghostTime = now - ghostMs;

  const sweep = db.transaction(() => {
    const removed = db.prepare(
      'DELETE FROM positions WHERE timestamp < ? RETURNING bus_id, route_id'
    ).all(removeTime) as { bus_id: string; route_id: string }[];

    const ghostedRows = db.prepare(
      'UPDATE positions SET is_ghost = 1 WHERE is_ghost = 0 AND timestamp < ? AND timestamp >= ? RETURNING *'
    ).all(ghostTime, removeTime) as PositionRow[];

    for (const row of ghostedRows) {
      const position = rowToPosition(row);
      queueLifecycleEvent(db, 'bus:position', position.routeId, { ...position });
    }
    for (const row of removed) {
      queueLifecycleEvent(db, 'bus:left', row.route_id, {
        busId: row.bus_id,
        routeId: row.route_id,
      });
    }

    return {
      toGhost: ghostedRows.map(rowToPosition),
      toRemove: removed.map(r => ({ busId: r.bus_id, routeId: r.route_id })),
    };
  });

  return sweep();
}

export function removePosition(busId: string): BusPosition | null {
  const db = getDb();
  const remove = db.transaction(() => {
    const row = db.prepare(
      'DELETE FROM positions WHERE bus_id = ? RETURNING *'
    ).get(busId) as PositionRow | undefined;
    if (row) {
      const position = rowToPosition(row);
      queueLifecycleEvent(db, 'bus:left', position.routeId, {
        busId: position.busId,
        routeId: position.routeId,
      });
      return position;
    }
    return null;
  });
  return remove();
}

export function removePositionOwned(busId: string, sessionId: string): BusPosition | null {
  const db = getDb();
  const remove = db.transaction(() => {
    const row = db.prepare(
      'DELETE FROM positions WHERE bus_id = ? AND session_id = ? RETURNING *'
    ).get(busId, sessionId) as PositionRow | undefined;
    if (row) {
      const position = rowToPosition(row);
      queueLifecycleEvent(db, 'bus:left', position.routeId, {
        busId: position.busId,
        routeId: position.routeId,
      });
      return position;
    }
    return null;
  });
  return remove();
}

export function getPosition(busId: string): BusPosition | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM positions WHERE bus_id = ?')
    .get(busId) as PositionRow | undefined;
  return row ? rowToPosition(row) : null;
}

export function getPositionSequence(busId: string, sessionId: string): number | null {
  const db = getDb();
  const row = db.prepare('SELECT sequence FROM positions WHERE bus_id = ? AND session_id = ?')
    .get(busId, sessionId) as { sequence: number | null } | undefined;
  return row?.sequence ?? null;
}

export interface PositionValidationState {
  lat: number;
  lon: number;
  capturedAt: number;
  receivedAt: number;
  sequence: number | null;
  sessionId: string | null;
}

export function getPositionValidationState(busId: string): PositionValidationState | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT lat, lon, timestamp, captured_at, sequence, session_id
    FROM positions
    WHERE bus_id = ?
  `).get(busId) as {
    lat: number;
    lon: number;
    timestamp: number;
    captured_at: number | null;
    sequence: number | null;
    session_id: string | null;
  } | undefined;

  if (!row) return null;
  return {
    lat: row.lat,
    lon: row.lon,
    capturedAt: row.captured_at ?? row.timestamp,
    receivedAt: row.timestamp,
    sequence: row.sequence,
    sessionId: row.session_id,
  };
}

export function getAllPositions(): BusPosition[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM positions').all() as PositionRow[];
  return rows.map(rowToPosition);
}

export function registerDriver(
  phoneNumber: string,
  name: string,
  routeId: string,
  options: {
    driverId?: string;
    companyId?: string;
    busId?: string;
    pinHash?: string;
  } = {},
): DriverInfo {
  const db = getDb();
  const now = Date.now();
  const driverId = options.driverId ?? phoneNumber;
  const companyId = options.companyId ?? null;
  const busId = options.busId ?? null;
  const pinHash = options.pinHash ?? null;

  const save = db.transaction(() => {
    db.prepare(`
      INSERT INTO drivers (
        phone_number, driver_id, name, route_id, company_id, bus_id, pin_hash, registered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(phone_number) DO UPDATE SET
        driver_id = excluded.driver_id,
        name = excluded.name,
        route_id = excluded.route_id,
        company_id = excluded.company_id,
        bus_id = excluded.bus_id,
        pin_hash = excluded.pin_hash,
        registered_at = excluded.registered_at
    `).run(phoneNumber, driverId, name, routeId, companyId, busId, pinHash, now);

    if (companyId && busId) {
      db.prepare(`
        INSERT INTO buses (bus_id, company_id, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(bus_id) DO UPDATE SET
          company_id = excluded.company_id,
          updated_at = excluded.updated_at
      `).run(busId, companyId, now, now);

      db.prepare(`
        UPDATE turn_assignments
        SET status = 'ended', ended_at = ?
        WHERE status = 'active' AND (driver_id = ? OR bus_id = ?)
      `).run(now, driverId, busId);

      db.prepare(`
        INSERT INTO turn_assignments (
          assignment_id, driver_id, bus_id, company_id, route_id, started_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, 'active')
      `).run(randomUUID(), driverId, busId, companyId, routeId, now);
    }
  });
  save();
  const driver = {
    driverId,
    phoneNumber,
    name,
    routeId,
    registeredAt: new Date(now).toISOString(),
    companyId,
    busId,
    pinHash,
  };
  driverCache.set(phoneNumber, driver);
  return driver;
}

export function getDriver(phoneNumber: string): DriverInfo | null {
  const cached = driverCache.get(phoneNumber);
  if (cached) return cached;
  const db = getDb();
  const row = db.prepare(`
    SELECT driver_id, phone_number, name, route_id, company_id, bus_id, pin_hash, registered_at
    FROM drivers
    WHERE phone_number = ?
  `).get(phoneNumber) as {
    driver_id: string;
    phone_number: string;
    name: string;
    route_id: string;
    company_id: string | null;
    bus_id: string | null;
    pin_hash: string | null;
    registered_at: number;
  } | undefined;
  if (!row) return null;
  const driver = {
    driverId: row.driver_id,
    phoneNumber: row.phone_number,
    name: row.name,
    routeId: row.route_id,
    registeredAt: new Date(row.registered_at).toISOString(),
    companyId: row.company_id,
    busId: row.bus_id,
    pinHash: row.pin_hash,
  };
  driverCache.set(phoneNumber, driver);
  return driver;
}

export function getDriverById(driverId: string): DriverInfo | null {
  const db = getDb();
  const row = db.prepare('SELECT phone_number FROM drivers WHERE driver_id = ?')
    .get(driverId) as { phone_number: string } | undefined;
  return row ? getDriver(row.phone_number) : null;
}

export function endAssignment(driverId: string, busId: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE turn_assignments
    SET status = 'ended', ended_at = ?
    WHERE driver_id = ? AND bus_id = ? AND status = 'active'
  `).run(Date.now(), driverId, busId);
}
