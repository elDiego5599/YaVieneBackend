import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeDb, getDb } from '../../src/data/database';
import { calorBusquedas, K_BUSQUEDAS, rankingBusquedas } from '../../src/data/busquedas';
import { sembrarBusquedasDemo } from '../../src/demo/busquedas_demo';

const db = getDb();
const routeId = 'R-106';
const now = Date.parse('2026-10-26T15:00:00.000Z');
db.prepare(`INSERT INTO busquedas(route_id,hora,celda_key,celda_lat,celda_lng,count)
VALUES ('R-AJENA', ?, 'keep', 10.9, -74.8, 9)`).run(now - 1);
db.prepare(`INSERT INTO busquedas(route_id,hora,celda_key,celda_lat,celda_lng,count)
VALUES ('R-777', ?, 'real', 10.9, -74.8, 1)`).run(now - 1);
sembrarBusquedasDemo(now);
const firstCount = (db.prepare('SELECT COUNT(*) AS n FROM busquedas WHERE route_id = ?').get(routeId) as { n: number }).n;
sembrarBusquedasDemo(now);
const secondCount = (db.prepare('SELECT COUNT(*) AS n FROM busquedas WHERE route_id = ?').get(routeId) as { n: number }).n;
sembrarBusquedasDemo(now + 60 * 60_000);
const nextHourRows = (db.prepare('SELECT COUNT(*) AS n FROM busquedas WHERE route_id = ? AND hora > ?').get(routeId, now) as { n: number }).n;
const thirdCount = (db.prepare('SELECT COUNT(*) AS n FROM busquedas WHERE route_id = ?').get(routeId) as { n: number }).n;
db.prepare("UPDATE demo_seed_meta SET version = 'old' WHERE name = 'busquedas'").run();
sembrarBusquedasDemo(now);
const sentinel = (db.prepare("SELECT count FROM busquedas WHERE route_id = 'R-AJENA'").get() as { count: number }).count;
const realCount = (db.prepare("SELECT count FROM busquedas WHERE route_id = 'R-777'").get() as { count: number }).count;
const rutasJson = JSON.parse(readFileSync(join(__dirname, '..', '..', 'scripts', 'data', 'rutas.json'), 'utf8')) as { rutas: Array<{ routeId: string; waypoints: Array<{ lat: number; lon: number }> }> };
const geometry = rutasJson.rutas.find(route => route.routeId === routeId)!;
const metros = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => Math.hypot((a.lat-b.lat)*111320, (a.lon-b.lon)*111320*Math.cos(11*Math.PI/180));
const geometries = rutasJson.rutas.filter(route => ['R-101','R-102','R-103','R-104','R-105','R-106','R-107','R-109','R-110'].includes(route.routeId));
// Distancia a los tramos, no a los vértices: en una recta larga los
// vértices quedan a cientos de metros y la celda sí está sobre la calle.
const aTramo = (p: { lat: number; lon: number }, a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const k = Math.cos(11 * Math.PI / 180), ax = (a.lon - p.lon) * k, ay = a.lat - p.lat, bx = (b.lon - p.lon) * k, by = b.lat - p.lat;
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(ax + t * dx, ay + t * dy) * 111320;
};
const aRuta = (p: { lat: number; lon: number }, route: { waypoints: Array<{ lat: number; lon: number }> }) =>
  Math.min(...route.waypoints.slice(1).map((b, i) => aTramo(p, route.waypoints[i], b)));
const rawRows = db.prepare('SELECT route_id, celda_lat AS lat, celda_lng AS lon, SUM(count) AS count FROM busquedas WHERE celda_lat IS NOT NULL AND hora >= ? AND hora < ? AND route_id IN (SELECT route_id FROM company_routes WHERE company_id IN (\'EMP-01\',\'EMP-03\')) GROUP BY route_id, celda_lat, celda_lng HAVING SUM(count) >= ?').all(now - 30 * 86400000, now + 1, K_BUSQUEDAS) as Array<{ route_id: string; lat: number; lon: number; count: number }>;
const rawOffRoute = rawRows.filter(row => { const route = rutasJson.rutas.find(item => item.routeId === row.route_id); return route && aRuta(row, route) > 400 && aRuta(row, route) <= 3000; }).length;
const offRouteVisible = rawOffRoute;
const beyondLimit = rawRows.filter(row => { const route = rutasJson.rutas.find(item => item.routeId === row.route_id); return route && Math.min(...route.waypoints.map(point => metros(row, point))) > 3000; }).length;
const limits = db.prepare('SELECT MIN(hora) AS min, MAX(hora) AS max FROM busquedas WHERE route_id IN (SELECT route_id FROM company_routes WHERE company_id IN (\'EMP-01\',\'EMP-03\'))').get() as { min: number; max: number };
const maxHour = limits.max;
const allDemo = rankingBusquedas('EMP-01', now - 30 * 86400000, now + 1);
const peaksByCompany = ['EMP-01', 'EMP-03'].map(companyId => [...new Set(rankingBusquedas(companyId, now - 30 * 86400000, now + 1).map(route => route.horaPico).filter(hour => hour !== null))].length);
const addedRows = thirdCount - secondCount;
const daily = db.prepare('SELECT date(hora / 1000, \'unixepoch\', \'-5 hours\') AS day, SUM(count) AS n FROM busquedas WHERE route_id = ? AND hora >= ? AND hora < ? GROUP BY day').all(routeId, now - 40 * 86400000, now) as Array<{ day: string; n: number }>;
const localMidnight = Date.UTC(2026, 9, 26, 5);
const todayRank = rankingBusquedas('EMP-01', localMidnight, now + 1)[0];
const visiblePeak = todayRank?.horaPico === null ? 0 : calorBusquedas('EMP-01', todayRank.routeId, localMidnight, now + 1, todayRank.horaPico ?? undefined)?.length ?? 0;
const monthRank = rankingBusquedas('EMP-01', now - 30 * 86400000, now + 1)[0];
const visibleHours = Array.from({ length: 16 }, (_, i) => calorBusquedas('EMP-01', monthRank.routeId, now - 30 * 86400000, now + 1, i + 6)?.length ?? 0);
const peakCells = db.prepare("SELECT COUNT(*) AS n, MAX(count) AS max FROM busquedas WHERE route_id = ? AND hora = ?").get(todayRank.routeId, localMidnight + todayRank.horaPico! * 3600000) as { n: number; max: number };
const totals = db.prepare("SELECT route_id AS routeId, SUM(count) AS total FROM busquedas WHERE route_id IN (SELECT route_id FROM company_routes WHERE company_id IN ('EMP-01','EMP-03')) GROUP BY route_id").all() as Array<{ routeId: string; total: number }>;
const visibleDistances = geometries.flatMap(route => {
  const companyId = ['R-107','R-109','R-110'].includes(route.routeId) ? 'EMP-03' : 'EMP-01';
  return (calorBusquedas(companyId, route.routeId, now - 30 * 86400000, now + 1) ?? []).map(cell =>
    aRuta({ lat: cell.lat, lon: cell.lng }, route));
});
const maxVisibleDistance = Math.max(...visibleDistances);
const fueraDeCalle = visibleDistances.filter(d => d > 110).length / visibleDistances.length;
const monthCells = calorBusquedas('EMP-01', monthRank.routeId, now - 30 * 86400000, now + 1) ?? [];
const monthGeometry = rutasJson.rutas.find(route => route.routeId === monthRank.routeId)!;
const tramos = monthGeometry.waypoints.filter((_, i) => i % 10 === 0);
const tramosConCalor = tramos.filter(point => monthCells.some(cell => metros({ lat: cell.lat, lon: cell.lng }, point) <= 250)).length / tramos.length;
const maxMes = Math.max(...monthCells.map(cell => cell.count));
const celdasCalientes = monthCells.filter(cell => cell.count >= maxMes / 4).length / monthCells.length;
const semanaCells = calorBusquedas('EMP-01', monthRank.routeId, now - 7 * 86400000, now + 1) ?? [];
const reparto = (cells: Array<{ lat: number; lng: number; count: number }>) => {
  const total = cells.reduce((sum, cell) => sum + cell.count, 0);
  return new Map(cells.map(cell => [`${cell.lat},${cell.lng}`, cell.count / total]));
};
const mes = reparto(monthCells), semana = reparto(semanaCells);
// Distancia de variación total: la mitad de lo que difieren los repartos.
const semanaContraMes = [...new Set([...mes.keys(), ...semana.keys()])]
  .reduce((sum, k) => sum + Math.abs((mes.get(k) ?? 0) - (semana.get(k) ?? 0)), 0) / 2;
const formas = ['EMP-01', 'EMP-03'].flatMap(companyId => rankingBusquedas(companyId, now - 30 * 86400000, now + 1)
  .map(route => ({ routeId: route.routeId, horaPico: route.horaPico, porHora: route.porHora })));
// Manchas lejos de la ruta (dueño, 2026-10-27): solo sobre la calle de otra
// ruta, nunca en el agua ni en un potrero. A cada una se le mide la calle más
// cercana de todas las rutas y la distancia a la suya.
const visiblesLejos = geometries.flatMap(route => {
  const companyId = ['R-107','R-109','R-110'].includes(route.routeId) ? 'EMP-03' : 'EMP-01';
  return (calorBusquedas(companyId, route.routeId, now - 30 * 86400000, now + 1) ?? [])
    .map(cell => ({ routeId: route.routeId, p: { lat: cell.lat, lon: cell.lng } }))
    .filter(({ p }) => aRuta(p, route) > 400)
    .map(({ routeId, p }) => ({ routeId, aSuya: aRuta(p, route), aCalle: Math.min(...rutasJson.rutas.map(r => aRuta(p, r))) }));
});
const lejosSinCalle = visiblesLejos.filter(c => c.aCalle > 110).length;
const rutasConManchas = new Set(visiblesLejos.map(c => c.routeId)).size;
const lejosMin = Math.min(...visiblesLejos.map(c => c.aSuya)), lejosMax = Math.max(...visiblesLejos.map(c => c.aSuya));
// Las zonas más calientes cambian de una semana a otra (dueño, 2026-10-27:
// siempre salían las mismas 5): de las 5 celdas más calientes de cada semana,
// la parte que queda a más de 500 m de las 5 de la semana anterior.
const top5 = (desde: number) => (calorBusquedas('EMP-01', monthRank.routeId, desde, desde + 7 * 86400000) ?? [])
  .sort((a, b) => b.count - a.count).slice(0, 5).map(cell => ({ lat: cell.lat, lon: cell.lng }));
const semanas = [4, 3, 2, 1].map(k => top5(now + 1 - k * 7 * 86400000));
const zonasNuevas = semanas.slice(1).map((sem, i) =>
  sem.filter(p => semanas[i].every(q => metros(p, q) > 500)).length / Math.max(1, sem.length));
const output = { formas, lejosSinCalle, rutasConManchas, lejosMin, lejosMax, zonasNuevas, semanaContraMes, celdasCalientes, fueraDeCalle, maxVisibleDistance, tramosConCalor, firstCount, secondCount, thirdCount, sentinel, realCount, daily, visiblePeak, peakCells, todayRank, localMidnight, visibleHours, offRouteVisible, rawOffRoute, beyondLimit, maxHour, peaksByCompany, addedRows, nextHourRows, minHour: limits.min, threshold: K_BUSQUEDAS, totals };
closeDb();
process.stdout.write(JSON.stringify(output));
