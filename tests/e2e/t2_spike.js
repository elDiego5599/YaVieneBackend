// TIER 2.1 — Spike test: 200 buses (100 pos/s) + 2,000 pasajeros en Socket.io
// Abre 2 000 sockets desde esta máquina: el backend tiene que arrancar con
// YA_VIENE_MAX_SOCKETS_IP=5000, o pasado el 100 los rechaza (socket/handler.ts).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'localdev';

const { execSync } = require('child_process');

// Preparar drivers sintéticos en la DB (módulo compilado)
const dbmod = require('../../dist/data/database.js');
const { createDeviceSession } = require('../../dist/data/sessions.js');
const { signToken } = require('../../dist/auth/tokens.js');
const mqtt = require('mqtt');
const { io } = require('socket.io-client');

const N_BUSES = parseInt(process.env.N_BUSES || '200', 10);
const N_PASSENGERS = parseInt(process.env.N_PASSENGERS || '2000', 10);
const DURATION_MS = parseInt(process.env.DURATION_MS || '30000', 10);
const PUB_INTERVAL_MS = 2000; // cada bus 1 posición / 2s → 100 pos/s con 200 buses
const ROUTE_ID = 'R-101';
const COMPANY_ID = 'EMP-01';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = dbmod.getDb();
const now = Date.now();
const busIds = [];
for (let i = 1; i <= N_BUSES; i++) {
  const busId = `S-${String(i).padStart(4, '0')}`;
  busIds.push(busId);
  db.prepare(`
    INSERT OR IGNORE INTO drivers (phone_number, driver_id, name, route_id, company_id, bus_id, pin_hash, registered_at)
    VALUES (?, ?, ?, ?, ?, ?, 'test', ?)
  `).run(`9000${String(i).padStart(6, '0')}`, `d-spike-${i}`, `Driver ${i}`, ROUTE_ID, COMPANY_ID, busId, now);
}

const tokens = busIds.map((busId, i) => {
  const sessionId = `spike-${busId}-${now}`;
  createDeviceSession({
    sessionId, deviceId: `d-spike-${i + 1}`, identifier: `9000${String(i + 1).padStart(6, '0')}`,
    companyId: COMPANY_ID, busId, routeId: ROUTE_ID,
  });
  return signToken({
    sub: `d-spike-${i + 1}`, deviceId: `d-spike-${i + 1}`, identifier: `9000${String(i + 1).padStart(6, '0')}`,
    role: 'device', companyId: COMPANY_ID, busId, routeId: ROUTE_ID, sessionId,
  });
});

(async () => {
  console.log(`Spike: ${N_BUSES} buses @ 1 pos/2s = ${N_BUSES / PUB_INTERVAL_MS * 1000} pos/s + ${N_PASSENGERS} pasajeros, ${DURATION_MS / 1000}s`);

  // ── Pasajeros (muestra de 40 registran latencia; el resto solo se conectan) ──
  const latencySamples = [];
  const sampleSet = new Set();
  while (sampleSet.size < 40) sampleSet.add(Math.floor(Math.random() * N_PASSENGERS));
  let receivedCount = 0;
  let deliveredLatencySum = 0;
  let deliveredLatencyMax = 0;
  let passengerErrors = 0;

  const passengerPromises = [];
  for (let p = 0; p < N_PASSENGERS; p++) {
    passengerPromises.push(new Promise((resolve) => {
      const s = io('http://127.0.0.1:3000', { path: '/ws', transports: ['websocket'], reconnection: false });
      let settled = false;
      const done = (socket) => { if (!settled) { settled = true; resolve(socket); } };
      s.on('connect', () => {
        s.emit('subscribe:route', ROUTE_ID);
        s.on('positions:batch', () => {});
        if (sampleSet.has(p)) {
          const onPos = (pos) => {
            const lat = Date.now() - pos.receivedAt;
            if (!Number.isFinite(lat) || lat < 0) return;
            receivedCount++;
            deliveredLatencySum += lat;
            if (lat > deliveredLatencyMax) deliveredLatencyMax = lat;
            latencySamples.push(lat);
          };
          s.on('bus:position', onPos);
          s.on('positions:update', (data) => {
            const buses = data?.buses;
            if (Array.isArray(buses)) for (const b of buses) onPos(b);
          });
        }
        done(s);
      });
      s.on('connect_error', () => { if (!settled) passengerErrors++; done(null); });
      setTimeout(() => { if (!settled) passengerErrors++; done(null); }, 15000);
    }));
  }
  const passengerSockets = (await Promise.all(passengerPromises)).filter(Boolean);
  console.log(`Pasajeros conectados: ${passengerSockets.length}/${N_PASSENGERS}`);
  await sleep(2000);

  // ── Buses MQTT ──
  const busClients = [];
  for (const token of tokens) {
    const auth = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    busClients.push(new Promise((resolve, reject) => {
      const c = mqtt.connect('mqtt://127.0.0.1:8883', {
        username: auth.phoneNumber, password: token,
        clientId: `${auth.busId}_${Date.now()}`, keepalive: 15, clean: true,
        reconnectPeriod: 500, connectTimeout: 5000,
      });
      c.on('error', reject);
      c.on('connect', () => {
        c.subscribe(`empresa/${auth.companyId}/bus/${auth.busId}/ack`, { qos: 0 }, (err) => {
          if (err) return reject(err);
          resolve(c);
        });
      });
    }));
  }
  const clients = await Promise.all(busClients);
  console.log(`Buses conectados: ${clients.length}/${N_BUSES}`);
  await sleep(1000);

  // ── Monitores ──
  const backendPid = execSync('pgrep -f "dist/index.js" | head -1').toString().trim();
  const cpuSamples = [];
  const cpuTimer = setInterval(() => {
    try {
      const out = execSync(`ps -p ${backendPid} -o %cpu= | tr -d ' '`).toString().trim();
      cpuSamples.push(parseFloat(out));
    } catch (_) {}
  }, 2000);

  // ── Pico: todos transmiten ──
  let published = 0;
  let ackAccepted = 0;
  for (const c of clients) {
    c.setMaxListeners(50);
    c.on('message', (_t, buf) => {
      try {
        const ack = JSON.parse(buf.toString());
        if (ack.accepted === true) ackAccepted++;
      } catch (_) {}
    });
  }
  const pubStart = Date.now();
  const ramp = clients.map((c, idx) => {
    return (async () => {
      const topic = `empresa/${COMPANY_ID}/bus/${busIds[idx]}/posicion`;
      let seq = 0;
      while (Date.now() - pubStart < DURATION_MS) {
        seq++;
        published++;
        const payload = JSON.stringify({
          protocolVersion: 1, sequence: seq, capturedAt: Date.now(),
          lat: 10.99 + (idx % 50) * 0.00005, lon: -74.79 - (idx % 50) * 0.00005,
          speedKmh: 30,
        });
        await new Promise((r) => c.publish(topic, payload, { qos: 0 }, r));
        await sleep(PUB_INTERVAL_MS);
      }
    })();
  });
  await Promise.all(ramp);
  const elapsedSec = (Date.now() - pubStart) / 1000;
  clearInterval(cpuTimer);

  // ── Resultados ──
  const p50 = [...latencySamples].sort((a, b) => a - b)[Math.floor(latencySamples.length * 0.5)] || 0;
  const p95 = [...latencySamples].sort((a, b) => a - b)[Math.floor(latencySamples.length * 0.95)] || 0;
  const mean = latencySamples.length ? deliveredLatencySum / latencySamples.length : 0;
  const avgCpu = cpuSamples.length ? cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length : 0;
  const maxCpu = cpuSamples.length ? Math.max(...cpuSamples) : 0;
  const throughput = published / elapsedSec;

  console.log(`\n── RESULTADOS SPIKE ──`);
  console.log(`Publicados: ${published} (${throughput.toFixed(1)} pos/s)`);
  console.log(`ACKs aceptados: ${ackAccepted}`);
  console.log(`Latencia (muestra ${latencySamples.length} entregas): media=${mean.toFixed(0)}ms p50=${p50}ms p95=${p95}ms max=${deliveredLatencyMax}ms`);
  console.log(`CPU backend: media=${avgCpu.toFixed(1)}% max=${maxCpu.toFixed(1)}%`);
  console.log(`Pasajeros: conectados=${passengerSockets.length} errores=${passengerErrors}`);

  const passLatency = p95 < 200 && mean < 200;
  const passThroughput = Math.abs(throughput - N_BUSES / PUB_INTERVAL_MS * 1000) / (N_BUSES / PUB_INTERVAL_MS * 1000) < 0.1;
  const passCpu = maxCpu < 60;
  const passPassengers = passengerSockets.length >= N_PASSENGERS * 0.95;

  console.log(`\nCriterios: latencia_p95<200ms:${passLatency} | throughput_≈100pos/s:${passThroughput} | CPU<60%:${passCpu} | pasajeros≥95%:${passPassengers}`);

  for (const s of passengerSockets) s.disconnect();
  for (const c of clients) c.end(true);
  process.exit(passLatency && passCpu && passPassengers ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
