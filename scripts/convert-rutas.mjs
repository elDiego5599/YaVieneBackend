/**
 * Convertidor de rutas (KMZ de Sobusa + GPX de Coolitoral → rutas.json)
 *
 * Lee los recorridos reales —KMZ de Google Earth para Sobusa, GPX de
 * mapstogpx para Coolitoral— y genera el archivo `rutas.json` que usan el
 * mapa del pasajero y el simulador.
 *
 * Uso:
 *   node scripts/convert-rutas.mjs                # lee ~/Desktop/rutasSobusa y ~/Desktop/rutasCoolitoral
 *   node scripts/convert-rutas.mjs --kmz=/ruta    # carpeta custom de los KMZ
 *   node scripts/convert-rutas.mjs --gpx=/ruta    # carpeta custom de los GPX
 *   node scripts/convert-rutas.mjs --dry-run      # solo imprime estadísticas
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_KMZ_DIR = join(homedir(), 'Desktop', 'rutasSobusa');
const args = process.argv.slice(2);
const DEFAULT_GPX_DIR = join(homedir(), 'Desktop', 'rutasCoolitoral');
const kmzDir = args.find((a) => a.startsWith('--kmz='))?.slice(6) ?? DEFAULT_KMZ_DIR;
const gpxDir = args.find((a) => a.startsWith('--gpx='))?.slice(6) ?? DEFAULT_GPX_DIR;
const dryRun = args.includes('--dry-run');

// Mapeo archivo KMZ → ruta en el sistema (los IDs R-101..R-106 ya están en la
// base con los nombres originales de Sobusa; aquí van los códigos de servicio).
const ROUTE_MAP = [
  {
    file: 'B18-4175',
    routeId: 'R-101',
    name: 'B18 Tcherassi',
    terminalA: 'Ciudad Mallorquín',
    terminalB: 'La Playa',
  },
  {
    file: 'C11-4168',
    routeId: 'R-102',
    name: 'C11 Silencio',
    terminalA: 'Nevada',
    terminalB: 'El Silencio',
  },
  {
    file: 'C12-4169',
    routeId: 'R-103',
    name: 'C12 Vivero Paraíso',
    terminalA: 'Vía 40',
    terminalB: 'Paraíso',
  },
  {
    file: 'C13-4143',
    routeId: 'R-104',
    name: 'C13 Carrera 50 Paraíso',
    terminalA: 'Nevada (Soledad)',
    terminalB: 'Calle 76 (Vía 40)',
  },
  {
    file: 'C14-4170',
    routeId: 'R-105',
    name: 'C14 Carrera 54 Uninorte',
    terminalA: 'Granabastos',
    terminalB: 'Uninorte',
  },
  {
    file: 'C16-4167',
    routeId: 'R-106',
    name: 'C16 Calle 72 Uninorte',
    terminalA: 'Granabastos',
    terminalB: 'Uninorte',
  },
];

// Coolitoral (EMP-03), sembrada por la migración 27 con estos mismos
// nombres. Los terminales salen del nombre de cada archivo. A2 (R-108) se
// quitó el 2026-10-05 (dueño, migración 28): era el mismo recorrido que A1.
//
// A1 ya no sale de mapstogpx: sale de los ocho hitos del mapa de Google que
// mandó Coolitoral, en su orden (los `<wpt>` del archivo), con la geometría
// de calle a calle que devuelve OSRM en modo `driving`
// (router.project-osrm.org, 2026-10-05). Para que siga las mismas calles
// que la línea de Google, la consulta lleva puntos de paso tomados de esa
// línea; donde OSM marca una calle en contravía (el enlace de la Vía 40 al
// río y la Calle 8), OSRM toma la paralela. Es un circuito de 41 km
// (Google: 40,5) que sale de la Calle 17 en Sur Oriente, va al oeste hasta
// Sabanilla Montecarmelo, vuelve por Uninorte y la Vía 40 y baja por la
// orilla del río.
//
// A3 tampoco sale de mapstogpx: sale de los diez hitos de su mapa de Google
// (los `<wpt>`), con la línea azul de Google calzada calle a calle sobre
// OpenStreetMap (2026-10-05). OSRM no servía aquí: donde OSM marca en
// contravía calles que Google sí recorre, daba vueltas que el bus no da.
// El calce sigue la línea de Google y no los sentidos de OSM. Son 21,1 km
// (Google: 21,8): de la Calle 17 en Sur Oriente sube por la Carrera 43
// hasta Ciudad Jardín y Riomar, vuelve por la Calle 75, El Prado y la
// Carrera 44, y baja por el oriente hasta Coolitoral.
const GPX_MAP = [
  {
    file: 'rutaA1-GOOGLE-OSRM',
    routeId: 'R-107',
    name: 'A1 Silencio Universidades',
    terminalA: 'Silencio, Nogales',
    terminalB: 'Universidades, Vía 40',
  },
  {
    file: 'rutaA3-GOOGLE-OSM',
    routeId: 'R-109',
    name: 'A3 Carrera 43 Peñita',
    terminalA: 'Carrera 43',
    terminalB: 'La Peñita',
  },
  {
    file: 'rutaA4CRA50',
    routeId: 'R-110',
    name: 'A4 Carrera 50',
    terminalA: 'Calle 17',
    terminalB: 'Carrera 50',
  },
];

// Decimación por distancia mínima (metros) + tope de puntos.
const MIN_SPACING_M = 80;
const MAX_POINTS = 500;

function haversineMeters(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function parseKml(kml) {
  const m = kml.match(/<coordinates>([\s\S]*?)<\/coordinates>/);
  if (!m) throw new Error('No hay <coordinates> en el KML');
  const coords = m[1]
    .trim()
    .split(/\s+/)
    .map((triple) => triple.split(','))
    .filter((c) => c.length >= 2)
    .map((c) => ({ lat: parseFloat(c[1]), lon: parseFloat(c[0]) }))
    .filter((p) => !Number.isNaN(p.lat) && !Number.isNaN(p.lon));
  if (coords.length < 2) throw new Error('Coordenadas vacías');
  return coords;
}

function parseHitos(gpx) {
  return [...gpx.matchAll(/<wpt\s+lat="([-\d.]+)"\s+lon="([-\d.]+)"/g)]
    .map((m) => ({ lat: parseFloat(m[1]), lon: parseFloat(m[2]) }))
    .filter((p) => !Number.isNaN(p.lat) && !Number.isNaN(p.lon));
}

function parseGpx(gpx) {
  const coords = [...gpx.matchAll(/<trkpt\s+lat="([-\d.]+)"\s+lon="([-\d.]+)"/g)]
    .map((m) => ({ lat: parseFloat(m[1]), lon: parseFloat(m[2]) }))
    .filter((p) => !Number.isNaN(p.lat) && !Number.isNaN(p.lon));
  if (coords.length < 2) throw new Error('Sin <trkpt> en el GPX');
  return coords;
}

// Los hitos de un GPX (`<wpt>`) no se pierden al diezmar: se queda el punto
// del trazado más cercano a cada uno. Sin esto, con un punto cada 80 m, A3
// pasaba a 59 m del hito de la Carrera 38 y el más cercano que quedaba
// estaba a 117 (2026-10-05).
function puntosAncla(points, hitos) {
  return new Set(hitos.map((h) => {
    let mejor = points[0];
    for (const p of points) if (haversineMeters(h, p) < haversineMeters(h, mejor)) mejor = p;
    return mejor;
  }));
}

function decimate(points, minSpacingM, maxPoints, anclas = new Set()) {
  if (points.length <= maxPoints && points.length <= 1) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const last = out[out.length - 1];
    if (anclas.has(points[i]) || haversineMeters(last, points[i]) >= minSpacingM) out.push(points[i]);
  }
  if (out.length < 2) out.push(points[points.length - 1]);
  if (out.length > maxPoints) {
    const stride = Math.ceil(out.length / maxPoints);
    return out.filter((p, i) => i % stride === 0 || anclas.has(p));
  }
  return out;
}

function routeLengthKm(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineMeters(points[i - 1], points[i]);
  return (total / 1000).toFixed(1);
}

const fuentes = [
  ...ROUTE_MAP.map((entry) => ({
    entry,
    leer: () => ({
      raw: parseKml(execFileSync('unzip', ['-p', join(kmzDir, `${entry.file}.kmz`), 'doc.kml'], { encoding: 'utf8' })),
      hitos: [],
    }),
  })),
  ...GPX_MAP.map((entry) => ({
    entry,
    leer: () => {
      const gpx = readFileSync(join(gpxDir, `${entry.file}.gpx`), 'utf8');
      return { raw: parseGpx(gpx), hitos: parseHitos(gpx) };
    },
  })),
];

const results = [];
for (const { entry, leer } of fuentes) {
  const { raw, hitos } = leer();
  const waypoints = decimate(raw, MIN_SPACING_M, MAX_POINTS, puntosAncla(raw, hitos));
  const lengthKm = routeLengthKm(raw);
  results.push({
    routeId: entry.routeId,
    name: entry.name,
    terminalA: entry.terminalA,
    terminalB: entry.terminalB,
    lengthKm: parseFloat(lengthKm),
    waypoints,
    paradas: [], // la mayoría de buses en Barranquilla no tienen paradas fijas
  });
  console.log(
    `  ${entry.file.slice(0, 40).padEnd(40)} → ${entry.routeId}  ${String(waypoints.length).padStart(4)} pts  ${lengthKm.padStart(6)} km`
  );
}

const payload = { generado: new Date().toISOString(), rutas: results };
if (dryRun) {
  console.log(`\n[dry-run] ${results.length} rutas, sin escribir archivos.`);
  process.exit(0);
}

const appTarget = join(ROOT, '..', 'YaViene', 'app_pasajero', 'assets', 'data', 'rutas.json');
const simTarget = join(ROOT, 'scripts', 'data', 'rutas.json');
for (const target of [appTarget, simTarget]) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(payload, null, 2));
  console.log(`  ✓ ${target}`);
}
console.log('\nListo. Recompila la app del pasajero para incluir el asset.');
