// Conductores: registro, caché en memoria y turnos (turn_assignments).
// El caché evita un SELECT por posición recibida: el flujo MQTT consulta
// el conductor en cada mensaje.
import { randomUUID } from 'crypto';
import { getDb } from './database';
import { DriverInfo } from './bus_types';

export const driverCache = new Map<string, DriverInfo>();

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
