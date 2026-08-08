export const HTTP_PORT = parseInt(process.env.HTTP_PORT || '3000', 10);
export const WS_PATH = process.env.WS_PATH || '/ws';
export const MQTT_PORT = parseInt(process.env.MQTT_PORT || '8883', 10);
// MQTT por TCP queda solo en loopback (pruebas locales). El acceso remoto
// es por WebSocket (wss) en el mismo servidor HTTP: /mqtt.
export const MQTT_HOST = process.env.MQTT_HOST || '127.0.0.1';
export const HTTP_TLS_CERT_PATH = process.env.HTTP_TLS_CERT_PATH;
export const HTTP_TLS_KEY_PATH = process.env.HTTP_TLS_KEY_PATH;
export const MQTT_TLS_CERT_PATH = process.env.MQTT_TLS_CERT_PATH;
export const MQTT_TLS_KEY_PATH = process.env.MQTT_TLS_KEY_PATH;
export const GHOST_TIMEOUT_MS = 90_000;
export const BUS_TIMEOUT_MS = 30_000;
