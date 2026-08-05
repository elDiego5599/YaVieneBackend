import aedes from 'aedes';
import { createServer as createNetServer, Server } from 'net';
import { createServer as createTlsServer } from 'tls';
import fs from 'fs';
import {
  MQTT_PORT,
  MQTT_HOST,
  MQTT_TLS_CERT_PATH,
  MQTT_TLS_KEY_PATH,
} from '../config';
import { TokenPayload, verifyToken } from '../auth/tokens';
import { claimSession, isSessionAuthorized, releaseSession } from '../data/sessions';
import { incrementMetric } from '../observability/metrics';

let brokerReady = false;

export function isBrokerReady(): boolean {
  return brokerReady;
}

export interface PositionHandlingResult {
  accepted: boolean;
  sequence?: number;
  reason?: string;
}

type MessageHandler = (
  clientId: string,
  auth: TokenPayload,
  topic: string,
  payload: Record<string, unknown>,
) => PositionHandlingResult | void;
type DisconnectHandler = (clientId: string, auth: TokenPayload) => void;

export function startBroker(onMessage: MessageHandler, onDisconnect?: DisconnectHandler): Promise<Server> {
  const broker: any = new aedes();
  const debugLogs = process.env.MQTT_DEBUG_LOGS === 'true';

  // ── Candado 1: JWT authentication ──────────────────────────────────
  broker.authenticate = (client: any, username: string | undefined, password: Buffer | undefined, callback: (err: Error | null, success: boolean | null) => void) => {
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

    if (!claimSession(payload.sessionId, client.id)) {
      incrementMetric('mqtt.auth.rejected_session');
      console.warn(`[MQTT] Session rejected for client ${client.id}: already owned or revoked`);
      return callback(null, false);
    }

    (client as any).authPayload = payload;
    incrementMetric('mqtt.auth.accepted');
    console.log(`[MQTT] Auth OK: ${payload.phoneNumber} (bus ${payload.busId})`);
    callback(null, true);
  };

  // ── Candado 1: Authorize publish — solo su propio topic ────────────
  broker.authorizePublish = (client: any, packet: any, callback: (err: Error | null, success: boolean | null) => void) => {
    const payload: any = (client as any).authPayload;
    const topic = packet.topic;

    if (!payload) {
      incrementMetric('mqtt.publish.rejected_no_auth');
      console.warn(`[MQTT] authorizePublish: no authPayload for client ${client.id}`);
      return callback(null, false);
    }

    if (!isSessionAuthorized(payload.sessionId, client.id)) {
      incrementMetric('mqtt.publish.rejected_session');
      console.warn(`[MQTT] Session no longer authorized for client ${client.id}`);
      return callback(null, false);
    }

    const expectedTopic = `empresa/${payload.companyId}/bus/${payload.busId}/posicion`;
    if (debugLogs) {
      console.log(`[MQTT] authorizePublish: client=${client.id} topic=${topic} expected=${expectedTopic}`);
    }
    if (topic !== expectedTopic) {
      incrementMetric('mqtt.publish.rejected_topic');
      console.warn(`[MQTT] Unauthorized publish by ${payload.phoneNumber} to ${topic} (expected ${expectedTopic})`);
      return callback(null, false);
    }

    incrementMetric('mqtt.publish.authorized');
    callback(null, true);
  };

  broker.authorizeSubscribe = (client: any, subscription: any, callback: (err: Error | null, subscription?: any) => void) => {
    const payload = (client as any).authPayload as TokenPayload | undefined;
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

  function publishAck(auth: TokenPayload, result: PositionHandlingResult): void {
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
        const authPayload = (client as any).authPayload as TokenPayload | undefined;
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
    const authPayload = client.authPayload as TokenPayload | undefined;
    if (authPayload && onDisconnect) {
      if (!releaseSession(authPayload.sessionId, client.id as string)) return;
      console.log(`[MQTT] Disconnect: ${authPayload.phoneNumber} (bus ${authPayload.busId})`);
      onDisconnect(client.id as string, authPayload);
    }
  });

  const server = MQTT_TLS_CERT_PATH && MQTT_TLS_KEY_PATH
    ? createTlsServer({
        cert: fs.readFileSync(MQTT_TLS_CERT_PATH),
        key: fs.readFileSync(MQTT_TLS_KEY_PATH),
      }, broker.handle)
    : createNetServer(broker.handle);
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
      resolve(server);
    });
  });
}
