const mqtt = require('mqtt');
const { io } = require('socket.io-client');

const HTTP_BASE = process.env.HTTP_BASE || 'http://127.0.0.1:3000';
const MQTT_URL = process.env.MQTT_URL || 'mqtt://127.0.0.1:8883';
const WS_URL = process.env.WS_URL || 'http://127.0.0.1:3000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loginDriver(phoneNumber, pin = '1234', extra = {}) {
  const res = await fetch(`${HTTP_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber, pin, ...extra }),
  });
  const body = await res.json();
  return { status: res.status, ...body };
}

function decodeToken(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
}

function connectBus(token, busId) {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(MQTT_URL, {
      username: decodeToken(token).phoneNumber,
      password: token,
      clientId: `${busId}_${Date.now()}_${Math.floor(Math.random() * 99999)}`,
      keepalive: 15,
      clean: true,
      reconnectPeriod: 500,
      connectTimeout: 5000,
    });
    client.on('error', (err) => reject(err));
    client.on('connect', () => {
      const auth = decodeToken(token);
      client.subscribe(`empresa/${auth.companyId}/bus/${auth.busId}/ack`, { qos: 0 }, (err) => {
        if (err) return reject(err);
        resolve(client);
      });
    });
    client.on('close', () => {});
  });
}

function publishPosition(client, topicParts, opts = {}) {
  const [companyId, busId, routeId] = topicParts;
  const seq = opts.sequence ?? (client.__seq = (client.__seq || 0) + 1);
  const payload = JSON.stringify({
    protocolVersion: 1,
    sequence: seq,
    capturedAt: opts.capturedAt ?? Date.now(),
    lat: opts.lat ?? 10.99,
    lon: opts.lon ?? -74.79,
    speedKmh: opts.speedKmh ?? 32,
  });
  client.publish(`empresa/${companyId}/bus/${busId}/posicion`, payload, { qos: 0 });
  return { seq, payload: JSON.parse(payload) };
}

function connectPassenger(routeId, opts = {}) {
  return new Promise((resolve) => {
    const socket = io(WS_URL, {
      path: '/ws',
      transports: ['websocket'],
      reconnection: false,
      auth: opts.auth || {},
    });
    socket.on('connect', () => {
      socket.emit('subscribe:route', routeId);
      socket.on('positions:batch', () => {});
      resolve(socket);
    });
  });
}

const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
}

function report(label) {
  const fails = results.filter((r) => !r.pass);
  console.log(`\n=== ${label}: ${results.length - fails.length}/${results.length} PASS ===`);
  if (fails.length) {
    for (const f of fails) console.log(`  FAIL: ${f.name} | ${f.detail}`);
  }
  process.exit(fails.length ? 1 : 0);
}

module.exports = {
  HTTP_BASE, MQTT_URL, WS_URL, sleep, loginDriver, decodeToken,
  connectBus, publishPosition, connectPassenger, record, report,
};
