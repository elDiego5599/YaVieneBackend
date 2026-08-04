import aedes from 'aedes';
import { createServer, Server } from 'net';
import { MQTT_PORT, MQTT_HOST } from '../config';
import { TokenPayload, verifyToken } from '../auth/tokens';

type MessageHandler = (
  clientId: string,
  auth: TokenPayload,
  topic: string,
  payload: Record<string, unknown>,
) => void;
type DisconnectHandler = (clientId: string, auth: TokenPayload) => void;

export function startBroker(onMessage: MessageHandler, onDisconnect?: DisconnectHandler): Promise<Server> {
  const broker: any = new aedes();

  // ── Candado 1: JWT authentication ──────────────────────────────────
  broker.authenticate = (client: any, username: string | undefined, password: Buffer | undefined, callback: (err: Error | null, success: boolean | null) => void) => {
    if (!password) {
      return callback(null, false);
    }

    const token = password.toString();
    const payload = verifyToken(token);

    if (!payload || payload.role !== 'driver') {
      console.warn(`[MQTT] Auth rejected for client ${client.id}: invalid JWT`);
      return callback(null, false);
    }

    (client as any).authPayload = payload;
    console.log(`[MQTT] Auth OK: ${payload.phoneNumber} (bus ${payload.busId})`);
    callback(null, true);
  };

  // ── Candado 1: Authorize publish — solo su propio topic ────────────
  broker.authorizePublish = (client: any, packet: any, callback: (err: Error | null, success: boolean | null) => void) => {
    const payload: any = (client as any).authPayload;
    const topic = packet.topic;

    if (!payload) {
      console.warn(`[MQTT] authorizePublish: no authPayload for client ${client.id}`);
      return callback(null, false);
    }

    const expectedTopic = `empresa/${payload.companyId}/bus/${payload.busId}/posicion`;
    console.log(`[MQTT] authorizePublish: client=${client.id} topic=${topic} expected=${expectedTopic}`);
    if (topic !== expectedTopic) {
      console.warn(`[MQTT] Unauthorized publish by ${payload.phoneNumber} to ${topic} (expected ${expectedTopic})`);
      return callback(null, false);
    }

    callback(null, true);
  };

  broker.on('publish', (packet: any, client: any) => {
    console.log(`[MQTT] publish event: client=${client?.id ?? 'null'} topic=${packet.topic}`);
    if (!client) return;

    const topic = packet.topic;

    const matchesNew = topic.match(/^empresa\/[^/]+\/bus\/([^/]+)\/posicion$/);
    const matchesOld = topic.startsWith('gps/');

    if (matchesNew || matchesOld) {
      try {
        const authPayload = (client as any).authPayload as TokenPayload | undefined;
        if (!authPayload) return;
        const payload = JSON.parse(packet.payload.toString());
        onMessage(client.id, authPayload, topic, payload);
      } catch (err) {
        console.error('[MQTT] Error parsing payload:', (err as Error).message);
      }
    }
  });

  broker.on('clientDisconnect', (client: any) => {
    const authPayload = client.authPayload as TokenPayload | undefined;
    if (authPayload && onDisconnect) {
      console.log(`[MQTT] Disconnect: ${authPayload.phoneNumber} (bus ${authPayload.busId})`);
      onDisconnect(client.id as string, authPayload);
    }
  });

  const server = createServer(broker.handle);

  return new Promise((resolve) => {
    server.listen(MQTT_PORT, MQTT_HOST, () => {
      console.log(`[MQTT] Broker listening on mqtt://${MQTT_HOST}:${MQTT_PORT}`);
      resolve(server);
    });
  });
}
