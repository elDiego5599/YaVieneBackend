/**
 * Prueba de fuego: rompe el código a propósito y mira si la suite lo nota.
 *
 * Que las pruebas pasen no dice que cuiden algo: una prueba que nunca falla
 * tampoco falla cuando el código se rompe. Aquí cada mutación es un error
 * creíble en una pieza que importa —un `>=` que pasa a `>`, un chequeo de
 * dueño que desaparece, un tope que se duplica—; se aplica sobre `src/`, se
 * corre la suite entera y se deshace. Si la suite sigue en verde con el
 * error puesto, esa mutación «sobrevive» y falta una prueba.
 *
 * Uso:
 *   npm run fuego                  # todas (≈40 s cada una)
 *   npm run fuego -- --solo=3,7    # solo esas (el número de la lista)
 *
 * No toca el backend vivo: muta `src/`, no `dist/`, y las pruebas usan bases
 * temporales. Se niega a correr con cambios sin commitear en `src/`, para
 * que deshacer sea siempre volver al archivo tal como estaba.
 * `tests/prueba_de_fuego.test.ts` vigila que cada mutación siga aplicando:
 * si alguien cambia la línea, la lista no se pudre en silencio.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const MUTACIONES = [
  // Física: lo que impide que un GPS mentiroso teletransporte un bus.
  { archivo: 'src/security/physics.ts', de: 'speedKmh < 0 || speedKmh > MAX_SPEED_KMH', a: 'speedKmh < 0 || speedKmh > MAX_SPEED_KMH * 2', que: 'tope de velocidad reportada' },
  { archivo: 'src/security/physics.ts', de: 'if (capturedAt <= previous.capturedAt) {', a: 'if (capturedAt < previous.capturedAt) {', que: 'posición repetida o vieja' },
  { archivo: 'src/security/physics.ts', de: 'if (calculatedSpeedKmh > MAX_SPEED_KMH) {', a: 'if (calculatedSpeedKmh > MAX_SPEED_KMH * 2) {', que: 'salto imposible entre dos posiciones' },
  { archivo: 'src/security/physics.ts', de: 'capturedAt > Date.now() + MAX_CAPTURE_CLOCK_SKEW_MS', a: 'capturedAt > Date.now() + 10 * MAX_CAPTURE_CLOCK_SKEW_MS', que: 'posición del futuro' },
  { archivo: 'src/security/physics.ts', de: 'capturedAt < Date.now() - MAX_PAST_CAPTURE_MS', a: 'capturedAt < Date.now() - 10 * MAX_PAST_CAPTURE_MS', que: 'posición demasiado vieja' },
  { archivo: 'src/security/physics.ts', de: 'if (!previous || previous.sessionId !== sessionId) {', a: 'if (!previous) {', que: 'comparar contra la sesión anterior' },
  { archivo: 'src/security/physics.ts', de: 'const c = 2 * Math.atan2(', a: 'const c = 1 * Math.atan2(', que: 'distancia haversine' },
  // Payload: lo que entra del equipo del bus.
  { archivo: 'src/security/payload.ts', de: 'if (p.protocolVersion !== 1) {', a: 'if (p.protocolVersion !== 1 && false) {', que: 'versión del protocolo' },
  { archivo: 'src/security/payload.ts', de: '(sequence as number) < 1', a: '(sequence as number) < 0', que: 'secuencia desde 1' },
  { archivo: 'src/security/payload.ts', de: 'lat > 90 ||', a: 'lat > 900 ||', que: 'latitud en rango' },
  { archivo: 'src/security/payload.ts', de: 'heading >= 0 && heading < 360', a: 'heading >= 0 && heading <= 360', que: 'rumbo por debajo de 360' },
  { archivo: 'src/security/payload.ts', de: "if (sentido === 'ida' || sentido === 'venida')", a: "if (typeof sentido === 'string')", que: 'sentido ida o venida' },
  { archivo: 'src/security/zona.ts', de: 'return lat >= ZONA.latMin &&', a: 'return lat >= ZONA.latMin - 1 &&', que: 'zona de servicio' },
  // Autenticación: quién puede qué.
  { archivo: 'src/auth/http.ts', de: "if (auth?.role !== 'admin') return null;", a: 'if (!auth) return null;', que: 'solo administradores al panel' },
  { archivo: 'src/auth/http.ts', de: "if (!auth || auth.role !== 'device' || auth.busId !== busId) return false;", a: "if (!auth || auth.role !== 'device') return false;", que: 'el equipo solo reporta su bus' },
  { archivo: 'src/auth/http.ts', de: 'session.busId === auth.busId;', a: 'true;', que: 'la sesión es de ese bus' },
  { archivo: 'src/auth/http.ts', de: "session?.status === 'active' &&", a: 'session != null &&', que: 'sesión revocada no reporta' },
  { archivo: 'src/auth/tokens.ts', de: "if (decoded.role !== 'device') return null;", a: "if (decoded.role === 'nadie') return null;", que: 'rol del token' },
  { archivo: 'src/auth/tokens.ts', de: 'export const ADMIN_TOKEN_TTL_S = 8 * 60 * 60;', a: 'export const ADMIN_TOKEN_TTL_S = 24 * 60 * 60;', que: 'el token del panel dura 8 h' },
  { archivo: 'src/auth/passwords.ts', de: 'expected.length === actual.length && timingSafeEqual(expected, actual)', a: 'expected.length === actual.length', que: 'la contraseña se compara' },
  { archivo: 'src/data/sessions.ts', de: 'if (cached.clientId != null && cached.clientId !== clientId) return false;', a: 'if (cached.clientId != null && false) return false;', que: 'una sesión, un cliente' },
  { archivo: 'src/data/sessions.ts', de: "if (!session || session.status !== 'active' || session.clientId !== clientId) {", a: "if (!session || session.status !== 'active') {", que: 'sesión de otro cliente' },
  // Panel web: la sesión en una cookie que la página no lee (panel_cookie.test.ts).
  { archivo: 'src/auth/cookie_panel.ts', de: 'HttpOnly; Secure; SameSite=Strict;', a: 'Secure; SameSite=Lax;', que: 'cookie del panel HttpOnly y Strict' },
  { archivo: 'src/auth/http.ts', de: "return payload?.role === 'admin' ? payload : null;", a: 'return payload;', que: 'la cookie solo lleva tokens de panel' },
  { archivo: 'src/api/routes.ts', de: 'return leerCookiePanel(req.headers) !== null && !esOrigenDelPanel(req.headers);', a: 'return false;', que: 'escribir con cookie exige el Origin del panel' },
  { archivo: 'src/api/routes.ts', de: 'if (web && !esOrigenDelPanel(req.headers)) {', a: 'if (false) {', que: 'el login no se abre a otra página' },
  { archivo: 'src/api/routes.ts', de: 'writeJson(res, 200, { company });', a: 'writeJson(res, 200, { token, company });', que: 'el token no viaja en el cuerpo al navegador' },
  { archivo: 'src/socket/handler.ts', de: 'return esOrigenDelPanel(handshake.headers) ? leerCookiePanel(handshake.headers) : null;', a: 'return leerCookiePanel(handshake.headers);', que: 'socket con cookie exige el Origin del panel' },
  { archivo: 'src/index.ts', de: "res.setHeader('Access-Control-Allow-Credentials', 'true');", a: '', que: 'CORS deja viajar la cookie al panel' },
  { archivo: 'src/api/routes.ts', de: "if (leerCookiePanel(req.headers)) res.setHeader('Set-Cookie', cookieBorrada());", a: '', que: 'cerrar sesión borra la cookie' },
  // Avisos con la app cerrada.
  { archivo: 'src/data/avisos_push.ts', de: 'if (delToken.n >= MAX_AVISOS_POR_TOKEN)', a: 'if (delToken.n > MAX_AVISOS_POR_TOKEN)', que: 'tope de avisos por teléfono' },
  { archivo: 'src/data/avisos_push.ts', de: 'if (total.n >= MAX_AVISOS)', a: 'if (total.n > MAX_AVISOS)', que: 'tope total de avisos' },
  { archivo: 'src/data/avisos_push.ts', de: 'Math.min(aviso.vidaMs, VIDA_MAXIMA_MS)', a: 'aviso.vidaMs', que: 'vida máxima de un aviso' },
  { archivo: 'src/data/avisos_push.ts', de: "if (fila.enviado_en !== null) return 'enviado';", a: "if (false) return 'enviado';", que: 'aviso ya enviado' },
  { archivo: 'src/data/avisos_push.ts', de: 'if (metros > c.radio_m ||', a: 'if (metros > RADIO_AVISO_M ||', que: 'radio del aviso el que eligió el pasajero' },
  { archivo: 'src/api/routes.ts', de: 'radioM < RADIO_MINIMO_M || radioM > RADIO_MAXIMO_M', a: 'radioM < 0 || radioM > RADIO_MAXIMO_M', que: 'distancia mínima del aviso' },
  { archivo: 'src/api/routes.ts', de: 'radioM: radioM ?? RADIO_AVISO_M,', a: 'radioM: radioM ?? RADIO_MAXIMO_M,', que: 'el kilómetro de las apps de antes' },
  // Límites contra abuso.
  { archivo: 'src/security/rate_limiter.ts', de: 'if (vivas.length >= this.maxRequests) {', a: 'if (vivas.length > this.maxRequests) {', que: 'tope de peticiones' },
  { archivo: 'src/security/rate_limiter.ts', de: 'if (vivos.length < this.maxFallos) {', a: 'if (vivos.length <= this.maxFallos) {', que: 'fallos antes del bloqueo' },
  { archivo: 'src/security/rate_limiter.ts', de: 'this.bloqueoBaseMs * 2 ** (bloqueos - 1)', a: 'this.bloqueoBaseMs', que: 'bloqueo que crece' },
  { archivo: 'src/mqtt/guardia.ts', de: 'if (this.largo > this.tope) return false;', a: 'if (this.largo > this.tope * 2) return false;', que: 'tope de paquete MQTT' },
  { archivo: 'src/mqtt/guardia.ts', de: 'if (n >= this.tope) return false;', a: 'if (n > this.tope) return false;', que: 'conexiones MQTT por IP' },
  // Visibilidad: el bus que la empresa oculta no lo ve el pasajero.
  { archivo: 'src/api/routes.ts', de: 'getCompanyBuses(params.id).filter((b) => b.visible),', a: 'getCompanyBuses(params.id),', que: 'ocultos fuera de la lista pública' },
  { archivo: 'src/data/positions_store.ts', de: 'WHERE p.route_id = ? AND (b.visible = 1 OR b.visible IS NULL)', a: 'WHERE p.route_id = ?', que: 'ocultos fuera de las posiciones por ruta' },
  // Flota demo: la placa vieja de la presentación no se queda en el panel.
  { archivo: 'src/demo/flota_demo.ts', de: "  'BUS-WGV705',\n", a: '', que: 'retirar la placa vieja de la demo' },
];

function correrSuite() {
  const r = spawnSync('npm', ['test'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0;
}

function main() {
  const sucio = spawnSync('git', ['status', '--porcelain', '--', 'src'], { cwd: ROOT, encoding: 'utf8' });
  if (sucio.status !== 0 || sucio.stdout.trim()) {
    console.error('Hay cambios sin commitear en src/: la prueba de fuego no corre así.');
    process.exit(2);
  }
  const solo = process.argv.find((a) => a.startsWith('--solo='))?.slice(7).split(',').map(Number);
  const elegidas = MUTACIONES.map((m, i) => ({ ...m, n: i + 1 })).filter((m) => !solo || solo.includes(m.n));

  let original = null;
  let ruta = null;
  const deshacer = () => { if (ruta && original !== null) writeFileSync(ruta, original); };
  for (const senal of ['SIGINT', 'SIGTERM']) process.on(senal, () => { deshacer(); process.exit(130); });

  const sobreviven = [];
  for (const m of elegidas) {
    ruta = join(ROOT, m.archivo);
    original = readFileSync(ruta, 'utf8');
    if (original.split(m.de).length !== 2) throw new Error(`#${m.n} no aplica: «${m.de}» no está una sola vez en ${m.archivo}`);
    const inicio = Date.now();
    try {
      writeFileSync(ruta, original.replace(m.de, m.a));
      const pasa = correrSuite();
      const s = ((Date.now() - inicio) / 1000).toFixed(0);
      console.log(`${pasa ? 'SOBREVIVE' : 'muere    '}  #${String(m.n).padStart(2)}  ${m.que}  (${s} s)`);
      if (pasa) sobreviven.push(m);
    } finally {
      deshacer();
      original = null;
    }
  }
  console.log(`\n${elegidas.length - sobreviven.length} de ${elegidas.length} mutaciones las detecta la suite.`);
  if (sobreviven.length) {
    console.log('Sin prueba que las note:');
    for (const m of sobreviven) console.log(`  #${m.n} ${m.archivo}: ${m.que}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
