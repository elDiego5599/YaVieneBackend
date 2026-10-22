// Conductores: registro, caché en memoria y turnos (turn_assignments).
// El caché evita un SELECT por posición recibida: el flujo MQTT consulta
// el conductor en cada mensaje.
import { randomUUID } from 'crypto';
import { getDb } from './database';
import { DriverInfo } from './bus_types';
import { busCompanyCache } from './fleet_admin';

export const driverCache = new Map<string, DriverInfo>();

/**
 * `'taken'` si el bus ya es de otra empresa (auditoría 2026-09, P2-1). Antes
 * el alta se lo pasaba a la nueva sin avisar —el mismo robo silencioso que
 * `createBus` ya cerraba— y sin tocar `busCompanyCache`, así que la empresa
 * vieja seguía pudiendo ocultar, editar o borrar un bus que ya no era suyo
 * hasta reiniciar el backend. En ese caso no se escribe nada.
 */
export type RegisterDriverError = 'taken';

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
): DriverInfo | RegisterDriverError {
  const db = getDb();
  const now = Date.now();
  const driverId = options.driverId ?? phoneNumber;
  const companyId = options.companyId ?? null;
  const busId = options.busId ?? null;
  const pinHash = options.pinHash ?? null;

  const save = db.transaction((): RegisterDriverError | null => {
    if (companyId && busId) {
      const bus = db.prepare('SELECT company_id FROM buses WHERE bus_id = ?')
        .get(busId) as { company_id: string } | undefined;
      if (bus && bus.company_id !== companyId) return 'taken';
    }

    if (companyId && busId) {
      db.prepare(`
        INSERT INTO buses (bus_id, company_id, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(bus_id) DO UPDATE SET
          updated_at = excluded.updated_at
      `).run(busId, companyId, now, now);

      db.prepare(`
        INSERT INTO gps_devices (
          device_id, company_id, bus_id, identifier, kind, secret_hash,
          status, name, route_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'sim', ?, 'active', ?, ?, ?, ?)
        ON CONFLICT(identifier) DO UPDATE SET
          device_id = excluded.device_id,
          name = excluded.name,
          route_id = excluded.route_id,
          company_id = excluded.company_id,
          bus_id = excluded.bus_id,
          secret_hash = excluded.secret_hash,
          status = 'active',
          updated_at = excluded.updated_at
      `).run(driverId, companyId, busId, phoneNumber, pinHash ?? '', name, routeId, now, now);

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
    return null;
  });
  const error = save();
  if (error) return error;
  // La caché de «de quién es el bus» guarda también los «no está»: un bus
  // que el panel preguntó antes de existir quedaba sin empresa en memoria y
  // su dueña recibía 404 hasta reiniciar. Tras el alta dice lo que la base.
  if (companyId && busId) busCompanyCache.set(busId, companyId);
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
    SELECT device_id AS driver_id, identifier AS phone_number, name AS name,
           route_id, company_id, bus_id, secret_hash AS pin_hash, created_at AS registered_at
    FROM gps_devices
    WHERE identifier = ?
  `).get(phoneNumber) as {
    driver_id: string; phone_number: string; name: string; route_id: string;
    company_id: string; bus_id: string; pin_hash: string; registered_at: number;
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

export function getActiveDeviceByIdentifier(identifier: string): DriverInfo | null {
  const row = getDb().prepare(
    'SELECT status FROM gps_devices WHERE identifier = ?',
  ).get(identifier) as { status: string } | undefined;
  if (!row || row.status !== 'active') return null;
  return getDriver(identifier);
}

export function getDriverById(driverId: string): DriverInfo | null {
  const db = getDb();
  const row = db.prepare('SELECT identifier AS phone_number FROM gps_devices WHERE device_id = ?')
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
