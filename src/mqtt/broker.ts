import aedes from 'aedes';
import { createServer as createNetServer, Server } from 'net';
import { createServer as createTlsServer } from 'tls';
import http from 'http';
import fs from 'fs';
import { WebSocketServer, createWebSocketStream } from 'ws';
import {
  MQTT_PORT,
  MQTT_HOST,
  MQTT_TLS_CERT_PATH,
  MQTT_TLS_KEY_PATH,
} from '../config';
import { DriverTokenPayload, verifyToken } from '../auth/tokens';
import { claimSession, getSession, isSessionAuthorized, releaseSession } from '../data/sessions';
import { incrementMetric } from '../observability/metrics';

// ── Patch anti-desbordamiento de pila: mqemitter drena su cola de forma
//    síncrona (un _do() por mensaje encolado). Una ráfaga masiva de MQTT
//    (ej. 5,000 buses saliendo de un túnel) llena la cola y la recursión
//    revienta la pila (RangeError). Diferimos cada paso a un tick distinto:
//    profundidad = 1, orden FIFO intacto. ────────────────────────────────
const mqemitterModule = require('mqemitter');
const MQEmitterClass = mqemitterModule.MQEmitter ?? mqemitterModule;
const originalMqDo = MQEmitterClass.prototype._do as (
  message: unknown,
  callback: (...args: any[]) => void,
) => unknown;
MQEmitterClass.prototype._do = function patchedDo(
  message: unknown,
  callback: (...args: any[]) => void,
): unknown {
  (this as { _doing: boolean })._doing = true;
  const self = this;
  setImmediate(() => {
    originalMqDo.call(self, message, callback);
  });
  return this;
};

let brokerReady = false;
let brokerServer: Server | null = null;
let brokerWs: WebSocketServer | null = null;
let sessionSweepTimer: NodeJS.Timeout | null = null;
const SESSION_SWEEP_MS = 5_000;

export function isBrokerReady(): boolean {
  return brokerReady;
}

export function closeBroker(): Promise<void> {
  if (sessionSweepTimer) {
    clearInterval(sessionSweepTimer);
    sessionSweepTimer = null;
  }
  if (brokerWs) {
    brokerWs.close();
    brokerWs = null;
  }
  if (!brokerServer) return Promise.resolve();
  const server = brokerServer;
  brokerServer = null;
  return new Promise((resolve) => server.close(() => resolve()));
}

function forceCloseClient(broker: any, client: any, reason: string): void {
  try {
    if (client && !client.closed) {
      console.warn(`[MQTT] Closing client ${client.id}: ${reason}`);
      client.close(() => {});
    }
  } catch (err) {
    console.warn(`[MQTT] Failed to close client ${client?.id}: ${(err as Error).message}`);
  }
}

export interface PositionHandlingResult {
  accepted: boolean;
  sequence?: number;
  reason?: string;
}

type MessageHandler = (
  clientId: string,
  auth: DriverTokenPayload,
  topic: string,
  payload: Record<string, unknown>,
) => PositionHandlingResult | void;
type DisconnectHandler = (clientId: string, auth: DriverTokenPayload) => void;

export function startBroker(
  onMessage: MessageHandler,
  onDisconnect?: DisconnectHandler,
  httpServer?: http.Server,
  wsPath = '/mqtt',
): Promise<Server> {
  const broker: any = new aedes();
  const debugLogs = process.env.MQTT_DEBUG_LOGS === 'true';

  // ── Candado 1: JWT authentication ──────────────────────────────────
  broker.authenticate = (client: any, username: string | undefined, password: Buffer | undefined, callback: any) => {
    if (!password) {
      incrementMetric('mqtt.auth.rejected');
      return callback(null, false);
    }

    const token = password.toString();
    const payload = verifyToken(token);

    if (!payload || payload.role !== 'driver') {
      incrementMetric('mqtt.auth.rejected');
      console.warn(`[MQTT] Auth rejected for client ${client.id}: invalid JWT`);
      return callback(null, false);
    }
    const driverPayload = payload as DriverTokenPayload;

    if (!claimSession(driverPayload.sessionId, client.id)) {
      // La sesión está "reclamada" por otro cliente. Si ese dueño ya está
      // cerrado (conexión muerta que aedes aún no depuró), robamos el claim
      // para que el reconexión del conductor sea inmediata en vez de esperar
      // el timeout de keepalive (~15s de rechazos).
      const ownedBy = getSession(driverPayload.sessionId)?.clientId ?? null;
      if (ownedBy) {
        const owner = (broker.clients as Record<string, any> | undefined)?.[ownedBy];
        if (!owner || owner.closed) {
          releaseSession(driverPayload.sessionId, ownedBy);
          if (claimSession(driverPayload.sessionId, client.id)) {
            (client as any).authPayload = driverPayload;
            incrementMetric('mqtt.auth.accepted');
            console.log(`[MQTT] Auth OK (claim robado): ${driverPayload.phoneNumber} (bus ${driverPayload.busId})`);
            return callback(null, true);
          }
        }
      }
      incrementMetric('mqtt.auth.rejected_session');
      console.warn(`[MQTT] Session rejected for client ${client.id}: already owned or revoked`);
      return callback(null, false);
    }

    (client as any).authPayload = driverPayload;
    incrementMetric('mqtt.auth.accepted');
    console.log(`[MQTT] Auth OK: ${driverPayload.phoneNumber} (bus ${driverPayload.busId})`);
    callback(null, true);
  };

  // ── Candado 1: Authorize publish — solo su propio topic ────────────
  broker.authorizePublish = (client: any, packet: any, callback: any) => {
    const payload: any = (client as any).authPayload;
    const topic = packet.topic;

    if (!payload) {
      incrementMetric('mqtt.publish.rejected_no_auth');
      console.warn(`[MQTT] authorizePublish: no authPayload for client ${client.id}`);
      forceCloseClient(broker, client, 'publish sin authPayload');
      return callback(null, false);
    }

    if (!isSessionAuthorized(payload.sessionId, client.id)) {
      incrementMetric('mqtt.publish.rejected_session');
      console.warn(`[MQTT] Session no longer authorized for client ${client.id}`);
      forceCloseClient(broker, client, 'sesión revocada o reclamada por otro dispositivo');
      return callback(null, false);
    }

    const expectedTopic = `empresa/${payload.companyId}/bus/${payload.busId}/posicion`;
    if (debugLogs) {
      console.log(`[MQTT] authorizePublish: client=${client.id} topic=${topic} expected=${expectedTopic}`);
    }
    if (topic !== expectedTopic) {
      incrementMetric('mqtt.publish.rejected_topic');
      console.warn(`[MQTT] TOPIC HIJACKING: ${payload.phoneNumber} (bus ${payload.busId}) intentó publicar a ${topic}`);
      forceCloseClient(broker, client, `topic hijacking: ${topic}`);
      return callback(null, false);
    }

    incrementMetric('mqtt.publish.authorized');
    callback(null, true);
  };

  broker.authorizeSubscribe = (client: any, subscription: any, callback: any) => {
    const payload = (client as any).authPayload as DriverTokenPayload | undefined;
    const expectedTopic = payload
      ? `empresa/${payload.companyId}/bus/${payload.busId}/ack`
      : null;

    if (!payload || subscription.topic !== expectedTopic || !isSessionAuthorized(payload.sessionId, client.id)) {
      incrementMetric('mqtt.subscribe.rejected');
      return callback(null, null);
    }

    incrementMetric('mqtt.subscribe.accepted');
    callback(null, subscription);
  };

  function publishAck(auth: DriverTokenPayload, result: PositionHandlingResult): void {
    if (result.sequence == null) return;
    const topic = `empresa/${auth.companyId}/bus/${auth.busId}/ack`;
    const payload = Buffer.from(JSON.stringify({
      protocolVersion: 1,
      sessionId: auth.sessionId,
      sequence: result.sequence,
      accepted: result.accepted,
      reason: result.reason,
      receivedAt: Date.now(),
    }));

    broker.publish({
      cmd: 'publish',
      topic,
      payload,
      qos: 0,
      retain: false,
      dup: false,
    }, (error: Error | undefined) => {
      if (error) {
        incrementMetric('mqtt.ack.publish_error');
        console.error('[MQTT] ACK publish error:', error.message);
      } else {
        incrementMetric('mqtt.ack.published');
      }
    });
  }

  broker.on('publish', (packet: any, client: any) => {
    if (debugLogs) {
      console.log(`[MQTT] publish event: client=${client?.id ?? 'null'} topic=${packet.topic}`);
    }
    if (!client) return;

    const topic = packet.topic;

    const matchesNew = topic.match(/^empresa\/[^/]+\/bus\/([^/]+)\/posicion$/);
    const matchesOld = topic.startsWith('gps/');

    if (matchesNew || matchesOld) {
      incrementMetric('mqtt.messages.received');
      try {
        const authPayload = (client as any).authPayload as DriverTokenPayload | undefined;
        if (!authPayload) return;
        const payload = JSON.parse(packet.payload.toString());
        const result = onMessage(client.id, authPayload, topic, payload);
        if (result) {
          incrementMetric(result.accepted ? 'position.accepted' : 'position.rejected');
          publishAck(authPayload, result);
        }
      } catch (err) {
        console.error('[MQTT] Error parsing payload:', (err as Error).message);
      }
    }
  });

  broker.on('clientDisconnect', (client: any) => {
    const authPayload = client.authPayload as DriverTokenPayload | undefined;
    if (authPayload && onDisconnect) {
      if (!releaseSession(authPayload.sessionId, client.id as string)) return;
      console.log(`[MQTT] Disconnect: ${authPayload.phoneNumber} (bus ${authPayload.busId})`);
      onDisconnect(client.id as string, authPayload);
    }
  });

  // ── Sweep de sesiones: cierra clientes cuya sesión fue revocada (2º celular) ──
  sessionSweepTimer = setInterval(() => {
    for (const client of Object.values(broker.clients as Record<string, any>)) {
      const payload = client?.authPayload as DriverTokenPayload | undefined;
      if (!payload) continue;
      if (client.closed) continue;
      if (!isSessionAuthorized(payload.sessionId, client.id)) {
        forceCloseClient(
          broker,
          client,
          `sesión revocada (${payload.phoneNumber} inició en otro dispositivo o fue expulsada)`,
        );
      }
    }
  }, SESSION_SWEEP_MS);

  // ── MQTT por WebSocket: misma vía que el HTTP, ruta /mqtt ─────────
  //    Es el canal público (el túnel entrega TLS). aedes consume el
  //    stream duplex que crea `ws` a partir del socket WebSocket.
  if (httpServer) {
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: 256 * 1024,
    });
    brokerWs = wss;
    httpServer.on('upgrade', (req, socket, head) => {
      const { pathname } = new URL(req.url ?? '/', 'http://localhost');
      if (pathname !== wsPath) return;
      wss.handleUpgrade(req, socket, head, (ws) => {
        broker.handle(createWebSocketStream(ws), req);
      });
    });
  }

  const server = MQTT_TLS_CERT_PATH && MQTT_TLS_KEY_PATH
    ? createTlsServer({
        cert: fs.readFileSync(MQTT_TLS_CERT_PATH),
        key: fs.readFileSync(MQTT_TLS_KEY_PATH),
      }, broker.handle)
    : createNetServer(broker.handle);
  brokerServer = server;
  server.on('error', (error) => {
    brokerReady = false;
    console.error('[MQTT] Broker server error:', error.message);
  });
  server.on('close', () => {
    brokerReady = false;
  });

  return new Promise((resolve) => {
    server.listen(MQTT_PORT, MQTT_HOST, () => {
      brokerReady = true;
      const scheme = MQTT_TLS_CERT_PATH && MQTT_TLS_KEY_PATH ? 'mqtts' : 'mqtt';
      console.log(`[MQTT] Broker listening on ${scheme}://${MQTT_HOST}:${MQTT_PORT}`);
      if (httpServer) {
        console.log(`[MQTT] Broker WebSocket en ${wsPath} (mismo servidor HTTP, TLS por túnel)`);
      }
      resolve(server);
    });
  });
}
