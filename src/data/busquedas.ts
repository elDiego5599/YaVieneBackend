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

/** Días de la semana como en ISO 8601: 1 es lunes y 7, domingo. */
export type DiaSemana = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Un campo de la fecha de Barranquilla (`%H` la hora, `%w` el día con 0 en domingo). */
const enBogota = (formato: '%H' | '%w', columna: string) =>
  `CAST(strftime('${formato}', datetime(${columna} / 1000, 'unixepoch', '-5 hours')) AS INTEGER)`;

/** El filtro de días en SQL y sus valores; sin días pedidos, todos cuentan. */
function filtroDias(columna: string, dias?: readonly DiaSemana[]): { sql: string; valores: number[] } {
  if (!dias?.length) return { sql: '', valores: [] };
  return { sql: `AND ${enBogota('%w', columna)} IN (${dias.map(() => '?').join(', ')})`, valores: dias.map((dia) => dia % 7) };
}

export function rankingBusquedas(companyId: string, desde: number, hasta: number, hora?: number, dias?: readonly DiaSemana[]) {
  const enDias = filtroDias('b.hora', dias);
  const rows = getDb().prepare(`SELECT cr.route_id AS routeId, cr.name AS name,
    COALESCE(SUM(b.count), 0) AS total,
    ${Array.from({ length: 24 }, (_, h) => `SUM(CASE WHEN ${enBogota('%H', 'b.hora')} = ${h} THEN b.count ELSE 0 END) AS h${h}`).join(',\n    ')}
    FROM company_routes cr LEFT JOIN busquedas b ON b.route_id = cr.route_id AND b.hora >= ? AND b.hora < ? ${enDias.sql}
    WHERE cr.company_id = ? GROUP BY cr.route_id ORDER BY total DESC, cr.name`).all(desde, hasta, ...enDias.valores, companyId) as Record<string, unknown>[];
  const resultado = rows.map((row) => {
    const porHora = Array.from({ length: 24 }, (_, h) => Number(row[`h${h}`] ?? 0));
    const max = Math.max(...porHora);
    return { routeId: row.routeId, name: row.name, total: hora === undefined ? Number(row.total) : porHora[hora], porHora, horaPico: max ? porHora.indexOf(max) : null };
  });
  if (hora !== undefined) resultado.sort((a, b) => b.total - a.total);
  return resultado;
}

const DIA_MS = 24 * 60 * 60 * 1000;
const BOGOTA_MS = 5 * 60 * 60 * 1000;
/** Lo más largo que se puede pedir: lo que se guarda y el día de hoy. */
export const MAX_DIAS_RANGO = Math.ceil(RETENCION_MS / DIA_MS) + 1;

/** La medianoche de Bogotá en que empieza el día de [instant]. */
export function diaBogota(instant: number): number {
  return Math.floor((instant - BOGOTA_MS) / DIA_MS) * DIA_MS + BOGOTA_MS;
}

/**
 * Lleva el rango a días enteros de Bogotá: `desde` a la medianoche de su
 * día y `hasta` a la del día siguiente, salvo que ya caiga en una. Así toda
 * consulta del calor es una suma de días enteros, y restar dos rangos nunca
 * parte un día (AUD29-01). Nulo si queda vacío o pasa de [MAX_DIAS_RANGO].
 */
export function rangoEnDias(desde: number, hasta: number): { desde: number; hasta: number } | null {
  const inicio = diaBogota(desde);
  const fin = diaBogota(hasta) === hasta ? hasta : diaBogota(hasta) + DIA_MS;
  if (fin <= inicio || fin - inicio > MAX_DIAS_RANGO * DIA_MS) return null;
  return { desde: inicio, hasta: fin };
}

// D17 y AUD29-01: el umbral k va por cubeta (día de Bogotá y celda), no por
// la suma del rango. Con la suma, dos rangos solapados se restaban y dejaban
// ver las 1 o 2 búsquedas de un día; así cada día que se cuenta ya tiene
// sus 5, y una resta solo da días que se podían ver solos. Una zona con 2 un
// día y 3 otro no sale: es el precio (dueño, 2026-10-31).
export function calorBusquedas(companyId: string, routeId: string, desde: number, hasta: number, hora?: number, dias?: readonly DiaSemana[]) {
  const own = getDb().prepare('SELECT 1 FROM company_routes WHERE company_id = ? AND route_id = ?').get(companyId, routeId);
  if (!own) return null;
  const enDias = filtroDias('hora', dias);
  const enHora = hora === undefined ? { sql: '', valores: [] } : { sql: `AND ${enBogota('%H', 'hora')} = ?`, valores: [hora] };
  const rows = getDb().prepare(`SELECT lat, lng, SUM(dia_count) AS count FROM (
      SELECT celda_lat AS lat, celda_lng AS lng, SUM(count) AS dia_count FROM busquedas
      WHERE route_id = ? AND celda_lat IS NOT NULL AND hora >= ? AND hora < ? ${enHora.sql} ${enDias.sql}
      GROUP BY (hora - ${BOGOTA_MS}) / ${DIA_MS}, celda_lat, celda_lng HAVING SUM(count) >= ?
    ) GROUP BY lat, lng`)
    .all(routeId, desde, hasta, ...enHora.valores, ...enDias.valores, K_BUSQUEDAS);
  return rows;
}
