import aedes from 'aedes';
import { createServer, Server } from 'net';
import { MQTT_PORT, MQTT_HOST } from '../config';

type MessageHandler = (clientId: string, topic: string, payload: Record<string, unknown>) => void;

export function startBroker(onMessage: MessageHandler): Promise<Server> {
  const broker: any = new aedes();

  broker.on('publish', (packet: any, client: any) => {
    if (!client) return;

    const topic = packet.topic;

    // Format legacy: gps/{phoneNumber}
    // Format multi-tenant: empresa/{empresaId}/bus/{busId}/posicion
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
