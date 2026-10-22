// H-5 "Slowloris de WebSocket": clientes que reciben pero NO leen (búfer lleno).
// Verifica que el guard anti-Slowloris (bufferedAmount > 1MB) los desconecta
// y que la memoria del servidor queda acotada y el servicio sigue vivo.
// Abre 105 sockets desde esta máquina: el backend tiene que arrancar con
// YA_VIENE_MAX_SOCKETS_IP=5000, o pasado el 100 los rechaza (socket/handler.ts).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'localdev';
const { execSync } = require('child_process');
const fs = require('fs');
const WebSocket = require('ws');
const dbmod = require('../../dist/data/database.js');
const { createDeviceSession } = require('../../dist/data/sessions.js');
const { signToken } = require('../../dist/auth/tokens.js');
const mqtt = require('mqtt');
const { io } = require('socket.io-client');
const { sleep, record, report } = require('./helpers');

const N_BUSES = 300;
const N_SLOW = 100;
const N_NORMAL = 5;
const ROUTE_ID = 'R-101';
const COMPANY_ID = 'EMP-01';

const db = dbmod.getDb();
const now = Date.now();
const busSpecs = [];
for (let i = 1; i <= N_BUSES; i++) {
  const busId = `H5-${String(i).padStart(3, '0')}`;
  const phone = `9500${String(i).padStart(6, '0')}`;
  db.prepare(`
    INSERT OR IGNORE INTO drivers (phone_number, driver_id, name, route_id, company_id, bus_id, pin_hash, registered_at)
    VALUES (?, ?, ?, ?, ?, ?, 'test', ?)
  `).run(phone, `d-h5-${i}`, `H5 ${i}`, ROUTE_ID, COMPANY_ID, busId, now);
  createDeviceSession({
    sessionId: `h5-${busId}-${now}`, deviceId: `d-h5-${i}`, identifier: phone,
    companyId: COMPANY_ID, busId, routeId: ROUTE_ID,
  });
  busSpecs.push({
    busId, phone,
    token: signToken({
      sub: `d-h5-${i}`, driverId: `d-h5-${i}`, phoneNumber: phone, role: 'driver',
      companyId: COMPANY_ID, busId, routeId: ROUTE_ID, sessionId: `h5-${busId}-${now}`,
    }),
  });
}

// ── Handshake engine.io/socket.io "a mano" (protocolo EIO=4) ──
function rawSocketioClient(routeId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:3000/ws/?EIO=4&transport=websocket`);
    let opened = false;
    ws.on('message', (data) => {
      const msg = data.toString();
      if (msg.startsWith('0')) { ws.send('40'); }                        // engine.io open -> CONNECT
      else if (msg.startsWith('40') && !opened) {                        // CONNECT ack -> suscribirse YA
        opened = true;
        ws.send(`42["subscribe:route","${routeId}"]`);
        ws.emit('socketio-ready');
      } else if (msg.startsWith('42')) {
        ws.emit('io-message', msg.slice(2));
      } else if (msg.startsWith('2') && opened) { ws.send('3'); }        // ping -> pong
    });
    ws.once('socketio-ready', () => resolve(ws));
    ws.on('error', reject);
  });
}

(async () => {
  const pid = execSync('pgrep -f "dist/index.js" | head -1').toString().trim();
  const rss = () => parseInt(execSync(`ps -p ${pid} -o rss= | tr -d ' '`).toString().trim(), 10) / 1024;
  const rssBefore = rss();
  const logBefore = fs.statSync('/tmp/yaviene-backend.log').size;

  // 1. Buses publicando a R-101 (1 pos/s c/u) — tráfico para llenar búferes
  const clients = [];
  for (const spec of busSpecs) {
    clients.push(await new Promise((resolve, reject) => {
      const c = mqtt.connect('mqtt://127.0.0.1:8883', {
        username: spec.phone, password: spec.token, clientId: `${spec.busId}_h5`,
        keepalive: 15, clean: true,
      });
      c.on('error', reject);
      c.on('connect', () => resolve(c));
    }));
  }
  const topic = (i) => `empresa/${COMPANY_ID}/bus/${busSpecs[i].busId}/posicion`;
  const seq = new Array(N_BUSES).fill(1);
  const pubTimer = setInterval(() => {
    for (let i = 0; i < N_BUSES; i++) {
      clients[i].publish(topic(i), JSON.stringify({
        protocolVersion: 1, sequence: seq[i]++, capturedAt: Date.now(),
        lat: 10.99 + (i % 20) * 0.0004, lon: -74.79 - (i % 20) * 0.0003, speedKmh: 30,
      }));
    }
  }, 100);

  // 2. Clientes normales (control)
  const normals = [];
  for (let i = 0; i < N_NORMAL; i++) {
    normals.push(await new Promise((resolve, reject) => {
      const s = io('http://127.0.0.1:3000', { path: '/ws', transports: ['websocket'], reconnection: false, forceNew: true });
      s.on('connect', () => { s.emit('subscribe:route', ROUTE_ID); resolve(s); });
      s.on('connect_error', reject);
    }));
  }
  let normalReceived = 0;
  let normalLast = Date.now();
  for (const n of normals) {
    n.on('positions:update', () => { normalReceived++; normalLast = Date.now(); });
    n.on('bus:position', () => { normalReceived++; normalLast = Date.now(); });
  }

  // 3. Slowloris: 100 clientes que se suscriben y luego dejan de leer
  const slows = [];
  for (let i = 0; i < N_SLOW; i++) {
    const ws = await rawSocketioClient(ROUTE_ID);
    await sleep(20);
    ws._socket.pause();
    slows.push(ws);
  }
  const tSlowStart = Date.now();

  // Monitoreo
  const peak = { rss: rssBefore };
  const monitor = setInterval(() => { peak.rss = Math.max(peak.rss, rss()); }, 1000);

  // Los lentos nunca confirman ping: engine.io los cerraría por timeout (~15s).
  // El guard los cierra al superar 1MB en búfer (~450KB/s por socket -> ~3s).
  await sleep(18000);
  clearInterval(monitor);
  const rssDuring = peak.rss - rssBefore;
  await sleep(3000);
  const rssAfter = rss() - rssBefore;

  const tail = fs.readFileSync('/tmp/yaviene-backend.log', 'utf8').slice(logBefore);
  const guardCloses = (tail.match(/Slow consumer detected/g) || []).length;
  const alive = await new Promise((resolve) => {
    const probe = io('http://127.0.0.1:3000', { path: '/ws', transports: ['websocket'], reconnection: false });
    probe.on('connect', () => { probe.disconnect(); resolve(true); });
    probe.on('connect_error', () => resolve(false));
  });

  console.log(`\n── RESULTADOS H-5 ──`);
  console.log(`Slow consumers desconectados por el guard: ${guardCloses}/${N_SLOW}`);
  console.log(`RSS: base ${rssBefore.toFixed(0)}MB -> pico +${rssDuring.toFixed(0)}MB -> tras cierre +${rssAfter.toFixed(0)}MB`);
  console.log(`Clientes normales: ${normalReceived} eventos recibidos, último hace ${Date.now() - normalLast}ms`);
  console.log(`Servidor sigue vivo: ${alive}`);

  record('H-5: el guard desconectó a los consumidores lentos (>1MB en búfer)', guardCloses >= 80, `${guardCloses}/${N_SLOW}`);
  record('H-5: memoria acotada durante el ataque (pico < 250MB de delta)', rssDuring < 250, `pico +${rssDuring.toFixed(0)}MB`);
  record('H-5: clientes normales siguieron recibiendo posiciones', normalReceived > 0 && Date.now() - normalLast < 3000, `${normalReceived} eventos`);
  record('H-5: el servidor no se cayó', alive === true, `alive=${alive}`);

  clearInterval(pubTimer);
  for (const c of clients) c.end(true);
  for (const n of normals) n.disconnect();
  for (const w of slows) { try { w.terminate(); } catch {} }
  db.prepare("DELETE FROM driver_sessions WHERE session_id LIKE 'h5-%'").run();
  db.prepare("DELETE FROM drivers WHERE phone_number LIKE '9500%'").run();
  db.prepare("DELETE FROM positions WHERE device_id LIKE '9500%'").run();
  report('H-5');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
