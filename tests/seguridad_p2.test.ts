// Auditoría 2026-09, riesgos P2 y la segunda barrera de P1-2, contra el
// backend de verdad:
// - P2-1: re-provisionar un conductor con un bus de otra empresa se lo
//   pasaba a la nueva sin avisar, y la caché de «de quién es el bus» no se
//   enteraba. Ahora es 409 BUS_TAKEN, y cuando el alta pasa la caché dice
//   lo mismo que la base.
// - P2-2: los topes por IP cuentan una IPv6 por su /64, en la API (login) y
//   en el cupo de conexiones MQTT anónimas.
// - P2-3: diez PIN fallidos contra una misma cuenta la bloquean un rato,
//   vengan de las IP que vengan.
// - P1-2, segunda barrera: la lista de posiciones de una ruta solo trae
//   buses de la empresa dueña, aunque la base tenga uno ajeno colado de
//   antes del arreglo.
//
// Los intentos desde «muchas IP» entran por loopback con X-Forwarded-For,
// que es como llegan detrás de ngrok.
//
// Puertos propios, HTTP 3270 y MQTT 9040 (reparto en arranque.test.ts).
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { after, before, test } from 'node:test';

import Database from 'better-sqlite3';
import { io } from 'socket.io-client';
import WebSocket from 'ws';

const HTTP_PORT = 3270;
const MQTT_PORT = 9040;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const ADMIN_API_KEY = 'seguridad-p2-admin-key';
const CLAVE_PANEL = 'secret123-de-prueba';
const DB_PATH = `/tmp/yaviene-seguridad-p2-${process.pid}-${Date.now()}.db`;
const EMPRESA_A = 'EMP-P2A';
const EMPRESA_B = 'EMP-P2B';

// Los de src/security; se repiten a propósito (ver mqtt_abuso.test.ts).
const FALLOS_PARA_BLOQUEAR = 10;
const ANONIMAS_POR_IP = 20;
const LOGINS_POR_IP = 20;

let backend: ChildProcess;
let panelA: Record<string, string>;
let panelB: Record<string, string>;

async function esperarListo(): Promise<void> {
  const limite = Date.now() + 15_000;
  while (Date.now() < limite) {
    try {
      if ((await fetch(`${BASE}/api/ready`)).status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('el backend no llegó a estar listo');
}

function parar(hijo: ChildProcess): Promise<void> {
  if (hijo.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const matar = setTimeout(() => hijo.kill('SIGKILL'), 3000);
    hijo.once('exit', () => {
      clearTimeout(matar);
      resolve();
    });
    hijo.kill('SIGTERM');
  });
}

async function llamar(headers: Record<string, string>, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const texto = await res.text();
  return { status: res.status, headers: res.headers, texto, json: texto ? JSON.parse(texto) : null };
}

async function panel(companyId: string, username: string): Promise<Record<string, string>> {
  const alta = await llamar(
    { 'content-type': 'application/json', 'x-admin-key': ADMIN_API_KEY },
    'POST', `/api/admin/empresas/${companyId}/admin`, { username, password: CLAVE_PANEL },
  );
  assert.equal(alta.status, 201, alta.texto);
  const login = await llamar({ 'content-type': 'application/json' }, 'POST', '/api/admin/login', {
    username, password: CLAVE_PANEL,
  });
  assert.equal(login.status, 200, login.texto);
  return { authorization: `Bearer ${login.json.token}`, 'content-type': 'application/json' };
}

function provisionar(datos: { phoneNumber: string; companyId: string; busId: string; routeId: string; pin?: string }) {
  return llamar(
    { 'content-type': 'application/json', 'x-admin-key': ADMIN_API_KEY },
    'POST', '/api/admin/drivers', { name: 'Equipo', pin: '135790', ...datos },
  );
}

/** Login del equipo como si llegara por el túnel desde `ip`. */
function loginDesde(ip: string, phoneNumber: string, pin: string) {
  return llamar(
    { 'content-type': 'application/json', 'x-forwarded-for': ip },
    'POST', '/api/auth/login', { phoneNumber, pin },
  );
}

before(async () => {
  backend = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      HTTP_PORT: String(HTTP_PORT),
      MQTT_PORT: String(MQTT_PORT),
      JWT_SECRET: 'test-jwt-secret',
      ADMIN_API_KEY,
      MQTT_DEBUG_LOGS: 'false',
      YA_VIENE_FLOTA_DEMO: '0',
      YA_VIENE_DB_PATH: DB_PATH,
    },
    stdio: 'ignore',
  });
  await esperarListo();
  panelA = await panel(EMPRESA_A, 'ana-p2');
  panelB = await panel(EMPRESA_B, 'beto-p2');
  assert.equal((await llamar(panelA, 'POST', '/api/fleet/routes', { routeId: 'R-501', name: 'Ruta de A' })).status, 201);
  assert.equal((await llamar(panelB, 'POST', '/api/fleet/routes', { routeId: 'R-601', name: 'Ruta de B' })).status, 201);
  assert.equal((await llamar(panelA, 'POST', '/api/fleet/buses', { placa: 'AAA501', routeId: 'R-501' })).status, 201);
  assert.equal((await llamar(panelB, 'POST', '/api/fleet/buses', { placa: 'BBB601', routeId: 'R-601' })).status, 201);
});

after(async () => {
  await parar(backend);
  for (const sufijo of ['', '-wal', '-shm']) rmSync(`${DB_PATH}${sufijo}`, { force: true });
});

test('P2-1: re-provisionar no pasa un bus a otra empresa', async () => {
  const robo = await provisionar({ phoneNumber: '3005010009', companyId: EMPRESA_B, busId: 'BUS-AAA501', routeId: 'R-601' });
  assert.equal(robo.status, 409, robo.texto);
  assert.equal(robo.json.error.code, 'BUS_TAKEN');
  assert.equal(robo.texto.includes(EMPRESA_A), false, 'el 409 no dice de quién es el bus');

  // Nada quedó a medias: ni el bus cambió de dueño ni el conductor existe.
  const base = new Database(DB_PATH, { readonly: true });
  try {
    const fila = base.prepare('SELECT company_id FROM buses WHERE bus_id = ?').get('BUS-AAA501') as { company_id: string };
    assert.equal(fila.company_id, EMPRESA_A);
    assert.equal(base.prepare('SELECT 1 FROM drivers WHERE phone_number = ?').get('3005010009'), undefined);
  } finally {
    base.close();
  }
  assert.equal((await loginDesde('10.9.0.1', '3005010009', '135790')).status, 401);

  // La dueña sigue mandando en su bus y la otra sigue sin verlo.
  assert.equal((await llamar(panelA, 'POST', '/api/fleet/buses/BUS-AAA501/visibility', { visible: false })).status, 200);
  assert.equal((await llamar(panelA, 'POST', '/api/fleet/buses/BUS-AAA501/visibility', { visible: true })).status, 200);
  assert.equal((await llamar(panelB, 'POST', '/api/fleet/buses/BUS-AAA501/visibility', { visible: false })).status, 404);

  // Re-provisionar dentro de la misma empresa sigue valiendo, las veces que haga falta.
  for (let i = 0; i < 2; i++) {
    const mismo = await provisionar({ phoneNumber: '3005010001', companyId: EMPRESA_A, busId: 'BUS-AAA501', routeId: 'R-501' });
    assert.equal(mismo.status, 201, mismo.texto);
  }
});

test('P2-1: tras un alta, la memoria del backend dice lo mismo que la base', async () => {
  // El panel pregunta por un bus que todavía no existe: la caché guarda
  // «no está». Si el alta del conductor no la corrige, el bus nuevo es de
  // B en la base y B recibe 404 hasta reiniciar el backend.
  assert.equal((await llamar(panelB, 'POST', '/api/fleet/buses/BUS-NUEVO602/visibility', { visible: false })).status, 404);
  const alta = await provisionar({ phoneNumber: '3006020001', companyId: EMPRESA_B, busId: 'BUS-NUEVO602', routeId: 'R-601' });
  assert.equal(alta.status, 201, alta.texto);
  const oculto = await llamar(panelB, 'POST', '/api/fleet/buses/BUS-NUEVO602/visibility', { visible: false });
  assert.equal(oculto.status, 200, oculto.texto);
  assert.equal((await llamar(panelB, 'POST', '/api/fleet/buses/BUS-NUEVO602/visibility', { visible: true })).status, 200);
  assert.equal((await llamar(panelA, 'POST', '/api/fleet/buses/BUS-NUEVO602/visibility', { visible: false })).status, 404);
});

test('P2-3: diez PIN fallidos bloquean la cuenta aunque vengan de IP distintas', async () => {
  assert.equal((await provisionar({ phoneNumber: '3005030001', companyId: EMPRESA_A, busId: 'BUS-PIN503', routeId: 'R-501' })).status, 201);
  assert.equal((await provisionar({ phoneNumber: '3005030002', companyId: EMPRESA_A, busId: 'BUS-PIN504', routeId: 'R-501' })).status, 201);

  // Cada intento desde una IP nueva: los topes por IP y por (IP, cuenta) no
  // lo frenan, que es justo lo que P2-3 dice.
  for (let i = 1; i <= FALLOS_PARA_BLOQUEAR; i++) {
    const fallo = await loginDesde(`10.3.0.${i}`, '3005030001', String(100000 + i));
    assert.equal(fallo.status, 401, `el fallo ${i} todavía es 401`);
  }
  // Bloqueada: ni el PIN bueno entra, y así probar no dice si se acertó.
  const bloqueada = await loginDesde('10.3.1.1', '3005030001', '135790');
  assert.equal(bloqueada.status, 429, bloqueada.texto);
  assert.equal(bloqueada.json.error.code, 'RATE_LIMITED');
  const espera = Number(bloqueada.headers.get('retry-after'));
  assert.ok(espera > 0 && espera <= 3600, `Retry-After: ${bloqueada.headers.get('retry-after')}`);

  // Otra cuenta, desde las mismas IP, no se entera.
  assert.equal((await loginDesde('10.3.0.1', '3005030002', '135790')).status, 200);

  // Volver a dar de alta la línea (con la clave de administración) levanta
  // el bloqueo: es lo que hace el runbook con un equipo propio mal configurado.
  assert.equal((await provisionar({ phoneNumber: '3005030001', companyId: EMPRESA_A, busId: 'BUS-PIN503', routeId: 'R-501', pin: '246813' })).status, 201);
  assert.equal((await loginDesde('10.3.1.2', '3005030001', '246813')).status, 200);

  // Un acierto borra la cuenta de fallos: el equipo que se equivoca de vez
  // en cuando no acaba bloqueado.
  for (let ronda = 0; ronda < 2; ronda++) {
    for (let i = 1; i < FALLOS_PARA_BLOQUEAR; i++) {
      assert.equal((await loginDesde(`10.4.${ronda}.${i}`, '3005030002', '000000')).status, 401);
    }
    assert.equal((await loginDesde(`10.4.${ronda}.99`, '3005030002', '135790')).status, 200);
  }
});

test('P1-2, segunda barrera: la lista de una ruta solo trae buses de su dueña', { timeout: 20_000 }, async () => {
  // Un bus de B colado en la ruta de A, como pudo quedar en la base antes
  // del arreglo de P1-2, y uno de A en su ruta. Y una ruta vieja que no está
  // en ningún catálogo: sin dueña, sigue como antes.
  assert.equal((await provisionar({ phoneNumber: '3005010002', companyId: EMPRESA_A, busId: 'BUS-AAA501', routeId: 'R-501' })).status, 201);
  assert.equal((await provisionar({ phoneNumber: '3006010001', companyId: EMPRESA_B, busId: 'BUS-BBB601', routeId: 'R-601' })).status, 201);
  assert.equal((await provisionar({ phoneNumber: '3006880001', companyId: EMPRESA_B, busId: 'BUS-VIEJO688', routeId: 'R-688' })).status, 201);
  const base = new Database(DB_PATH);
  try {
    // Los dos visibles: un bus que el panel acaba de dar de alta nace oculto,
    // y si el de B siguiera así lo dejaría fuera el filtro de visibilidad y
    // no la barrera de empresa, que es lo que esta prueba mide. Se fija aquí
    // y no se hereda de P2-1, que deja visible el de A.
    base.prepare("UPDATE buses SET route_id = 'R-501', visible = 1 WHERE bus_id = 'BUS-BBB601'").run();
    base.prepare("UPDATE buses SET visible = 1 WHERE bus_id IN ('BUS-AAA501', 'BUS-VIEJO688')").run();
    const posicion = base.prepare(`
      INSERT INTO positions (bus_id, route_id, lat, lon, speed_kmh, timestamp, driver_phone, captured_at)
      VALUES (?, ?, 10.98, -74.8, 20, ?, ?, ?)
      ON CONFLICT(bus_id) DO UPDATE SET route_id = excluded.route_id, timestamp = excluded.timestamp
    `);
    const ahora = Date.now();
    posicion.run('BUS-AAA501', 'R-501', ahora, '3005010002', ahora);
    posicion.run('BUS-BBB601', 'R-501', ahora, '3006010001', ahora);
    posicion.run('BUS-VIEJO688', 'R-688', ahora, '3006880001', ahora);
  } finally {
    base.close();
  }

  const lista = await llamar({}, 'GET', '/api/routes/R-501/positions');
  assert.equal(lista.status, 200);
  assert.deepEqual(lista.json.buses.map((b: { busId: string }) => b.busId), ['BUS-AAA501'], lista.texto);

  // El socket arma la foto inicial de la sala con la misma consulta.
  const pasajero = io(BASE, { path: '/ws', transports: ['websocket'], reconnection: false });
  try {
    const foto = await new Promise<{ buses: { busId: string }[] }>((resolve, reject) => {
      const reloj = setTimeout(() => reject(new Error('sin positions:batch')), 5000);
      pasajero.once('positions:batch', (datos) => {
        clearTimeout(reloj);
        resolve(datos);
      });
      pasajero.on('connect', () => pasajero.emit('subscribe:route', 'R-501'));
    });
    assert.deepEqual(foto.buses.map((b) => b.busId), ['BUS-AAA501']);
  } finally {
    pasajero.disconnect();
  }

  const vieja = await llamar({}, 'GET', '/api/routes/R-688/positions');
  assert.deepEqual(vieja.json.buses.map((b: { busId: string }) => b.busId), ['BUS-VIEJO688']);
});

test('P2-2: el tope de logins por IP cuenta una IPv6 por su /64', async () => {
  // Cuentas distintas y una dirección distinta cada vez, todas del mismo
  // /64: es una sola máquina y le tocan 20 intentos por minuto.
  for (let i = 1; i <= LOGINS_POR_IP; i++) {
    const intento = await loginDesde(`2001:db8:77:1::${i.toString(16)}`, `39977000${String(i).padStart(2, '0')}`, '000000');
    assert.equal(intento.status, 401, `el intento ${i} todavía entra`);
  }
  const otro = await loginDesde('2001:db8:77:1:abcd::1', '3997700099', '000000');
  assert.equal(otro.status, 429, 'la dirección 21 del mismo /64 comparte el tope');
  assert.equal((await loginDesde('2001:db8:77:2::1', '3997700098', '000000')).status, 401, 'otro /64 tiene su propio tope');
});

test('P2-2: el cupo de conexiones MQTT anónimas cuenta una IPv6 por su /64', { timeout: 20_000 }, async () => {
  const abrir = (ip: string) => new Promise<WebSocket | number>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}/mqtt`, 'mqtt', { headers: { 'x-forwarded-for': ip } });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (req, res) => {
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    ws.once('error', reject);
  });
  const abiertas: WebSocket[] = [];
  try {
    for (let i = 1; i <= ANONIMAS_POR_IP; i++) {
      const ws = await abrir(`2001:db8:88:1::${i.toString(16)}`);
      assert.ok(ws instanceof WebSocket, `la conexión ${i} entra`);
      abiertas.push(ws);
    }
    assert.equal(await abrir('2001:db8:88:1:ffff::1'), 429, 'otra dirección del mismo /64 no estrena cupo');
    const otro = await abrir('2001:db8:88:2::1');
    assert.ok(otro instanceof WebSocket, 'otro /64 tiene su propio cupo');
    abiertas.push(otro);
  } finally {
    for (const ws of abiertas) ws.terminate();
  }
});

test('P2-3: el bloqueo queda contado en /api/metrics', async () => {
  const res = await llamar({ 'x-admin-key': ADMIN_API_KEY }, 'GET', '/api/metrics');
  assert.equal(res.status, 200);
  const contadores = res.json.counters as Record<string, number>;
  assert.ok((contadores['login.cuenta_bloqueada'] ?? 0) >= 1, JSON.stringify(contadores));
});
