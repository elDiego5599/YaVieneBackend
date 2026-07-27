module.exports = {
  HTTP_PORT: process.env.HTTP_PORT || 3000,
  WS_PATH: process.env.WS_PATH || '/ws',
  MQTT_PORT: process.env.MQTT_PORT || 8883,
  MQTT_HOST: process.env.MQTT_HOST || '0.0.0.0',
  GHOST_TIMEOUT_MS: 90000,
  BUS_TIMEOUT_MS: 30000,
};
