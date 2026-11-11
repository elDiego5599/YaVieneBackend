// El buzón de problemas y sugerencias del pasajero (D14).
//
// La app manda el reporte aquí y no al correo directo: así la dirección del
// equipo no viaja dentro de la APK y el pasajero no necesita tener una cuenta
// de correo configurada. El reporte se guarda primero y sale después, por el
// reloj de index.ts: si Gmail está caído o la clave aún no está puesta, el
// reporte espera en la tabla y no se pierde. Cuando el correo sale, la fila se
// borra: el buzón no es un archivo de reportes, es una cola.
//
// La queja (D18) es un tipo más: lleva motivo y, si el pasajero los deja,
// ruta, bus, celda y hora. Sale por correo igual y, si trae ruta, además se
// guarda para la empresa (`quejas.ts`).
//
// Sin campo de contacto a propósito (Ley 1581): el reporte no pide nombre,
// correo ni teléfono. Lo que el pasajero escriba en el texto es suyo, y la
// app le dice que no ponga datos personales.
import { randomUUID } from 'node:crypto';
import { getDb } from './database';
import { incrementMetric } from '../observability/metrics';
import { enviarCorreo, type ConfigCorreo, type MensajeCorreo } from '../buzon/correo';
import { CAMPOS_QUEJA, guardarQueja, leerQueja, LITERAL_MOTIVO, type MotivoQueja, type Queja } from './quejas';

export const TIPOS_REPORTE = ['problema', 'sugerencia', 'queja'] as const;
export type TipoReporte = (typeof TIPOS_REPORTE)[number];
export const MIN_TEXTO_REPORTE = 3;
/** El mismo tope que el contador del formulario de la app. */
export const MAX_TEXTO_REPORTE = 1000;
/** Tope de la cola: con Gmail caído días, una avalancha llena esto y no el disco. */
export const MAX_REPORTES = 1000;
/** Cuántos salen por vuelta del reloj. */
const LOTE = 5;
const ESPERA_BASE_MS = 60_000;
const ESPERA_MAXIMA_MS = 6 * 60 * 60 * 1000;

const PLATAFORMAS = ['android', 'ios'] as const;
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
// Controles fuera, salvo el salto de línea y el tabulador: el texto se lee en
// un correo y no debe poder pintar nada raro.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;
// El separador de línea y el de párrafo (U+2028, U+2029) son saltos de línea
// para el correo y para JSON, así que se vuelven `\n`. Los controles de
// dirección (U+202A a U+202E, U+2066 a U+2069) dan vuelta lo que sigue en el
// correo del equipo y el BOM (U+FEFF) no se ve: se quitan sin rechazar el
// reporte, porque el pasajero no los ve y no sabría qué corregir. El ZWJ
// (U+200D) se queda: es el que junta los emojis de varias personas.
const INVISIBLES = /[\u202A-\u202E\u2066-\u2069\uFEFF]/g;

interface ReporteBase {
  texto: string;
  plataforma?: string;
  version?: string;
}
export type NuevoReporte =
  | (ReporteBase & { tipo: 'problema' | 'sugerencia' })
  | (ReporteBase & { tipo: 'queja'; queja: Queja });

/**
 * Lee y valida el cuerpo de `POST /api/reportes`. Devuelve el reporte limpio
 * o el motivo del rechazo, que la ruta responde como 400.
 */
export function leerReporte(cuerpo: unknown, ahora: number = Date.now()): NuevoReporte | { error: string } {
  if (typeof cuerpo !== 'object' || cuerpo === null || Array.isArray(cuerpo)) {
    return { error: 'El reporte debe ser un objeto' };
  }
  const campos = cuerpo as Record<string, unknown>;
  const { tipo, texto, plataforma, version } = campos;
  if (typeof tipo !== 'string' || !(TIPOS_REPORTE as readonly string[]).includes(tipo)) {
    return { error: 'tipo debe ser «problema», «sugerencia» o «queja»' };
  }
  const esQueja = tipo === 'queja';
  if (!esQueja && CAMPOS_QUEJA.some((campo) => campos[campo] !== undefined)) {
    return { error: `${CAMPOS_QUEJA.join(', ')}: solo la queja los lleva` };
  }
  // En la queja el motivo ya dice qué pasó: el texto es opcional.
  if (texto === undefined && !esQueja) return { error: 'Falta el texto del reporte' };
  if (texto !== undefined && typeof texto !== 'string') return { error: 'Falta el texto del reporte' };
  const limpio = (texto ?? '')
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(INVISIBLES, '')
    .trim();
  const largo = [...limpio].length;
  const sinTexto = esQueja && largo === 0;
  if (!sinTexto && (largo < MIN_TEXTO_REPORTE || largo > MAX_TEXTO_REPORTE)) {
    return { error: `El texto debe tener entre ${MIN_TEXTO_REPORTE} y ${MAX_TEXTO_REPORTE} caracteres` };
  }
  if (CONTROL.test(limpio)) return { error: 'El texto trae caracteres no válidos' };
  if (plataforma !== undefined && !(PLATAFORMAS as readonly unknown[]).includes(plataforma)) {
    return { error: 'plataforma debe ser «android» o «ios»' };
  }
  if (version !== undefined && (typeof version !== 'string' || !VERSION.test(version))) {
    return { error: 'version no es válida' };
  }
  const base: ReporteBase = {
    texto: limpio,
    ...(plataforma !== undefined ? { plataforma: plataforma as string } : {}),
    ...(version !== undefined ? { version: version as string } : {}),
  };
  if (!esQueja) return { tipo: tipo as 'problema' | 'sugerencia', ...base };
  const queja = leerQueja(campos, ahora);
  if ('error' in queja) return queja;
  return { tipo: 'queja', ...base, queja };
}

/**
 * Guarda un reporte para que el reloj lo mande. La queja con ruta se guarda
 * además para su empresa, en la misma transacción: o quedan las dos o
 * ninguna, y con el buzón lleno tampoco se guarda (el pasajero reintenta).
 */
export function crearReporte(reporte: NuevoReporte, ahora: number = Date.now()): { id: string } | 'lleno' {
  const db = getDb();
  const crear = db.transaction(() => {
    const total = db.prepare('SELECT COUNT(*) AS n FROM reportes').get() as { n: number };
    if (total.n >= MAX_REPORTES) return 'lleno' as const;
    const id = randomUUID();
    const queja = reporte.tipo === 'queja' ? reporte.queja : null;
    db.prepare(`
      INSERT INTO reportes (id, tipo, texto, plataforma, version, creado, proximo_intento,
        motivo, route_id, bus_id, celda_lat, celda_lng, hora)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, reporte.tipo, reporte.texto, reporte.plataforma ?? null, reporte.version ?? null, ahora, ahora,
      queja?.motivo ?? null, queja?.routeId ?? null, queja?.busId ?? null,
      queja?.celda?.lat ?? null, queja?.celda?.lng ?? null, queja?.hora ?? null,
    );
    if (queja?.routeId != null && queja.companyId != null) {
      guardarQueja({ ...queja, routeId: queja.routeId, companyId: queja.companyId }, reporte.texto, ahora);
    }
    return { id };
  });
  const resultado = crear();
  incrementMetric(resultado === 'lleno' ? 'buzon.lleno' : 'buzon.recibidos');
  return resultado;
}

interface FilaReporte {
  id: string;
  tipo: TipoReporte;
  texto: string;
  plataforma: string | null;
  version: string | null;
  creado: number;
  intentos: number;
  // Lo de la queja (D18); nulo en problemas y sugerencias.
  motivo: MotivoQueja | null;
  route_id: string | null;
  /** El nombre de la ruta cuando sale el correo; nulo si la empresa la borró. */
  ruta_nombre: string | null;
  bus_id: string | null;
  celda_lat: number | null;
  celda_lng: number | null;
  hora: number | null;
}

const HORA_BOGOTA = new Intl.DateTimeFormat('es-CO', {
  timeZone: 'America/Bogota',
  dateStyle: 'medium',
  timeStyle: 'short',
});

const ASUNTO: Record<TipoReporte, string> = {
  problema: 'Ya Viene · Problema reportado',
  sugerencia: 'Ya Viene · Sugerencia',
  queja: 'Ya Viene · Queja',
};
const TIPO: Record<TipoReporte, string> = { problema: 'Problema', sugerencia: 'Sugerencia', queja: 'Queja' };

/** Las líneas de la queja; la que no tiene dato no sale, para no inventar. */
function lineasDeQueja(fila: FilaReporte): string[] {
  if (fila.tipo !== 'queja' || fila.motivo == null) return [];
  return [
    `Motivo: ${LITERAL_MOTIVO[fila.motivo]}`,
    fila.route_id == null ? null : `Ruta: ${[fila.route_id, fila.ruta_nombre].filter(Boolean).join(' ')}`,
    fila.bus_id == null ? null : `Bus: ${fila.bus_id}`,
    fila.celda_lat == null || fila.celda_lng == null ? null : `Lugar: ${fila.celda_lat}, ${fila.celda_lng} (celda de 150 m)`,
    fila.hora == null ? null : `Hora del hecho: ${HORA_BOGOTA.format(fila.hora)} (hora de Colombia)`,
  ].filter((linea): linea is string => linea !== null);
}

/** El correo de un reporte. El asunto es fijo; el texto solo va en el cuerpo. */
export function mensajeDeReporte(fila: FilaReporte): MensajeCorreo {
  const desde = [
    fila.plataforma === 'ios' ? 'iPhone' : fila.plataforma === 'android' ? 'Android' : null,
    fila.version ? `app ${fila.version}` : null,
  ].filter(Boolean).join(' · ') || 'sin dato';
  return {
    id: fila.id,
    asunto: ASUNTO[fila.tipo],
    texto: [
      `Tipo: ${TIPO[fila.tipo]}`,
      ...lineasDeQueja(fila),
      `Desde: ${desde}`,
      `Recibido: ${HORA_BOGOTA.format(fila.creado)} (hora de Colombia)`,
      '',
      fila.texto || '(sin texto)',
      '',
      '—',
      'Enviado desde el buzón de la app del pasajero.',
    ].join('\n'),
  };
}

let enVuelta = false;

/**
 * Una vuelta del reloj: manda hasta cinco reportes pendientes, uno tras otro.
 * El que sale se borra; el primero que falla espera más cada vez (1 min, 2,
 * 4… hasta 6 h) y corta la vuelta, porque si Gmail rechazó uno rechazará el
 * siguiente. Nunca se rechaza y no se pisa consigo misma: si la vuelta
 * anterior sigue hablando con Gmail, esta no hace nada.
 */
export async function enviarReportes(
  config: ConfigCorreo,
  enviar: (config: ConfigCorreo, mensaje: MensajeCorreo) => Promise<void> = enviarCorreo,
  ahora: () => number = Date.now,
): Promise<void> {
  if (enVuelta) return;
  enVuelta = true;
  try {
    const filas = getDb().prepare(`
      SELECT id, tipo, texto, plataforma, version, creado, intentos,
        motivo, route_id, bus_id, celda_lat, celda_lng, hora,
        (SELECT name FROM company_routes cr WHERE cr.route_id = reportes.route_id LIMIT 1) AS ruta_nombre
      FROM reportes WHERE proximo_intento <= ? ORDER BY creado LIMIT ?
    `).all(ahora(), LOTE) as FilaReporte[];
    for (const fila of filas) {
      try {
        await enviar(config, mensajeDeReporte(fila));
      } catch (error) {
        incrementMetric('buzon.fallidos');
        const espera = Math.min(ESPERA_BASE_MS * 2 ** fila.intentos, ESPERA_MAXIMA_MS);
        getDb().prepare('UPDATE reportes SET intentos = intentos + 1, proximo_intento = ? WHERE id = ?')
          .run(ahora() + espera, fila.id);
        console.error(`[Buzón] No salió un reporte (intento ${fila.intentos + 1}):`, (error as Error).message);
        return;
      }
      getDb().prepare('DELETE FROM reportes WHERE id = ?').run(fila.id);
      incrementMetric('buzon.enviados');
    }
  } catch (error) {
    // La base se cerró a mitad de la vuelta (el apagado): lo pendiente sigue
    // en la tabla y sale en el próximo arranque.
    console.error('[Buzón] La vuelta se cortó:', error);
  } finally {
    enVuelta = false;
  }
}
