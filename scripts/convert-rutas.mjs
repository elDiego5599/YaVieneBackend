/**
 * Convertidor de rutas (KMZ de Sobusa y de Coolitoral → rutas.json)
 *
 * Lee los recorridos reales —KMZ de Google Earth que mandó cada empresa— y
 * genera el archivo `rutas.json` que usan el mapa del pasajero y el
 * simulador.
 *
 * Uso:
 *   node scripts/convert-rutas.mjs                # lee ~/Desktop/rutasSobusa y ~/Desktop/rutasCoolitoral
 *   node scripts/convert-rutas.mjs --kmz=/ruta    # carpeta custom de los KMZ de Sobusa
 *   node scripts/convert-rutas.mjs --coolitoral=/ruta  # carpeta custom de los KMZ de Coolitoral
 *   node scripts/convert-rutas.mjs --dry-run      # solo imprime estadísticas
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_KMZ_DIR = join(homedir(), 'Desktop', 'rutasSobusa');
const args = process.argv.slice(2);
const DEFAULT_COOLITORAL_DIR = join(homedir(), 'Desktop', 'rutasCoolitoral');
const kmzDir = args.find((a) => a.startsWith('--kmz='))?.slice(6) ?? DEFAULT_KMZ_DIR;
const coolitoralDir = args.find((a) => a.startsWith('--coolitoral='))?.slice(13) ?? DEFAULT_COOLITORAL_DIR;
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
// nombres. Los KMZ los mandó Coolitoral (2026-10-05) y reemplazan a los GPX
// de mapstogpx y a las líneas de Google calzadas sobre OSRM/OSM. Cada uno es
// un circuito cerrado que sale y vuelve a la Calle 17 en Sur Oriente: A1 de
// 41,6 km hasta Sabanilla Montecarmelo, A3 de 23,3 y A4 de 24,1 km. A2
// (A2-4107) no entra: el 85 % de sus puntos cae a menos de 60 m de A1, y el
// dueño la quitó el 2026-10-05 (R-108, migración 28).
const COOLITORAL_MAP = [
  {
    file: 'A1-4106',
    routeId: 'R-107',
    name: 'A1 Silencio Universidades',
    terminalA: 'Silencio, Nogales',
    terminalB: 'Universidades, Vía 40',
  },
  {
    file: 'A3-4108',
    routeId: 'R-109',
    name: 'A3 Carrera 43 Peñita',
    terminalA: 'Carrera 43',
    terminalB: 'La Peñita',
  },
  {
    file: 'A4-4109',
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

function decimate(points, minSpacingM, maxPoints) {
  if (points.length <= maxPoints && points.length <= 1) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const last = out[out.length - 1];
    if (haversineMeters(last, points[i]) >= minSpacingM) out.push(points[i]);
  }
  if (out.length < 2) out.push(points[points.length - 1]);
  if (out.length > maxPoints) {
    const stride = Math.ceil(out.length / maxPoints);
    return out.filter((_, i) => i % stride === 0);
  }
  return out;
}

function routeLengthKm(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineMeters(points[i - 1], points[i]);
  return (total / 1000).toFixed(1);
}

const fuentes = [
  ...ROUTE_MAP.map((entry) => ({ entry, dir: kmzDir })),
  ...COOLITORAL_MAP.map((entry) => ({ entry, dir: coolitoralDir })),
];

const results = [];
for (const { entry, dir } of fuentes) {
  const raw = parseKml(execFileSync('unzip', ['-p', join(dir, `${entry.file}.kmz`), 'doc.kml'], { encoding: 'utf8' }));
  const waypoints = decimate(raw, MIN_SPACING_M, MAX_POINTS);
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
