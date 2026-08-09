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
  /** Sentido de marcha reportado por el bus: 'ida' | 'venida' | null. */
  sentido: 'ida' | 'venida' | null;
  timestamp: string;
  capturedAt: number;
  receivedAt: number;
  sequence: number | null;
  eventId?: string;
  driverPhone: string;
  companyId: string;
  isGhost: boolean;
}

export interface FleetBus {
  busId: string;
  companyId: string;
  routeId: string | null;
  placa: string;
  interno: string;
  driverName: string | null;
  visible: boolean;
  online: boolean;
  lat: number | null;
  lon: number | null;
  heading: number | null;
  speedKmh: number | null;
  sentido: 'ida' | 'venida' | null;
  capturedAt: number | null;
  receivedAt: number | null;
  sequence: number | null;
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
  sentido: string | null;
  timestamp: number;
  driver_phone: string;
  session_id: string | null;
  captured_at: number | null;
  sequence: number | null;
  is_ghost: number;
  bus_company_id?: string | null;
}

function normalizeSentido(raw: string | null | undefined): 'ida' | 'venida' | null {
  if (raw === 'ida' || raw === 'venida') return raw;
  return null;
}

const driverCache = new Map<string, DriverInfo>();
const visibilityCache = new Map<string, boolean>();
const busCompanyCache = new Map<string, string>();

function rowToPosition(row: PositionRow): BusPosition {
  return {
    busId: row.bus_id,
    routeId: row.route_id,
    lat: row.lat,
    lon: row.lon,
    heading: row.heading,
    speedKmh: row.speed_kmh,
    sentido: normalizeSentido(row.sentido),
    timestamp: new Date(row.timestamp).toISOString(),
    capturedAt: row.captured_at ?? row.timestamp,
    receivedAt: row.timestamp,
    sequence: row.sequence,
    driverPhone: row.driver_phone,
    companyId: row.bus_company_id ?? '',
    isGhost: row.is_ghost === 1,
  };
}

export function toPublicPosition(position: BusPosition): Omit<BusPosition, 'driverPhone' | 'companyId'> {
  const { driverPhone: _driverPhone, companyId: _companyId, ...publicPosition } = position;
  return publicPosition;
}

export function loadVisibilityCache(): void {
  const rows = getDb().prepare('SELECT bus_id, visible FROM buses').all() as {
    bus_id: string;
    visible: number;
  }[];
  visibilityCache.clear();
  for (const row of rows) {
    visibilityCache.set(row.bus_id, row.visible === 1);
  }
}

export function loadBusCompanyCache(): void {
  const rows = getDb().prepare('SELECT bus_id, company_id FROM buses').all() as {
    bus_id: string;
    company_id: string;
  }[];
  busCompanyCache.clear();
  for (const row of rows) {
    busCompanyCache.set(row.bus_id, row.company_id);
  }
}

export function getBusCompanyId(busId: string): string | null {
  const cached = busCompanyCache.get(busId);
  if (cached !== undefined) return cached || null;
  const row = getDb().prepare('SELECT company_id FROM buses WHERE bus_id = ?')
    .get(busId) as { company_id: string } | undefined;
  const value = row?.company_id ?? '';
  busCompanyCache.set(busId, value);
  return value || null;
}

export function getBusVisibility(busId: string): boolean {
  const cached = visibilityCache.get(busId);
  if (cached !== undefined) return cached;
  const row = getDb().prepare('SELECT visible FROM buses WHERE bus_id = ?')
    .get(busId) as { visible: number } | undefined;
  const value = row?.visible !== 0;
  visibilityCache.set(busId, value);
  return value;
}

export function getFleetPositions(companyId: string): FleetBus[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT b.bus_id, b.company_id, b.visible, b.plate_number, b.interno, b.route_id AS bus_route_id,
           p.route_id, p.lat, p.lon, p.heading, p.speed_kmh, p.sentido,
           p.timestamp, p.captured_at, p.sequence, p.is_ghost,
           d.name AS driver_name
    FROM buses b
    LEFT JOIN positions p ON p.bus_id = b.bus_id
    LEFT JOIN drivers d ON d.phone_number = p.driver_phone
    WHERE b.company_id = ?
    ORDER BY b.bus_id ASC
  `).all(companyId) as {
    bus_id: string;
    company_id: string;
    visible: number;
    plate_number: string | null;
    interno: string | null;
    bus_route_id: string | null;
    route_id: string | null;
    lat: number | null;
    lon: number | null;
    heading: number | null;
    speed_kmh: number | null;
    sentido: string | null;
    timestamp: number | null;
    captured_at: number | null;
    sequence: number | null;
    is_ghost: number | null;
    driver_name: string | null;
  }[];

  return rows.map((row) => ({
    busId: row.bus_id,
    companyId: row.company_id,
    routeId: row.route_id ?? row.bus_route_id,
    placa: row.plate_number ?? row.bus_id,
    interno: row.interno ?? '',
    driverName: row.driver_name,
    visible: row.visible === 1,
    online: row.timestamp != null,
    lat: row.lat,
    lon: row.lon,
    heading: row.heading ?? 0,
    speedKmh: row.speed_kmh ?? 0,
    sentido: normalizeSentido(row.sentido),
    capturedAt: row.captured_at ?? row.timestamp,
    receivedAt: row.timestamp,
    sequence: row.sequence,
    isGhost: row.is_ghost === 1,
  }));
}

export function createBus(
  companyId: string,
  placa: string,
  routeId: string,
  interno?: string,
): FleetBus | null {
  const normalized = normalizePlaca(placa);
  if (!normalized) return null;
  if (!routeId || !routeId.trim()) return null;
  const busId = busIdFromPlaca(normalized);
  const now = Date.now();
  const db = getDb();

  const existing = db.prepare('SELECT interno FROM buses WHERE bus_id = ?')
    .get(busId) as { interno: string | null } | undefined;
  const resolvedInterno = (interno ?? '').trim()
    || existing?.interno
    || String((db.prepare('SELECT COUNT(*) AS c FROM buses WHERE company_id = ?')
        .get(companyId) as { c: number }).c + 1).padStart(3, '0');

  const insert = db.prepare(`
    INSERT INTO buses (bus_id, company_id, plate_number, route_id, interno, visible, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(bus_id) DO UPDATE SET
      company_id = excluded.company_id,
      plate_number = excluded.plate_number,
      route_id = excluded.route_id,
      interno = excluded.interno,
      updated_at = excluded.updated_at
  `);
  insert.run(busId, companyId, normalized, routeId || null, resolvedInterno, now, now);
  busCompanyCache.set(busId, companyId);
  return {
    busId,
    companyId,
    routeId: routeId || null,
    placa: normalized,
    interno: resolvedInterno,
    driverName: null,
    visible: false,
    online: false,
    lat: null,
    lon: null,
    heading: 0,
    speedKmh: 0,
    sentido: null,
    capturedAt: null,
    receivedAt: null,
    sequence: null,
    isGhost: false,
  };
}

export function updateBus(
  busId: string,
  changes: { placa?: string; routeId?: string | null; interno?: string },
): FleetBus | null {
  const companyId = getBusCompanyId(busId);
  if (!companyId) return null;
  const db = getDb();

  let newPlaca: string | null = null;
  if (changes.placa !== undefined) {
    newPlaca = normalizePlaca(changes.placa);
    if (!newPlaca) return null;
  }
  const routeId = changes.routeId !== undefined ? changes.routeId : null;
  const interno = changes.interno !== undefined ? changes.interno.trim() : null;

  const dbUpdate = db.transaction(() => {
    if (newPlaca) {
      db.prepare('UPDATE buses SET plate_number = ?, updated_at = ? WHERE bus_id = ?')
        .run(newPlaca, Date.now(), busId);
    }
    if (routeId !== null) {
      db.prepare('UPDATE buses SET route_id = ?, updated_at = ? WHERE bus_id = ?')
        .run(routeId || null, Date.now(), busId);
    }
    if (interno !== null) {
      db.prepare('UPDATE buses SET interno = ?, updated_at = ? WHERE bus_id = ?')
        .run(interno, Date.now(), busId);
    }
  });
  dbUpdate();

  const updated = getFleetPositions(companyId).find((b) => b.busId === busId);
  return updated ?? null;
}

export function deleteBus(busId: string): { busId: string; routeId: string | null } | null {
  const companyId = getBusCompanyId(busId);
  if (!companyId) return null;
  const db = getDb();

  const remove = db.transaction(() => {
    const position = db.prepare(
      'SELECT route_id FROM positions WHERE bus_id = ?'
    ).get(busId) as { route_id: string } | undefined;

    const routeId = position?.route_id
      ?? (db.prepare('SELECT route_id FROM buses WHERE bus_id = ?').get(busId) as { route_id: string | null } | undefined)?.route_id
      ?? null;

    db.prepare('DELETE FROM turn_assignments WHERE bus_id = ?').run(busId);
    db.prepare('DELETE FROM positions WHERE bus_id = ?').run(busId);
    db.prepare('DELETE FROM buses WHERE bus_id = ?').run(busId);

    if (routeId) {
      queueLifecycleEvent(db, 'bus:removed', routeId, { busId, routeId });
    }
    return routeId;
  });
  const routeId = remove();

  busCompanyCache.delete(busId);
  visibilityCache.delete(busId);
  return { busId, routeId };
}

export function deleteAllBuses(companyId: string): number {
  const db = getDb();
  const remove = db.transaction(() => {
    const buses = db.prepare('SELECT bus_id FROM buses WHERE company_id = ?')
      .all(companyId) as { bus_id: string }[];
    for (const bus of buses) {
      const pos = db.prepare(
        'SELECT route_id FROM positions WHERE bus_id = ? LIMIT 1',
      ).get(bus.bus_id) as { route_id: string } | undefined;
      const busRow = db.prepare(
        'SELECT route_id FROM buses WHERE bus_id = ?',
      ).get(bus.bus_id) as { route_id: string | null } | undefined;
      const routeId = pos?.route_id ?? busRow?.route_id ?? null;
      if (routeId) {
        queueLifecycleEvent(db, 'bus:removed', routeId, {
          busId: bus.bus_id,
          routeId,
        });
      }
    }
    db.prepare('DELETE FROM positions WHERE bus_id IN (SELECT bus_id FROM buses WHERE company_id = ?)').run(companyId);
    db.prepare('DELETE FROM turn_assignments WHERE bus_id IN (SELECT bus_id FROM buses WHERE company_id = ?)').run(companyId);
    db.prepare('DELETE FROM buses WHERE company_id = ?').run(companyId);
    return buses.length;
  });
  const count = remove();

  const toClear = [...busCompanyCache.entries()]
    .filter(([, c]) => c === companyId)
    .map(([busId]) => busId);
  for (const busId of toClear) {
    busCompanyCache.delete(busId);
    visibilityCache.delete(busId);
  }
  return count;
}

export function normalizePlaca(placa: string): string | null {
  const cleaned = placa.trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z]{3}[0-9]{3}$/.test(cleaned)) return null;
  return cleaned;
}

export function busIdFromPlaca(placa: string): string {
  return 'BUS-' + placa.replace(/[^A-Z0-9]/g, '');
}

const routeNameMap: Record<string, string> = {
  'R-101': 'Tcherassi',
  'R-102': 'Carrera 14 - Silencio',
  'R-103': 'Vivero Paraíso',
  'R-104': 'Carrera 50 - Paraiso',
  'R-105': 'Carrera 54 - Uninorte',
  'R-106': 'Calle 72 - Uninorte',
};

export function getCompanyRoutes(companyId: string): {
  routeId: string;
  name: string;
  terminalA: string | null;
  terminalB: string | null;
  total: number;
  online: number;
}[] {
  const db = getDb();
  const derived = db.prepare(`
    SELECT COALESCE(p.route_id, b.route_id) AS route_id,
           COUNT(DISTINCT b.bus_id) AS total,
           SUM(CASE WHEN p.bus_id IS NOT NULL THEN 1 ELSE 0 END) AS online
    FROM buses b
    LEFT JOIN positions p ON p.bus_id = b.bus_id
    WHERE b.company_id = ? AND COALESCE(p.route_id, b.route_id) IS NOT NULL
    GROUP BY COALESCE(p.route_id, b.route_id)
  `).all(companyId) as { route_id: string; total: number; online: number }[];
  const catalog = db.prepare(`
    SELECT route_id, name, terminal_a, terminal_b FROM company_routes
    WHERE company_id = ?
    ORDER BY route_id ASC
  `).all(companyId) as { route_id: string; name: string; terminal_a: string | null; terminal_b: string | null }[];

  const totals = new Map(derived.map((r) => [r.route_id, r]));
  const byId = new Map(catalog.map((r) => [r.route_id, r.name]));
  const seen = new Set<string>();
  const merged: {
    routeId: string;
    name: string;
    terminalA: string | null;
    terminalB: string | null;
    total: number;
    online: number;
  }[] = [];

  for (const route of catalog) {
    seen.add(route.route_id);
    merged.push({
      routeId: route.route_id,
      name: route.name,
      terminalA: route.terminal_a,
      terminalB: route.terminal_b,
      total: totals.get(route.route_id)?.total ?? 0,
      online: totals.get(route.route_id)?.online ?? 0,
    });
  }
  for (const row of derived) {
    if (seen.has(row.route_id)) continue;
    merged.push({
      routeId: row.route_id,
      name: byId.get(row.route_id) ?? routeNameMap[row.route_id] ?? `Ruta ${row.route_id}`,
      terminalA: null,
      terminalB: null,
      total: row.total,
      online: row.online ?? 0,
    });
  }
  return merged;
}

export function getCompanyBuses(companyId: string): {
  busId: string;
  placa: string;
  routeId: string | null;
  interno: string;
  visible: boolean;
}[] {
  const rows = getDb().prepare(`
    SELECT bus_id, plate_number, route_id, interno, visible
    FROM buses
    WHERE company_id = ?
    ORDER BY interno ASC, bus_id ASC
  `).all(companyId) as {
    bus_id: string;
    plate_number: string | null;
    route_id: string | null;
    interno: string | null;
    visible: number;
  }[];

  return rows.map((row) => ({
    busId: row.bus_id,
    placa: row.plate_number ?? row.bus_id,
    routeId: row.route_id,
    interno: row.interno ?? '',
    visible: row.visible === 1,
  }));
}

export function routeNameExists(companyId: string, name: string, excludeRouteId?: string): boolean {
  const db = getDb();
  const cleaned = name.trim().toLowerCase();
  if (!cleaned) return false;
  const excluded = excludeRouteId ?? '';
  const inCatalog = db.prepare(
    'SELECT 1 FROM company_routes WHERE company_id = ? AND LOWER(name) = ? AND route_id != ? LIMIT 1',
  ).get(companyId, cleaned, excluded);
  if (inCatalog) return true;
  const derived = db.prepare(`
    SELECT COALESCE(p.route_id, b.route_id) AS route_id
    FROM buses b
    LEFT JOIN positions p ON p.bus_id = b.bus_id
    WHERE b.company_id = ? AND COALESCE(p.route_id, b.route_id) IS NOT NULL
  `).all(companyId) as { route_id: string }[];
  return derived.some((r) => {
    if (r.route_id === excluded) return false;
    const fallback = routeNameMap[r.route_id] ?? `Ruta ${r.route_id}`;
    return fallback.toLowerCase() === cleaned;
  });
}

export function addCompanyRoute(
  companyId: string,
  routeId: string,
  name: string,
): { routeId: string; name: string } | null {
  const cleanedName = name.trim();
  if (!cleanedName) return null;
  let cleanedId = routeId.trim().toUpperCase();
  if (!cleanedId) {
    const last = getDb().prepare(
      'SELECT route_id FROM company_routes WHERE company_id = ? ORDER BY route_id DESC LIMIT 1',
    ).get(companyId) as { route_id: string } | undefined;
    const match = last?.route_id.match(/^R-(\d+)$/);
    const next = match ? parseInt(match[1], 10) + 1 : 1;
    cleanedId = `R-${String(next).padStart(3, '0')}`;
  }
  if (!/^[A-Z0-9-]{2,20}$/.test(cleanedId)) return null;
  getDb().prepare(`
    INSERT INTO company_routes (company_id, route_id, name, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(company_id, route_id) DO UPDATE SET name = excluded.name
  `).run(companyId, cleanedId, cleanedName, Date.now());
  return { routeId: cleanedId, name: cleanedName };
}

export function renameCompanyRoute(
  companyId: string,
  routeId: string,
  name: string,
): { routeId: string; name: string } | null {
  const cleanedName = name.trim();
  if (!cleanedName) return null;
  const result = getDb().prepare(
    'UPDATE company_routes SET name = ? WHERE company_id = ? AND route_id = ?',
  ).run(cleanedName, companyId, routeId);
  if (result.changes === 0) return null;
  return { routeId, name: cleanedName };
}

export function removeCompanyRoute(companyId: string, routeId: string): boolean {
  const db = getDb();
  const remove = db.transaction(() => {
    const result = db.prepare(
      'DELETE FROM company_routes WHERE company_id = ? AND route_id = ?',
    ).run(companyId, routeId);
    if (result.changes === 0) return false;

    const busIds = (db.prepare(
      'SELECT bus_id FROM buses WHERE company_id = ? AND route_id = ?',
    ).all(companyId, routeId) as { bus_id: string }[]).map((r) => r.bus_id);

    if (busIds.length > 0) {
      const fallback = db.prepare(
        'SELECT route_id FROM company_routes WHERE company_id = ? ORDER BY route_id ASC LIMIT 1',
      ).get(companyId) as { route_id: string } | undefined;
      const fallbackId = fallback?.route_id ?? 'R-101';
      db.prepare(
        'UPDATE buses SET route_id = ?, updated_at = ? WHERE company_id = ? AND route_id = ?',
      ).run(fallbackId, Date.now(), companyId, routeId);
      const setPositionRoute = db.prepare(
        'UPDATE positions SET route_id = ? WHERE bus_id = ?',
      );
      for (const busId of busIds) {
        setPositionRoute.run(fallbackId, busId);
      }
    }
    return true;
  });
  return remove();
}

export function setBusVisibility(
  busId: string,
  visible: boolean,
): { busId: string; routeId: string; visible: boolean } | null {
  const companyId = getBusCompanyId(busId);
  if (!companyId) return null;

  const db = getDb();
  const update = db.transaction(() => {
    db.prepare('UPDATE buses SET visible = ?, updated_at = ? WHERE bus_id = ?')
      .run(visible ? 1 : 0, Date.now(), busId);

    const position = getPosition(busId);
    const routeId = position?.routeId ?? '';
    queueLifecycleEvent(db, visible ? 'bus:visible' : 'bus:hidden', routeId, {
      busId,
      routeId,
      ...(visible && position ? { position: { ...position, visible } } : {}),
    });
  });
  update();

  visibilityCache.set(busId, visible);
  busCompanyCache.set(busId, companyId);
  return { busId, routeId: getPosition(busId)?.routeId ?? '', visible };
}

export function setAllBusVisibility(companyId: string, visible: boolean): number {
  const db = getDb();
  const buses = db.prepare('SELECT bus_id FROM buses WHERE company_id = ?')
    .all(companyId) as { bus_id: string }[];
  for (const bus of buses) {
    setBusVisibility(bus.bus_id, visible);
  }
  return buses.length;
}

export function upsertPosition(phoneNumber: string, data: {
  busId: string;
  routeId?: string;
  lat: number;
  lon: number;
  heading?: number;
  speedKmh?: number;
  sentido?: 'ida' | 'venida';
  sessionId?: string;
  capturedAt?: number;
  sequence?: number;
  driverValidated?: boolean;
  companyId?: string;
}): BusPosition | null {
  const db = getDb();

  const driver = data.driverValidated ? undefined : getDriver(phoneNumber);
  if (!data.driverValidated && !driver) return null;

  const now = Date.now();
  const routeId = data.routeId || driver?.routeId;
  if (!routeId) return null;
  const heading = data.heading ?? 0;
  const speedKmh = data.speedKmh ?? 0;
  const sentido = normalizeSentido(data.sentido ?? null);
  const companyId = data.companyId || driver?.companyId || '';

  const result = db.prepare(`
    INSERT INTO positions (
      bus_id, route_id, lat, lon, heading, speed_kmh, sentido, timestamp, driver_phone,
      session_id, captured_at, sequence, is_ghost
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(bus_id) DO UPDATE SET
      lat = excluded.lat,
      lon = excluded.lon,
      heading = excluded.heading,
      speed_kmh = excluded.speed_kmh,
      sentido = excluded.sentido,
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
    sentido,
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
    sentido,
    timestamp: new Date(now).toISOString(),
    capturedAt: data.capturedAt ?? now,
    receivedAt: now,
    sequence: data.sequence ?? null,
    driverPhone: phoneNumber,
    companyId,
    isGhost: false,
  };
}

export function getPositionsByRoute(routeId: string): BusPosition[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT p.*, b.company_id AS bus_company_id
    FROM positions p
    LEFT JOIN buses b ON b.bus_id = p.bus_id
    WHERE p.route_id = ? AND (b.visible = 1 OR b.visible IS NULL)
  `).all(routeId) as PositionRow[];
  return rows.map(rowToPosition);
}

export function sweepPositions(ghostMs: number): {
  toGhost: BusPosition[];
} {
  const db = getDb();
  const now = Date.now();
  const ghostTime = now - ghostMs;

  const sweep = db.transaction(() => {
    const ghostedRows = db.prepare(
      'UPDATE positions SET is_ghost = 1 WHERE is_ghost = 0 AND timestamp < ? RETURNING *'
    ).all(ghostTime) as PositionRow[];

    for (const row of ghostedRows) {
      const position = rowToPosition(row);
      queueLifecycleEvent(db, 'bus:position', position.routeId, { ...position });
    }

    return { toGhost: ghostedRows.map(rowToPosition) };
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
  const row = db.prepare(`
    SELECT p.*, b.company_id AS bus_company_id
    FROM positions p
    LEFT JOIN buses b ON b.bus_id = p.bus_id
    WHERE p.bus_id = ?
  `).get(busId) as PositionRow | undefined;
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
  const rows = db.prepare(`
    SELECT p.*, b.company_id AS bus_company_id
    FROM positions p
    LEFT JOIN buses b ON b.bus_id = p.bus_id
  `).all() as PositionRow[];
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
