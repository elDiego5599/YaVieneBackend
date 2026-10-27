// TIER 2.2 — Soak test (acortado a 10 min; el protocolo pide 24h)
// 50 buses transmitiendo sin parar. Señales: RSS plana (sin leaks) + WAL sin inflarse.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'localdev';
const { execSync } = require('child_process');
const fs = require('fs');

const dbmod = require('../../dist/data/database.js');
const { createDeviceSession } = require('../../dist/data/sessions.js');
const { signToken } = require('../../dist/auth/tokens.js');
const mqtt = require('mqtt');

const N_BUSES = 50;
const INTERVAL_MS = 5000; // 10 pos/s total
const DURATION_MS = parseInt(process.env.SOAK_MS || (10 * 60 * 1000), 10);
const ROUTE_ID = 'R-101';
const COMPANY_ID = 'EMP-01';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WAL_PATH = 'data/yaviene.db-wal';

const db = dbmod.getDb();
const now = Date.now();
for (let i = 1; i <= N_BUSES; i++) {
  const busId = `SOAK-${String(i).padStart(3, '0')}`;
  db.prepare(`
    INSERT OR IGNORE INTO drivers (phone_number, driver_id, name, route_id, company_id, bus_id, pin_hash, registered_at)
    VALUES (?, ?, ?, ?, ?, ?, 'test', ?)
  `).run(`9100${String(i).padStart(6, '0')}`, `d-soak-${i}`, `Soak ${i}`, ROUTE_ID, COMPANY_ID, busId, now);
  createDeviceSession({
    sessionId: `soak-${busId}-${now}`, deviceId: `d-soak-${i}`,
    identifier: `9100${String(i).padStart(6, '0')}`, companyId: COMPANY_ID,
    busId, routeId: ROUTE_ID,
  });
}

(async () => {
  const backendPid = execSync('pgrep -f "dist/index.js" | head -1').toString().trim();
  const rss = (pid) => parseInt(execSync(`ps -p ${pid} -o rss= | tr -d ' '`).toString().trim(), 10) * 1024;
  const walSize = () => (fs.existsSync(WAL_PATH) ? fs.statSync(WAL_PATH).size : 0);

  const clients = [];
  for (let i = 1; i <= N_BUSES; i++) {
    const busId = `SOAK-${String(i).padStart(3, '0')}`;
    const auth = { phoneNumber: `9100${String(i).padStart(6, '0')}`, busId, companyId: COMPANY_ID, routeId: ROUTE_ID };
    const token = signToken({
      sub: `d-soak-${i}`, deviceId: `d-soak-${i}`, identifier: auth.phoneNumber,
      role: 'device', companyId: COMPANY_ID, busId, routeId: ROUTE_ID,
      sessionId: `soak-${busId}-${now}`,
    });
    clients.push(new Promise((resolve, reject) => {
      const c = mqtt.connect('mqtt://127.0.0.1:8883', {
        username: auth.phoneNumber, password: token, clientId: `${busId}_soak`, keepalive: 15, clean: true,
      });
      c.on('error', reject);
      c.on('connect', () => resolve(c));
    }));
  }
  const all = await Promise.all(clients);
  console.log(`Soak: ${N_BUSES} buses @ ${INTERVAL_MS}ms = ${(N_BUSES / INTERVAL_MS * 1000).toFixed(1)} pos/s durante ${DURATION_MS / 60000} min`);

  const rssStart = rss(backendPid);
  const walStart = walSize();
  console.log(`Inicio: RSS=${(rssStart / 1048576).toFixed(1)}MB WAL=${(walStart / 1024).toFixed(0)}KB`);

  const samples = [];
  const sampler = setInterval(() => {
    const m = rss(backendPid);
    const w = walSize();
    samples.push({ t: Date.now(), rss: m, wal: w });
    console.log(`  +${Math.round((Date.now() - now) / 60000)}min RSS=${(m / 1048576).toFixed(1)}MB WAL=${(w / 1024).toFixed(0)}KB`);
  }, 60000);

  const started = Date.now();
  let published = 0;
  const publish = () => {
    all.forEach((c, idx) => {
      published++;
      c.publish(`empresa/${COMPANY_ID}/bus/SOAK-${String(idx + 1).padStart(3, '0')}/posicion`, JSON.stringify({
        protocolVersion: 1, sequence: Date.now() % 100000, capturedAt: Date.now(),
        lat: 10.98 + (idx % 20) * 0.0004, lon: -74.79 - (idx % 20) * 0.0003, speedKmh: 30,
      }));
    });
  };
  publish();
  const iv = setInterval(publish, INTERVAL_MS);
  while (Date.now() - started < DURATION_MS) await sleep(5000);
  clearInterval(iv);
  clearInterval(sampler);

  const rssEnd = rss(backendPid);
  const walEnd = walSize();
  console.log(`\nFin:    RSS=${(rssEnd / 1048576).toFixed(1)}MB WAL=${(walEnd / 1024).toFixed(0)}KB (publicadas: ${published})`);
  const deltaMb = (rssEnd - rssStart) / 1048576;
  const walGrowthMb = (walEnd - walStart) / 1048576;
  console.log(`ΔRSS=${deltaMb.toFixed(1)}MB | ΔWAL=${walGrowthMb.toFixed(1)}MB`);

  const passMem = deltaMb < 50;   // sin leak: margen generoso para 10 min
  const passWal = walGrowthMb < 10;
  console.log(`Criterios: ΔRSS<50MB:${passMem} | ΔWAL<10MB:${passWal}`);
  console.log('Nota: soak de 10 min como proxy; el protocolo pide 24h (documentar con run prolongado en CI)');

  // limpieza
  db.prepare("DELETE FROM driver_sessions WHERE session_id LIKE 'soak-%'").run();
  db.prepare("DELETE FROM drivers WHERE phone_number LIKE '9100%'").run();
  for (const c of all) c.end(true);
  process.exit(passMem && passWal ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
