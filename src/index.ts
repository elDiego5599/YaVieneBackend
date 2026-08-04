import http from 'http';
import { HTTP_PORT, BUS_TIMEOUT_MS } from './config';
import { startBroker } from './mqtt/broker';
import { setupSocketServer, broadcastBusPosition, broadcastBusLeft } from './socket/handler';
import { handleAPI } from './api/routes';
import { upsertPosition, getDriver, getPosition, removePosition, sweepPositions } from './data/buses';
import { TokenPayload } from './auth/tokens';

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
  (_clientId: string, auth: TokenPayload, topic, payload) => {
  const match = topic.match(/^empresa\/[^/]+\/bus\/([^/]+)\/posicion$/);
  if (!match) {
    console.warn(`[MQTT] Topic rejected after authorization: ${topic}`);
    return;
  }

  const topicBusId = match[1];
  if (topicBusId !== auth.busId) {
    console.warn(`[MQTT] Topic bus mismatch for authenticated driver ${auth.driverId}`);
    return;
  }

  const driver = getDriver(auth.phoneNumber);

  if (
    !driver ||
    driver.driverId !== auth.driverId ||
    driver.companyId !== auth.companyId ||
    driver.busId !== auth.busId ||
    driver.routeId !== auth.routeId
  ) {
    console.warn(`[MQTT] Stale or unauthorized driver assignment: ${auth.driverId}`);
    return;
  }

  const lat = payload.lat as number;
  const lon = payload.lon as number;
  const speedKmh = payload.speedKmh as number | undefined;

  // ── Candado 3: Rechazar posiciones físicamente imposibles ──────
  if (!sanityCheck(auth.busId, lat, lon, speedKmh ?? 0)) {
    return;
  }

  const updated = upsertPosition(auth.phoneNumber, {
    busId: auth.busId,
    routeId: auth.routeId,
    lat,
    lon,
    heading: payload.heading as number | undefined,
    speedKmh: speedKmh,
  });

  if (updated) broadcastBusPosition(updated);
},
  (_clientId: string, auth: TokenPayload) => {
    const driver = getDriver(auth.phoneNumber);
    if (!driver || driver.driverId !== auth.driverId) return;
    const removed = removePosition(auth.busId);
    if (!removed || removed.driverPhone !== auth.phoneNumber) return;
    broadcastBusLeft(auth.busId, removed.routeId);
    console.log(`[MQTT] Bus ${auth.busId} removido por desconexión del conductor ${auth.phoneNumber}`);
  }
);

server.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`[HTTP] Server listening on http://0.0.0.0:${HTTP_PORT}`);
});

process.on('SIGTERM', () => {
  console.log('[Server] Shutting down...');
  process.exit(0);
});
