import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { siembraBusquedasDemoHabilitada } from '../config';
import { getDb } from '../data/database';
import { K_BUSQUEDAS, PASO_LAT, PASO_LNG } from '../data/busquedas';
import { dentroDeZona } from '../security/zona';

type Punto = { lat: number; lon: number };
type Ruta = { routeId: string; name?: string; waypoints: Punto[] };
type Celda = Punto & { key: string };
const VERSION = 'busquedas-demo-v7';
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
// Los focos caen sobre la ruta en parches de fuerza variada, con huecos entre
// ellos, y cambian de sitio cada semana (dueño, 2026-10-27: siempre salían
// las mismas 5 zonas), así el mes cubre casi toda la ruta. Cada semana suma
// además una mancha a 1 o 2 km, sobre la calle de otra ruta: nunca en el
// agua ni en un potrero.
// 2,5, con fuerzas de 0,5 a 1,3, deja más de una quinta parte de las celdas
// en caliente y la hora pico a la vista.
const EXPONENTE = 2.5;
type Foco = { center: Punto; sigma: number; weight: number; lejos: boolean };
function focosSemana(routeId: string, points: Punto[], lejanas: Celda[], semana: number): Foco[] {
  const azar = (que: string) => hash(`${routeId}:semana:${semana}:${que}`);
  const n = 6, giro = azar('giro') % 1000 / 1000;
  const focos: Foco[] = Array.from({ length: n }, (_, i) => {
    const desfase = (azar(`sitio:${i}`) % 61 - 30) / 100;
    const indice = Math.round(((i + giro + desfase + n) % n) * (points.length - 1) / n);
    return {
      center: points[Math.min(points.length - 1, Math.max(0, indice))],
      sigma: 300 + azar(`sigma:${i}`) % 401,
      weight: 0.5 + (azar(`peso:${i}`) % 81) / 100,
      lejos: false,
    };
  });
  if (lejanas.length > 0) {
    focos.push({ center: lejanas[azar('lejos') % lejanas.length], sigma: 200, weight: 0.5 + (azar('peso lejos') % 31) / 100, lejos: true });
  }
  return focos;
}

// Celdas de la calle de las otras rutas a 1 o 2 km de esta: el único sitio
// donde cae una mancha lejos, porque ahí seguro hay calle.
function celdasLejanas(propia: Celda[], otras: Celda[]): Celda[] {
  return otras.filter(c => {
    const d = Math.min(...propia.map(p => distancia(c, p)));
    return d >= 1000 && d <= 2000;
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

// Toda ruta se llena en la mañana (6 a 8) y en la tarde (4 a 6 y media),
// pero cada una a su hora, con su alto y su ancho, un mediodía propio y un
// valle que no es plano (dueño, 2026-10-26: las rutas se veían calcadas).
// La de Uninorte suma el mediodía de los estudiantes, sin pasar la punta.
function perfil(routeId: string, nombre?: string): number[] {
  const azar = (que: string) => (hash(`${routeId}:perfil:${que}`) % 1001) / 1000;
  const campana = (h: number, centro: number, ancho: number) => Math.exp(-((h - centro) ** 2) / (2 * ancho ** 2));
  const manana = 6.5 + 1.5 * azar('mañana'), tarde = 16.5 + 2 * azar('tarde');
  const altoManana = 2.5 + 3 * azar('alto mañana'), altoTarde = 2.5 + 3 * azar('alto tarde');
  const anchoManana = 0.7 + 0.6 * azar('ancho mañana'), anchoTarde = 0.8 + 0.7 * azar('ancho tarde');
  const uninorte = nombre?.toLocaleLowerCase('es').includes('uninorte') ?? false;
  const mediodia = 12 + azar('mediodía');
  const altoMediodia = uninorte ? 0.75 * Math.min(altoManana, altoTarde) : 0.3 + 1.2 * azar('alto mediodía');
  const valle = 0.3 + 0.3 * azar('valle');
  return Array.from({ length: 24 }, (_, h) => {
    if (h < 5 || h > 22) return 0.01;
    // A las 5 ya sale la gente del primer turno; a las 10 de la noche quedan pocos.
    const servicio = h === 22 ? 0.5 : 1;
    return (valle * servicio + altoManana * campana(h, manana, anchoManana) + altoMediodia * campana(h, mediodia, 0.8)
      + altoTarde * campana(h, tarde, anchoTarde)) * (0.88 + azar(`hora ${h}`) * 0.24);
  });
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
      const enRuta = celdasRuta(route.waypoints);
      const otras = new Map<string, Celda>();
      for (const r of rutasJson.rutas) {
        if (r.routeId !== route_id && r.waypoints.length >= 2) for (const c of celdasRuta(r.waypoints)) otras.set(c.key, c);
      }
      const lejanas = celdasLejanas(enRuta, [...otras.values()]);
      const cerca = [...celdasCerca(enRuta).map(c => ({ c, lado: Math.exp(-(c.aCalle ** 2) / (2 * 250 ** 2)), lejos: false })),
        ...lejanas.map(c => ({ c, lado: 1, lejos: true }))];
      const weights = perfil(route_id, route.name);
      const routeSeed = hash(route_id);
      const routeRank = demo.findIndex(item => item.route_id === route_id);
      // Por orden, pero sin escalera pareja: cada ruta suma de 0 a 150 al día,
      // menos que el paso de 175, así el orden queda y los saltos no se calcan.
      const daily = 300 + (demo.length - routeRank - 1) * 175 + routeSeed % 151;
      // Sin piso: entre focos la ruta queda sin calor, y a los lados de la
      // calle se apaga en unos 250 m. A la 2,5, para que la hora pico junte
      // sus búsquedas en el foco y se vea (K_BUSQUEDAS por celda). La semana
      // se toma de la fecha, así cada hora sembrada da lo mismo al repetirla.
      // Una mancha lejos solo calienta las celdas lejanas, y un foco de la
      // ruta, solo las de la ruta.
      const porSemana = new Map<number, number[]>();
      const pesosSemana = (semana: number) => {
        let pesos = porSemana.get(semana);
        if (!pesos) {
          const foci = focosSemana(route_id, route.waypoints, lejanas, semana);
          pesos = cerca.map(({ c, lado, lejos }) => {
            const peso = (lado * foci.reduce((sum, foco) => foco.lejos !== lejos ? sum
              : sum + foco.weight * Math.exp(-(distancia(c, foco.center) ** 2) / (2 * foco.sigma ** 2)), 0)) ** EXPONENTE;
            return peso >= 0.002 ? peso : 0;
          });
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
        // De a K_BUSQUEDAS por celda: el calor solo muestra lo que junta K en
        // un mismo día y hora (D17, AUD29-01), y la demo repartida de a una
        // dejaba vacías las horas fuera de la punta. El promedio del mes no
        // cambia: el reparto sigue siendo sistemático.
        const porCelda = repartir(Math.round(total / K_BUSQUEDAS), pesosSemana(Math.floor((hour - 5 * HORA) / (7 * 24 * HORA))), hash(`${route_id}:${hour}`));
        for (let i = 0; i < cerca.length; i++) {
          const { c } = cerca[i], count = porCelda[i] * K_BUSQUEDAS;
          if (count > 0) insert.run(route_id, hour, c.key, c.lat, c.lon, count);
        }
      }
    }
    db.prepare("INSERT INTO demo_seed_meta(name,version) VALUES ('busquedas',?) ON CONFLICT(name) DO UPDATE SET version=excluded.version").run(VERSION);
  })();
}
