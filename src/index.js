const http = require('http');
const { HTTP_PORT } = require('./config');
const { startBroker } = require('./mqtt/broker');
const { setupSocketServer, broadcastBusPosition } = require('./socket/handler');
const { setupAPI } = require('./api/routes');
const { upsertPosition, getDriver } = require('./data/buses');

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  setupAPIListeners(req, res);
});

const routeHandlers = [];
function setupAPIListeners(req, res) {
  for (const handler of routeHandlers) {
    if (handler(req, res)) return;
  }
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
}

setupSocketServer(server);

function registerRoute(method, path, handler) {
  routeHandlers.push((req, res) => {
    if (req.method !== method) return false;

    const urlParts = req.url.split('?')[0];
    const paramMatch = path.match(/:(\w+)/g) || [];
    const pathParts = path.split('/');
    const urlPartsSplit = urlParts.split('/');

    if (pathParts.length !== urlPartsSplit.length) return false;

    const params = {};
    for (let i = 0; i < pathParts.length; i++) {
      if (pathParts[i].startsWith(':')) {
        params[pathParts[i].slice(1)] = urlPartsSplit[i];
      } else if (pathParts[i] !== urlPartsSplit[i]) {
        return false;
      }
    }

    if (req.method === 'POST' || req.method === 'PUT') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          req.body = body ? JSON.parse(body) : {};
        } catch { req.body = {}; }
        handler(req, res, params);
      });
    } else {
      req.params = params;
      handler(req, res, params);
    }
    return true;
  });
}

registerRoute('GET', '/api/health', (_, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
});

registerRoute('GET', '/api/companies', (_, res) => {
  const companies = [
    { id: '1', name: 'Coolitoral S.A.' },
    { id: '2', name: 'Metrocaribe Ltda.' },
    { id: '3', name: 'Transcaribe S.A.S.' },
  ];
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(companies));
});

registerRoute('GET', '/api/companies/:id/routes', (_, res, params) => {
  const allRoutes = {
    '1': [
      { id: '101', name: 'Ruta 1 - Centro/Soledad', companyId: '1' },
      { id: '102', name: 'Ruta 2 - Murillo/Terminal', companyId: '1' },
    ],
    '2': [
      { id: '201', name: 'Ruta 5 - Riomar/Abello', companyId: '2' },
    ],
    '3': [
      { id: '301', name: 'Troncal - Portal/Caribe', companyId: '3' },
    ],
  };
  const routes = allRoutes[params.id] ?? [];
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(routes));
});

registerRoute('GET', '/api/routes/:routeId/positions', (_, res, params) => {
  const { getPositionsByRoute } = require('./data/buses');
  const positions = getPositionsByRoute(params.routeId);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ routeId: params.routeId, buses: positions }));
});

registerRoute('GET', '/api/buses/:busId', (_, res, params) => {
  const { getPosition } = require('./data/buses');
  const bus = getPosition(params.busId);
  if (!bus) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Bus not found' }));
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(bus));
});

registerRoute('GET', '/api/drivers/:phone', (_, res, params) => {
  const { getDriver } = require('./data/buses');
  const driver = getDriver(params.phone);
  if (!driver) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Driver not found' }));
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(driver));
});

registerRoute('POST', '/api/gps', (req, res, _params) => {
  const { phoneNumber, busId, routeId, lat, lon, heading, speedKmh } = req.body;
  if (!phoneNumber || !busId || lat == null || lon == null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Missing required fields' }));
  }
  const updated = upsertPosition(phoneNumber, { busId, routeId, lat, lon, heading, speedKmh });
  if (!updated) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Driver not registered' }));
  }
  broadcastBusPosition(updated);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(updated));
});

registerRoute('POST', '/api/drivers/register', (req, res, _params) => {
  const { phoneNumber, name, routeId } = req.body;
  if (!phoneNumber || !routeId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'phoneNumber and routeId required' }));
  }
  const { registerDriver } = require('./data/buses');
  registerDriver(phoneNumber, name || phoneNumber, routeId);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ phoneNumber, routeId, status: 'registered' }));
});

startBroker((clientId, topic, payload) => {
  const parts = topic.split('/');
  const phoneNumber = parts[1];
  const driver = getDriver(phoneNumber);
  if (!driver) {
    console.warn(`[MQTT] Unknown driver: ${phoneNumber}`);
    return;
  }
  const updated = upsertPosition(phoneNumber, {
    busId: payload.busId || `BUS-${phoneNumber.slice(-4)}`,
    routeId: driver.routeId,
    lat: payload.lat,
    lon: payload.lon,
    heading: payload.heading,
    speedKmh: payload.speedKmh,
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
