import http from 'http';
import https from 'https';
import fs from 'fs';
import {
  HTTP_PORT,
  HTTP_TLS_CERT_PATH,
  HTTP_TLS_KEY_PATH,
  BUS_TIMEOUT_MS,
  CORS_ORIGINS,
} from './config';
import { closeBroker, PositionHandlingResult, startBroker } from './mqtt/broker';
import { handleAPI } from './api/routes';
import {
  getPositionValidationState,
  BusPosition,
  sweepPositions,
  upsertPosition,
  getBusVisibility,
  loadBusCompanyCache,
  loadVisibilityCache,
} from './data/buses';
import { closeDb } from './data/database';
import { cleanupRevokedSessions } from './data/sessions';
import { dispatchLifecycleEvents, LifecycleEvent } from './data/lifecycle_events';
import { flushMetrics, restoreMetrics } from './observability/metrics';
import { arrancarFlotaDemo, detenerFlotaDemo } from './demo/flota_demo';
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

// ── Guardia de arranque ──────────────────────────────────────────────
// Sin JWT_SECRET el backend arranca con un secret por defecto y rota todos
// los tokens en silencio: las apps quedan con "sesión expiró" en loop.
// Arrancar siempre con local.env cargado (start-test.sh lo hace).
if (!process.env.JWT_SECRET) {
  throw new Error(
    'JWT_SECRET es obligatorio: arranca con start-test.sh o con local.env cargado',
  );
}

// ── Candado 3: Sanity check de física imposible (módulo puro, ver security/physics.ts) ──
import {
  haversineDistanceKm,
  sanityCheck,
  SanityResult,
} from './security/physics';
// ─────────────────────────────────────────────────────────────────────

const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => {
  // CORS solo para orígenes autorizados explícitamente (CORS_ORIGINS): los
  // clientes nativos no usan CORS y un navegador no autorizado no puede
  // leer las respuestas.
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

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
// Un bus sin publicar por GHOST_MS pasa a estado "sin señal" (is_ghost=1)
// pero su posición se conserva: los buses NO desaparecen del mapa, solo se
// marcan como stale hasta que vuelvan a publicar.
// Un bus quieto (semáforo, trancón) no publica posiciones nuevas porque el
// GPS no cruza el distanceFilter: solo se marca sin señal tras 5 min sin
// publicar nada. Sobrescribible con YA_VIENE_GHOST_MS (tests).
const GHOST_MS = Number(process.env.YA_VIENE_GHOST_MS ?? 5 * 60 * 1000);

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
  sweepPositions(GHOST_MS);
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
    sentido: payload.sentido === 'ida' || payload.sentido === 'venida'
      ? payload.sentido
      : undefined,
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
    // Desconexión MQTT: NO se borra la posición. El bus conserva su última
    // ubicación y pasa a "sin señal" (is_ghost) tras GHOST_MS via sweep.
    console.log(
      `[MQTT] Conductor ${auth.phoneNumber} desconectado — bus ${auth.busId} pasa a sin señal en ${GHOST_MS / 1000}s`,
    );
  },
  server,
);

// '::' y no '0.0.0.0': en doble pila (ipv6Only=false por defecto en Node)
// acepta IPv4 e IPv6 a la vez. Con '0.0.0.0' el socket era solo IPv4, y
// `localhost` resuelve primero a ::1 en macOS: el panel pedía
// http://localhost:3000, se topaba con conexión rechazada en IPv6 y
// mostraba "No se pudo conectar con el servidor" con el backend corriendo.
server.listen(HTTP_PORT, '::', () => {
  const scheme = HTTP_TLS_CERT_PATH && HTTP_TLS_KEY_PATH ? 'https' : 'http';
  console.log(`[HTTP] Server listening on ${scheme}://[::]:${HTTP_PORT} (IPv4+IPv6)`);
});

loadVisibilityCache();
loadBusCompanyCache();
restoreMetrics();
// Backend encendido = buses rodando. Va después de `listen` porque los
// simuladores se autentican contra este mismo servidor por HTTP.
arrancarFlotaDemo();
// Los contadores viven en memoria; a disco cada 30s para que un reinicio
// no borre la señal operativa.
const metricsFlushTimer = setInterval(flushMetrics, 30_000);
metricsFlushTimer.unref();

const shutdown = async (signal: string): Promise<void> => {
  console.log(`[Server] Shutting down from ${signal}...`);
  detenerFlotaDemo();
  clearInterval(sweepTimer);
  clearInterval(sessionCleanupTimer);
  clearInterval(lifecycleDispatchTimer);
  clearInterval(metricsFlushTimer);
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
