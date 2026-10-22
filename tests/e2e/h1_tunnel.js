// H-1 "Túnel de Soledad": 50 buses sin señal 3 min, replay de 100 posiciones c/u (5,000 paquetes en <1s)
process.env.JWT_SECRET = process.env.JWT_SECRET || 'localdev';
const { execSync } = require('child_process');
const { monitorEventLoopDelay } = require('perf_hooks');

const dbmod = require('../../dist/data/database.js');
const { createDriverSession } = require('../../dist/data/sessions.js');
const { signToken } = require('../../dist/auth/tokens.js');
const mqtt = require('mqtt');
const { io } = require('socket.io-client');
const { sleep, record, report, connectPassenger } = require('./helpers');

const N_BUSES = 50;
const REPLAY_PER_BUS = 100;
const ROUTE_ID = 'R-101';
const COMPANY_ID = 'EMP-01';
const CAPTURE_SPACING_MS = 1800; // 100 pos en ~3 min

const db = dbmod.getDb();
const now = Date.now();
const busSpecs = [];
for (let i = 1; i <= N_BUSES; i++) {
  const busId = `H1-${String(i).padStart(3, '0')}`;
  const phone = `9300${String(i).padStart(6, '0')}`;
  db.prepare(`
    INSERT OR IGNORE INTO drivers (phone_number, driver_id, name, route_id, company_id, bus_id, pin_hash, registered_at)
    VALUES (?, ?, ?, ?, ?, ?, 'test', ?)
  `).run(phone, `d-h1-${i}`, `H1 ${i}`, ROUTE_ID, COMPANY_ID, busId, now);
  // El ingreso rechaza con BUS_NOT_FOUND a un bus que no está en el
  // catálogo; sin esta fila el replay entero volvía rechazado.
  db.prepare(`
    INSERT OR IGNORE INTO buses (bus_id, company_id, route_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(busId, COMPANY_ID, ROUTE_ID, now, now);
  createDriverSession({
    sessionId: `h1-${busId}-${now}`, driverId: `d-h1-${i}`, phoneNumber: phone,
    companyId: COMPANY_ID, busId, routeId: ROUTE_ID,
  });
  busSpecs.push({
    busId, phone,
    token: signToken({
      sub: `d-h1-${i}`, driverId: `d-h1-${i}`, phoneNumber: phone, role: 'driver',
      companyId: COMPANY_ID, busId, routeId: ROUTE_ID, sessionId: `h1-${busId}-${now}`,
    }),
  });
}

(async () => {
  const clients = [];
  for (const spec of busSpecs) {
    clients.push(await new Promise((resolve, reject) => {
      const c = mqtt.connect('mqtt://127.0.0.1:8883', {
        username: spec.phone, password: spec.token, clientId: `${spec.busId}_h1`,
        keepalive: 15, clean: true,
      });
      c.on('error', reject);
      c.on('connect', () => {
        c.subscribe(`empresa/${COMPANY_ID}/bus/${spec.busId}/ack`, { qos: 0 }, () => resolve(c));
      });
    }));
  }
  const ackStates = new Map(clients.map((c, i) => [i, { accepted: 0, rejected: 0, reasons: {} }]));
  clients.forEach((c, i) => {
    c.on('message', (_t, buf) => {
      const ack = JSON.parse(buf.toString());
      const st = ackStates.get(i);
      if (ack.accepted) st.accepted++;
      else {
        st.rejected++;
        st.reasons[ack.reason] = (st.reasons[ack.reason] || 0) + 1;
      }
    });
  });
  const topic = (i) => `empresa/${COMPANY_ID}/bus/${busSpecs[i].busId}/posicion`;

  // Pasajero midiendo latencia
  const passenger = await connectPassenger(ROUTE_ID);
  const latSamples = [];
  passenger.on('bus:position', (p) => {
    const lat = Date.now() - p.receivedAt;
    if (Number.isFinite(lat) && lat >= 0) latSamples.push(lat);
  });
  passenger.on('positions:update', (d) => {
    if (Array.isArray(d?.buses)) for (const b of d.buses) {
      const lat = Date.now() - b.receivedAt;
      if (Number.isFinite(lat) && lat >= 0) latSamples.push(lat);
    }
  });

  const loopHist = monitorEventLoopDelay({ resolution: 10 });
  loopHist.enable();
  const pid = execSync('pgrep -f "dist/index.js" | head -1').toString().trim();
  const rss = () => parseInt(execSync(`ps -p ${pid} -o rss= | tr -d ' '`).toString().trim(), 10);

  // Fase 1: 3 posiciones en vivo (seq 1..3) — capturadas ANTES del túnel
  const tunnelStart = Date.now() - (REPLAY_PER_BUS + 1) * CAPTURE_SPACING_MS;
  for (let i = 0; i < N_BUSES; i++) {
    for (let s = 1; s <= 3; s++) {
      clients[i].publish(topic(i), JSON.stringify({
        protocolVersion: 1, sequence: s, capturedAt: tunnelStart - (4 - s) * 1000,
        lat: 10.99 + (i % 20) * 0.0004, lon: -74.79 - (i % 20) * 0.0003, speedKmh: 30,
      }));
    }
  }
  await sleep(2500);
  const acceptedLive = [...ackStates.values()].reduce((a, s) => a + s.accepted, 0);

  // Fase 2: los 50 salen del túnel juntos — replay de 100 pos c/u en orden cronológico,
  // capturedAt desde tunnelStart hasta ~ahora (dentro de la ventana de 15 min)
  const replayStart = Date.now();
  for (let i = 0; i < N_BUSES; i++) {
    for (let s = 4; s <= 4 + REPLAY_PER_BUS - 1; s++) {
      const capturedAt = tunnelStart + (s - 4) * CAPTURE_SPACING_MS;
      clients[i].publish(topic(i), JSON.stringify({
        protocolVersion: 1, sequence: s, capturedAt,
        lat: 10.99 + (i % 20) * 0.0004 + (s % 5) * 0.00001,
        lon: -74.79 - (i % 20) * 0.0003 + (s % 5) * 0.00001,
        speedKmh: 30,
      }));
    }
  }
  const replayMs = Date.now() - replayStart;
  await sleep(4000);

  const totals = { accepted: 0, rejected: 0, reasons: {} };
  for (const st of ackStates.values()) {
    totals.accepted += st.accepted;
    totals.rejected += st.rejected;
    for (const [k, v] of Object.entries(st.reasons)) totals.reasons[k] = (totals.reasons[k] || 0) + v;
  }
  const acceptedReplay = totals.accepted - acceptedLive;
  loopHist.disable();

  // Fase 3: posiciones en vivo DESPUÉS del replay (seq 105)
  const latBefore = latSamples.length;
  for (let i = 0; i < N_BUSES; i++) {
    clients[i].publish(topic(i), JSON.stringify({
      protocolVersion: 1, sequence: 4 + REPLAY_PER_BUS + 1, capturedAt: Date.now(),
      lat: 10.99 + (i % 20) * 0.0004, lon: -74.79 - (i % 20) * 0.0003, speedKmh: 30,
    }));
  }
  await sleep(1500);
  const liveAfter = latSamples.slice(latBefore);
  const liveLatMax = liveAfter.length ? Math.max(...liveAfter) : -1;

  console.log(`\n── RESULTADOS H-1 ──`);
  console.log(`Replay: 5,000 paquetes descargados en ${replayMs}ms (${(5000 / (replayMs / 1000)).toFixed(0)} pkt/s)`);
  console.log(`ACKs: aceptados ${totals.accepted} | rechazados ${totals.rejected} ${JSON.stringify(totals.reasons)}`);
  console.log(`Replay aceptado: ${acceptedReplay}/${N_BUSES * REPLAY_PER_BUS}`);
  console.log(`Event loop backend: p50=${(loopHist.percentile(50) / 1e6).toFixed(1)}ms max=${(loopHist.max / 1e6).toFixed(1)}ms`);
  console.log(`Latencia WebSocket tras replay: max=${liveLatMax}ms (n=${liveAfter.length})`);

  record('H-1: los 5,000 paquetes del túnel fueron procesados y aceptados', acceptedReplay === N_BUSES * REPLAY_PER_BUS,
    `${acceptedReplay}/${N_BUSES * REPLAY_PER_BUS}`);
  record('H-1: sin rechazos por secuencia/orden (duplicados descartados correctamente)', totals.reasons['DUPLICATE'] === undefined || totals.reasons['DUPLICATE'] === 0, JSON.stringify(totals.reasons));
  record('H-1: latencia WebSocket en vivo < 300ms tras el replay', liveLatMax >= 0 && liveLatMax < 300, `max=${liveLatMax}ms`);

  db.prepare("DELETE FROM driver_sessions WHERE session_id LIKE 'h1-%'").run();
  db.prepare("DELETE FROM drivers WHERE phone_number LIKE '9300%'").run();
  db.prepare("DELETE FROM buses WHERE bus_id LIKE 'H1-%'").run();
  db.prepare("DELETE FROM positions WHERE device_id LIKE '9300%'").run();
  for (const c of clients) c.end(true);
  passenger.disconnect();
  report('H-1');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
