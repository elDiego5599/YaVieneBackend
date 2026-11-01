import aedes, { type Client, type PublishPacket } from 'aedes';
import { createServer as createNetServer, Server } from 'net';
import { createServer as createTlsServer } from 'tls';
import http from 'http';
import fs from 'fs';
import type { Duplex } from 'stream';
import { WebSocketServer, createWebSocketStream } from 'ws';
import {
  MQTT_PORT,
  MQTT_HOST,
  MQTT_TLS_CERT_PATH,
  MQTT_TLS_KEY_PATH,
} from '../config';
import { DeviceTokenPayload, verifyToken } from '../auth/tokens';
import { claimSession, getSession, isSessionAuthorized, releaseSession } from '../data/sessions';
import { incrementMetric } from '../observability/metrics';
import { textoParaLog } from '../observability/texto_log';
import { requestKey, SlidingWindowRateLimiter } from '../security/rate_limiter';
import {
  CupoPorClave,
  MAX_MENSAJE_WS_MQTT,
  MAX_MQTT_ANONIMAS_POR_IP,
  MAX_PAQUETE_MQTT,
  MAX_PUBLICACIONES_MQTT_POR_MINUTO,
  VENTANA_CUOTA_MQTT_MS,
  MAX_RAFAGA_MQTT_POR_SESION,
  VENTANA_RAFAGA_MQTT_MS,
  MQTT_CONNECT_TIMEOUT_MS,
  MedidorPaquetesMqtt,
} from './guardia';

// ── Patch anti-desbordamiento de pila: mqemitter drena su cola de forma
//    síncrona (un _do() por mensaje encolado). Una ráfaga masiva de MQTT
//    (ej. 5,000 buses saliendo de un túnel) llena la cola y la recursión
//    revienta la pila (RangeError). Diferimos cada paso a un tick distinto:
//    profundidad = 1, orden FIFO intacto. ────────────────────────────────
const mqemitterModule = require('mqemitter');
const MQEmitterClass = mqemitterModule.MQEmitter ?? mqemitterModule;
const originalMqDo = MQEmitterClass.prototype._do as (
  message: unknown,
  callback: (...args: unknown[]) => void,
) => unknown;
MQEmitterClass.prototype._do = function patchedDo(
  message: unknown,
  callback: (...args: unknown[]) => void,
): unknown {
  (this as { _doing: boolean })._doing = true;
  const self = this;
  setImmediate(() => {
    originalMqDo.call(self, message, callback);
  });
  return this;
};

type AedesBroker = InstanceType<typeof aedes>;

// aedes guarda los clientes vivos en `.clients` pero no lo declara en sus
// tipos: en vez de `any` por todo el archivo, el acceso vive aquí dentro.
interface AedesWithClients extends AedesBroker {
  clients: Record<string, Client>;
}

function clientsOf(broker: AedesBroker): Record<string, Client> {
  return (broker as AedesWithClients).clients;
}

let brokerReady = false;
let brokerServer: Server | null = null;
let brokerWs: WebSocketServer | null = null;
let aedesInstance: AedesBroker | null = null;
let sessionSweepTimer: NodeJS.Timeout | null = null;
const SESSION_SWEEP_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

// El payload JWT del conductor autenticado, por cliente. Antes se colgaba
// como propiedad extra sobre el objeto Client con casts a `any`; un WeakMap
// tipado hace lo mismo sin mentirle al compilador (y se limpia solo cuando
// el cliente es recolectado).
const clientAuth = new WeakMap<Client, DeviceTokenPayload>();

export function isBrokerReady(): boolean {
  return brokerReady;
}

export async function closeBroker(): Promise<void> {
  brokerReady = false;
  if (sessionSweepTimer) {
    clearInterval(sessionSweepTimer);
    sessionSweepTimer = null;
  }
  if (brokerWs) {
    brokerWs.close();
    brokerWs = null;
  }
  if (aedesInstance) {
    const instance = aedesInstance;
    aedesInstance = null;
    await Promise.race([
      new Promise<void>((resolve) => instance.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(() => {
        console.warn('[MQTT] aedes.close() timed out after 5s — forcing');
        resolve();
      }, SHUTDOWN_TIMEOUT_MS)),
    ]);
  }
  if (!brokerServer) return;
  const server = brokerServer;
  brokerServer = null;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function forceCloseClient(broker: AedesBroker, client: Client, reason: string): void {
  try {
    if (client && !client.closed) {
      console.warn(`[MQTT] Closing client ${client.id}: ${reason}`);
      client.close(() => {});
    }
  } catch (err) {
    console.warn(`[MQTT] Failed to close client ${client?.id}: ${(err as Error).message}`);
  }
}

/**
 * Corta la conexión en cuanto un paquete anuncia más de MAX_PAQUETE_MQTT
 * (ver guardia.ts). Va DESPUÉS de `broker.handle`: aedes lee con un
 * listener `readable` y `read()`, y así este `data` solo mira cada trozo
 * que aedes lee, justo antes de que llegue al parser. Puesto antes, pondría
 * el stream a fluir por su cuenta y aedes perdería los primeros bytes.
 */
function vigilarPaquetes(conn: Duplex, cerrar: () => void): void {
  const medidor = new MedidorPaquetesMqtt();
  let cortada = false;
  conn.on('data', (trozo: Buffer) => {
    if (cortada || medidor.medir(trozo)) return;
    cortada = true;
    incrementMetric('mqtt.rechazado.paquete_grande');
    console.warn(`[MQTT] Conexión cortada: un paquete anuncia más de ${MAX_PAQUETE_MQTT} bytes`);
    cerrar();
  });
}

export interface PositionHandlingResult {
  accepted: boolean;
  sequence?: number;
  reason?: string;
}

type MessageHandler = (
  clientId: string,
  auth: DeviceTokenPayload,
  topic: string,
  payload: Record<string, unknown>,
) => PositionHandlingResult | void;
type DisconnectHandler = (clientId: string, auth: DeviceTokenPayload) => void;

export function startBroker(
  onMessage: MessageHandler,
  onDisconnect?: DisconnectHandler,
  httpServer?: http.Server,
  wsPath = '/mqtt',
): Promise<Server> {
  const broker: AedesBroker = new aedes({ connectTimeout: MQTT_CONNECT_TIMEOUT_MS });
  aedesInstance = broker;
  // El sessionId cambia al renovar autorización; deviceId mezclaría una
  // sesión nueva con la anterior del mismo equipo.
  const cuotaPorMinuto = new SlidingWindowRateLimiter(MAX_PUBLICACIONES_MQTT_POR_MINUTO, VENTANA_CUOTA_MQTT_MS);
  const cuotaRafaga = new SlidingWindowRateLimiter(MAX_RAFAGA_MQTT_POR_SESION, VENTANA_RAFAGA_MQTT_MS);
  const debugLogs = process.env.MQTT_DEBUG_LOGS === 'true';

  // ── Candado 1: JWT authentication ──────────────────────────────────
  broker.authenticate = (client, _username, password, callback) => {
    if (!password) {
      incrementMetric('mqtt.auth.rejected');
      return callback(null, false);
    }

    const token = password.toString();
    const payload = verifyToken(token);

    if (!payload || payload.role !== 'device') {
      incrementMetric('mqtt.auth.rejected');
      console.warn(`[MQTT] Auth rejected for client ${client.id}: invalid JWT`);
      return callback(null, false);
    }
    const driverPayload = payload as DeviceTokenPayload;

    if (!claimSession(driverPayload.sessionId, client.id)) {
      // La sesión está "reclamada" por otro cliente. Si ese dueño ya está
      // cerrado (conexión muerta que aedes aún no depuró), robamos el claim
      // para que el reconexión del conductor sea inmediata en vez de esperar
      // el timeout de keepalive (~15s de rechazos).
      const ownedBy = getSession(driverPayload.sessionId)?.clientId ?? null;
      if (ownedBy) {
        const owner = clientsOf(broker)[ownedBy];
        if (!owner || owner.closed) {
          releaseSession(driverPayload.sessionId, ownedBy);
          if (claimSession(driverPayload.sessionId, client.id)) {
            clientAuth.set(client, driverPayload);
            incrementMetric('mqtt.auth.accepted');
            console.log(`[MQTT] Auth OK (claim robado): equipo ${driverPayload.deviceId} (bus ${driverPayload.busId})`);
            return callback(null, true);
          }
        }
      }
      incrementMetric('mqtt.auth.rejected_session');
      console.warn(`[MQTT] Session rejected for client ${client.id}: already owned or revoked`);
      return callback(null, false);
    }

    clientAuth.set(client, driverPayload);
    incrementMetric('mqtt.auth.accepted');
    // El teléfono del conductor no sale en los registros: en Fly se guardan
    // y los lee cualquiera con acceso a la consola. El driverId basta para
    // cruzar un incidente con la base.
    console.log(`[MQTT] Auth OK: equipo ${driverPayload.deviceId} (bus ${driverPayload.busId})`);
    callback(null, true);
  };

  // ── Candado 2: Authorize publish — solo su propio topic ────────────
  //
  // aedes lee este callback al revés de lo que parece: `callback(null)` es
  // "adelante, repártelo" y solo un Error lo deniega. Las ramas de rechazo
  // pasaban null y confiaban en que el cierre del cliente llegara antes que
  // el reparto: eso es una carrera, no un candado. Cada rechazo devuelve
  // ahora su Error, y el cierre queda como lo que siempre debió ser, un
  // extra para que el cliente no siga insistiendo.
  const denyPublish = (reason: string) => new Error(reason);

  broker.authorizePublish = (client, packet, callback) => {
    // Un publish puede llegar con client null (p. ej. bridge interno): sin
    // identidad no hay permiso.
    if (!client) {
      incrementMetric('mqtt.publish.rejected_no_auth');
      return callback(denyPublish('publish sin cliente'));
    }
    const payload = clientAuth.get(client);
    const topic = packet.topic;

    if (!payload) {
      incrementMetric('mqtt.publish.rejected_no_auth');
      console.warn(`[MQTT] authorizePublish: no authPayload for client ${client.id}`);
      forceCloseClient(broker, client, 'publish sin authPayload');
      return callback(denyPublish('publish sin authPayload'));
    }

    if (!isSessionAuthorized(payload.sessionId, client.id)) {
      incrementMetric('mqtt.publish.rejected_session');
      console.warn(`[MQTT] Session no longer authorized for client ${client.id}`);
      forceCloseClient(broker, client, 'sesión revocada o reclamada por otro dispositivo');
      return callback(denyPublish('sesión revocada o reclamada por otro dispositivo'));
    }

    const expectedTopic = `empresa/${payload.companyId}/bus/${payload.busId}/posicion`;
    if (debugLogs) {
      console.log(`[MQTT] authorizePublish: client=${client.id} topic=${textoParaLog(topic)} expected=${expectedTopic}`);
    }
    if (topic !== expectedTopic) {
      incrementMetric('mqtt.publish.rejected_topic');
      console.warn(`[MQTT] TOPIC HIJACKING: equipo ${payload.deviceId} (bus ${payload.busId}) intentó publicar a ${textoParaLog(topic)}`);
      forceCloseClient(broker, client, `topic hijacking: ${textoParaLog(topic)}`);
      return callback(denyPublish(`topic no autorizado: ${textoParaLog(topic)}`));
    }

    // Debe quedar antes del callback exitoso: aedes solo entonces reparte
    // el paquete y dispara parseo, SQLite y sockets.
    if (!cuotaRafaga.allow(payload.sessionId) || !cuotaPorMinuto.allow(payload.sessionId)) {
      incrementMetric('mqtt.publish.rejected_quota');
      console.warn('[MQTT] Publicación rechazada: cuota por sesión excedida');
      // En Aedes 0.51.3, devolver Error desde authorizePublish frena el
      // procesamiento del paquete pero no cierra de forma fiable QoS 0.
      // Cerramos explícitamente para que no siga recibiendo la ráfaga; la
      // cuota queda hasta caducar y reconectar no permite repetirla.
      client.close(() => {});
      return callback(denyPublish('cuota de publicaciones excedida'));
    }

    incrementMetric('mqtt.publish.authorized');
    callback(null);
  };

  broker.authorizeSubscribe = (client, subscription, callback) => {
    const payload = client ? clientAuth.get(client) : undefined;
    const expectedTopic = payload
      ? `empresa/${payload.companyId}/bus/${payload.busId}/ack`
      : null;

    if (!payload || !client || subscription.topic !== expectedTopic || !isSessionAuthorized(payload.sessionId, client.id)) {
      incrementMetric('mqtt.subscribe.rejected');
      return callback(null, null);
    }

    incrementMetric('mqtt.subscribe.accepted');
    callback(null, subscription);
  };

  function publishAck(auth: DeviceTokenPayload, result: PositionHandlingResult): void {
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

    const packet: PublishPacket = {
      cmd: 'publish',
      topic,
      payload,
      qos: 0,
      retain: false,
      dup: false,
    };
    broker.publish(packet, (error?: Error) => {
      if (error) {
        incrementMetric('mqtt.ack.publish_error');
        console.error('[MQTT] ACK publish error:', error.message);
      } else {
        incrementMetric('mqtt.ack.published');
      }
    });
  }

  broker.on('publish', (packet: PublishPacket, client: Client | null) => {
    if (debugLogs) {
      console.log(`[MQTT] publish event: client=${client?.id ?? 'null'} topic=${textoParaLog(packet.topic)}`);
    }
    if (!client) return;

    const topic = packet.topic;

    // Solo el topic vigente. La rama `gps/` era del esquema viejo y ya no
    // pasa el candado de autorización: dejarla aquí solo servía para sumar
    // `mqtt.messages.received` por mensajes que nadie llegaba a procesar.
    const matchesNew = topic.match(/^empresa\/[^/]+\/bus\/([^/]+)\/posicion$/);

    if (matchesNew) {
      incrementMetric('mqtt.messages.received');
      try {
        const authPayload = clientAuth.get(client);
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

  broker.on('clientDisconnect', (client: Client) => {
    const authPayload = clientAuth.get(client);
    if (authPayload && onDisconnect) {
      if (!releaseSession(authPayload.sessionId, client.id as string)) return;
      console.log(`[MQTT] Disconnect: equipo ${authPayload.deviceId} (bus ${authPayload.busId})`);
      onDisconnect(client.id as string, authPayload);
    }
  });

  // ── Sweep de sesiones: cierra clientes cuya sesión fue revocada (2º celular) ──
  sessionSweepTimer = setInterval(() => {
    cuotaPorMinuto.sweep();
    cuotaRafaga.sweep();
    for (const client of Object.values(clientsOf(broker))) {
      const payload = client ? clientAuth.get(client) : undefined;
      if (!payload) continue;
      if (client.closed) continue;
      if (!isSessionAuthorized(payload.sessionId, client.id)) {
        forceCloseClient(
          broker,
          client,
          `sesión revocada (equipo ${payload.deviceId} inició en otro dispositivo o fue expulsado)`,
        );
      }
    }
  }, SESSION_SWEEP_MS);

  // ── MQTT por WebSocket: misma vía que el HTTP, ruta /mqtt ─────────
  //    Es el canal público (el túnel entrega TLS). aedes consume el
  //    stream duplex que crea `ws` a partir del socket WebSocket.
  //
  //    Antes de autenticar, cada conexión ocupa un sitio del cupo de su
  //    dirección (guardia.ts): pasado el tope, el upgrade se contesta 429
  //    sin llegar a abrir el WebSocket. El sitio se suelta cuando aedes da
  //    al cliente por conectado (evento `client`, tras el CONNECT aceptado)
  //    o cuando el socket se cierra, lo que pase antes.
  if (httpServer) {
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_MENSAJE_WS_MQTT,
    });
    brokerWs = wss;
    const anonimas = new CupoPorClave(MAX_MQTT_ANONIMAS_POR_IP);
    const soltarAnonima = new WeakMap<Client, () => void>();
    broker.on('client', (client: Client) => {
      soltarAnonima.get(client)?.();
    });
    httpServer.on('upgrade', (req, socket, head) => {
      const { pathname } = new URL(req.url ?? '/', 'http://localhost');
      if (pathname !== wsPath) return;
      const clave = requestKey(req);
      if (!anonimas.tomar(clave)) {
        incrementMetric('mqtt.rechazado.anonimas_ip');
        socket.once('finish', () => socket.destroy());
        socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      let suelta = false;
      const soltar = () => {
        if (suelta) return;
        suelta = true;
        anonimas.soltar(clave);
      };
      socket.once('close', soltar);
      wss.handleUpgrade(req, socket, head, (ws) => {
        const conn = createWebSocketStream(ws);
        const client = broker.handle(conn, req);
        soltarAnonima.set(client, soltar);
        vigilarPaquetes(conn, () => ws.terminate());
      });
    });
  }

  // El TCP queda en loopback (o con TLS propio), pero el tope de paquete es
  // el mismo: nada legítimo lo pasa por ninguna de las dos vías.
  function atenderTcp(socket: Duplex): void {
    broker.handle(socket);
    vigilarPaquetes(socket, () => socket.destroy());
  }

  const server = MQTT_TLS_CERT_PATH && MQTT_TLS_KEY_PATH
    ? createTlsServer({
        cert: fs.readFileSync(MQTT_TLS_CERT_PATH),
        key: fs.readFileSync(MQTT_TLS_KEY_PATH),
      }, atenderTcp)
    : createNetServer(atenderTcp);
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
