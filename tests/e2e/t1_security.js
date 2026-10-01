process.env.JWT_SECRET = process.env.JWT_SECRET || 'localdev';
const jwt = require('jsonwebtoken');
const mqtt = require('mqtt');
const {
  sleep, loginDriver, decodeToken, connectBus, publishPosition,
  connectPassenger, record, report, MQTT_URL,
} = require('./helpers');

const SECRET = process.env.JWT_SECRET;
const DRIVER_A = '3000000000'; // bus BUS-WFK042
const OTHER_BUS = 'B-PHASE3';  // bus objetivo del hijack
const OTHER_PHONE = 'phase3driver';

async function t1_1_topic_hijack() {
  console.log('\n── T1.1 Topic hijacking (driver A publica en topic de B) ──');
  const { token } = await loginDriver(DRIVER_A, '1234');
  const auth = decodeToken(token);
  const client = await connectBus(token, auth.busId);
  await sleep(300);

  const closed = new Promise((resolve) => {
    client.on('close', () => resolve(true));
    setTimeout(() => resolve(false), 4000);
  });

  // El driver A intenta publicar en el topic del bus B
  const hijackPayload = {
    protocolVersion: 1,
    sequence: 1,
    capturedAt: Date.now(),
    lat: 10.99,
    lon: -74.79,
    speedKmh: 30,
    busId: OTHER_BUS,
  };
  client.publish(`empresa/${auth.companyId}/bus/${OTHER_BUS}/posicion`, JSON.stringify(hijackPayload));

  const wasClosed = await closed;
  record('T1.1: el socket del conductor A fue desconectado tras publicar en topic ajeno', wasClosed);

  let stillAlive = false;
  try {
    client.publish(`empresa/${auth.companyId}/bus/${auth.busId}/posicion`, JSON.stringify({ ...hijackPayload, busId: auth.busId }));
    await sleep(500);
    stillAlive = client.connected;
  } catch (_) {}
  record('T1.1: A ya no puede transmitir desde su propio topic tras el hijack', !stillAlive);
  client.end(true);
}

async function t1_2_socket_injection() {
  console.log('\n── T1.2 Inyección de eventos en WebSocket (pasajero emit bus:position) ──');
  const { io } = require('socket.io-client');
  const socket = io('http://127.0.0.1:3000', {
    path: '/ws', transports: ['websocket'], reconnection: false,
  });
  await new Promise((r) => socket.on('connect', r));

  let kicked = null;
  socket.on('disconnect', (reason) => { kicked = reason; });
  socket.on('server:error', (data) => { record('T1.2: pasajero recibió server:error', !!data?.message); });

  socket.emit('bus:position', { busId: 'BUS-WFK042', lat: 10.99, lon: -74.79 });
  socket.emit('bus:left', { busId: 'BUS-WFK042' });

  await sleep(1500);
  record('T1.2: pasajero fue desconectado (disconnect(true)) tras emitir bus:position', kicked !== null, `reason=${kicked}`);
  socket.disconnect();
}

async function t1_3_anti_gps_spoof() {
  console.log('\n── T1.3 Anti-GPS spoofing (teletransportación 10km en 1s) ──');
  const { token } = await loginDriver(DRIVER_A, '1234');
  const auth = decodeToken(token);
  const client = await connectBus(token, auth.busId);
  await sleep(300);

  // Pasajero escuchando la ruta
  const passenger = await connectPassenger('R-101');
  const received = [];
  passenger.on('bus:position', (p) => received.push(p));

  const acks = [];
  client.on('message', (_t, buf) => acks.push(JSON.parse(buf.toString())));

  // Posición válida (UniNorte aprox. 11.0200, -74.8514; centro 10.9600, -74.8000)
  publishPosition(client, [auth.companyId, auth.busId, auth.routeId], {
    lat: 11.02, lon: -74.8514, speedKmh: 30, capturedAt: Date.now(),
  });
  await sleep(1500);

  // Teletransportación: ~9km en 1 segundo
  publishPosition(client, [auth.companyId, auth.busId, auth.routeId], {
    lat: 10.96, lon: -74.8, speedKmh: 30, capturedAt: Date.now(),
  });
  await sleep(1500);

  const spoofAck = acks.find((a) => a.sequence === 2);
  record('T1.3: backend rechazó el paquete teletransportado (SANITY)', spoofAck && spoofAck.accepted === false, spoofAck ? `reason=${spoofAck.reason}` : 'sin ACK');
  const spoofedDelivered = received.some((p) => Math.abs(p.lat - 10.96) < 0.0001);
  record('T1.3: posición falsa NO fue retransmitida al pasajero', !spoofedDelivered);

  client.end(true);
  passenger.disconnect();
}

async function t1_4_jwt_and_session() {
  console.log('\n── T1.4 JWT manipulado / expirado / ownership de sesión ──');
  const { token } = await loginDriver(DRIVER_A, '1234');

  // 1. Firma alterada (1 carácter)
  const tampered = token.slice(0, -3) + (token.endsWith('a') ? 'b' : 'a');
  const bad = await new Promise((resolve) => {
    const c = mqtt.connect(MQTT_URL, {
      username: DRIVER_A, password: tampered, clientId: 'tamper_1',
      connectTimeout: 3000, reconnectPeriod: 0,
    });
    c.on('error', () => resolve('error'));
    c.on('connect', () => { c.end(); resolve('connected'); });
  });
  record('T1.4a: JWT con firma alterada es rechazado en MQTT', bad !== 'connected', bad);

  // 2. JWT expirado (firmado con expiresIn negativo)
  const expired = jwt.sign({
    sub: 'd1', driverId: 'd1', phoneNumber: DRIVER_A, role: 'driver',
    companyId: 'EMP-01', busId: 'BUS-WFK042', routeId: 'R-101', sessionId: 'expired-sess',
  }, SECRET, { expiresIn: '-60s', issuer: 'ya-viene-backend', audience: 'ya-viene-mqtt' });
  const bad2 = await new Promise((resolve) => {
    const c = mqtt.connect(MQTT_URL, {
      username: DRIVER_A, password: expired, clientId: 'expired_1',
      connectTimeout: 3000, reconnectPeriod: 0,
    });
    c.on('error', () => resolve('error'));
    c.on('connect', () => { c.end(); resolve('connected'); });
  });
  record('T1.4b: JWT expirado es rechazado en MQTT', bad2 !== 'connected', bad2);

  // 3. Ownership: segundo celular revoca el primero
  const t1 = await loginDriver(DRIVER_A, '1234');
  const a1 = decodeToken(t1.token);
  const phone1 = await connectBus(t1.token, a1.busId);
  await sleep(300);

  const t2 = await loginDriver(DRIVER_A, '1234');
  const a2 = decodeToken(t2.token);
  const phone2 = await connectBus(t2.token, a2.busId);
  await sleep(300);
  const ack2 = [];
  phone2.on('message', (_t, buf) => ack2.push(JSON.parse(buf.toString())));
  publishPosition(phone2, [a2.companyId, a2.busId, a2.routeId]);
  await sleep(800);

  const p1closed = await new Promise((resolve) => {
    phone1.on('close', () => resolve(true));
    setTimeout(() => resolve(false), 9000); // sweep cada 5s
  });
  record('T1.4c: primer celular fue desconectado tras login del segundo (sweep ≤5s)', p1closed);

  const p2alive = phone2.connected;
  const p2acked = ack2.some((a) => a.accepted === true);
  record('T1.4c: segundo celular mantiene el control y transmite', p2alive && p2acked);
  phone1.end(true);
  phone2.end(true);
}

(async () => {
  await t1_1_topic_hijack();
  await t1_2_socket_injection();
  await t1_3_anti_gps_spoof();
  await t1_4_jwt_and_session();
  report('TIER 1');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
