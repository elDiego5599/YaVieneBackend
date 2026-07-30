import http from 'http';
import { HTTP_PORT, BUS_TIMEOUT_MS } from './config';
import { startBroker } from './mqtt/broker';
import { setupSocketServer, broadcastBusPosition, broadcastBusLeft } from './socket/handler';
import { handleAPI } from './api/routes';
import { upsertPosition, getDriver, getPosition, removePosition, sweepPositions } from './data/buses';

// ── Candado 3: Sanity check de física imposible ─────────────────────
const MAX_SPEED_KMH = 120;
const EARTH_RADIUS_KM = 6371;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

function sanityCheck(busId: string, lat: number, lon: number, speedKmh: number): boolean {
  const previous = getPosition(busId);
  if (!previous) return true; // first position, cannot check

  const elapsedSec = (Date.now() - new Date(previous.timestamp).getTime()) / 1000;
  if (elapsedSec <= 0) return true;

  const distanceKm = haversineDistanceKm(previous.lat, previous.lon, lat, lon);
  const calculatedSpeedKmh = (distanceKm / elapsedSec) * 3600;

  if (calculatedSpeedKmh > MAX_SPEED_KMH) {
    console.warn(
      `[SANITY] REJECTED: bus ${busId} moviéndose a ${calculatedSpeedKmh.toFixed(1)} km/h ` +
      `(${distanceKm.toFixed(3)} km en ${elapsedSec.toFixed(1)}s) — máximo ${MAX_SPEED_KMH} km/h`
    );
    return false;
  }

  if (speedKmh > MAX_SPEED_KMH) {
    console.warn(
      `[SANITY] REJECTED: bus ${busId} reporta speedKmh=${speedKmh} — máximo ${MAX_SPEED_KMH} km/h`
    );
    return false;
  }

  return true;
}
// ─────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!handleAPI(req, res)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

setupSocketServer(server);

// ── Sweep de ciclo de vida de buses (cada 10s) ──────────────────────
const GHOST_MS = 30_000;
const REMOVE_MS = 60_000;

setInterval(() => {
  const { toGhost, toRemove } = sweepPositions(GHOST_MS, REMOVE_MS);

  for (const bus of toGhost) {
    broadcastBusPosition(bus);
    console.log(`[SWEEP] Bus ${bus.busId} marcado como ghost (>${GHOST_MS / 1000}s)`);
  }

  for (const { busId, routeId } of toRemove) {
    broadcastBusLeft(busId, routeId);
    console.log(`[SWEEP] Bus ${busId} removido del mapa (>${REMOVE_MS / 1000}s)`);
  }
}, 10_000);

startBroker(
  (clientId, topic, payload) => {
  const isNewFormat = topic.startsWith('empresa/');
  let driverPhone: string | null = null;

  if (isNewFormat) {
    const parts = topic.split('/');
    const busId = parts[3];
    driverPhone = payload.phoneNumber as string;
    payload.busId = busId;
  } else {
    const parts = topic.split('/');
    driverPhone = parts[1];
  }

  if (!driverPhone) {
    console.warn(`[MQTT] No phoneNumber in topic: ${topic}`);
    return;
  }

  const driver = getDriver(driverPhone);

  if (!driver) {
    console.warn(`[MQTT] Unknown driver: ${driverPhone}`);
    return;
  }

  const busId = (payload.busId as string) || `BUS-${driverPhone.slice(-4)}`;
  const lat = payload.lat as number;
  const lon = payload.lon as number;
  const speedKmh = payload.speedKmh as number | undefined;

  // ── Candado 3: Rechazar posiciones físicamente imposibles ──────
  if (!sanityCheck(busId, lat, lon, speedKmh ?? 0)) {
    return;
  }

  const updated = upsertPosition(driverPhone, {
    busId,
    routeId: driver.routeId,
    lat,
    lon,
    heading: payload.heading as number | undefined,
    speedKmh: speedKmh,
  });

  if (updated) broadcastBusPosition(updated);
},
  (phoneNumber, busId) => {
    const driver = getDriver(phoneNumber);
    if (!driver) return;
    removePosition(busId);
    broadcastBusLeft(busId, driver.routeId);
    console.log(`[MQTT] Bus ${busId} removido por desconexión del conductor ${phoneNumber}`);
  }
);

server.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`[HTTP] Server listening on http://0.0.0.0:${HTTP_PORT}`);
});

process.on('SIGTERM', () => {
  console.log('[Server] Shutting down...');
  process.exit(0);
});
