import { closeDb, getDb } from '../../src/data/database';
import { calorBusquedas, K_BUSQUEDAS, rankingBusquedas } from '../../src/data/busquedas';
import { sembrarBusquedasDemo } from '../../src/demo/busquedas_demo';

const db = getDb();
if (process.env.REAL_ROUTE) {
  db.exec('DELETE FROM busquedas');
  db.prepare(`INSERT INTO busquedas(route_id, hora, celda_key, celda_lat, celda_lng, count)
    VALUES (?, ?, 'real', 10.98, -74.78, 17)`).run(process.env.REAL_ROUTE, Number(process.env.SEED_NOW));
}
const now = Number(process.env.SEED_NOW);
sembrarBusquedasDemo(now);
const desde = now - 30 * 24 * 60 * 60_000;
const rutas = db.prepare("SELECT route_id FROM company_routes WHERE company_id IN ('EMP-01','EMP-03') ORDER BY route_id").all() as { route_id: string }[];
const seeded = rutas.map(({ route_id }) => ({
  routeId: route_id,
  heat: calorBusquedas(route_id.startsWith('R-10') && Number(route_id.slice(2)) >= 107 ? 'EMP-03' : 'EMP-01', route_id, desde, now + 1),
}));
const salida = {
  seeded,
  ranking: rankingBusquedas('EMP-01', desde, now + 1).map(({ routeId, total }) => ({ routeId, total })),
  counts: Object.fromEntries(rutas.map(({ route_id }) => [route_id,
    (db.prepare('SELECT COUNT(*) AS n FROM busquedas WHERE route_id = ?').get(route_id) as { n: number }).n])),
  totals: Object.fromEntries(rutas.map(({ route_id }) => [route_id,
    (db.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM busquedas WHERE route_id = ?').get(route_id) as { n: number }).n])),
  activeHours: Object.fromEntries(rutas.map(({ route_id }) => [route_id,
    (db.prepare("SELECT COUNT(DISTINCT strftime('%H', datetime(hora / 1000, 'unixepoch', '-5 hours'))) AS n FROM busquedas WHERE route_id = ?").get(route_id) as { n: number }).n])),
};
closeDb();
process.stdout.write(JSON.stringify(salida));

