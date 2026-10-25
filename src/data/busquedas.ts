import { getDb } from './database';

// Celdas centradas en múltiplos desde 0, a escala local de Barranquilla.
export const PASO_LAT = 0.00135;
export const PASO_LNG = 0.00137;
export const K_BUSQUEDAS = 5;
export const RETENCION_MS = 396 * 24 * 60 * 60 * 1000;

export function horaBogota(instant: number): number {
  const fecha = new Date(instant - 5 * 60 * 60 * 1000);
  fecha.setUTCMinutes(0, 0, 0);
  return fecha.getTime() + 5 * 60 * 60 * 1000;
}

export function registrarBusqueda(routeId: string, lat: number | null, lng: number | null, ahora = Date.now()): void {
  const db = getDb();
  const celdaKey = lat === null || lng === null ? '-' : `${lat},${lng}`;
  db.prepare(`INSERT INTO busquedas(route_id, hora, celda_key, celda_lat, celda_lng, count)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(route_id, hora, celda_key) DO UPDATE SET count = count + 1`)
    .run(routeId, horaBogota(ahora), celdaKey, lat, lng);
}

export function limpiarBusquedas(ahora = Date.now()): number {
  return getDb().prepare('DELETE FROM busquedas WHERE hora < ?').run(ahora - RETENCION_MS).changes;
}

export function rankingBusquedas(companyId: string, desde: number, hasta: number, hora?: number) {
  const rows = getDb().prepare(`SELECT cr.route_id AS routeId, cr.name AS name,
    COALESCE(SUM(b.count), 0) AS total,
    SUM(CASE WHEN CAST(strftime('%H', datetime(b.hora / 1000, 'unixepoch', '-5 hours')) AS INTEGER) = 0 THEN b.count ELSE 0 END) AS h0,
    ${Array.from({ length: 23 }, (_, i) => `SUM(CASE WHEN CAST(strftime('%H', datetime(b.hora / 1000, 'unixepoch', '-5 hours')) AS INTEGER) = ${i + 1} THEN b.count ELSE 0 END) AS h${i + 1}`).join(',\n    ')}
    FROM company_routes cr LEFT JOIN busquedas b ON b.route_id = cr.route_id AND b.hora >= ? AND b.hora < ?
    WHERE cr.company_id = ? GROUP BY cr.route_id ORDER BY total DESC, cr.name`).all(desde, hasta, companyId) as Record<string, unknown>[];
  const resultado = rows.map((row) => {
    const porHora = Array.from({ length: 24 }, (_, h) => Number(row[`h${h}`] ?? 0));
    const max = Math.max(...porHora);
    return { routeId: row.routeId, name: row.name, total: hora === undefined ? Number(row.total) : porHora[hora], porHora, horaPico: max ? porHora.indexOf(max) : null };
  });
  if (hora !== undefined) resultado.sort((a, b) => b.total - a.total);
  return resultado;
}

export function calorBusquedas(companyId: string, routeId: string, desde: number, hasta: number, hora?: number) {
  const own = getDb().prepare('SELECT 1 FROM company_routes WHERE company_id = ? AND route_id = ?').get(companyId, routeId);
  if (!own) return null;
  const rows = getDb().prepare(`SELECT celda_lat AS lat, celda_lng AS lng, SUM(count) AS count FROM busquedas
    WHERE route_id = ? AND celda_lat IS NOT NULL AND hora >= ? AND hora < ?
    ${hora === undefined ? '' : "AND CAST(strftime('%H', datetime(hora / 1000, 'unixepoch', '-5 hours')) AS INTEGER) = ?"}
    GROUP BY celda_lat, celda_lng HAVING SUM(count) >= ?`)
    .all(...(hora === undefined ? [routeId, desde, hasta, K_BUSQUEDAS] : [routeId, desde, hasta, hora, K_BUSQUEDAS]));
  return rows;
}
