import { getDb } from './database';

/**
 * El historial de posiciones: `positions` guarda solo la última de cada bus
 * (lo que el pasajero necesita), y aquí queda el recorrido para medir
 * intervalos entre buses, velocidades y horas pico.
 *
 * Se muestrea: la flota de ejemplo publica cada 0,4 a 1,5 s y con 240 buses
 * guardar todo serían decenas de millones de filas al día. Una muestra cada
 * 30 s por bus son unas 700.000 al día; a 20 km/h el bus anda 170 m entre
 * una y otra, bastante para saber cuándo pasó por cada tramo. Lo crudo dura
 * una semana; lo que se mide de él se resume aparte.
 */
export const MUESTREO_HISTORIAL_MS = 30_000;
export const RETENCION_HISTORIAL_MS = 7 * 24 * 60 * 60 * 1000;

export interface MuestraPosicion {
  busId: string;
  routeId: string;
  companyId: string;
  lat: number;
  lon: number;
  speedKmh: number;
  heading: number | null;
  sentido: string | null;
  capturedAt: number;
  receivedAt: number;
  simulado: boolean;
}

/**
 * Guarda la muestra si el bus no tiene otra en los últimos
 * MUESTREO_HISTORIAL_MS (ni una más nueva: una sesión nueva puede traer un
 * reloj atrasado). Devuelve si quedó guardada.
 */
export function registrarMuestra(m: MuestraPosicion): boolean {
  return getDb().prepare(`
    INSERT INTO posiciones_historial (
      bus_id, route_id, company_id, lat, lon, speed_kmh, heading, sentido,
      captured_at, received_at, simulado
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM posiciones_historial WHERE bus_id = ? AND captured_at > ?
    )
  `).run(
    m.busId, m.routeId, m.companyId, m.lat, m.lon, m.speedKmh, m.heading, m.sentido,
    m.capturedAt, m.receivedAt, m.simulado ? 1 : 0,
    m.busId, m.capturedAt - MUESTREO_HISTORIAL_MS,
  ).changes === 1;
}

/** Borra lo que pasó la retención; devuelve cuántas muestras se fueron. */
export function limpiarHistorial(ahora = Date.now()): number {
  return getDb().prepare('DELETE FROM posiciones_historial WHERE captured_at < ?')
    .run(ahora - RETENCION_HISTORIAL_MS).changes;
}
