"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = __importDefault(require("http"));
const config_1 = require("./config");
const broker_1 = require("./mqtt/broker");
const handler_1 = require("./socket/handler");
const routes_1 = require("./api/routes");
const buses_1 = require("./data/buses");
const server = http_1.default.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    if (!(0, routes_1.handleAPI)(req, res)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    }
});
(0, handler_1.setupSocketServer)(server);
(0, broker_1.startBroker)((clientId, topic, payload) => {
    const parts = topic.split('/');
    const phoneNumber = parts[1];
    const driver = (0, buses_1.getDriver)(phoneNumber);
    if (!driver) {
        console.warn(`[MQTT] Unknown driver: ${phoneNumber}`);
        return;
    }
    const updated = (0, buses_1.upsertPosition)(phoneNumber, {
        busId: payload.busId || `BUS-${phoneNumber.slice(-4)}`,
        routeId: driver.routeId,
        lat: payload.lat,
        lon: payload.lon,
        heading: payload.heading,
        speedKmh: payload.speedKmh,
    });
    if (updated)
        (0, handler_1.broadcastBusPosition)(updated);
});
server.listen(config_1.HTTP_PORT, () => {
    console.log(`[HTTP] Server listening on http://localhost:${config_1.HTTP_PORT}`);
});
process.on('SIGTERM', () => {
    console.log('[Server] Shutting down...');
    process.exit(0);
});
//# sourceMappingURL=index.js.map