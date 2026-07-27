"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BUS_TIMEOUT_MS = exports.GHOST_TIMEOUT_MS = exports.MQTT_HOST = exports.MQTT_PORT = exports.WS_PATH = exports.HTTP_PORT = void 0;
exports.HTTP_PORT = parseInt(process.env.HTTP_PORT || '3000', 10);
exports.WS_PATH = process.env.WS_PATH || '/ws';
exports.MQTT_PORT = parseInt(process.env.MQTT_PORT || '8883', 10);
exports.MQTT_HOST = process.env.MQTT_HOST || '0.0.0.0';
exports.GHOST_TIMEOUT_MS = 90_000;
exports.BUS_TIMEOUT_MS = 30_000;
//# sourceMappingURL=config.js.map