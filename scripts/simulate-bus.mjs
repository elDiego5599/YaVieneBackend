/**
 * Simulador de bus para prueba E2E de Ya Viene.
 *
 * Modo de uso:
 *   node scripts/simulate-bus.mjs
 *
 * Requiere el backend corriendo (npm run dev).
 * Envía posiciones GPS cada 2 segundos simulando un bus
 * recorriendo la Calle 30 en Barranquilla.
 */

import net from 'net';
import http from 'http';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const MQTT_PORT = parseInt(process.env.MQTT_PORT || '8883', 10);
const BUS_ID = process.env.BUS_ID || 'B-042';
const PHONE = process.env.PHONE || '3000000000';
const EMPRESA_ID = process.env.EMPRESA_ID || 'EMP-01';
const ROUTE_ID = process.env.ROUTE_ID || 'R-101';

// Coordenadas simulando un recorrido por la Calle 30, Barranquilla
const WAYPOINTS = [
  { lat: 10.9630, lon: -74.8230 },
  { lat: 10.9635, lon: -74.8200 },
  { lat: 10.9640, lon: -74.8170 },
  { lat: 10.9645, lon: -74.8140 },
  { lat: 10.9648, lon: -74.8110 },
  { lat: 10.9650, lon: -74.8080 },
  { lat: 10.9652, lon: -74.8050 },
  { lat: 10.9650, lon: -74.8020 },
  { lat: 10.9648, lon: -74.7990 },
  { lat: 10.9655, lon: -74.7960 },
];

let step = 0;
let token = '';
let mqttClient = null;

async function registerDriver() {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      phoneNumber: PHONE,
      name: `Conductor ${PHONE}`,
      busId: BUS_ID,
      routeId: ROUTE_ID,
      empresaId: EMPRESA_ID,
    });

    const url = new URL(`${BACKEND_URL}/api/drivers/register`);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          const json = JSON.parse(body);
          if (json.token) {
            console.log(`[REGISTER] Conductor ${PHONE} registrado. JWT obtenido.`);
            token = json.token;
            resolve();
          } else {
            reject(new Error(`Registro falló: ${body}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function connectMQTT() {
  return new Promise((resolve, reject) => {
    const host = new URL(BACKEND_URL).hostname;
    const client = net.createConnection({ host, port: MQTT_PORT }, () => {
      console.log(`[MQTT] Conectado a ${host}:${MQTT_PORT}`);
      mqttClient = client;
      resolve();
    });

    client.on('data', (data) => {
      console.log('[MQTT] ←', data.toString('hex').substring(0, 80));
    });

    client.on('error', (err) => {
      console.error('[MQTT] Error:', err.message);
      reject(err);
    });

    client.on('close', () => {
      console.log('[MQTT] Desconectado');
      mqttClient = null;
    });
  });
}

async function publishPosition(lat, lon) {
  if (!mqttClient) return;

  const heading = 45 + (step * 5 % 360);
  const speedKmh = 30 + Math.random() * 15;
  const payload = JSON.stringify({
    phoneNumber: PHONE,
    lat,
    lon,
    heading,
    speedKmh,
    timestamp: new Date().toISOString(),
  });

  // MQTT packet: fixed header (0x30 = PUBLISH, QoS 0) + remaining length + topic + payload
  const topic = `empresa/${EMPRESA_ID}/bus/${BUS_ID}/posicion`;
  const topicBuf = Buffer.from(topic);
  const payloadBuf = Buffer.from(payload);
  const remainingLen = topicBuf.length + 2 + payloadBuf.length;

  let header;
  if (remainingLen < 128) {
    header = Buffer.from([0x30, remainingLen]);
  } else {
    header = Buffer.from([0x30, (remainingLen & 0x7f) | 0x80, remainingLen >> 7]);
  }

  const topicLen = Buffer.alloc(2);
  topicLen.writeUInt16BE(topicBuf.length);
  const packet = Buffer.concat([header, topicLen, topicBuf, payloadBuf]);

  return new Promise((resolve, reject) => {
    mqttClient.write(packet, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function connectMQTTWithAuth() {
  return new Promise((resolve, reject) => {
    const host = new URL(BACKEND_URL).hostname;
    const client = net.createConnection({ host, port: MQTT_PORT }, () => {
      console.log(`[MQTT] Conectado a ${host}:${MQTT_PORT}`);
      mqttClient = client;
      resolve();
    });

    client.on('data', (data) => {
      const firstByte = data[0];
      if (firstByte === 0x20) {
        console.log('[MQTT] ✓ CONNACK recibido');
      } else if (firstByte === 0x30) {
        console.log('[MQTT] ← PUBLISH recibido (ignorado por el simulador)');
      } else {
        console.log('[MQTT] ←', data.toString('hex').substring(0, 80));
      }
    });

    client.on('error', (err) => {
      console.error('[MQTT] Error:', err.message);
      reject(err);
    });

    client.on('close', () => {
      console.log('[MQTT] Desconectado');
      mqttClient = null;
    });

    // Enviar CONNECT packet con JWT como password
    const clientId = `sim_${BUS_ID}_${Date.now()}`;
    const clientIdBuf = Buffer.from(clientId);
    const usernameBuf = Buffer.from(PHONE);
    const passwordBuf = Buffer.from(token);

    // Calcular remaining length
    const protocolName = Buffer.from('MQTT');
    const protocolLevel = 4; // MQTT 3.1.1
    const connectFlags = 0xC2; // Clean Session + Username + Password
    const keepAlive = 60;

    let remaining =
      2 + protocolName.length + // protocol name length + name
      1 +                       // protocol level
      1 +                       // connect flags
      2 +                       // keep alive
      2 + clientIdBuf.length;   // client id

    if (connectFlags & 0x80) {
      remaining += 2 + usernameBuf.length; // username
    }
    if (connectFlags & 0x40) {
      remaining += 2 + passwordBuf.length; // password
    }

    const remainingBuf = remaining < 128
      ? Buffer.from([remaining])
      : Buffer.from([(remaining & 0x7f) | 0x80, remaining >> 7]);

    const packet = Buffer.concat([
      Buffer.from([0x10]),                                                      // CONNECT
      remainingBuf,                                                              // remaining length
      Buffer.from([0x00, protocolName.length]),                                  // protocol name length
      protocolName,                                                              // "MQTT"
      Buffer.from([protocolLevel]),                                              // protocol level
      Buffer.from([connectFlags]),                                               // connect flags
      Buffer.from([0x00, keepAlive]),                                            // keep alive
      Buffer.from([0x00, clientIdBuf.length]), clientIdBuf,                      // client id
      Buffer.from([0x00, usernameBuf.length]), usernameBuf,                      // username
      Buffer.from([0x00, passwordBuf.length]), passwordBuf,                      // password
    ]);

    client.write(packet);
  });
}

async function publishPositionWithAuth(lat, lon) {
  if (!mqttClient) return;

  const topic = `empresa/${EMPRESA_ID}/bus/${BUS_ID}/posicion`;
  const payload = JSON.stringify({
    lat,
    lon,
    heading: 45 + (step * 5 % 360),
    speedKmh: 30 + Math.random() * 15,
    timestamp: new Date().toISOString(),
  });

  const topicBuf = Buffer.from(topic);
  const payloadBuf = Buffer.from(payload);

  // PUBLISH packet (QoS 0)
  const remainingLen = 2 + topicBuf.length + payloadBuf.length;
  const remainingBuf = remainingLen < 128
    ? Buffer.from([remainingLen])
    : Buffer.from([(remainingLen & 0x7f) | 0x80, remainingLen >> 7]);

  const topicLen = Buffer.alloc(2);
  topicLen.writeUInt16BE(topicBuf.length);

  const packet = Buffer.concat([
    Buffer.from([0x30]),  // PUBLISH
    remainingBuf,
    topicLen,
    topicBuf,
    payloadBuf,
  ]);

  return new Promise((resolve) => {
    mqttClient.write(packet, resolve);
  });
}

async function run() {
  try {
    console.log('══════════════════════════════════════════');
    console.log('  YA VIENE — Simulador de Bus');
    console.log(`  Bus: ${BUS_ID} | Ruta: ${ROUTE_ID}`);
    console.log(`  Backend: ${BACKEND_URL}`);
    console.log('══════════════════════════════════════════\n');

    // 1. Registrar conductor y obtener JWT
    await registerDriver();

    // 2. Conectar MQTT con JWT
    await connectMQTTWithAuth();

    // 3. Publicar posiciones cada 2 segundos
    console.log(`\n[LOOP] Enviando posiciones cada 2s por la Calle 30...\n`);
    setInterval(async () => {
      const wp = WAYPOINTS[step % WAYPOINTS.length];
      const offsetLat = (Math.random() - 0.5) * 0.001;
      const offsetLon = (Math.random() - 0.5) * 0.001;

      await publishPositionWithAuth(wp.lat + offsetLat, wp.lon + offsetLon);

      const now = new Date().toLocaleTimeString();
      console.log(`[${now}] ${BUS_ID} → (${(wp.lat + offsetLat).toFixed(5)}, ${(wp.lon + offsetLon).toFixed(5)})`);

      step++;
    }, 2000);

  } catch (err) {
    console.error('[FATAL]', err.message);
    process.exit(1);
  }
}

run();
