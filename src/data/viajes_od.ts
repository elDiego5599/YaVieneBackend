import { getDb } from './database';
import {
  type Celda, type DiaSemana, K_BUSQUEDAS, PASO_LAT, PASO_LNG, RETENCION_MS, diaBogota, filtroDias,
} from './busquedas';
import { dentroDeZona } from '../security/zona';

// D20: los viajes buscados, de una zona a otra. La zona es un bloque de
// 4 × 4 celdas de D17 (unos 600 m), con centro en múltiplos de ese paso
// desde 0. El pasajero no tiene cuenta (D3): no se guarda IP, dispositivo
// ni hora exacta, solo el par, la franja de 3 horas y la empresa de la ruta.
const PASO_ZONA_LAT = 4 * PASO_LAT;
const PASO_ZONA_LNG = 4 * PASO_LNG;
const DIA_MS = 24 * 60 * 60_000;
const BOGOTA_MS = 5 * 60 * 60_000;
const FRANJA_MS = 3 * 60 * 60_000;
export const MAX_RUTAS_POR_VIAJE = 2;
export const MAX_PARES = 200;
/**
 * AUD29-07: tope de filas nuevas por día de Bogotá. Un POST anónimo puede
 * inflar la tabla; pasado el tope solo se suma a filas que ya existen.
 */
export const MAX_FILAS_POR_DIA = 20_000;

/** El centro de la zona que contiene el punto. */
export function centroZona(lat: number, lng: number): Celda {
  return {
    lat: Number((Math.round(lat / PASO_ZONA_LAT) * PASO_ZONA_LAT).toFixed(8)),
    lng: Number((Math.round(lng / PASO_ZONA_LNG) * PASO_ZONA_LNG).toFixed(8)),
  };
}

/**
 * Lee una zona que manda la app: solo lat y lng finitos, dentro del área de
 * servicio y en el centro de una zona (tolerancia 1e-7, lo que se pierde en
 * el JSON). La app nunca manda un punto exacto, y aquí se comprueba.
 */
export function leerZona(valor: unknown): Celda | { error: string } {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) return { error: 'zona debe traer lat y lng' };
  if (Object.keys(valor).some((clave) => clave !== 'lat' && clave !== 'lng')) return { error: 'zona solo lleva lat y lng' };
  const { lat, lng } = valor as Record<string, unknown>;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { error: 'zona debe traer lat y lng finitos' };
  }
  if (!dentroDeZona(lat, lng)) return { error: 'zona fuera del área de servicio' };
  const centro = centroZona(lat, lng);
  if (Math.abs(lat - centro.lat) > 1e-7 || Math.abs(lng - centro.lng) > 1e-7) {
    return { error: 'zona debe coincidir con la rejilla de zonas' };
  }
  return centro;
}

/** El inicio, en ms, de la franja de 3 horas de Bogotá que contiene el instante. */
export function franjaBogota(instante: number): number {
  return Math.floor((instante - BOGOTA_MS) / FRANJA_MS) * FRANJA_MS + BOGOTA_MS;
}

/**
 * Las empresas dueñas de las rutas, sin repetir; `null` si una ruta no existe
 * o es de más de una empresa (no habría a quién contarle el viaje).
 */
export function empresasDeRutas(rutas: readonly string[]): string[] | null {
  const empresas = new Set<string>();
  const buscar = getDb().prepare('SELECT DISTINCT company_id FROM company_routes WHERE route_id = ?');
  for (const ruta of rutas) {
    const filas = buscar.all(ruta) as { company_id: string }[];
    if (filas.length !== 1) return null;
    empresas.add(filas[0].company_id);
  }
  return [...empresas];
}

/**
 * Cuenta un viaje por empresa. Falso, sin escribir nada, si haría pasar el
 * tope diario de filas nuevas; sumar a una fila que existe siempre pasa.
 */
export function registrarViaje(origen: Celda, destino: Celda, empresas: readonly string[], ahora = Date.now()): boolean {
  const db = getDb();
  const franja = franjaBogota(ahora);
  const dia = diaBogota(ahora);
  const existe = db.prepare(`SELECT 1 FROM viajes_od
    WHERE franja = ? AND o_lat = ? AND o_lng = ? AND d_lat = ? AND d_lng = ? AND company_id = ?`);
  const delDia = db.prepare('SELECT COUNT(*) AS n FROM viajes_od WHERE franja >= ? AND franja < ?');
  const sumar = db.prepare(`INSERT INTO viajes_od(franja, o_lat, o_lng, d_lat, d_lng, company_id, count)
    VALUES (?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(franja, o_lat, o_lng, d_lat, d_lng, company_id) DO UPDATE SET count = count + 1`);
  return db.transaction(() => {
    const nuevas = empresas.filter((id) => !existe.get(franja, origen.lat, origen.lng, destino.lat, destino.lng, id)).length;
    if (nuevas > 0 && (delDia.get(dia, dia + DIA_MS) as { n: number }).n + nuevas > MAX_FILAS_POR_DIA) return false;
    for (const id of empresas) sumar.run(franja, origen.lat, origen.lng, destino.lat, destino.lng, id);
    return true;
  })();
}

export function limpiarViajes(ahora = Date.now()): number {
  return getDb().prepare('DELETE FROM viajes_od WHERE franja < ?').run(ahora - RETENCION_MS).changes;
}

export interface ParViaje { origen: Celda; destino: Celda; total: number }

// D17 y AUD29-01 otra vez: el umbral k va por cubeta (día de Bogotá, par y
// empresa), después de filtrar franja y días, y se suman los días que lo
// pasan. Así dos rangos solapados no se restan para ver un día con menos de 5.
export function viajesDeEmpresa(
  companyId: string, desde: number, hasta: number,
  { franja, dias }: { franja?: number; dias?: readonly DiaSemana[] },
): ParViaje[] {
  const enDias = filtroDias('franja', dias);
  const enFranja = franja === undefined ? { sql: '', valores: [] } : {
    sql: "AND CAST(strftime('%H', datetime(franja / 1000, 'unixepoch', '-5 hours')) AS INTEGER) / 3 = ?",
    valores: [franja],
  };
  const filas = getDb().prepare(`SELECT o_lat, o_lng, d_lat, d_lng, SUM(dia_count) AS total FROM (
      SELECT o_lat, o_lng, d_lat, d_lng, SUM(count) AS dia_count FROM viajes_od
      WHERE company_id = ? AND franja >= ? AND franja < ? ${enFranja.sql} ${enDias.sql}
      GROUP BY (franja - ${BOGOTA_MS}) / ${DIA_MS}, o_lat, o_lng, d_lat, d_lng HAVING SUM(count) >= ?
    ) GROUP BY o_lat, o_lng, d_lat, d_lng
    ORDER BY total DESC, o_lat, o_lng, d_lat, d_lng LIMIT ${MAX_PARES}`)
    .all(companyId, desde, hasta, ...enFranja.valores, ...enDias.valores, K_BUSQUEDAS) as
    { o_lat: number; o_lng: number; d_lat: number; d_lng: number; total: number }[];
  return filas.map((f) => ({
    origen: { lat: f.o_lat, lng: f.o_lng }, destino: { lat: f.d_lat, lng: f.d_lng }, total: f.total,
  }));
}
