import { getDb } from './database';
import { RETENCION_HISTORIAL_MS } from './historial';
import { VELOCIDAD_EN_MARCHA_KMH } from './indicadores';
import { MAX_CAPTURE_CLOCK_SKEW_MS, MAX_PAST_CAPTURE_MS, MAX_SPEED_KMH } from '../security/physics';
import { ZONA } from '../security/zona';

/**
 * El proceso de datos del historial. Lo crudo (`posiciones_historial`) dura
 * una semana; antes de que la retención lo borre, cada día cerrado se resume
 * por ruta y hora en `servicio_horario` y se cuenta en `calidad_historial`
 * cuánto de lo crudo no pasó los controles de calidad.
 *
 * Los controles repiten los del ingreso (zona, velocidad, reloj) porque el
 * historial recibe lo que ya pasó por ahí, pero un límite que se afloje o un
 * camino que no pase por ahí no debe colarse en lo que se resume: lo que
 * llega a `servicio_horario` es lo que se midió con datos creíbles.
 */

const HORA_MS = 60 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;
/**
 * Barranquilla es UTC-5 todo el año (Colombia no tiene horario de verano):
 * su medianoche cae a las 05:00 UTC. Para hallarla se pasa el reloj a hora
 * local (restando el desfase), se recorta al día y se vuelve a UTC (sumándolo).
 */
const DESFASE_BOGOTA_MS = 5 * HORA_MS;

/**
 * Muestra creíble: dentro del área de servicio, a una velocidad posible, con
 * un reloj que no está adelantado y que no llegó más tarde de lo que deja
 * esperar el reenvío de un buffer sin señal.
 */
const VALIDA = `
  lat BETWEEN @latMin AND @latMax AND lon BETWEEN @lonMin AND @lonMax
  AND speed_kmh BETWEEN 0 AND @maxVelocidad
  AND captured_at <= received_at + @sesgo
  AND received_at - captured_at <= @tardia
`;

const FUERA_DE_RANGO = `
  NOT (lat BETWEEN @latMin AND @latMax AND lon BETWEEN @lonMin AND @lonMax
       AND speed_kmh BETWEEN 0 AND @maxVelocidad)
`;

const LIMITES = {
  latMin: ZONA.latMin,
  latMax: ZONA.latMax,
  lonMin: ZONA.lonMin,
  lonMax: ZONA.lonMax,
  maxVelocidad: MAX_SPEED_KMH,
  sesgo: MAX_CAPTURE_CLOCK_SKEW_MS,
  tardia: MAX_PAST_CAPTURE_MS,
};

/**
 * Resume el día que empieza en `dia` (medianoche de Barranquilla, en
 * milisegundos UTC). Se puede repetir: borra y vuelve a escribir ese día,
 * así que dos corridas dan lo mismo.
 */
export function consolidarDia(dia: number, ahora = Date.now()): void {
  const d = getDb();
  const fin = dia + DIA_MS;
  d.transaction(() => {
    d.prepare('DELETE FROM servicio_horario WHERE dia = ?').run(dia);
    // La velocidad media ignora los buses parados (semáforo, paradero): AVG
    // salta los NULL, y un bus que solo estuvo parado queda sin velocidad.
    d.prepare(`
      INSERT INTO servicio_horario (company_id, route_id, dia, hora, simulado, buses, muestras, velocidad_media)
      SELECT company_id, route_id, @dia,
             CAST(captured_at - @dia AS INTEGER) / ${HORA_MS} AS hora,
             simulado, COUNT(DISTINCT bus_id), COUNT(*),
             AVG(CASE WHEN speed_kmh > @enMarcha THEN speed_kmh END)
      FROM posiciones_historial
      WHERE captured_at >= @dia AND captured_at < @fin AND ${VALIDA}
      GROUP BY company_id, route_id, hora, simulado
    `).run({ ...LIMITES, dia, fin, enMarcha: VELOCIDAD_EN_MARCHA_KMH });

    // Causas exclusivas, en este orden: una muestra con la posición fuera de
    // rango se cuenta ahí aunque además traiga el reloj malo.
    d.prepare(`
      INSERT OR REPLACE INTO calidad_historial (
        dia, muestras, validas, fuera_de_rango, reloj_adelantado, llegada_tardia,
        sin_posicion_en_ruta, consolidado_at
      )
      SELECT @dia,
             COUNT(*),
             COALESCE(SUM(CASE WHEN ${VALIDA} THEN 1 ELSE 0 END), 0),
             COALESCE(SUM(CASE WHEN ${FUERA_DE_RANGO} THEN 1 ELSE 0 END), 0),
             COALESCE(SUM(CASE WHEN NOT (${FUERA_DE_RANGO}) AND captured_at > received_at + @sesgo
                               THEN 1 ELSE 0 END), 0),
             COALESCE(SUM(CASE WHEN NOT (${FUERA_DE_RANGO}) AND NOT captured_at > received_at + @sesgo
                                    AND received_at - captured_at > @tardia THEN 1 ELSE 0 END), 0),
             COALESCE(SUM(CASE WHEN ${VALIDA} AND fraccion_ruta IS NULL THEN 1 ELSE 0 END), 0),
             @ahora
      FROM posiciones_historial
      WHERE captured_at >= @dia AND captured_at < @fin
    `).run({ ...LIMITES, dia, fin, ahora });
  })();
}

/**
 * Consolida los días cerrados que aún no tienen resumen. Un día está cerrado
 * cuando pasó su medianoche y además el tiempo que puede tardar en llegar una
 * muestra con reloj atrasado (`MAX_PAST_CAPTURE_MS`); antes quedaría a medias.
 * Los días que la retención ya empezó a borrar no se tocan: su crudo está
 * incompleto y un resumen parcial pasaría por entero. Devuelve los días
 * consolidados, del más viejo al más nuevo.
 */
export function consolidarPendientes(ahora = Date.now()): number[] {
  const d = getDb();
  const pendientes = (d.prepare(`
    SELECT dia FROM (
      SELECT DISTINCT CAST(captured_at - @desfase AS INTEGER) / ${DIA_MS} * ${DIA_MS} + CAST(@desfase AS INTEGER) AS dia
      FROM posiciones_historial
    ) AS crudo
    WHERE dia + ${DIA_MS} + @tardia <= @ahora AND dia >= @desde
      AND NOT EXISTS (SELECT 1 FROM calidad_historial c WHERE c.dia = crudo.dia)
    ORDER BY dia
  `).all({
    desfase: DESFASE_BOGOTA_MS,
    tardia: MAX_PAST_CAPTURE_MS,
    ahora,
    desde: ahora - RETENCION_HISTORIAL_MS,
  }) as { dia: number }[]).map((f) => f.dia);
  for (const dia of pendientes) consolidarDia(dia, ahora);
  return pendientes;
}
