// El proceso de datos del historial: antes de que la retención borre lo
// crudo, cada día cerrado de Barranquilla se resume por ruta y hora
// (`servicio_horario`) y se cuenta cuánto de lo crudo no pasó los controles
// de calidad (`calidad_historial`). Las muestras se escriben a mano para que
// cada número se pueda sacar con lápiz.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-consolidacion-'));
process.env.YA_VIENE_DB_PATH = join(tmp, 'test.db');
process.env.JWT_SECRET = randomBytes(32).toString('hex');
const { getDb } = require('../src/data/database') as typeof import('../src/data/database');
const { limpiarHistorial } = require('../src/data/historial') as typeof import('../src/data/historial');
const { consolidarDia, consolidarPendientes } = require('../src/data/consolidacion') as typeof import('../src/data/consolidacion');

test.after(() => { getDb().close(); rmSync(tmp, { recursive: true, force: true }); });

const MIN = 60_000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;
// Medianoche del 20 de noviembre de 2026 en Barranquilla (UTC-5).
const D = Date.UTC(2026, 10, 20, 5, 0, 0);

interface Muestra {
  bus: string; t: number; ruta?: string; velocidad?: number; lat?: number; lon?: number;
  recibida?: number; fraccion?: number | null; simulado?: boolean;
}
function muestra(m: Muestra): void {
  getDb().prepare(`
    INSERT INTO posiciones_historial (bus_id, route_id, company_id, lat, lon, speed_kmh, heading, sentido,
      fraccion_ruta, sentido_ruta, captured_at, received_at, simulado)
    VALUES (?, ?, 'EMP-CON', ?, ?, ?, NULL, NULL, ?, 'ida', ?, ?, ?)
  `).run(m.bus, m.ruta ?? 'R-CON', m.lat ?? 10.96, m.lon ?? -74.79, m.velocidad ?? 20,
    m.fraccion === undefined ? 0.5 : m.fraccion, m.t, m.recibida ?? m.t, m.simulado ? 1 : 0);
}
function horas(dia: number) {
  return getDb().prepare(`
    SELECT route_id, hora, simulado, buses, muestras, velocidad_media
    FROM servicio_horario WHERE dia = ? ORDER BY route_id, hora, simulado
  `).all(dia);
}
function calidad(dia: number) {
  return getDb().prepare(`
    SELECT muestras, validas, fuera_de_rango, reloj_adelantado, llegada_tardia, sin_posicion_en_ruta
    FROM calidad_historial WHERE dia = ?
  `).get(dia);
}

test.beforeEach(() => {
  getDb().exec('DELETE FROM posiciones_historial; DELETE FROM servicio_horario; DELETE FROM calidad_historial;');
});

test('resume cada hora por ruta: buses distintos, muestras y la velocidad solo en marcha', () => {
  const h7 = D + 7 * HORA;
  muestra({ bus: 'A', t: h7, velocidad: 20 });
  muestra({ bus: 'A', t: h7 + 10 * MIN, velocidad: 2 }); // detenido: cuenta, pero no en la velocidad
  muestra({ bus: 'B', t: h7 + 20 * MIN, velocidad: 30, fraccion: null });
  muestra({ bus: 'S', t: h7 + 5 * MIN, velocidad: 10, simulado: true }); // la flota de ejemplo, aparte
  muestra({ bus: 'C', t: D + 9 * HORA, velocidad: 0 }); // solo detenido: sin velocidad
  muestra({ bus: 'C', t: D + 7 * HORA, ruta: 'R-OTRA', velocidad: 15 });

  consolidarDia(D);

  assert.deepEqual(horas(D), [
    { route_id: 'R-CON', hora: 7, simulado: 0, buses: 2, muestras: 3, velocidad_media: 25 },
    { route_id: 'R-CON', hora: 7, simulado: 1, buses: 1, muestras: 1, velocidad_media: 10 },
    { route_id: 'R-CON', hora: 9, simulado: 0, buses: 1, muestras: 1, velocidad_media: null },
    { route_id: 'R-OTRA', hora: 7, simulado: 0, buses: 1, muestras: 1, velocidad_media: 15 },
  ]);
});

test('lo que no pasa los controles no entra al resumen y queda contado por causa', () => {
  const t = D + 8 * HORA;
  muestra({ bus: 'A', t, velocidad: 20 });
  muestra({ bus: 'B', t, lat: 12.5 }); // fuera del área de servicio
  muestra({ bus: 'C', t, lon: -76 }); // fuera del área de servicio
  muestra({ bus: 'D', t, velocidad: 200 }); // más rápido de lo posible
  muestra({ bus: 'E', t, recibida: t - 31_000 }); // reloj del equipo adelantado
  muestra({ bus: 'F', t, recibida: t + 16 * MIN }); // llegó tarde
  muestra({ bus: 'G', t, fraccion: null }); // válida, pero sin saber dónde va en su ruta

  consolidarDia(D);

  assert.deepEqual(horas(D), [
    { route_id: 'R-CON', hora: 8, simulado: 0, buses: 2, muestras: 2, velocidad_media: 20 },
  ]);
  assert.deepEqual(calidad(D), {
    muestras: 7, validas: 2, fuera_de_rango: 3, reloj_adelantado: 1, llegada_tardia: 1, sin_posicion_en_ruta: 1,
  });
});

test('una muestra de otro día no entra: el día va de medianoche a medianoche en Barranquilla', () => {
  muestra({ bus: 'A', t: D - 1 }); // 23:59:59 del día anterior
  muestra({ bus: 'A', t: D + DIA }); // 00:00 del día siguiente
  muestra({ bus: 'A', t: D + DIA - 1 });

  consolidarDia(D);

  assert.deepEqual(horas(D), [
    { route_id: 'R-CON', hora: 23, simulado: 0, buses: 1, muestras: 1, velocidad_media: 20 },
  ]);
});

test('consolidar dos veces el mismo día da lo mismo', () => {
  muestra({ bus: 'A', t: D + HORA });
  consolidarDia(D);
  const primero = [horas(D), calidad(D)];
  consolidarDia(D);
  assert.deepEqual([horas(D), calidad(D)], primero);
});

test('solo se consolidan los días cerrados, con lo crudo entero y aún sin resumen', () => {
  muestra({ bus: 'A', t: D - DIA + HORA }); // ayer: ya consolidado antes
  muestra({ bus: 'A', t: D + HORA }); // hoy: cerrado
  muestra({ bus: 'A', t: D + DIA + HORA }); // mañana: sigue abierto
  muestra({ bus: 'A', t: D - 7 * DIA + HORA }); // la retención ya empezó a borrarlo
  consolidarDia(D - DIA);

  // Cerrado y con 15 minutos más, lo que puede tardar en llegar una muestra.
  const ahora = D + DIA + 15 * MIN;
  assert.deepEqual(consolidarPendientes(ahora), [D]);
  assert.deepEqual(consolidarPendientes(ahora), []);
  assert.deepEqual(consolidarPendientes(D + DIA + 14 * MIN), []);
  assert.equal(calidad(D + DIA), undefined);
  assert.equal(calidad(D - 7 * DIA), undefined);
});

test('un día cerrado sin muestras no deja resumen: solo se miran los días con algo crudo', () => {
  muestra({ bus: 'A', t: D - DIA + HORA });
  assert.deepEqual(consolidarPendientes(D + DIA + 15 * MIN), [D - DIA]);
  assert.equal(calidad(D), undefined);
});

test('el resumen sobrevive a la retención de lo crudo', () => {
  muestra({ bus: 'A', t: D + HORA });
  consolidarPendientes(D + DIA + 15 * MIN);
  limpiarHistorial(D + 30 * DIA);

  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM posiciones_historial').get() as { n: number }).n, 0);
  assert.deepEqual(horas(D), [
    { route_id: 'R-CON', hora: 1, simulado: 0, buses: 1, muestras: 1, velocidad_media: 20 },
  ]);
});
