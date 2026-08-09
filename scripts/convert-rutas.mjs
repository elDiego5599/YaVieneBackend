/**
 * Convertidor de rutas Sobusa (KMZ → rutas.json)
 *
 * Lee los recorridos reales en KMZ (Google Earth) y genera el archivo
 * `rutas.json` que usan el mapa del pasajero y el simulador.
 *
 * Uso:
 *   node scripts/convert-rutas.mjs                # lee ~/Desktop/rutasSobusa
 *   node scripts/convert-rutas.mjs --kmz=/ruta    # carpeta custom
 *   node scripts/convert-rutas.mjs --dry-run      # solo imprime estadísticas
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_KMZ_DIR = join(homedir(), 'Desktop', 'rutasSobusa');
const args = process.argv.slice(2);
const kmzDir = args.find((a) => a.startsWith('--kmz='))?.slice(6) ?? DEFAULT_KMZ_DIR;
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

const results = [];
for (const entry of ROUTE_MAP) {
  const kmz = join(kmzDir, `${entry.file}.kmz`);
  const kml = execFileSync('unzip', ['-p', kmz, 'doc.kml'], { encoding: 'utf8' });
  const raw = parseKml(kml);
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
    `  ${entry.file.padEnd(10)} → ${entry.routeId}  ${String(waypoints.length).padStart(4)} pts  ${lengthKm.padStart(6)} km`
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
