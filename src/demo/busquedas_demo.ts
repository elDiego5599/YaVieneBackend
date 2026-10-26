import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { siembraBusquedasDemoHabilitada } from '../config';
import { getDb } from '../data/database';
import { K_BUSQUEDAS, PASO_LAT, PASO_LNG } from '../data/busquedas';
import { dentroDeZona } from '../security/zona';

type Punto = { lat: number; lon: number };
type Ruta = { routeId: string; name?: string; waypoints: Punto[] };
type Celda = Punto & { key: string };
const VERSION = 'busquedas-demo-v4';
const HORA = 3_600_000;
const DIA = 24 * HORA;
const MLAT = 111_320;
const MLNG = MLAT * Math.cos(11 * Math.PI / 180);
const hash = (s: string): number => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const distancia = (a: Punto, b: Punto) => Math.hypot((a.lat - b.lat) * MLAT, (a.lon - b.lon) * MLNG);
const key = (lat: number, lon: number) => `${lat.toFixed(8)},${lon.toFixed(8)}`;
function celdasRuta(points: Punto[]): Celda[] {
  const result = new Map<string, Celda>();
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], n = Math.max(1, Math.ceil(distancia(a, b) / 35));
    for (let j = i === 1 ? 0 : 1; j <= n; j++) {
      const lat = Math.round((a.lat + (b.lat - a.lat) * j / n) / PASO_LAT) * PASO_LAT;
      const lon = Math.round((a.lon + (b.lon - a.lon) * j / n) / PASO_LNG) * PASO_LNG;
      if (dentroDeZona(lat, lon)) result.set(key(lat, lon), { lat, lon, key: key(lat, lon) });
    }
  }
  return [...result.values()];
}
// Los focos caen sobre la ruta (dueño, 2026-10-26): parches de fuerza
// variada, con huecos entre ellos, nunca manchas lejos del recorrido.
// 2,5 deja una quinta parte de las celdas en caliente y la hora pico a la vista.
const EXPONENTE = 2.5;
function focosRuta(routeId: string, points: Punto[]) {
  const n = 7;
  return Array.from({ length: n }, (_, i) => {
    const desfase = (hash(`${routeId}:sitio:${i}`) % 61 - 30) / 100;
    const indice = Math.round((i + 0.5 + desfase) * (points.length - 1) / n);
    return {
      center: points[Math.min(points.length - 1, Math.max(0, indice))],
      sigma: 300 + hash(`${routeId}:sigma:${i}`) % 401,
      weight: 0.2 + (hash(`${routeId}:peso:${i}`) % 131) / 100,
    };
  });
}

// La ruta y dos celdas a cada lado: quien busca el bus suele estar a una o
// dos cuadras de la calle por donde pasa, no encima. Cada celda guarda su
// distancia a la calle (la de la celda de la ruta más cercana).
function celdasCerca(ruta: Celda[]): Array<Celda & { aCalle: number }> {
  const result = new Map<string, Celda & { aCalle: number }>();
  for (const c of ruta) {
    for (let di = -2; di <= 2; di++) {
      for (let dj = -2; dj <= 2; dj++) {
        const lat = c.lat + di * PASO_LAT, lon = c.lon + dj * PASO_LNG;
        const k = key(lat, lon), aCalle = distancia({ lat, lon }, c), antes = result.get(k);
        // 280 m al centro de la celda de la ruta: con su media diagonal, nada
        // queda a más de 400 m de la calle.
        if (!dentroDeZona(lat, lon) || aCalle > 280) continue;
        if (!antes || aCalle < antes.aCalle) result.set(k, { lat, lon, key: k, aCalle });
      }
    }
  }
  return [...result.values()];
}

// Reparto sistemático: cada celda recibe en promedio su parte exacta, también
// las del corredor con parte menor a una búsqueda por hora (con el resto
// mayor primero nunca les tocaba y la ruta quedaba en manchas sueltas).
function repartir(total: number, pesos: number[], semilla: number): number[] {
  const suma = pesos.reduce((a, b) => a + b, 0);
  const desfase = (hash(`${semilla}:desfase`) % 1_000_000) / 1_000_000;
  let acumulado = 0;
  return pesos.map(peso => {
    const antes = acumulado;
    acumulado += total * peso / suma;
    return Math.floor(acumulado + desfase) - Math.floor(antes + desfase);
  });
}

function perfil(routeId: string, nombre?: string): number[] {
  const weights = Array.from({ length: 24 }, (_, h) => h >= 6 && h <= 21 ? 0.6 : 0.01) as number[];
  if (nombre?.toLocaleLowerCase('es').includes('uninorte')) {
    for (const [hora, peso] of [[6, 3.4], [7, 1.9], [12, 3.1], [13, 1.8], [17, 3.3], [18, 1.9]] as Array<[number, number]>) weights[hora] += peso;
    return weights;
  }
  const seed = hash(`${routeId}:perfil`), windows: Array<[number, number]> = [[5, 7], [7, 9], [12, 14], [17, 19], [19, 21]];
  const first = seed % windows.length;
  for (let i = 0; i < 3; i++) {
    const [start, end] = windows[(first + i) % windows.length];
    const height = i === 0 ? 5.5 : 1.4 + ((seed >>> (i * 5)) % 8) / 10;
    for (let h = start; h <= end; h++) weights[h] += height * (h === start || h === end ? 0.72 : 1);
  }
  return weights;
}

/** Agrega calor de demo idempotente por hora y celda. */
export function sembrarBusquedasDemo(ahora = Date.now()): void {
  if (!siembraBusquedasDemoHabilitada()) return;
  const rutasJson = JSON.parse(readFileSync(join(__dirname, '..', '..', 'scripts', 'data', 'rutas.json'), 'utf8')) as { rutas: Ruta[] };
  const db = getDb();
  db.exec('CREATE TABLE IF NOT EXISTS demo_seed_meta (name TEXT PRIMARY KEY, version TEXT NOT NULL)');
  const current = db.prepare("SELECT version FROM demo_seed_meta WHERE name = 'busquedas'").get() as { version: string } | undefined;
  const demo = db.prepare("SELECT route_id FROM company_routes WHERE company_id IN ('EMP-01','EMP-03') ORDER BY route_id").all() as { route_id: string }[];
  const insert = db.prepare('INSERT INTO busquedas(route_id,hora,celda_key,celda_lat,celda_lng,count) VALUES (?,?,?,?,?,?) ON CONFLICT(route_id,hora,celda_key) DO NOTHING');
  const start = Math.floor((ahora - 35 * DIA) / HORA) * HORA;
  const until = Math.floor(ahora / HORA) * HORA + HORA;
  db.transaction(() => {
    if (current?.version !== VERSION) {
      for (const { route_id } of demo) db.prepare('DELETE FROM busquedas WHERE route_id = ?').run(route_id);
    }
    for (const { route_id } of demo) {
      const route = rutasJson.rutas.find(r => r.routeId === route_id);
      if (!route || route.waypoints.length < 2) continue;
      const cells = celdasCerca(celdasRuta(route.waypoints)), weights = perfil(route_id, route.name);
      const foci = focosRuta(route_id, route.waypoints);
      const routeSeed = hash(route_id);
      const routeRank = demo.findIndex(item => item.route_id === route_id);
      const daily = 300 + (demo.length - routeRank - 1) * 175 + routeSeed % 80;
      // Sin piso: entre focos la ruta queda sin calor, y a los lados de la
      // calle se apaga en unos 250 m. Al cubo, para que la hora pico junte
      // sus búsquedas en el foco y se vea (K_BUSQUEDAS por celda).
      const cerca = cells.map(c => ({ c, lado: Math.exp(-(c.aCalle ** 2) / (2 * 250 ** 2)),
        aporte: foci.map(foco => foco.weight * Math.exp(-(distancia(c, foco.center) ** 2) / (2 * foco.sigma ** 2))) }))
        .filter(({ lado, aporte }) => (lado * aporte.reduce((a, b) => a + b, 0)) ** EXPONENTE >= 0.002);
      // Cada foco sube o baja por semana (dueño, 2026-10-26: 7 y 30 días se
      // veían iguales): la última semana no calca el mes. La semana se toma
      // de la fecha, así cada hora sembrada da lo mismo al repetirla.
      const porSemana = new Map<number, number[]>();
      const pesosSemana = (semana: number) => {
        let pesos = porSemana.get(semana);
        if (!pesos) {
          const fuerza = foci.map((_, f) => 0.15 + (hash(`${route_id}:foco:${f}:semana:${semana}`) % 171) / 100);
          pesos = cerca.map(({ lado, aporte }) => (lado * aporte.reduce((sum, a, f) => sum + a * fuerza[f], 0)) ** EXPONENTE);
          porSemana.set(semana, pesos);
        }
        return pesos;
      };
      for (let hour = start; hour < until; hour += HORA) {
        const localDate = new Date(hour - 5 * HORA), day = localDate.getUTCDay(), localHour = localDate.getUTCHours();
        const baseDay = day === 0 ? 0.35 : day === 6 ? 0.6 : 1;
        const shifted = day === 0 || day === 6 ? (localHour + 22) % 24 : localHour;
        const noise = 0.75 + hash(`${route_id}:${hour}:daily`) % 51 / 100;
        const rain = hash(`${route_id}:${localDate.toISOString().slice(0,10)}:lluvia`) % 19 === 0 ? 1.4 : 1;
        const total = daily * baseDay * noise * rain * weights[shifted] / weights.reduce((a,b) => a+b,0);
        const porCelda = repartir(Math.round(total), pesosSemana(Math.floor((hour - 5 * HORA) / (7 * 24 * HORA))), hash(`${route_id}:${hour}`));
        for (let i = 0; i < cerca.length; i++) {
          const { c } = cerca[i], count = porCelda[i];
          if (count > 0) insert.run(route_id, hour, c.key, c.lat, c.lon, count);
        }
      }
    }
    db.prepare("INSERT INTO demo_seed_meta(name,version) VALUES ('busquedas',?) ON CONFLICT(name) DO UPDATE SET version=excluded.version").run(VERSION);
  })();
}
