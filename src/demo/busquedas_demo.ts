import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { siembraBusquedasDemoHabilitada } from '../config';
import { getDb } from '../data/database';
import { K_BUSQUEDAS, PASO_LAT, PASO_LNG } from '../data/busquedas';
import { dentroDeZona } from '../security/zona';

type Punto = { lat: number; lon: number };
type Ruta = { routeId: string; name?: string; waypoints: Punto[] };
type Celda = Punto & { key: string };
const VERSION = 'busquedas-demo-v2';
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
function focosRuta(routeId: string, points: Punto[]) {
  const seed = hash(routeId);
  return Array.from({ length: 5 }, (_, i) => {
    const origin = points[Math.floor(i * (points.length - 1) / 4)];
    const radius = 650 + (hash(`${routeId}:radio:${i}`) % 1_700);
    const startAngle = ((seed >>> (i % 16)) % 360) * Math.PI / 180;
    const candidatos = Array.from({ length: 16 }, (_, j) => {
      const angle = startAngle + j * Math.PI / 8;
      return { lat: origin.lat + Math.sin(angle) * radius / MLAT, lon: origin.lon + Math.cos(angle) * radius / MLNG };
    });
    const center = candidatos.find(candidate => dentroDeZona(candidate.lat, candidate.lon)
      && Math.min(...points.map(point => distancia(candidate, point))) >= 500
      && Math.min(...points.map(point => distancia(candidate, point))) <= 2_500) ?? candidatos[0];
    return {
      center,
      sigma: 200 + hash(`${routeId}:sigma:${i}`) % 401,
      weight: 0.7 + (hash(`${routeId}:peso:${i}`) % 61) / 100,
    };
  });
}
function celdasConFocos(routeId: string, points: Punto[]): Celda[] {
  const referencias = points.filter((_, index) => index % 5 === 0);
  if (referencias.at(-1) !== points.at(-1)) referencias.push(points.at(-1)!);
  const cells = new Map(celdasRuta(points).map(c => [c.key, c]));
  const focos = focosRuta(routeId, points);
  for (const { center, sigma } of focos) {
    const reach = 3 * sigma;
    const latSteps = Math.ceil(reach / (PASO_LAT * MLAT));
    const lonSteps = Math.ceil(reach / (PASO_LNG * MLNG));
    for (let y = -latSteps; y <= latSteps; y++) for (let x = -lonSteps; x <= lonSteps; x++) {
      const lat = Math.round((center.lat + y * PASO_LAT) / PASO_LAT) * PASO_LAT;
      const lon = Math.round((center.lon + x * PASO_LNG) / PASO_LNG) * PASO_LNG;
      const cell = { lat, lon };
      if (!dentroDeZona(lat, lon) || Math.min(...referencias.map(p => distancia(cell, p))) > 2_750) continue;
      cells.set(key(lat, lon), { ...cell, key: key(lat, lon) });
    }
  }
  return [...cells.values()];
}

function repartir(total: number, pesos: number[], semilla: number): number[] {
  const suma = pesos.reduce((a, b) => a + b, 0);
  const exactos = pesos.map(peso => total * peso / suma);
  const resultado = exactos.map(Math.floor);
  let faltan = total - resultado.reduce((a, b) => a + b, 0);
  const orden = exactos.map((valor, i) => ({ i, resto: valor - resultado[i], desempate: hash(`${semilla}:${i}`) }))
    .sort((a, b) => b.resto - a.resto || a.desempate - b.desempate);
  for (let i = 0; i < faltan; i++) resultado[orden[i].i]++;
  return resultado;
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
      const cells = celdasConFocos(route_id, route.waypoints), weights = perfil(route_id, route.name);
      const foci = focosRuta(route_id, route.waypoints);
      const referencias = route.waypoints.filter((_, index) => index % 5 === 0);
      if (referencias.at(-1) !== route.waypoints.at(-1)) referencias.push(route.waypoints.at(-1)!);
      for (const foco of foci) {
        const lat = Math.round(foco.center.lat / PASO_LAT) * PASO_LAT;
        const lon = Math.round(foco.center.lon / PASO_LNG) * PASO_LNG;
        if (dentroDeZona(lat, lon) && Math.min(...referencias.map(point => distancia({ lat, lon }, point))) <= 2_750) {
          cells.push({ lat, lon, key: key(lat, lon) });
        }
      }
      const routeSeed = hash(route_id);
      const routeRank = demo.findIndex(item => item.route_id === route_id);
      const daily = 300 + (demo.length - routeRank - 1) * 175 + routeSeed % 80;
      const centers = [...new Map(cells.map(cell => [cell.key, cell])).values()].map((c, i) => ({ c, i, w: 0.000001 + foci.reduce((sum, foco) => {
        const d = distancia(c, foco.center);
        return sum + (d <= foco.sigma * 0.5 ? foco.weight * Math.exp(-(d ** 2) / (2 * foco.sigma ** 2)) : 0);
      }, 0) }));
      const sw = centers.reduce((a, b) => a + b.w, 0);
      for (let hour = start; hour < until; hour += HORA) {
        const localDate = new Date(hour - 5 * HORA), day = localDate.getUTCDay(), localHour = localDate.getUTCHours();
        const baseDay = day === 0 ? 0.35 : day === 6 ? 0.6 : 1;
        const shifted = day === 0 || day === 6 ? (localHour + 22) % 24 : localHour;
        const noise = 0.75 + hash(`${route_id}:${hour}:daily`) % 51 / 100;
        const rain = hash(`${route_id}:${localDate.toISOString().slice(0,10)}:lluvia`) % 19 === 0 ? 1.4 : 1;
        const total = daily * baseDay * noise * rain * weights[shifted] / weights.reduce((a,b) => a+b,0);
        const porCelda = repartir(Math.round(total), centers.map(center => center.w), hash(`${route_id}:${hour}`));
        for (let i = 0; i < centers.length; i++) {
          const { c } = centers[i], count = porCelda[i];
          if (count > 0) insert.run(route_id, hour, c.key, c.lat, c.lon, count);
        }
        for (const foco of foci) {
          const lat = Math.round(foco.center.lat / PASO_LAT) * PASO_LAT;
          const lon = Math.round(foco.center.lon / PASO_LNG) * PASO_LNG;
          if (!dentroDeZona(lat, lon) || Math.min(...referencias.map(point => distancia({ lat, lon }, point))) <= 300 || Math.min(...referencias.map(point => distancia({ lat, lon }, point))) > 2_750) continue;
          insert.run(route_id, hour, key(lat, lon), lat, lon, 1);
        }
      }
    }
    db.prepare("INSERT INTO demo_seed_meta(name,version) VALUES ('busquedas',?) ON CONFLICT(name) DO UPDATE SET version=excluded.version").run(VERSION);
  })();
}
