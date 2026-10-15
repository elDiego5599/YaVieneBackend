// La lista de «Avísame cuando salga», el formulario del hero de la web (D15).
//
// Guarda un celular y nada más: ni nombre, ni IP, ni de qué página vino. Con
// la Ley 1581 el número es un dato personal, así que entra solo con el
// permiso marcado, se guarda con la fecha y la versión del texto que la
// persona aceptó, y el equipo lo borra a pedido o vacía la lista entera
// cuando avisa del lanzamiento. Los números no se escriben en ningún log.
import { getDb } from './database';
import { incrementMetric } from '../observability/metrics';

/**
 * Versión del texto del permiso que firma la persona. El de hoy, en
 * `YaVieneWeb/index.html`: «Acepto el tratamiento de mis datos. Solo se
 * usará para avisarme que la app ya salió.» Si ese texto cambia, sube esta.
 */
export const VERSION_AUTORIZACION = 1;
/** Tope de la lista: una avalancha llena esto y no el disco. */
export const MAX_LANZAMIENTO = 20_000;

// Lo que deja el campo `type="tel"` de la web: cifras, espacios, guiones,
// paréntesis y un + solo adelante.
const ESCRITO = /^\+?[0-9 ()-]+$/;

/**
 * El número limpio, en cifras y con su indicativo, o null. Un celular de
 * Colombia (10 cifras que empiezan por 3) gana el 57; lo demás tiene que
 * traer ya su indicativo y caber en E.164 (8 a 15 cifras). Un fijo de 7
 * cifras no sirve: el aviso sale por WhatsApp.
 */
export function normalizarTelefono(valor: unknown): string | null {
  if (typeof valor !== 'string' || valor.length > 32 || !ESCRITO.test(valor.trim())) return null;
  const cifras = valor.replace(/\D/g, '');
  if (cifras.length === 10 && cifras.startsWith('3')) return `57${cifras}`;
  return cifras.length >= 8 && cifras.length <= 15 ? cifras : null;
}

/** Lee y valida el cuerpo de `POST /api/lanzamiento`. */
export function leerSuscripcion(cuerpo: unknown): { telefono: string } | { error: string } {
  if (typeof cuerpo !== 'object' || cuerpo === null || Array.isArray(cuerpo)) {
    return { error: 'El cuerpo debe ser un objeto' };
  }
  const { telefono, acepto } = cuerpo as Record<string, unknown>;
  if (acepto !== true) return { error: 'Falta aceptar el tratamiento de datos' };
  const limpio = normalizarTelefono(telefono);
  if (!limpio) return { error: 'telefono no es un celular válido' };
  return { telefono: limpio };
}

/**
 * Guarda el número. Si ya estaba se deja como estaba —con su primer
 * permiso— y se responde igual: quien pregunta no se entera de si lo estaba.
 */
export function guardarSuscripcion(telefono: string, ahora: number = Date.now()): 'ok' | 'lleno' {
  const db = getDb();
  const guardar = db.transaction(() => {
    if (db.prepare('SELECT 1 FROM lanzamiento WHERE telefono = ?').get(telefono)) return 'ok' as const;
    const total = db.prepare('SELECT COUNT(*) AS n FROM lanzamiento').get() as { n: number };
    if (total.n >= MAX_LANZAMIENTO) return 'lleno' as const;
    db.prepare('INSERT INTO lanzamiento (telefono, aceptado, autorizacion) VALUES (?, ?, ?)')
      .run(telefono, ahora, VERSION_AUTORIZACION);
    return 'ok' as const;
  });
  const resultado = guardar();
  incrementMetric(resultado === 'lleno' ? 'lanzamiento.lleno' : 'lanzamiento.recibidos');
  return resultado;
}

export interface Suscripcion {
  telefono: string;
  aceptado: number;
  autorizacion: number;
}

export function listarSuscripciones(): Suscripcion[] {
  return getDb().prepare('SELECT telefono, aceptado, autorizacion FROM lanzamiento ORDER BY aceptado').all() as Suscripcion[];
}

export function borrarSuscripcion(telefono: string): void {
  getDb().prepare('DELETE FROM lanzamiento WHERE telefono = ?').run(telefono);
}

export function borrarTodas(): void {
  getDb().prepare('DELETE FROM lanzamiento').run();
}
