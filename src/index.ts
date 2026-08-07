import http from 'http';
import https from 'https';
import fs from 'fs';
import {
  HTTP_PORT,
  HTTP_TLS_CERT_PATH,
  HTTP_TLS_KEY_PATH,
  BUS_TIMEOUT_MS,
} from './config';
import { closeBroker, PositionHandlingResult, startBroker } from './mqtt/broker';
import { handleAPI } from './api/routes';
import {
  getPositionValidationState,
  BusPosition,
  removePositionOwned,
  sweepPositions,
  upsertPosition,
  getBusVisibility,
  loadBusCompanyCache,
  loadVisibilityCache,
} from './data/buses';
import { closeDb } from './data/database';
import { cleanupRevokedSessions } from './data/sessions';
import { dispatchLifecycleEvents, LifecycleEvent } from './data/lifecycle_events';
import { DriverTokenPayload } from './auth/tokens';
import {
  setupSocketServer,
  broadcastBusPosition,
  broadcastBusLeft,
  broadcastBusRemoved,
  broadcastBusHidden,
  broadcastBusVisible,
  getIO,
} from './socket/handler';

// ── Candado 3: Sanity check de física imposible ─────────────────────
const MAX_SPEED_KMH = 120;
const EARTH_RADIUS_KM = 6371;
const MAX_CAPTURE_CLOCK_SKEW_MS = 30_000;
// Ventana de reloj en el pasado: permite reenvío de buffers offline (túneles
// sin señal, hasta 15 min), pero rechaza relojes manipulados más atrás.
const MAX_PAST_CAPTURE_MS = 15 * 60 * 1000;

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

interface SanityResult {
  accepted: boolean;
  reason?: string;
}

function sanityCheck(
  busId: string,
  sessionId: string,
  previous: ReturnType<typeof getPositionValidationState>,
  lat: number,
  lon: number,
  speedKmh: number,
  capturedAt: number,
): SanityResult {
  if (capturedAt > Date.now() + MAX_CAPTURE_CLOCK_SKEW_MS) {
    return { accepted: false, reason: 'FUTURE_CAPTURE_TIME' };
  }

  if (capturedAt < Date.now() - MAX_PAST_CAPTURE_MS) {
    console.warn(`[SANITY] REJECTED: bus ${busId} con reloj ${((Date.now() - capturedAt) / 60000).toFixed(1)} min en el pasado`);
    return { accepted: false, reason: 'CLOCK_DRIFT_EXCEEDED' };
  }

  if (!Number.isFinite(speedKmh) || speedKmh < 0 || speedKmh > MAX_SPEED_KMH) {
    console.warn(`[SANITY] REJECTED: bus ${busId} reporta speedKmh=${speedKmh}`);
    return { accepted: false, reason: 'INVALID_REPORTED_SPEED' };
  }

  if (!previous || previous.sessionId !== sessionId) {
    return { accepted: true };
  }

  if (capturedAt <= previous.capturedAt) {
    return { accepted: false, reason: 'OUT_OF_ORDER_CAPTURE' };
  }

  const elapsedSec = (capturedAt - previous.capturedAt) / 1000;
  if (elapsedSec <= 0) {
    return { accepted: false, reason: 'NO_CAPTURE_TIME_DELTA' };
  }

  const distanceKm = haversineDistanceKm(previous.lat, previous.lon, lat, lon);
  const calculatedSpeedKmh = (distanceKm / elapsedSec) * 3600;

  if (calculatedSpeedKmh > MAX_SPEED_KMH) {
    console.warn(
      `[SANITY] REJECTED: bus ${busId} moviéndose a ${calculatedSpeedKmh.toFixed(1)} km/h ` +
      `(${distanceKm.toFixed(3)} km en ${elapsedSec.toFixed(1)}s) — máximo ${MAX_SPEED_KMH} km/h`
    );
    return { accepted: false, reason: 'SANITY_REJECTED' };
  }

  return { accepted: true };
}
// ─────────────────────────────────────────────────────────────────────

const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => {
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
};

const server = HTTP_TLS_CERT_PATH && HTTP_TLS_KEY_PATH
  ? https.createServer({
      cert: fs.readFileSync(HTTP_TLS_CERT_PATH),
      key: fs.readFileSync(HTTP_TLS_KEY_PATH),
    }, requestHandler)
  : http.createServer(requestHandler);

setupSocketServer(server);

// ── Sweep de ciclo de vida de buses (cada 10s) ──────────────────────
const GHOST_MS = 30_000;
const REMOVE_MS = 60_000;

function emitLifecycleEvent(event: LifecycleEvent): void {
  if (event.eventType === 'bus:removed') {
    broadcastBusRemoved(
      event.payload.busId as string,
      event.routeId,
      event.eventId,
    );
    return;
  }

  if (event.eventType === 'bus:left') {
    broadcastBusLeft(
      event.payload.busId as string,
      event.routeId,
      event.eventId,
    );
    return;
  }

  if (event.eventType === 'bus:hidden') {
    broadcastBusHidden(
      event.payload.busId as string,
      event.routeId,
      event.eventId,
    );
    return;
  }

  if (event.eventType === 'bus:visible') {
    const payload = event.payload as { busId: string; position?: BusPosition };
    broadcastBusVisible(
      payload.busId,
      event.routeId,
      event.eventId,
      payload.position,
    );
    return;
  }

  if (!getBusVisibility(event.payload.busId as string)) return;

  broadcastBusPosition({
    ...(event.payload as unknown as BusPosition),
    eventId: event.eventId,
  }, true);
}

const sweepTimer = setInterval(() => {
  sweepPositions(GHOST_MS, REMOVE_MS);
  dispatchLifecycleEvents(emitLifecycleEvent);
}, 10_000);
sweepTimer.unref();
const lifecycleDispatchTimer = setInterval(() => {
  dispatchLifecycleEvents(emitLifecycleEvent);
}, 250);
lifecycleDispatchTimer.unref();
const sessionCleanupTimer = setInterval(() => {
  cleanupRevokedSessions();
}, 60 * 60 * 1000);
sessionCleanupTimer.unref();

startBroker(
  (_clientId: string, auth: DriverTokenPayload, topic, payload): PositionHandlingResult | void => {
  const match = topic.match(/^empresa\/([^/]+)\/bus\/([^/]+)\/posicion$/);
  if (!match) {
    console.warn(`[MQTT] Topic rejected after authorization: ${topic}`);
    return;
  }

  const topicCompanyId = match[1];
  const topicBusId = match[2];
  if (topicCompanyId !== auth.companyId || topicBusId !== auth.busId) {
    console.warn(`[MQTT] Topic bus mismatch for authenticated driver ${auth.driverId}`);
    return;
  }

  const sequence = payload.sequence;
  const capturedAt = payload.capturedAt;
  if (payload.protocolVersion !== 1) {
    return {
      accepted: false,
      sequence: Number.isSafeInteger(sequence) ? sequence as number : undefined,
      reason: 'UNSUPPORTED_PROTOCOL_VERSION',
    };
  }
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) {
    return { accepted: false, reason: 'INVALID_SEQUENCE' };
  }
  if (!Number.isSafeInteger(capturedAt) || (capturedAt as number) < 1) {
    return { accepted: false, sequence: sequence as number, reason: 'INVALID_CAPTURE_TIME' };
  }

  const positionSequence = sequence as number;
  const captureTime = capturedAt as number;
  const lat = payload.lat as number;
  const lon = payload.lon as number;
  const speedKmh = payload.speedKmh as number | undefined;

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    return { accepted: false, sequence: positionSequence, reason: 'INVALID_COORDINATES' };
  }

  const previous = getPositionValidationState(auth.busId);
  if (
    previous?.sessionId === auth.sessionId &&
    previous.sequence != null &&
    positionSequence <= previous.sequence
  ) {
    return { accepted: true, sequence: positionSequence, reason: 'DUPLICATE' };
  }

  // ── Candado 3: Rechazar posiciones físicamente imposibles ──────
  const sanity = sanityCheck(
    auth.busId,
    auth.sessionId,
    previous,
    lat,
    lon,
    speedKmh ?? 0,
    captureTime,
  );
  if (!sanity.accepted) {
    return { accepted: false, sequence: positionSequence, reason: sanity.reason };
  }

  const updated = upsertPosition(auth.phoneNumber, {
    busId: auth.busId,
    routeId: auth.routeId,
    lat,
    lon,
    heading: payload.heading as number | undefined,
    speedKmh: speedKmh,
    sessionId: auth.sessionId,
    capturedAt: captureTime,
    sequence: positionSequence,
    driverValidated: true,
    companyId: auth.companyId,
  });

  if (!updated) {
    return { accepted: true, sequence: positionSequence, reason: 'DUPLICATE' };
  }
  if (!getBusVisibility(auth.busId)) {
    console.log(`[FLEET] Bus ${auth.busId} oculto — posición guardada sin difundir`);
  } else {
    broadcastBusPosition(updated);
  }
  return { accepted: true, sequence: positionSequence };
},
  (_clientId: string, auth: DriverTokenPayload) => {
    const removed = removePositionOwned(auth.busId, auth.sessionId);
    if (!removed || removed.driverPhone !== auth.phoneNumber) return;
    console.log(`[MQTT] Bus ${auth.busId} removido por desconexión del conductor ${auth.phoneNumber}`);
  }
);

server.listen(HTTP_PORT, '0.0.0.0', () => {
  const scheme = HTTP_TLS_CERT_PATH && HTTP_TLS_KEY_PATH ? 'https' : 'http';
  console.log(`[HTTP] Server listening on ${scheme}://0.0.0.0:${HTTP_PORT}`);
});

loadVisibilityCache();
loadBusCompanyCache();

const shutdown = async (signal: string): Promise<void> => {
  console.log(`[Server] Shutting down from ${signal}...`);
  clearInterval(sweepTimer);
  clearInterval(sessionCleanupTimer);
  clearInterval(lifecycleDispatchTimer);
  getIO()?.close();
  await closeBroker();
  await new Promise<void>((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
  closeDb();
  process.exit(0);
};

process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });
