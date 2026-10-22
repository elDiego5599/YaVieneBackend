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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decidirVisibilidadTerminal, type EstadoVisibilidad } from './visibilidad_terminal';
import { visibilityCache } from './fleet_admin';

const estadosVisibilidad = new Map<string, EstadoVisibilidad>();
let geometriasRuta: Map<string, { waypoints: Array<{ lat: number; lon: number }> | null; valida: boolean }> | undefined;

/** Descarta el estado automático cuando el panel reactiva manualmente un bus. */
export function resetEstadoVisibilidadTerminal(busId: string): void {
  estadosVisibilidad.delete(busId);
}

function geometriaDeRuta(): NonNullable<typeof geometriasRuta> {
  if (geometriasRuta) return geometriasRuta;
  try {
    const datos = JSON.parse(readFileSync(join(__dirname, '..', '..', 'scripts', 'data', 'rutas.json'), 'utf8')) as {
      rutas: Array<{ routeId: string; waypoints: Array<{ lat: number; lon: number }> }>;
    };
    geometriasRuta = new Map(datos.rutas.map((r) => {
      const puntos = r.waypoints;
      const valido = Array.isArray(puntos) && puntos.length >= 2 && puntos.every((p) =>
        Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180);
      return [r.routeId, { waypoints: valido ? puntos : null, valida: valido }];
    }));
  } catch {
    geometriasRuta = new Map();
  }
  return geometriasRuta;
}

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

export function toPublicPosition(position: BusPosition): Omit<BusPosition, 'driverPhone' | 'companyId' | 'enTerminal'> {
  const { driverPhone: _driverPhone, companyId: _companyId, enTerminal: _enTerminal, ...publicPosition } = position;
  return publicPosition;
}

/** La fila del bus en el catálogo, o `undefined` si no está dado de alta. */
function busDelCatalogo(busId: string): { route_id: string | null } | undefined {
  return getDb().prepare('SELECT route_id FROM buses WHERE bus_id = ?')
    .get(busId) as { route_id: string | null } | undefined;
}

/**
 * Si el bus existe en el catálogo. Se consulta la base y no
 * `busCompanyCache`: esa caché guarda también los «no está», y cualquier
 * camino que cree la fila del bus sin corregirla (el alta de conductor lo
 * hacía hasta P2-1) dejaría un bus preguntado antes de existir rechazado
 * para siempre.
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

  const ruta = geometriaDeRuta().get(routeId);
  const filaVisible = db.prepare(`
    SELECT b.visible, b.en_terminal, p.route_id AS route_id, p.route_fraction, p.sentido, p.route_direction
    FROM buses b LEFT JOIN positions p ON p.bus_id = b.bus_id WHERE b.bus_id = ?
  `).get(data.busId) as {
    visible: number; en_terminal: number; route_id: string | null; route_fraction: number | null;
    sentido: string | null; route_direction: string | null;
  } | undefined;
  const sentidoPersistido = filaVisible?.route_direction === 'ida' || filaVisible?.route_direction === 'venida'
    ? filaVisible.route_direction
    : filaVisible?.sentido === 'ida' || filaVisible?.sentido === 'venida' ? filaVisible.sentido : undefined;
  const estadoPersistido: EstadoVisibilidad | undefined = filaVisible?.route_id === routeId
    ? {
      visible: filaVisible.visible === 1,
      rutaId: routeId,
      sentido: sentidoPersistido,
      fraccionRecorrida: filaVisible.route_fraction ?? undefined,
      muestrasQuieto: 0,
      muestrasSalida: 0,
      ...(filaVisible.visible === 0 && filaVisible.en_terminal === 1 && filaVisible.route_fraction !== null && filaVisible.route_fraction !== undefined
        ? { fraccionAlOcultar: sentidoPersistido === 'venida' ? 1 - filaVisible.route_fraction : filaVisible.route_fraction }
        : {}),
    }
    : undefined;
  const decisionCalculada = decidirVisibilidadTerminal({
    busId: data.busId, routeId, lat: data.lat, lon: data.lon, speedKmh,
    capturedAt: data.capturedAt ?? now,
    sentido,
    geometria: ruta?.waypoints,
  }, estadosVisibilidad.get(data.busId) ?? estadoPersistido);
  // Un apagado ordenado desde el panel no se debe convertir en ocultamiento
  // terminal ni revertir por movimiento. La migración separa ambos motivos.
  const ocultoManual = filaVisible?.visible === 0 && filaVisible.en_terminal === 0;
  const decision = ocultoManual ? {
    ...decisionCalculada,
    visible: false,
    estado: { ...decisionCalculada.estado, visible: false },
    motivo: 'visible' as const,
  } : decisionCalculada;

  const result = db.prepare(`
    INSERT INTO positions (
      bus_id, route_id, lat, lon, heading, speed_kmh, sentido, timestamp, driver_phone,
      session_id, captured_at, sequence, is_ghost, route_fraction, route_direction
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
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
      is_ghost = 0,
      route_fraction = excluded.route_fraction,
      route_direction = excluded.route_direction
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
    decision.fraccionRecorrida ?? null,
    decision.estado.sentido ?? null,
  );

  if (result.changes !== 1) return null;

  estadosVisibilidad.set(data.busId, decision.estado);
  const enTerminal = !decision.visible && decision.motivo === 'en_terminal';
  if (filaVisible && (filaVisible.visible !== (decision.visible ? 1 : 0)
    || filaVisible.en_terminal !== (enTerminal ? 1 : 0))) {
    db.prepare('UPDATE buses SET visible = ?, en_terminal = ?, updated_at = ? WHERE bus_id = ?')
      .run(decision.visible ? 1 : 0, enTerminal ? 1 : 0, now, data.busId);
    visibilityCache.set(data.busId, decision.visible);
    if (filaVisible.visible !== (decision.visible ? 1 : 0)) queueLifecycleEvent(db, decision.visible ? 'bus:visible' : 'bus:hidden', routeId, {
      busId: data.busId, routeId,
      enTerminal,
      ...(decision.visible ? { position: { busId: data.busId, routeId, lat: data.lat, lon: data.lon, heading, speedKmh, sentido, timestamp: new Date(now).toISOString(), capturedAt: data.capturedAt ?? now, receivedAt: now, sequence: data.sequence ?? null, driverPhone: phoneNumber, companyId, isGhost: false } } : {}),
    });
  }

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
    enTerminal: !decision.visible && decision.motivo === 'en_terminal',
  };
}

// JOIN y no LEFT JOIN: es la lectura pública de una ruta, y una posición
// sin bus en el catálogo es un bus borrado, no uno sin empresa que haya que
// enseñar. `visible` NULL sigue contando como visible, igual que en
// `getBusVisibility`.
//
// Segunda barrera de P1-2 (auditoría 2026-09): una ruta del catálogo solo
// enseña buses de su empresa. El alta y la edición ya no dejan poner un bus
// en la ruta de otra, pero un bus colado antes del arreglo seguía saliendo
// en el mapa de los pasajeros ajenos. Una ruta que no está en ningún
// catálogo (buses viejos provisionados sin ruta de catálogo) no tiene dueña
// que proteger y sigue como antes. `company_routes` es única por
// `route_id` (migración 20): el LEFT JOIN no duplica filas.
export function getPositionsByRoute(routeId: string): BusPosition[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT p.*, b.company_id AS bus_company_id
    FROM positions p
    JOIN buses b ON b.bus_id = p.bus_id
    LEFT JOIN company_routes cr ON cr.route_id = p.route_id
    WHERE p.route_id = ? AND (b.visible = 1 OR b.visible IS NULL)
      AND (cr.company_id IS NULL OR cr.company_id = b.company_id)
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
