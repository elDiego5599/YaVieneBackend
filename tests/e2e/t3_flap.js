// TIER 3.1 — Flapping de red: 25 ciclos conectar/publicar/desconectar
process.env.JWT_SECRET = process.env.JWT_SECRET || 'localdev';
const { execSync } = require('child_process');
const { loginDriver, decodeToken, connectBus, publishPosition, sleep, record, report } = require('./helpers');

(async () => {
  const { token } = await loginDriver('3000000000', '1234');
  const auth = decodeToken(token);
  const CYCLES = 25;

  let connects = 0;
  let acks = 0;
  let publishes = 0;
  const phantomCheck = () => {
    const established = execSync('lsof -nP -iTCP:8883 -sTCP:ESTABLISHED 2>/dev/null | wc -l | tr -d " "').toString().trim();
    return parseInt(established, 10);
  };

  for (let i = 0; i < CYCLES; i++) {
    const c = await connectBus(token, auth.busId);
    connects++;
    c.on('message', (_t, buf) => {
      try { if (JSON.parse(buf.toString()).accepted) acks++; } catch (_) {}
    });
    publishPosition(c, [auth.companyId, auth.busId, auth.routeId], { sequence: i + 1 });
    publishes++;
    await sleep(400);
    c.end(true);
    await sleep(300);
  }
  await sleep(3000);

  const phantoms = phantomCheck();
  record('T3.1: las 25 reconexiones reclamaron la sesión correctamente', connects === CYCLES, `${connects}/${CYCLES}`);
  record('T3.1: cada lote de posiciones fue aceptado (sin pérdida)', acks === CYCLES, `${acks}/${CYCLES} ACKs`);
  record('T3.1: cero conexiones fantasma en el broker tras el flapping', phantoms === 0, `conexiones :8883 = ${phantoms}`);
  report('TIER 3.1');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
