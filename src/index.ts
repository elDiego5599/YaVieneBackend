import http from 'http';
import https from 'https';
import fs from 'fs';
import {
  HTTP_PORT,
  HTTP_TLS_CERT_PATH,
  HTTP_TLS_KEY_PATH,
  CORS_ORIGINS,
  flotaDemoHabilitada,
  validateConfig,
} from './config';
import { closeBroker, PositionHandlingResult, startBroker } from './mqtt/broker';
import { handleAPI, metodosHttpRegistrados } from './api/routes';
import {
  getPositionValidationState,
  busInCatalog,
  BusPosition,
  sweepPositions,
  upsertPosition,
  getBusVisibility,
  loadBusCompanyCache,
  loadVisibilityCache,
} from './data/buses';
import { closeDb } from './data/database';
import { cleanupRevokedSessions } from './data/sessions';
import { dispatchBusEvents } from './data/despacho';
import { LifecycleEvent } from './data/lifecycle_events';
import { flushMetrics, incrementMetric, restoreMetrics } from './observability/metrics';
import { arrancarFlotaDemo, detenerFlotaDemo } from './demo/flota_demo';
import { DriverTokenPayload } from './auth/tokens';
import { validarPayloadPosicion } from './security/payload';
import { cerrarRedLocal } from './security/red_local';
import { registrarTamanosLimitadores } from './security/rate_limiter';
import {
  setupSocketServer,
  closeSocketServer,
  broadcastBusPosition,
  broadcastBusLeft,
  broadcastBusRemoved,
  broadcastBusHidden,
  broadcastBusVisible,
} from './socket/handler';

// ── Guardia de arranque ──────────────────────────────────────────────
// Sin JWT_SECRET el backend arranca con un secret por defecto y rota todos
// los tokens en silencio: las apps quedan con "sesión expiró" en loop.
// Arrancar siempre con local.env cargado. validateConfig revisa además
// secretos vacíos, TLS a medias, CORS mal escrito y MQTT expuesto sin
// cifrar: cualquiera de esos errores detiene el arranque en vez de dejar un
// servidor inseguro funcionando en silencio.
{
  const { errores, avisos } = validateConfig();
  for (const aviso of avisos) console.warn(`[Config] Aviso: ${aviso}`);
  if (errores.length > 0) {
    for (const error of errores) console.error(`[Config] ${error}`);
    throw new Error(`Configuración inválida: ${errores.join(' | ')}`);
  }
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
  // Los métodos salen de las rutas registradas, no de una lista escrita a
  // mano: la de antes decía `GET, POST` y dejaba fuera el PATCH y el
  // DELETE de la flota, así que un panel servido desde otro origen no
  // pasaba del preflight al apagar o borrar un bus.
  const metodos = [...metodosHttpRegistrados(), 'OPTIONS'].join(', ');
  res.setHeader('Access-Control-Allow-Methods', metodos);
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
    // Del bus borrado ya no queda la empresa en la base: viene en el aviso.
    broadcastBusRemoved(
      event.payload.busId as string,
      event.routeId,
      event.eventId,
      event.payload.companyId as string | undefined,
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

// Una excepción dentro de un setInterval sube sin dueño y tumba el proceso
// entero (Node termina ante un error no capturado). Un fallo puntual de
// cualquiera de los cuatro relojes que escriben en SQLite —barrido, despacho,
// limpieza de sesiones y volcado de métricas—, por disco lleno o base
// bloqueada, se registra y la siguiente vuelta lo reintenta, en vez de apagar
// el tiempo real.
function vueltaProtegida(nombre: string, metrica: string, trabajo: () => void): () => void {
  return () => {
    try {
      trabajo();
    } catch (error) {
      incrementMetric(metrica);
      console.error(`[${nombre}] Falló una vuelta; se reintenta en la siguiente:`, error);
    }
  };
}

const sweepTimer = setInterval(vueltaProtegida('Sweep', 'sweep.error', () => {
  sweepPositions(GHOST_MS);
  dispatchBusEvents(emitLifecycleEvent);
}), 10_000);
sweepTimer.unref();
const lifecycleDispatchTimer = setInterval(vueltaProtegida('Outbox', 'outbox.dispatch.error', () => {
  dispatchBusEvents(emitLifecycleEvent);
}), 250);
lifecycleDispatchTimer.unref();
const sessionCleanupTimer = setInterval(vueltaProtegida('Sesiones', 'sessions.cleanup.error', () => {
  cleanupRevokedSessions();
}), 60 * 60 * 1000);
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

  // Tipo y rango de cada campo, en security/payload.ts: de aquí para abajo
  // ya no hay `as number` sobre lo que mandó el equipo.
  const validado = validarPayloadPosicion(payload);
  if (!validado.ok) {
    return { accepted: false, sequence: validado.sequence, reason: validado.reason };
  }
  const {
    sequence: positionSequence,
    capturedAt: captureTime,
    lat,
    lon,
    speedKmh,
    heading,
    sentido,
  } = validado.posicion;

  // Un bus borrado del catálogo no publica. La sesión ya se revoca al
  // borrarlo, pero entre el borrado y el barrido del broker cabe alguna
  // publicación, y `upsertPosition` la descarta devolviendo null, que abajo
  // se contaría como DUPLICATE aceptado. Mejor decirle al teléfono la verdad.
  if (!busInCatalog(auth.busId)) {
    return { accepted: false, sequence: positionSequence, reason: 'BUS_NOT_FOUND' };
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
    heading,
    speedKmh,
    sentido,
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
      `[MQTT] Conductor ${auth.driverId} desconectado — bus ${auth.busId} pasa a sin señal en ${GHOST_MS / 1000}s`,
    );
  },
  server,
);

// '::' y no '0.0.0.0': en doble pila (ipv6Only=false por defecto en Node)
// acepta IPv4 e IPv6 a la vez. Con '0.0.0.0' el socket era solo IPv4, y
// `localhost` resuelve primero a ::1 en macOS: el panel pedía
// http://localhost:3000, se topaba con conexión rechazada en IPv6 y
// mostraba "No se pudo conectar con el servidor" con el backend corriendo.
// '::' abre además el puerto a la red local: fuera de producción se cierra
// al conectar todo lo que no sea esta máquina (ver red_local.ts).
cerrarRedLocal(server);
server.listen(HTTP_PORT, '::', () => {
  const scheme = HTTP_TLS_CERT_PATH && HTTP_TLS_KEY_PATH ? 'https' : 'http';
  console.log(`[HTTP] Server listening on ${scheme}://[::]:${HTTP_PORT} (IPv4+IPv6)`);
});

loadVisibilityCache();
loadBusCompanyCache();
restoreMetrics();
// Backend encendido = buses rodando. Va después de `listen` porque los
// simuladores se autentican contra este mismo servidor por HTTP.
//
// Encendida por defecto en desarrollo: la demo es lo que se enseña, y
// arrancar el backend sin buses moviéndose deja la app y el panel vacíos. En
// producción viene apagada salvo YA_VIENE_FLOTA_DEMO=1 escrito en el
// despliegue, porque la flota simulada publica en el mismo canal que los
// buses reales (ver flotaDemoHabilitada en config.ts).
const FLOTA_DEMO = flotaDemoHabilitada();
console.log(
  `[Demo] Flota simulada ${FLOTA_DEMO ? 'ENCENDIDA' : 'apagada'} `
  + `(YA_VIENE_FLOTA_DEMO=${process.env.YA_VIENE_FLOTA_DEMO ?? 'sin definir'}, `
  + `NODE_ENV=${process.env.NODE_ENV ?? 'sin definir'})`,
);
if (FLOTA_DEMO) arrancarFlotaDemo();
// Los contadores viven en memoria; a disco cada 30s para que un reinicio
// no borre la señal operativa. En la misma vuelta se publica cuánto pesa
// cada limitador (`rate_limiter.ts`). YA_VIENE_METRICS_FLUSH_MS existe para las
// pruebas, que no esperan medio minuto.
const METRICS_FLUSH_MS = (() => {
  const ms = Number(process.env.YA_VIENE_METRICS_FLUSH_MS);
  return Number.isFinite(ms) && ms >= 100 ? ms : 30_000;
})();
const metricsFlushTimer = setInterval(
  vueltaProtegida('Métricas', 'metrics.flush.error', () => {
    registrarTamanosLimitadores();
    flushMetrics();
  }),
  METRICS_FLUSH_MS,
);
metricsFlushTimer.unref();

// Los contadores se vuelcan cada 30 s, así que apagar el servidor tiraba
// a la basura hasta medio minuto de señal operativa —justo la del rato
// anterior a la caída, que es la que se quiere leer después. Va en su propia
// función, protegida y una sola vez, porque se llama desde dos sitios: el
// final normal del apagado y el reloj de emergencia.
let datosCerrados = false;
function cerrarDatos(): void {
  if (datosCerrados) return;
  datosCerrados = true;
  try {
    flushMetrics();
  } catch (error) {
    console.error('[Server] No se pudieron guardar las métricas al apagar:', error);
  }
  try {
    closeDb();
  } catch (error) {
    console.error('[Server] No se pudo cerrar SQLite al apagar:', error);
  }
}

// Tiempo máximo del apagado ordenado. Pasado, se guarda lo que se pueda y se
// sale igual: el orquestador (Fly, launchd) manda SIGKILL poco después y ahí
// ya no se guarda nada.
const APAGADO_MAX_MS = 10_000;
let apagando = false;

const shutdown = async (signal: string): Promise<void> => {
  // SIGTERM y SIGINT tienen cada uno su `once`: un Ctrl+C durante el apagado
  // lo arrancaba por segunda vez y cerraba la base dos veces.
  if (apagando) return;
  apagando = true;
  console.log(`[Server] Shutting down from ${signal}...`);

  // Antes, si algo se colgaba al cerrar (una conexión que no suelta, el
  // broker) o lanzaba, el proceso se quedaba a medias o moría sin volcar las
  // métricas ni cerrar SQLite. El reloj NO lleva unref a propósito: si el
  // cierre se queda esperando una promesa que nunca resuelve y no queda nada
  // más vivo, Node saldría con código 0 sin pasar por el volcado.
  const reloj = setTimeout(() => {
    console.error(`[Server] El apagado pasó de ${APAGADO_MAX_MS / 1000}s — salida forzada`);
    cerrarDatos();
    process.exit(1);
  }, APAGADO_MAX_MS);

  let codigo = 0;
  try {
    // Orden: primero lo que genera trabajo nuevo (simuladores, timers),
    // luego lo que lo recibe (sockets, MQTT, HTTP) y al final los datos.
    detenerFlotaDemo();
    clearInterval(sweepTimer);
    clearInterval(sessionCleanupTimer);
    clearInterval(lifecycleDispatchTimer);
    clearInterval(metricsFlushTimer);
    closeSocketServer();
    await closeBroker();
    await new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  } catch (error) {
    console.error('[Server] Error cerrando conexiones:', error);
    codigo = 1;
  } finally {
    clearTimeout(reloj);
    cerrarDatos();
    process.exit(codigo);
  }
};

process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });
// Windows no entrega SIGTERM/SIGINT al hijo (kill() termina sin correr
// handlers): el padre apaga por IPC con el mismo `shutdown` y el mismo
// volcado. Solo dispara cuando hay canal IPC (tests); en Fly no hay padre.
process.on('message', (msg: unknown) => {
  if (msg === 'shutdown') void shutdown('IPC');
});
