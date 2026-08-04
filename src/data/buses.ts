import { getDb } from './database';

export interface BusPosition {
  busId: string;
  routeId: string;
  lat: number;
  lon: number;
  heading: number;
  speedKmh: number;
  timestamp: string;
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
  is_ghost: number;
}

function rowToPosition(row: PositionRow): BusPosition {
  return {
    busId: row.bus_id,
    routeId: row.route_id,
    lat: row.lat,
    lon: row.lon,
    heading: row.heading,
    speedKmh: row.speed_kmh,
    timestamp: new Date(row.timestamp).toISOString(),
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
}): BusPosition | null {
  const db = getDb();

  const driver = db.prepare('SELECT route_id FROM drivers WHERE phone_number = ?')
    .get(phoneNumber) as { route_id: string } | undefined;
  if (!driver) return null;

  const previous = db.prepare('SELECT heading FROM positions WHERE bus_id = ?')
    .get(data.busId) as { heading: number } | undefined;

  const now = Date.now();
  const routeId = data.routeId || driver.route_id;
  const heading = data.heading ?? previous?.heading ?? 0;
  const speedKmh = data.speedKmh ?? 0;

  db.prepare(`
    INSERT INTO positions (bus_id, route_id, lat, lon, heading, speed_kmh, timestamp, driver_phone, is_ghost)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(bus_id) DO UPDATE SET
      lat = excluded.lat,
      lon = excluded.lon,
      heading = excluded.heading,
      speed_kmh = excluded.speed_kmh,
      timestamp = excluded.timestamp,
      is_ghost = 0
  `).run(data.busId, routeId, data.lat, data.lon, heading, speedKmh, now, phoneNumber);

  return {
    busId: data.busId,
    routeId,
    lat: data.lat,
    lon: data.lon,
    heading,
    speedKmh,
    timestamp: new Date(now).toISOString(),
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

  const removed = db.prepare(
    'DELETE FROM positions WHERE timestamp < ? RETURNING bus_id, route_id'
  ).all(removeTime) as { bus_id: string; route_id: string }[];

  const ghostedRows = db.prepare(
    'UPDATE positions SET is_ghost = 1 WHERE is_ghost = 0 AND timestamp < ? RETURNING *'
  ).all(ghostTime) as PositionRow[];

  return {
    toGhost: ghostedRows.map(rowToPosition),
    toRemove: removed.map(r => ({ busId: r.bus_id, routeId: r.route_id })),
  };
}

export function removePosition(busId: string): BusPosition | null {
  const db = getDb();
  const row = db.prepare(
    'DELETE FROM positions WHERE bus_id = ? RETURNING *'
  ).get(busId) as PositionRow | undefined;
  return row ? rowToPosition(row) : null;
}

export function getPosition(busId: string): BusPosition | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM positions WHERE bus_id = ?')
    .get(busId) as PositionRow | undefined;
  return row ? rowToPosition(row) : null;
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
  return {
    driverId,
    phoneNumber,
    name,
    routeId,
    registeredAt: new Date(now).toISOString(),
    companyId,
    busId,
    pinHash,
  };
}

export function getDriver(phoneNumber: string): DriverInfo | null {
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
  return {
    driverId: row.driver_id,
    phoneNumber: row.phone_number,
    name: row.name,
    routeId: row.route_id,
    registeredAt: new Date(row.registered_at).toISOString(),
    companyId: row.company_id,
    busId: row.bus_id,
    pinHash: row.pin_hash,
  };
}

export function getDriverById(driverId: string): DriverInfo | null {
  const db = getDb();
  const row = db.prepare('SELECT phone_number FROM drivers WHERE driver_id = ?')
    .get(driverId) as { phone_number: string } | undefined;
  return row ? getDriver(row.phone_number) : null;
}
