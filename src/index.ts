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
  const parts = topic.split('/');
  const phoneNumber = parts[1];
  const driver = getDriver(phoneNumber);

  if (!driver) {
    console.warn(`[MQTT] Unknown driver: ${phoneNumber}`);
    return;
  }

  const updated = upsertPosition(phoneNumber, {
    busId: (payload.busId as string) || `BUS-${phoneNumber.slice(-4)}`,
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
