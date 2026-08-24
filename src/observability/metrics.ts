// Métricas en memoria con persistencia a SQLite.
//
// El camino caliente (incrementMetric/setMetric) sigue siendo un Map en
// memoria: cero I/O por mensaje MQTT o request HTTP. La persistencia va
// por detrás: restoreMetrics() al arrancar, flushMetrics() cada 30s y en
// el apagado limpio. Sin esto, cada reinicio borraba la única señal
// operativa del sistema (posiciones aceptadas/rechazadas, auth MQTT).
import { getDb } from '../data/database';

const counters = new Map<string, number>();
const gauges = new Map<string, number>();

let restored = false;

export function incrementMetric(name: string, amount = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + amount);
}

export function setMetric(name: string, value: number): void {
  gauges.set(name, value);
}

export function getMetrics(): Record<string, Record<string, number>> {
  return {
    counters: Object.fromEntries(counters.entries()),
    gauges: Object.fromEntries(gauges.entries()),
  };
}

/** Carga los contadores persistidos una sola vez, al arrancar y antes de
 *  que el tráfico acumule nada en memoria. */
export function restoreMetrics(): void {
  if (restored) return;
  restored = true;
  const rows = getDb().prepare('SELECT name, value FROM metrics').all() as {
    name: string;
    value: number;
  }[];
  for (const row of rows) {
    // Línea base persistida; lo que hubiera en memoria (no debería haber
    // nada todavía) se conserva encima.
    counters.set(row.name, (counters.get(row.name) ?? 0) + row.value);
  }
}

/** Escribe todos los contadores en una transacción. Idempotente. */
export function flushMetrics(): void {
  if (!restored) return;
  const db = getDb();
  const upsert = db.prepare(
    'INSERT INTO metrics (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value',
  );
  const write = db.transaction(() => {
    for (const [name, value] of counters) {
      upsert.run(name, value);
    }
  });
  write();
}
