// H-3 "Estampida de Pasajeros": 3,000 reconexiones simultáneas + positions:batch al mismo tiempo
const { execSync } = require('child_process');
const { io } = require('socket.io-client');
const { sleep, record, report } = require('./helpers');

const N = 3000;
const ROUTE_ID = 'R-101';

(async () => {
  const pid = execSync('pgrep -f "dist/index.js" | head -1').toString().trim();
  const rss = () => parseInt(execSync(`ps -p ${pid} -o rss= | tr -d ' '`).toString().trim(), 10) / 1024;
  const rssBefore = rss();
  console.log(`Estampida: ${N} pasajeros conectando simultáneamente, RSS inicial=${rssBefore.toFixed(1)}MB`);

  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: N }, () => new Promise((resolve) => {
    const s = io('http://127.0.0.1:3000', { path: '/ws', transports: ['websocket'], reconnection: false, forceNew: true });
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    s.on('connect', () => {
      let batchReceived = false;
      s.on('positions:batch', () => {
        if (!batchReceived) { batchReceived = true; finish(true); s.disconnect(); }
      });
      setTimeout(() => { s.emit('subscribe:route', ROUTE_ID); }, 50);
      setTimeout(() => finish(false), 10000);
    });
    s.on('connect_error', () => finish(false));
  })));
  const elapsed = Date.now() - t0;
  const ok = results.filter(Boolean).length;
  await sleep(2000);
  const rssAfter = rss();

  const log = require('fs').readFileSync('/tmp/yaviene-backend.log', 'utf8');
  const busyErrors = (log.match(/SQLITE_BUSY|SQLITE_ERROR/i) || []).length;

  console.log(`\n── RESULTADOS H-3 ──`);
  console.log(`Conectados y batch entregado: ${ok}/${N} en ${elapsed}ms`);
  console.log(`RSS servidor: ${rssBefore.toFixed(1)}MB -> ${rssAfter.toFixed(1)}MB (Δ=${(rssAfter - rssBefore).toFixed(1)}MB)`);
  console.log(`Errores SQLITE_BUSY en el log: ${busyErrors}`);

  record('H-3: 3,000 pasajeros reconectados en manada y todos recibieron positions:batch', ok === N, `${ok}/${N} en ${elapsed}ms`);
  record('H-3: sin errores SQLITE_BUSY en modo WAL', busyErrors === 0, `${busyErrors} errores`);
  record('H-3: heap del servidor sin inflarse (ΔRSS < 200MB)', rssAfter - rssBefore < 200, `Δ=${(rssAfter - rssBefore).toFixed(1)}MB`);
  report('H-3');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
