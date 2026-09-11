// Administración de flota: CRUD de buses por empresa, visibilidad y placas.
// La visibilidad y la empresa del bus se cachean en memoria porque el camino
// caliente (cada posición recibida / cada lectura pública) las consulta.
import { getDb } from './database';
import { queueLifecycleEvent } from './lifecycle_events';
import { FleetBus, normalizeSentido } from './bus_types';
import { getPosition } from './positions_store';
import { isRouteId } from './routes_store';
import { revokeSessionsForBus } from './sessions';

/**
 * Largo máximo del número interno. Sale en `/api/companies/:id/buses`, que es
 * público, y antes solo lo acotaba el tope del cuerpo de la petición (32 KB).
 * Los internos reales son de tres o cuatro cifras.
 */
export const MAX_INTERNO = 12;

export const visibilityCache = new Map<string, boolean>();
export const busCompanyCache = new Map<string, string>();

export function getBusCompanyId(busId: string): string | null {
  const cached = busCompanyCache.get(busId);
  if (cached !== undefined) return cached || null;
  const row = getDb().prepare('SELECT company_id FROM buses WHERE bus_id = ?')
    .get(busId) as { company_id: string } | undefined;
  const value = row?.company_id ?? '';
  busCompanyCache.set(busId, value);
  return value || null;
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
    // Una fila en `positions` sólo dice que este bus reportó alguna vez. El
    // barrido marca `is_ghost` cuando lleva GHOST_MS sin publicar, y hasta
    // ahora esos seguían contando como conectados: el panel de la empresa
    // enseñaba la flota entera en línea con todos los teléfonos apagados.
    online: row.timestamp != null && row.is_ghost !== 1,
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

/**
 * Alta (o renovación) de un bus. Devuelve el bus, o por qué no se pudo:
 * `invalid` es una placa mal escrita, una ruta que falta o no tiene forma de
 * ruta, o un interno demasiado largo; `taken` es una placa que ya está dada
 * de alta en OTRA empresa.
 *
 * Ese segundo caso era un robo silencioso: el INSERT resuelve el conflicto
 * de placa pisando `company_id` con el de quien la manda, así que a un
 * administrador le bastaba con dar de alta la placa de un bus ajeno para que
 * el bus —y las posiciones que ya estaba publicando— cambiaran de empresa sin
 * que la dueña se enterara. Una placa es única en el país; que ya exista en
 * otra empresa no es un conflicto que se resuelva sobrescribiendo.
 *
 * La ruta solo se comprobaba no vacía, así que cualquier cadena acababa en
 * `buses.route_id`: un bus con ruta `<lo que sea>` queda fuera del mapa para
 * siempre, porque el socket del pasajero rechaza suscribirse a algo que no
 * tenga forma de ruta. Ahora se exige la misma forma que el alta de rutas.
 */
export type CreateBusError = 'invalid' | 'taken';

export function createBus(
  companyId: string,
  placa: string,
  routeId: string,
  interno?: string,
): FleetBus | CreateBusError {
  const normalized = normalizePlaca(placa);
  if (!normalized) return 'invalid';
  routeId = routeId.trim();
  if (!isRouteId(routeId)) return 'invalid';
  if ((interno ?? '').trim().length > MAX_INTERNO) return 'invalid';
  const busId = busIdFromPlaca(normalized);
  const now = Date.now();
  const db = getDb();

  const existing = db.prepare('SELECT interno, company_id FROM buses WHERE bus_id = ?')
    .get(busId) as { interno: string | null; company_id: string } | undefined;
  if (existing && existing.company_id !== companyId) return 'taken';
  // La misma placa puede estar en un bus cuyo id no sale de ella (los de la
  // demo se llaman B-201, y la edición cambia la placa sin tocar el id).
  // Sin esto el alta chocaría contra `idx_buses_plate` con un 500.
  if (placaDeOtroBus(normalized, busId)) return 'taken';
  // El número interno salía de COUNT(*)+1, y eso repite en cuanto se borra un
  // bus: con 001, 002 y 003 dados de alta, borrar el 002 deja el contador en
  // 2 y el siguiente nace como 003, chocando con el que ya existe. Se toma el
  // mayor interno numérico de la empresa, que no depende de cuántos queden.
  const resolvedInterno = (interno ?? '').trim()
    || existing?.interno
    || String(((db.prepare(
        `SELECT MAX(CAST(interno AS INTEGER)) AS m FROM buses
         WHERE company_id = ? AND interno GLOB '[0-9]*'`,
      ).get(companyId) as { m: number | null }).m ?? 0) + 1).padStart(3, '0');

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

/** Si la placa ya la lleva un bus distinto de `busId`, de cualquier empresa. */
function placaDeOtroBus(placa: string, busId: string): boolean {
  return getDb().prepare('SELECT 1 FROM buses WHERE plate_number = ? AND bus_id <> ?')
    .get(placa, busId) !== undefined;
}

/**
 * Edición de un bus. Devuelve el bus, `null` si no existe o la placa está
 * mal escrita, o `'taken'` si la placa ya la lleva otro bus. Ese caso no se
 * miraba: el alta rechazaba la placa ajena y la edición la aceptaba, así que
 * bastaba con crear un bus cualquiera y cambiarle la placa por la de otro.
 */
export type UpdateBusError = 'taken';

export function updateBus(
  busId: string,
  changes: { placa?: string; routeId?: string | null; interno?: string },
): FleetBus | UpdateBusError | null {
  const companyId = getBusCompanyId(busId);
  if (!companyId) return null;
  const db = getDb();

  let newPlaca: string | null = null;
  if (changes.placa !== undefined) {
    newPlaca = normalizePlaca(changes.placa);
    if (!newPlaca) return null;
    if (placaDeOtroBus(newPlaca, busId)) return 'taken';
  }
  const routeId = changes.routeId !== undefined ? changes.routeId : null;
  const interno = changes.interno !== undefined ? changes.interno.trim() : null;

  const dbUpdate = db.transaction(() => {
    if (newPlaca) {
      db.prepare('UPDATE buses SET plate_number = ?, updated_at = ? WHERE bus_id = ?')
        .run(newPlaca, Date.now(), busId);
    }
    if (routeId !== null) {
      const nueva = routeId || null;
      db.prepare('UPDATE buses SET route_id = ?, updated_at = ? WHERE bus_id = ?')
        .run(nueva, Date.now(), busId);
      // La posición viva lleva su propia ruta, que es la que lee el
      // pasajero. Cambiar sólo la del catálogo dejaba el bus en el mapa de
      // la ruta vieja hasta que el conductor reiniciara turno. Se mueven las
      // dos en la misma transacción, como hace `removeCompanyRoute`, y la
      // sala vieja recibe `bus:left` para soltarlo en el acto; en la nueva
      // aparece con su siguiente posición. Sin ruta nueva no hay mapa donde
      // ponerlo, y la posición se borra (`positions.route_id` es NOT NULL).
      const viva = db.prepare('SELECT route_id FROM positions WHERE bus_id = ?')
        .get(busId) as { route_id: string } | undefined;
      if (viva && viva.route_id !== nueva) {
        if (nueva) {
          db.prepare('UPDATE positions SET route_id = ? WHERE bus_id = ?').run(nueva, busId);
        } else {
          db.prepare('DELETE FROM positions WHERE bus_id = ?').run(busId);
        }
        queueLifecycleEvent(db, 'bus:left', viva.route_id, { busId, routeId: viva.route_id });
      }
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
    // Dentro de la transacción: si el borrado se deshace, el teléfono
    // conserva su sesión; si se confirma, ya no puede publicar.
    revokeSessionsForBus(busId);

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
      // Lo mismo que `deleteBus`: sin esto los teléfonos de la flota
      // borrada seguían publicando.
      revokeSessionsForBus(bus.bus_id);
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

// Las placas reales son 3 letras + 3 números (SQA223). El id público del
// bus deriva de la placa: BUS-SQA223.
export function normalizePlaca(placa: string): string | null {
  const cleaned = placa.trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z]{3}[0-9]{3}$/.test(cleaned)) return null;
  return cleaned;
}

export function busIdFromPlaca(placa: string): string {
  return 'BUS-' + placa.replace(/[^A-Z0-9]/g, '');
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
