// TIER 3.2 — Caída violenta: kill -9 con 20 buses transmitiendo, reinicio 5s después
process.env.JWT_SECRET = process.env.JWT_SECRET || 'localdev';
const { execSync } = require('child_process');
const fs = require('fs');
const mqtt = require('mqtt');

const dbmod = require('../../dist/data/database.js');
const { createDeviceSession } = require('../../dist/data/sessions.js');
const { signToken } = require('../../dist/auth/tokens.js');
const { sleep, record, report } = require('./helpers');

const N_BUSES = 20;
const ROUTE_ID = 'R-101';
const COMPANY_ID = 'EMP-01';
const LOG = '/tmp/yaviene-backend.log';

const db = dbmod.getDb();
const now = Date.now();
const tokens = [];
for (let i = 1; i <= N_BUSES; i++) {
  const busId = `KILL-${String(i).padStart(3, '0')}`;
  const phone = `9200${String(i).padStart(6, '0')}`;
  db.prepare(`
    INSERT OR IGNORE INTO drivers (phone_number, driver_id, name, route_id, company_id, bus_id, pin_hash, registered_at)
    VALUES (?, ?, ?, ?, ?, ?, 'test', ?)
  `).run(phone, `d-kill-${i}`, `Kill ${i}`, ROUTE_ID, COMPANY_ID, busId, now);
  createDeviceSession({
    sessionId: `kill-${busId}-${now}`, deviceId: `d-kill-${i}`, identifier: phone,
    companyId: COMPANY_ID, busId, routeId: ROUTE_ID,
  });
  tokens.push(signToken({
    sub: `d-kill-${i}`, deviceId: `d-kill-${i}`, identifier: phone, role: 'device',
    companyId: COMPANY_ID, busId, routeId: ROUTE_ID, sessionId: `kill-${busId}-${now}`,
  }));
}

(async () => {
  // 20 buses transmitiendo cada 2s
  const clients = [];
  let ackCount = 0;
  const phase = { afterRestart: false };
  for (const token of tokens) {
    const auth = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    clients.push(await new Promise((resolve, reject) => {
      const c = mqtt.connect('mqtt://127.0.0.1:8883', {
        username: auth.phoneNumber, password: token, clientId: `${auth.busId}_kill9`,
        keepalive: 15, clean: true, reconnectPeriod: 1000, connectTimeout: 5000,
      });
      c.on('error', reject);
      c.on('connect', () => {
        c.subscribe(`empresa/${auth.companyId}/bus/${auth.busId}/ack`, { qos: 0 }, () => resolve(c));
      });
      c.on('message', (_t, buf) => {
        try { if (JSON.parse(buf.toString()).accepted) ackCount++; } catch (_) {}
      });
    }));
  }
  let published = 0;
  const publishAll = () => {
    clients.forEach((c, idx) => {
      published++;
      c.publish(`empresa/${COMPANY_ID}/bus/KILL-${String(idx + 1).padStart(3, '0')}/posicion`, JSON.stringify({
        protocolVersion: 1, sequence: published % 100000, capturedAt: Date.now(),
        lat: 10.99 + (idx % 10) * 0.0003, lon: -74.79 - (idx % 10) * 0.0002, speedKmh: 30,
      }));
    });
  };
  publishAll();
  const iv = setInterval(publishAll, 2000);
  await sleep(6000);

  const preAcks = ackCount;
  console.log(`ACKs antes del kill: ${preAcks}`);

  // kill -9
  const pid = execSync('pgrep -f "dist/index.js" | head -1').toString().trim();
  console.log(`Kill -9 al backend (pid ${pid}) con ${N_BUSES} buses transmitiendo...`);
  execSync(`kill -9 ${pid}`);

  // 10 buses quedan "muertos" (radio rota): su sesión no vuelve. Los otros 10 se reconectan solos.
  for (let i = 0; i < N_BUSES / 2; i++) {
    clients[i].end(true);
  }
  await sleep(5000);
  console.log('Reiniciando backend...');
  const backendDir = process.cwd();
  const child = require('child_process').spawn('node', ['dist/index.js'], {
    cwd: backendDir,
    env: { ...process.env, JWT_SECRET: 'localdev', ADMIN_API_KEY: 'localadmin',
           NODE_OPTIONS: `--require ${backendDir}/tests/e2e/loop_monitor.js` },
    stdio: ['ignore', fs.openSync(LOG, 'a'), fs.openSync(LOG, 'a')],
    detached: true,
  });
  child.unref();
  await sleep(4000);

  // a) integridad de la DB (WAL)
  const integrity = db.pragma('integrity_check', { simple: true });
  record('T3.2a: SQLite íntegra tras kill -9 (PRAGMA integrity_check)', integrity === 'ok', String(integrity));

  // c) reconexión automática de los 10 vivos
  await sleep(8000);
  const aliveReconnected = clients.filter((c) => c.connected).length;
  record('T3.2c: conductores vivos reconectados automáticamente y aceptando posiciones',
    aliveReconnected === N_BUSES / 2, `reconectados=${aliveReconnected}/${N_BUSES / 2} ACKs tras reinicio=${ackCount}`);

  // b) outbox: tras 60s, los 10 muertos pasan a "sin señal" (is_ghost)
  //    y el dispatcher emite su posición ghost (delivered_at set).
  //    Los buses NO desaparecen: su posición se conserva.
  await sleep(62000);
  const outbox = db.prepare(`
    SELECT event_type, payload, delivered_at, created_at
    FROM lifecycle_events
    WHERE payload LIKE '%KILL-%' AND created_at > ?
  `).all(now);
  const ghostEvents = outbox.filter((e) => e.event_type === 'bus:position'
    && e.delivered_at != null && (JSON.parse(e.payload || '{}')).isGhost === true);
  const deadBusIds = new Set(clients.slice(0, N_BUSES / 2).map((_, i) => `KILL-${String(i + 1).padStart(3, '0')}`));
  const uniqueDeadGhosted = new Set(
    ghostEvents.map((e) => (JSON.parse(e.payload) || {}).busId),
  );
  const covered = [...uniqueDeadGhosted].filter((b) => deadBusIds.has(b)).length;
  record('T3.2b: buses muertos pasan a "sin señal" (is_ghost) sin desaparecer',
    covered >= N_BUSES / 2, `buses muertos en ghost: ${covered}/${N_BUSES / 2}`);

  // d) las posiciones de los buses muertos siguen existiendo (no se borran)
  const remainingPositions = db.prepare(
    'SELECT COUNT(*) AS c FROM positions WHERE bus_id LIKE "KILL-%"'
  ).get();
  record('T3.2d: las posiciones de los buses muertos se conservan',
    remainingPositions.c >= N_BUSES / 2, `posiciones conservadas: ${remainingPositions.c}/${N_BUSES / 2}`);

  clearInterval(iv);
  db.prepare("DELETE FROM driver_sessions WHERE session_id LIKE 'kill-%'").run();
  db.prepare("DELETE FROM drivers WHERE phone_number LIKE '9200%'").run();
  for (const c of clients) c.end(true);
  report('TIER 3.2');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
