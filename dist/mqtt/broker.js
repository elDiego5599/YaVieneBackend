"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startBroker = startBroker;
const aedes_1 = __importDefault(require("aedes"));
const net_1 = require("net");
const config_1 = require("../config");
function startBroker(onMessage) {
    const broker = new aedes_1.default();
    broker.on('publish', (packet, client) => {
        if (client && packet.topic.startsWith('gps/')) {
            try {
                const payload = JSON.parse(packet.payload.toString());
                onMessage(client.id, packet.topic, payload);
            }
            catch (err) {
                console.error('[MQTT] Error parsing payload:', err.message);
            }
        }
    });
    const server = (0, net_1.createServer)(broker.handle);
    return new Promise((resolve) => {
        server.listen(config_1.MQTT_PORT, config_1.MQTT_HOST, () => {
            console.log(`[MQTT] Broker listening on mqtt://${config_1.MQTT_HOST}:${config_1.MQTT_PORT}`);
            resolve(server);
        });
    });
}
//# sourceMappingURL=broker.js.map