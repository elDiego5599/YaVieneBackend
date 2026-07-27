const aedes = require('aedes')();
const net = require('net');
const { MQTT_PORT, MQTT_HOST } = require('../config');

function startBroker(onMessage) {
  aedes.on('publish', (packet, client) => {
    if (client && packet.topic.startsWith('gps/')) {
      try {
        const payload = JSON.parse(packet.payload.toString());
        onMessage(client.id, packet.topic, payload);
      } catch (err) {
        console.error('[MQTT] Error parsing payload:', err.message);
      }
    }
  });

  const server = net.createServer(aedes.handle);

  return new Promise((resolve) => {
    server.listen(MQTT_PORT, MQTT_HOST, () => {
      console.log(`[MQTT] Broker listening on mqtt://${MQTT_HOST}:${MQTT_PORT}`);
      resolve(server);
    });
  });
}

module.exports = { startBroker };
