// Avisos de «tu bus está cerca» que el servidor manda por push (D13).
//
// La app del pasajero avisa sola mientras está viva: mira la posición del bus
// cada 5 s y lanza la notificación local a la distancia que el pasajero
// eligió (de 500 m a 3 km). Con la app cerrada eso no
// corre, y para eso está esta tabla. El servidor vigila todos los avisos desde
// que se arman, viva o no la app: no sabe cuándo la cierran, y esperar a que
// los latidos faltaran un minuto hacía que el aviso saliera con el bus ya a
// 700 m (dueño, 2026-10-02). La app late cada 20 s para mover el punto y el
// token, y para enterarse (410) de que el servidor ya avisó.
//
// Las dos partes no suenan dos veces: la app borra la fila cuando avisa sola;
// el push de un aviso que la app ya dio por sonado se descarta allá; y si las
// dos llegan a la vez, la notificación sale con el mismo identificador y
// Android no la hace sonar otra vez (`onlyAlertOnce`).
import { randomUUID } from 'node:crypto';
import { getDb } from './database';
import { haversineDistanceKm } from '../security/physics';
import { incrementMetric } from '../observability/metrics';
import type { EmisorFcm } from '../push/fcm';

/**
 * La distancia del aviso la elige el pasajero en la app, entre estos dos
 * topes (`distanciaAvisoMinima` / `Maxima` en la app). Por debajo de 500 m
 * el aviso llega con el bus encima; por encima de 3 km avisa demasiado
 * pronto y la ruta deja de servir de filtro.
 */
export const RADIO_MINIMO_M = 500;
export const RADIO_MAXIMO_M = 3000;
/** El de una app de antes, que no manda distancia: el kilómetro fijo de entonces. */
export const RADIO_AVISO_M = 1000;
/** Tres horas, como `vidaDeUnAviso` en la app: un aviso olvidado no queda armado. */
export const VIDA_MAXIMA_MS = 3 * 60 * 60 * 1000;
/** Un pasajero sigue como mucho dos buses a la vez. */
export const MAX_AVISOS_POR_TOKEN = 2;
/** Tope de la tabla entera: una avalancha llena esto y no el disco. */
export const MAX_AVISOS = 10_000;

export interface NuevoAviso {
  token: string;
  busId: string;
  routeId: string;
  lat: number;
  lon: number;
  vidaMs: number;
  /** Metros a los que suena, ya validados entre los dos topes. */
  radioM: number;
}

/**
 * Arma un aviso. Uno nuevo del mismo teléfono para el mismo bus reemplaza al
 * anterior (rearmar después de que avisó). Devuelve el identificador, que es
 * lo único que la app necesita para latir o desarmar.
 */
export function crearAviso(
  aviso: NuevoAviso,
  ahora: number = Date.now(),
): { id: string } | 'tope_token' | 'lleno' {
  const db = getDb();
  const crear = db.transaction(() => {
    db.prepare('DELETE FROM avisos_push WHERE token = ? AND bus_id = ?').run(aviso.token, aviso.busId);
    const delToken = db.prepare('SELECT COUNT(*) AS n FROM avisos_push WHERE token = ?')
      .get(aviso.token) as { n: number };
    if (delToken.n >= MAX_AVISOS_POR_TOKEN) return 'tope_token' as const;
    const total = db.prepare('SELECT COUNT(*) AS n FROM avisos_push').get() as { n: number };
    if (total.n >= MAX_AVISOS) return 'lleno' as const;
    const id = randomUUID();
    db.prepare(`
      INSERT INTO avisos_push (id, token, bus_id, route_id, lat, lon, creado, vence, radio_m)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, aviso.token, aviso.busId, aviso.routeId, aviso.lat, aviso.lon,
      ahora, ahora + Math.min(aviso.vidaMs, VIDA_MAXIMA_MS), aviso.radioM,
    );
    return { id };
  });
  return crear();
}

/**
 * Un latido de la app viva: pone al día el punto (el pasajero puede
 * moverse) y el token (FCM a veces lo cambia), y le dice si ya se avisó.
 */
export function renovarAviso(
  id: string,
  latido: { token: string; lat: number; lon: number },
  ahora: number = Date.now(),
): 'renovado' | 'enviado' | 'no_existe' {
  const db = getDb();
  const fila = db.prepare('SELECT vence, enviado_en FROM avisos_push WHERE id = ?')
    .get(id) as { vence: number; enviado_en: number | null } | undefined;
  if (!fila || fila.vence <= ahora) return 'no_existe';
  if (fila.enviado_en !== null) return 'enviado';
  db.prepare(`
    UPDATE avisos_push SET token = ?, lat = ?, lon = ?
    WHERE id = ? AND enviado_en IS NULL
  `).run(latido.token, latido.lat, latido.lon, id);
  return 'renovado';
}

export function borrarAviso(id: string): void {
  getDb().prepare('DELETE FROM avisos_push WHERE id = ?').run(id);
}

/** Toma el envío para sí: solo una vuelta puede, aunque dos se crucen. */
export function marcarEnviado(id: string, ahora: number = Date.now()): boolean {
  return getDb().prepare('UPDATE avisos_push SET enviado_en = ? WHERE id = ? AND enviado_en IS NULL')
    .run(ahora, id).changes === 1;
}

/** El envío falló de una forma que puede salir bien después. */
export function desmarcarEnviado(id: string): void {
  getDb().prepare('UPDATE avisos_push SET enviado_en = NULL WHERE id = ?').run(id);
}

/** El token ya no sirve: ningún aviso suyo va a llegar. */
export function borrarPorToken(token: string): number {
  return getDb().prepare('DELETE FROM avisos_push WHERE token = ?').run(token).changes;
}

export function barrerVencidos(ahora: number = Date.now()): number {
  return getDb().prepare('DELETE FROM avisos_push WHERE vence <= ?').run(ahora).changes;
}

/**
 * Una vuelta del servidor: barre lo vencido y avisa de los buses que entraron
 * al radio que eligió el pasajero. Solo cuentan los buses con
 * señal (`is_ghost = 0`), visibles y en la ruta del aviso, igual que en la
 * app. Devuelve una promesa que se cumple cuando terminan los envíos de esta
 * vuelta y nunca se rechaza (el reloj de index.ts no la espera).
 */
export function revisarAvisos(emisor: EmisorFcm, ahora: number = Date.now()): Promise<void> {
  barrerVencidos(ahora);
  const candidatos = getDb().prepare(`
    SELECT a.id, a.token, a.bus_id, a.route_id, a.lat, a.lon, a.radio_m, p.lat AS bus_lat, p.lon AS bus_lon
    FROM avisos_push a
    JOIN positions p ON p.bus_id = a.bus_id AND p.route_id = a.route_id AND p.is_ghost = 0
    JOIN buses b ON b.bus_id = a.bus_id AND b.visible = 1
    WHERE a.enviado_en IS NULL
  `).all() as Array<{
    id: string; token: string; bus_id: string; route_id: string;
    lat: number; lon: number; radio_m: number; bus_lat: number; bus_lon: number;
  }>;

  const envios: Promise<void>[] = [];
  for (const c of candidatos) {
    const metros = haversineDistanceKm(c.lat, c.lon, c.bus_lat, c.bus_lon) * 1000;
    if (metros > c.radio_m || !marcarEnviado(c.id, ahora)) continue;
    const datos = {
      tipo: 'bus_cerca',
      avisoId: c.id,
      busId: c.bus_id,
      routeId: c.route_id,
      distancia: String(Math.round(metros)),
    };
    envios.push(emisor.enviar(c.token, datos, ahora).then(
      (resultado) => {
        if (resultado === 'enviado') {
          incrementMetric('push.enviados');
        } else if (resultado === 'token_invalido') {
          incrementMetric('push.token_invalido');
          borrarPorToken(c.token);
        } else {
          incrementMetric('push.fallidos');
          desmarcarEnviado(c.id);
        }
      },
      () => {
        incrementMetric('push.fallidos');
        desmarcarEnviado(c.id);
      },
    ).catch((error) => {
      // La base se cerró mientras FCM respondía (el apagado): la fila se
      // queda como esté y vence sola.
      console.error('[Push] No se pudo apuntar el resultado de un envío:', error);
    }));
  }
  return Promise.all(envios).then(() => undefined);
}
