// La queja del pasajero (D18): el buzón de D14 con motivo y, si el pasajero
// los deja, la ruta, el bus, la celda de 150 m donde pasó y la hora
// redondeada. Sale por correo al equipo como todo reporte y, si trae ruta, se
// guarda 13 meses para que la empresa de esa ruta la vea en su panel.
//
// Lo guardado es solo la queja: sin IP, plataforma ni versión. El lugar es la
// celda de la rejilla de D17 y la hora va a la hora en punto: la queja dice
// qué pasó y dónde, no dónde estaba una persona a qué minuto.
import { randomUUID } from 'node:crypto';
import { getDb } from './database';
import { type Celda, type DiaSemana, filtroDias, horaBogota, leerCelda, RETENCION_MS } from './busquedas';

/** Los motivos, en el orden de la app. Su texto en español va en [LITERAL_MOTIVO]. */
export const MOTIVOS_QUEJA = [
  'no_paro', 'iba_lleno', 'mal_trato', 'conduccion', 'otra_ruta', 'estado_bus', 'otro',
] as const;
export type MotivoQueja = (typeof MOTIVOS_QUEJA)[number];

/** Como los dice la app (`MotivoQueja` en Dart); el correo y el panel usan los mismos. */
export const LITERAL_MOTIVO: Record<MotivoQueja, string> = {
  no_paro: 'No paró',
  iba_lleno: 'Iba lleno',
  mal_trato: 'Mal trato',
  conduccion: 'Conducción',
  otra_ruta: 'Otra ruta',
  estado_bus: 'Estado del bus',
  otro: 'Otro',
};

/** 13 meses, lo mismo que las búsquedas de D17 (dueño, 2026-11-10). */
export const RETENCION_QUEJAS_MS = RETENCION_MS;
/** Lo más viejo que se puede contar: una semana. Más atrás ya no se recuerda la hora. */
const MAX_ANTIGUEDAD_MS = 7 * 24 * 60 * 60_000;
/** Lo que el panel lista de una vez; el mapa cuenta todas las del filtro. */
const MAX_LISTA = 500;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export interface Queja {
  motivo: MotivoQueja;
  routeId: string | null;
  /** La empresa de la ruta, que la ve en su panel. La pone el backend, nunca la app. */
  companyId: string | null;
  busId: string | null;
  celda: Celda | null;
  /** La hora del hecho, en punto. */
  hora: number | null;
}

/** Los campos que solo lleva la queja: en un problema o una sugerencia son un error. */
export const CAMPOS_QUEJA = ['motivo', 'routeId', 'busId', 'celda', 'hora'] as const;

export function esMotivoQueja(valor: unknown): valor is MotivoQueja {
  return typeof valor === 'string' && (MOTIVOS_QUEJA as readonly string[]).includes(valor);
}

/**
 * Lee los campos de la queja del cuerpo de `POST /api/reportes`. Solo el
 * motivo es obligatorio; la ruta tiene que existir (de ahí sale la empresa),
 * el bus tiene que ser de esa ruta, la celda de la rejilla y la hora de la
 * última semana, sin pasar de la hora en curso.
 */
export function leerQueja(cuerpo: Record<string, unknown>, ahora: number): Queja | { error: string } {
  const { motivo, routeId, busId, celda, hora } = cuerpo;
  if (!esMotivoQueja(motivo)) return { error: `motivo debe ser uno de: ${MOTIVOS_QUEJA.join(', ')}` };

  let companyId: string | null = null;
  if (routeId !== undefined) {
    if (typeof routeId !== 'string' || routeId.length > 64) return { error: 'la ruta no es válida' };
    const duenas = getDb().prepare('SELECT company_id FROM company_routes WHERE route_id = ?')
      .all(routeId) as { company_id: string }[];
    // Una ruta de dos empresas no tendría dueño claro: mejor no guardarla a ciegas.
    if (duenas.length !== 1) return { error: 'la ruta no existe' };
    companyId = duenas[0].company_id;
  }

  if (busId !== undefined) {
    if (typeof busId !== 'string' || busId.length > 64) return { error: 'el bus no es válido' };
    if (companyId === null) return { error: 'el bus necesita su ruta' };
    const delaRuta = getDb().prepare('SELECT 1 FROM buses WHERE bus_id = ? AND route_id = ? AND company_id = ?')
      .get(busId, routeId, companyId);
    if (!delaRuta) return { error: 'el bus no es de esa ruta' };
  }

  let enCelda: Celda | null = null;
  if (celda !== undefined) {
    const leida = leerCelda(celda);
    if ('error' in leida) return leida;
    enCelda = leida;
  }

  let enHora: number | null = null;
  if (hora !== undefined) {
    const instante = typeof hora === 'string' && ISO.test(hora) ? Date.parse(hora) : Number.NaN;
    if (!Number.isFinite(instante)) return { error: 'hora debe ser una fecha ISO 8601 con zona' };
    // El reloj del teléfono puede ir unos minutos adelante: la hora en curso vale.
    if (horaBogota(instante) > horaBogota(ahora)) return { error: 'la hora no puede ser futura' };
    if (instante < ahora - MAX_ANTIGUEDAD_MS) return { error: 'la hora no puede ser de hace más de 7 días' };
    enHora = horaBogota(instante);
  }

  return {
    motivo,
    routeId: (routeId as string | undefined) ?? null,
    companyId,
    busId: (busId as string | undefined) ?? null,
    celda: enCelda,
    hora: enHora,
  };
}

/** Guarda la queja para el panel de su empresa. Sin ruta no tiene dueño y no se llama. */
export function guardarQueja(queja: Queja & { routeId: string; companyId: string }, texto: string, creado: number): void {
  getDb().prepare(`
    INSERT INTO quejas (id, motivo, texto, route_id, company_id, bus_id, celda_lat, celda_lng, hora, creado)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(), queja.motivo, texto, queja.routeId, queja.companyId, queja.busId,
    queja.celda?.lat ?? null, queja.celda?.lng ?? null, queja.hora, creado,
  );
}

/** Borra las de más de 13 meses. Corre con el reloj de index.ts. */
export function limpiarQuejas(ahora: number = Date.now()): number {
  return getDb().prepare('DELETE FROM quejas WHERE creado < ?').run(ahora - RETENCION_QUEJAS_MS).changes;
}

export interface FiltroQuejas {
  /** El rango cuenta por la hora del hecho o, si el pasajero no la dio, por la de llegada. */
  desde: number;
  hasta: number;
  routeId?: string;
  motivo?: MotivoQueja;
  /** Solo esos días de la semana en Barranquilla, como en las búsquedas; sin días, todos. */
  dias?: readonly DiaSemana[];
}

/**
 * Lo que ve la empresa en Reportes: la lista, la más reciente arriba, y el
 * mapa por celda. Sin placa: el bus va por su id, que el panel ya conoce.
 * Nulo si pide una ruta que no es suya.
 */
export function quejasDeEmpresa(companyId: string, filtro: FiltroQuejas) {
  const db = getDb();
  if (filtro.routeId !== undefined
    && !db.prepare('SELECT 1 FROM company_routes WHERE company_id = ? AND route_id = ?').get(companyId, filtro.routeId)) {
    return null;
  }
  const condiciones = ['q.company_id = ?', 'COALESCE(q.hora, q.creado) >= ?', 'COALESCE(q.hora, q.creado) < ?'];
  const valores: (string | number)[] = [companyId, filtro.desde, filtro.hasta];
  if (filtro.routeId !== undefined) { condiciones.push('q.route_id = ?'); valores.push(filtro.routeId); }
  if (filtro.motivo !== undefined) { condiciones.push('q.motivo = ?'); valores.push(filtro.motivo); }
  const enDias = filtroDias('COALESCE(q.hora, q.creado)', filtro.dias);
  valores.push(...enDias.valores);
  const donde = `${condiciones.join(' AND ')} ${enDias.sql}`;

  const filas = db.prepare(`
    SELECT q.id, q.motivo, q.texto, q.route_id, cr.name AS ruta, q.bus_id, q.celda_lat, q.celda_lng, q.hora, q.creado
    FROM quejas q LEFT JOIN company_routes cr ON cr.company_id = q.company_id AND cr.route_id = q.route_id
    WHERE ${donde}
    ORDER BY COALESCE(q.hora, q.creado) DESC, q.creado DESC, q.id
    LIMIT ${MAX_LISTA}
  `).all(...valores) as {
    id: string; motivo: MotivoQueja; texto: string; route_id: string; ruta: string | null; bus_id: string | null;
    celda_lat: number | null; celda_lng: number | null; hora: number | null; creado: number;
  }[];
  const celdas = db.prepare(`
    SELECT q.celda_lat AS lat, q.celda_lng AS lng, COUNT(*) AS total FROM quejas q
    WHERE ${donde} AND q.celda_lat IS NOT NULL
    GROUP BY q.celda_lat, q.celda_lng ORDER BY total DESC, lat, lng
  `).all(...valores) as { lat: number; lng: number; total: number }[];

  return {
    quejas: filas.map((f) => ({
      id: f.id,
      motivo: f.motivo,
      texto: f.texto,
      routeId: f.route_id,
      ruta: f.ruta,
      busId: f.bus_id,
      celda: f.celda_lat === null || f.celda_lng === null ? null : { lat: f.celda_lat, lng: f.celda_lng },
      hora: f.hora,
      creado: f.creado,
    })),
    celdas,
  };
}
