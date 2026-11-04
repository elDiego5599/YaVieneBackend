// El buzón de problemas y sugerencias del pasajero (D14).
//
// La app manda el reporte aquí y no al correo directo: así la dirección del
// equipo no viaja dentro de la APK y el pasajero no necesita tener una cuenta
// de correo configurada. El reporte se guarda primero y sale después, por el
// reloj de index.ts: si Gmail está caído o la clave aún no está puesta, el
// reporte espera en la tabla y no se pierde. Cuando el correo sale, la fila se
// borra: el buzón no es un archivo de reportes, es una cola.
//
// Sin campo de contacto a propósito (Ley 1581): el reporte no pide nombre,
// correo ni teléfono. Lo que el pasajero escriba en el texto es suyo, y la
// app le dice que no ponga datos personales.
import { randomUUID } from 'node:crypto';
import { getDb } from './database';
import { incrementMetric } from '../observability/metrics';
import { enviarCorreo, type ConfigCorreo, type MensajeCorreo } from '../buzon/correo';

export const TIPOS_REPORTE = ['problema', 'sugerencia'] as const;
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

export interface NuevoReporte {
  tipo: TipoReporte;
  texto: string;
  plataforma?: string;
  version?: string;
}

/**
 * Lee y valida el cuerpo de `POST /api/reportes`. Devuelve el reporte limpio
 * o el motivo del rechazo, que la ruta responde como 400.
 */
export function leerReporte(cuerpo: unknown): NuevoReporte | { error: string } {
  if (typeof cuerpo !== 'object' || cuerpo === null || Array.isArray(cuerpo)) {
    return { error: 'El reporte debe ser un objeto' };
  }
  const { tipo, texto, plataforma, version } = cuerpo as Record<string, unknown>;
  if (typeof tipo !== 'string' || !(TIPOS_REPORTE as readonly string[]).includes(tipo)) {
    return { error: 'tipo debe ser «problema» o «sugerencia»' };
  }
  if (typeof texto !== 'string') return { error: 'Falta el texto del reporte' };
  const limpio = texto
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(INVISIBLES, '')
    .trim();
  const largo = [...limpio].length;
  if (largo < MIN_TEXTO_REPORTE || largo > MAX_TEXTO_REPORTE) {
    return { error: `El texto debe tener entre ${MIN_TEXTO_REPORTE} y ${MAX_TEXTO_REPORTE} caracteres` };
  }
  if (CONTROL.test(limpio)) return { error: 'El texto trae caracteres no válidos' };
  if (plataforma !== undefined && !(PLATAFORMAS as readonly unknown[]).includes(plataforma)) {
    return { error: 'plataforma debe ser «android» o «ios»' };
  }
  if (version !== undefined && (typeof version !== 'string' || !VERSION.test(version))) {
    return { error: 'version no es válida' };
  }
  return {
    tipo: tipo as TipoReporte,
    texto: limpio,
    ...(plataforma !== undefined ? { plataforma: plataforma as string } : {}),
    ...(version !== undefined ? { version: version as string } : {}),
  };
}

/** Guarda un reporte para que el reloj lo mande. */
export function crearReporte(reporte: NuevoReporte, ahora: number = Date.now()): { id: string } | 'lleno' {
  const db = getDb();
  const crear = db.transaction(() => {
    const total = db.prepare('SELECT COUNT(*) AS n FROM reportes').get() as { n: number };
    if (total.n >= MAX_REPORTES) return 'lleno' as const;
    const id = randomUUID();
    db.prepare(`
      INSERT INTO reportes (id, tipo, texto, plataforma, version, creado, proximo_intento)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, reporte.tipo, reporte.texto, reporte.plataforma ?? null, reporte.version ?? null, ahora, ahora);
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
}

const HORA_BOGOTA = new Intl.DateTimeFormat('es-CO', {
  timeZone: 'America/Bogota',
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** El correo de un reporte. El asunto es fijo; el texto solo va en el cuerpo. */
export function mensajeDeReporte(fila: FilaReporte): MensajeCorreo {
  const tipo = fila.tipo === 'problema' ? 'Problema' : 'Sugerencia';
  const desde = [
    fila.plataforma === 'ios' ? 'iPhone' : fila.plataforma === 'android' ? 'Android' : null,
    fila.version ? `app ${fila.version}` : null,
  ].filter(Boolean).join(' · ') || 'sin dato';
  return {
    id: fila.id,
    asunto: `Ya Viene · ${tipo === 'Problema' ? 'Problema reportado' : 'Sugerencia'}`,
    texto: [
      `Tipo: ${tipo}`,
      `Desde: ${desde}`,
      `Recibido: ${HORA_BOGOTA.format(fila.creado)} (hora de Colombia)`,
      '',
      fila.texto,
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
      SELECT id, tipo, texto, plataforma, version, creado, intentos
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
