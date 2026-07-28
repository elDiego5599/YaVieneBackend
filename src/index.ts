import http from 'http';
import { HTTP_PORT } from './config';
import { startBroker } from './mqtt/broker';
import { setupSocketServer, broadcastBusPosition } from './socket/handler';
import { handleAPI } from './api/routes';
import { upsertPosition, getDriver } from './data/buses';

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

startBroker((clientId, topic, payload) => {
  const isNewFormat = topic.startsWith('empresa/');
  let driverPhone: string | null = null;

  if (isNewFormat) {
    // empresa/{empresaId}/bus/{busId}/posicion
    const parts = topic.split('/');
    const busId = parts[3];
    driverPhone = payload.phoneNumber as string;
    payload.busId = busId;
  } else {
    // gps/{phoneNumber}
    const parts = topic.split('/');
    driverPhone = parts[1];
  }

  if (!driverPhone) {
    console.warn(`[MQTT] No phoneNumber in topic: ${topic}`);
    return;
  }

  const driver = getDriver(driverPhone);

  if (!driver) {
    console.warn(`[MQTT] Unknown driver: ${driverPhone}`);
    return;
  }

  const updated = upsertPosition(driverPhone, {
    busId: (payload.busId as string) || `BUS-${driverPhone.slice(-4)}`,
    routeId: driver.routeId,
    lat: payload.lat as number,
    lon: payload.lon as number,
    heading: payload.heading as number | undefined,
    speedKmh: payload.speedKmh as number | undefined,
  });

  if (updated) broadcastBusPosition(updated);
});

server.listen(HTTP_PORT, () => {
  console.log(`[HTTP] Server listening on http://localhost:${HTTP_PORT}`);
});

process.on('SIGTERM', () => {
  console.log('[Server] Shutting down...');
  process.exit(0);
});
