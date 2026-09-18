// Store de posiciones vivas: la tabla `positions` es un snapshot por bus
// (upsert con orden de sesión), no un historial. Todo lo que lee/escribe
// posiciones pasa por aquí.
import { getDb } from './database';
import { queueLifecycleEvent } from './lifecycle_events';
import {
  BusPosition,
  PositionRow,
  PositionValidationState,
  normalizeSentido,
} from './bus_types';
import { getDriver } from './drivers_store';

export function rowToPosition(row: PositionRow): BusPosition {
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

/** La fila del bus en el catálogo, o `undefined` si no está dado de alta. */
function busDelCatalogo(busId: string): { route_id: string | null } | undefined {
  return getDb().prepare('SELECT route_id FROM buses WHERE bus_id = ?')
    .get(busId) as { route_id: string | null } | undefined;
}

/**
 * Si el bus existe en el catálogo. Se consulta la base y no
 * `busCompanyCache`: esa caché guarda también los «no está», y el alta de un
 * conductor crea la fila del bus sin pasar por ella, así que un bus
 * preguntado antes de provisionarse quedaría rechazado para siempre.
 */
export function busInCatalog(busId: string): boolean {
  return busDelCatalogo(busId) !== undefined;
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

  // Sólo publica un bus que está en el catálogo. Sin esto, el teléfono de un
  // bus recién borrado seguía mandando y cada posición recreaba su fila en
  // `positions`: un bus sin dueño que el pasajero veía en el mapa.
  const bus = busDelCatalogo(data.busId);
  if (!bus) return null;

  // La ruta la decide el catálogo y no la sesión. La sesión guarda la ruta
  // con la que el conductor inició turno, y cuando el panel le cambia la
  // ruta al bus, `updateBus` mueve la posición a la nueva… hasta que la
  // siguiente publicación, con la ruta vieja de la sesión, la devolvía a
  // donde estaba. Un bus provisionado desde el alta de conductor no tiene
  // ruta en el catálogo, y para ése sigue valiendo la de la sesión.
  const now = Date.now();
  const routeId = bus.route_id || data.routeId || driver?.routeId;
  if (!routeId) return null;
  // Sin rumbo va NULL y no 0: 0 es el norte, y el mapa dibujaba apuntando
  // hacia arriba un bus del que no se sabe hacia dónde va.
  const heading = data.heading ?? null;
  const speedKmh = data.speedKmh ?? 0;
  const sentido = normalizeSentido(data.sentido ?? null);
  const companyId = data.companyId || driver?.companyId || '';

  const result = db.prepare(`
    INSERT INTO positions (
      bus_id, route_id, lat, lon, heading, speed_kmh, sentido, timestamp, driver_phone,
      session_id, captured_at, sequence, is_ghost
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(bus_id) DO UPDATE SET
      route_id = excluded.route_id,
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

// JOIN y no LEFT JOIN: es la lectura pública de una ruta, y una posición
// sin bus en el catálogo es un bus borrado, no uno sin empresa que haya que
// enseñar. `visible` NULL sigue contando como visible, igual que en
// `getBusVisibility`.
export function getPositionsByRoute(routeId: string): BusPosition[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT p.*, b.company_id AS bus_company_id
    FROM positions p
    JOIN buses b ON b.bus_id = p.bus_id
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

  // Pre-check: evitar lock de escritura WAL en el hilo principal si no hay candidatos.
  // idx_positions_timestamp cubre el filtro timestamp < ?.
  const hasCandidates = db.prepare(
    'SELECT 1 FROM positions WHERE is_ghost = 0 AND timestamp < ? LIMIT 1'
  ).get(ghostTime);
  if (!hasCandidates) {
    return { toGhost: [] };
  }

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

/**
 * ¿Sigue valiendo un evento `bus:position` de fantasma que ya está en la
 * cola?
 *
 * El barrido marca sin señal a un bus y encola el aviso; el despacho lo
 * manda después, y entre las dos cosas el bus puede haber vuelto a
 * publicar. Si el aviso sale igual, el pasajero ve «sin señal» un bus que
 * acaba de reportar, y no se corrige hasta la siguiente posición: el
 * fantasma tapa a la posición viva porque llega después.
 *
 * Se mira contra la fila de ahora: si el bus ya no está, si dejó de ser
 * fantasma, o si su captura es más nueva que la del evento, el evento nació
 * viejo y no se emite.
 */
export function isGhostEventStillValid(busId: string, capturedAt: number): boolean {
  const actual = getPosition(busId);
  if (!actual) return false;
  if (!actual.isGhost) return false;
  return actual.capturedAt <= capturedAt;
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

export function getPosition(busId: string): (BusPosition & { visible: boolean }) | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT p.*, b.company_id AS bus_company_id, b.visible AS bus_visible
    FROM positions p
    LEFT JOIN buses b ON b.bus_id = p.bus_id
    WHERE p.bus_id = ?
  `).get(busId) as PositionRow | undefined;
  if (!row) return null;
  return { ...rowToPosition(row), visible: row.bus_visible !== 0 };
}

export function getPositionSequence(busId: string, sessionId: string): number | null {
  const db = getDb();
  const row = db.prepare('SELECT sequence FROM positions WHERE bus_id = ? AND session_id = ?')
    .get(busId, sessionId) as { sequence: number | null } | undefined;
  return row?.sequence ?? null;
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
