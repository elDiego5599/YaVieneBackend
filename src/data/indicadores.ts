import { enBogota, filtroDias, type DiaSemana } from './busquedas';
import { getDb } from './database';
import { MUESTREO_HISTORIAL_MS } from './historial';

/**
 * Los indicadores de servicio de una ruta, sacados del historial de
 * posiciones: lo que una empresa de buses mide para saber si cumple
 * (cuántos buses andan a cada hora, a qué velocidad y cada cuánto pasa uno).
 *
 * El intervalo (headway) se mide en un punto fijo, la mitad de la ruta: cada
 * vez que un bus la cruza en un sentido queda un paso, y el intervalo es el
 * tiempo entre dos pasos seguidos en ese sentido, sea del bus que sea. Se
 * da la mediana y el p90 porque un promedio lo tuercen los buses que se
 * amontonan (dos seguidos y luego un hueco largo), que es justo lo que la
 * empresa quiere ver.
 */
const PUNTO_DE_PASO = 0.5;
/** Entre dos muestras más separadas que esto no se sabe cuándo cruzó: se perdió la señal. */
const MAX_HUECO_CRUCE_MS = 3 * MUESTREO_HISTORIAL_MS;
/** Un intervalo más largo que esto es una pausa del servicio (fin del turno, la noche), no un intervalo. */
const MAX_INTERVALO_MS = 2 * 60 * 60 * 1000;
/** Por debajo de esto el bus está parado (semáforo, paradero) y no cuenta para la velocidad en marcha. */
const VELOCIDAD_EN_MARCHA_KMH = 3;

export interface IndicadorHora {
  hora: number;
  /** Buses distintos que andan en esa hora, en promedio por día con servicio a esa hora. */
  busesPromedio: number;
  velocidadPromedioKmh: number | null;
}

export interface Intervalo {
  medianaMin: number;
  p90Min: number;
  /** Cuántas veces se cruzó el punto de paso en ese sentido. */
  pasos: number;
}

export interface IndicadoresRuta {
  porHora: IndicadorHora[];
  /** La hora con más buses andando; null sin datos. */
  horaPico: number | null;
  intervalos: { ida: Intervalo | null; venida: Intervalo | null };
  /** Si algo de lo medido viene de la flota de ejemplo: el panel lo dice. */
  simulado: boolean;
}

const unDecimal = (n: number) => Math.round(n * 10) / 10;
const dosDecimales = (n: number) => Math.round(n * 100) / 100;

/** null si la ruta no es de la empresa. */
export function indicadoresDeRuta(
  companyId: string, routeId: string, desde: number, hasta: number, dias?: readonly DiaSemana[],
): IndicadoresRuta | null {
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM company_routes WHERE company_id = ? AND route_id = ?').get(companyId, routeId)) return null;
  const enDias = filtroDias('captured_at', dias);
  const donde = `route_id = ? AND captured_at >= ? AND captured_at < ? ${enDias.sql}`;
  const valores = [routeId, desde, hasta, ...enDias.valores];

  const filas = db.prepare(`
    SELECT hora, AVG(buses) AS buses, SUM(suma) AS suma, SUM(marcha) AS marcha FROM (
      SELECT ${enBogota('%H', 'captured_at')} AS hora,
        COUNT(DISTINCT bus_id) AS buses,
        SUM(CASE WHEN speed_kmh > ${VELOCIDAD_EN_MARCHA_KMH} THEN speed_kmh ELSE 0 END) AS suma,
        SUM(CASE WHEN speed_kmh > ${VELOCIDAD_EN_MARCHA_KMH} THEN 1 ELSE 0 END) AS marcha
      FROM posiciones_historial WHERE ${donde}
      GROUP BY strftime('%Y-%m-%d', datetime(captured_at / 1000, 'unixepoch', '-5 hours')), hora
    ) GROUP BY hora
  `).all(...valores) as { hora: number; buses: number; suma: number; marcha: number }[];
  const porHora: IndicadorHora[] = Array.from({ length: 24 }, (_, hora) => ({ hora, busesPromedio: 0, velocidadPromedioKmh: null }));
  for (const f of filas) {
    porHora[f.hora] = {
      hora: f.hora,
      busesPromedio: unDecimal(f.buses),
      velocidadPromedioKmh: f.marcha > 0 ? unDecimal(f.suma / f.marcha) : null,
    };
  }
  const pico = porHora.reduce((max, h) => (h.busesPromedio > max.busesPromedio ? h : max));

  const simulado = db.prepare(`SELECT 1 FROM posiciones_historial WHERE ${donde} AND simulado = 1 LIMIT 1`).get(...valores) !== undefined;

  return {
    porHora,
    horaPico: pico.busesPromedio > 0 ? pico.hora : null,
    intervalos: intervalos(db.prepare(`
      SELECT bus_id AS bus, captured_at AS t, fraccion_ruta AS f, sentido_ruta AS sentido
      FROM posiciones_historial WHERE ${donde} AND fraccion_ruta IS NOT NULL
      ORDER BY bus_id, captured_at
    `).iterate(...valores) as Iterable<MuestraRuta>),
    simulado,
  };
}

interface MuestraRuta { bus: string; t: number; f: number; sentido: 'ida' | 'venida' | null }

function intervalos(muestras: Iterable<MuestraRuta>): IndicadoresRuta['intervalos'] {
  const pasos = { ida: [] as number[], venida: [] as number[] };
  let antes: MuestraRuta | undefined;
  for (const m of muestras) {
    if (antes?.bus === m.bus && m.t - antes.t <= MAX_HUECO_CRUCE_MS) {
      const subio = antes.f < PUNTO_DE_PASO && m.f >= PUNTO_DE_PASO && m.sentido === 'ida';
      const bajo = antes.f > PUNTO_DE_PASO && m.f <= PUNTO_DE_PASO && m.sentido === 'venida';
      // Cuándo cruzó, interpolado entre las dos muestras: a 30 s entre una y
      // otra, redondear a la muestra movería cada paso hasta 30 s.
      if (subio || bajo) pasos[m.sentido!].push(antes.t + ((PUNTO_DE_PASO - antes.f) / (m.f - antes.f)) * (m.t - antes.t));
    }
    antes = m;
  }
  return { ida: resumen(pasos.ida), venida: resumen(pasos.venida) };
}

function resumen(pasos: number[]): Intervalo | null {
  pasos.sort((a, b) => a - b);
  const huecos = pasos.slice(1).map((t, i) => t - pasos[i]).filter((ms) => ms <= MAX_INTERVALO_MS).sort((a, b) => a - b);
  if (huecos.length === 0) return null;
  const mitad = huecos.length >> 1;
  const mediana = huecos.length % 2 ? huecos[mitad] : (huecos[mitad - 1] + huecos[mitad]) / 2;
  // p90 por rango más cercano: un valor que de verdad se midió.
  const p90 = huecos[Math.ceil(0.9 * huecos.length) - 1];
  return { medianaMin: dosDecimales(mediana / 60_000), p90Min: dosDecimales(p90 / 60_000), pasos: pasos.length };
}
