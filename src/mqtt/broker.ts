import aedes from 'aedes';
import { createServer, Server } from 'net';
import { MQTT_PORT, MQTT_HOST } from '../config';
import { verifyToken } from '../auth/tokens';

type MessageHandler = (clientId: string, topic: string, payload: Record<string, unknown>) => void;

export function startBroker(onMessage: MessageHandler): Promise<Server> {
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
      return callback(null, false);
    }

    // Only allow publishing to own empresa/bus topic
    const expectedTopic = `empresa/${payload.empresaId}/bus/${payload.busId}/posicion`;
    if (topic !== expectedTopic) {
      console.warn(`[MQTT] Unauthorized publish by ${payload.phoneNumber} to ${topic} (expected ${expectedTopic})`);
      return callback(null, false);
    }

    callback(null, true);
  };

  broker.on('publish', (packet: any, client: any) => {
    if (!client) return;

    const topic = packet.topic;

    const matchesNew = topic.match(/^empresa\/[^/]+\/bus\/([^/]+)\/posicion$/);
    const matchesOld = topic.startsWith('gps/');

    if (matchesNew || matchesOld) {
      try {
        const payload = JSON.parse(packet.payload.toString());
        onMessage(client.id, topic, payload);
      } catch (err) {
        console.error('[MQTT] Error parsing payload:', (err as Error).message);
      }
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
