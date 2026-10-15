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
 * El número limpio, en cifras y con su indicativo, o null. Sin +, solo un
 * celular de Colombia: 10 cifras que empiezan por 3 (gana el 57) o esas
 * mismas con el 57 delante. Con +, el de otro país en E.164 (8 a 15
 * cifras); el +57 tiene que ser igual un celular. Ni un fijo ni diez
 * cifras cualquiera: el aviso sale por WhatsApp. La web aplica la misma
 * regla antes de enviar (`celularValido`, YaVieneWeb/src/aviso-lanzamiento.ts).
 */
export function normalizarTelefono(valor: unknown): string | null {
  if (typeof valor !== 'string' || valor.length > 32) return null;
  const escrito = valor.trim();
  if (!ESCRITO.test(escrito)) return null;
  const cifras = escrito.replace(/\D/g, '');
  if (/^3\d{9}$/.test(cifras)) return `57${cifras}`;
  if (/^573\d{9}$/.test(cifras)) return cifras;
  const internacional = escrito.startsWith('+') && !cifras.startsWith('57');
  return internacional && cifras.length >= 8 && cifras.length <= 15 ? cifras : null;
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
