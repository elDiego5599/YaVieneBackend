// Las quejas del pasajero (D18): el buzón de D14 con motivo, ruta, bus, celda
// y hora. Se validan en la frontera, salen por correo como antes y además se
// guardan 13 meses para que la empresa de la ruta las vea en su panel. Todo
// contra una base temporal y un servidor en proceso: nada sale a internet.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-quejas-'));
process.env.YA_VIENE_DB_PATH = join(tmp, 'test.db');
process.env.JWT_SECRET = randomBytes(32).toString('hex');

// require y no import: abren la base y leen el env al evaluarse.
const { handleAPI } = require('../src/api/routes') as typeof import('../src/api/routes');
const { getDb } = require('../src/data/database') as typeof import('../src/data/database');
const { addCompanyRoute } = require('../src/data/routes_store') as typeof import('../src/data/routes_store');
const { createOrUpdateCompanyAdmin } = require('../src/data/empresas') as typeof import('../src/data/empresas');
const { signToken } = require('../src/auth/tokens') as typeof import('../src/auth/tokens');
const { hashSecret } = require('../src/auth/passwords') as typeof import('../src/auth/passwords');
const { reportesRateLimiter } = require('../src/security/rate_limiter') as typeof import('../src/security/rate_limiter');
const reportes = require('../src/data/reportes') as typeof import('../src/data/reportes');
const quejas = require('../src/data/quejas') as typeof import('../src/data/quejas');

// Una celda de la rejilla de D17 en el centro de Barranquilla.
const CELDA = { lat: 10.99035, lng: -74.78967 }; // 8141 × 0,00135 y -54591 × 0,00137
const AHORA = Date.parse('2026-11-10T17:40:00.000Z'); // 12:40 p. m. en Barranquilla
const DIA = 24 * 60 * 60_000;

let base = '';
const servidor: Server = createServer((req, res) => {
  if (!handleAPI(req, res)) {
    res.writeHead(404);
    res.end();
  }
});

function tokenDe(companyId: string): string {
  getDb().prepare('INSERT OR IGNORE INTO empresas (company_id, name, created_at) VALUES (?, ?, ?)').run(companyId, companyId, 0);
  const admin = createOrUpdateCompanyAdmin(companyId, `admin-${companyId.toLowerCase()}`, hashSecret('una clave cualquiera de prueba'));
  return signToken({ sub: admin.adminId, role: 'admin', companyId, username: admin.username, tv: admin.tokenVersion });
}

/** Vacía el limitador del buzón: un barrido desde más allá de su ventana de 10 minutos. */
function olvidarLimitador(): void {
  reportesRateLimiter.sweep(Date.now() + 10 * 60_000 + 1);
}

async function enviar(cuerpo: unknown) {
  // Cada envío es de otra IP para el limitador: aquí se prueba la queja, el
  // tope de 5 por 10 minutos tiene su prueba abajo.
  olvidarLimitador();
  const r = await fetch(`${base}/api/reportes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  return { estado: r.status, cuerpo: texto ? (JSON.parse(texto) as Record<string, unknown>) : {} };
}

async function panel(token: string | null, consulta = '') {
  const r = await fetch(`${base}/api/panel/quejas${consulta}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { estado: r.status, cuerpo: (await r.json()) as Record<string, unknown> };
}

function limpiar(): void {
  getDb().prepare('DELETE FROM reportes').run();
  getDb().prepare('DELETE FROM quejas').run();
}

test.before(async () => {
  addCompanyRoute('EMP-QUEJAS', 'R-901', 'Ruta de la queja');
  addCompanyRoute('EMP-OTRA', 'R-902', 'Ruta de otra empresa');
  const bus = getDb().prepare(`INSERT INTO buses (bus_id, company_id, route_id, plate_number, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, 0)`);
  bus.run('BUS-901', 'EMP-QUEJAS', 'R-901', 'ABC123');
  bus.run('BUS-902', 'EMP-OTRA', 'R-902', 'XYZ789');
  await new Promise<void>((listo) => servidor.listen(0, '127.0.0.1', listo));
  const dir = servidor.address();
  base = `http://127.0.0.1:${typeof dir === 'object' && dir ? dir.port : 0}`;
});

test.after(async () => {
  await new Promise<void>((listo) => servidor.close(() => listo()));
  getDb().close();
  rmSync(tmp, { recursive: true, force: true });
});

// ── La frontera ──────────────────────────────────────────────────────

test('los motivos viven en un solo sitio y son los siete acordados', () => {
  assert.deepEqual([...quejas.MOTIVOS_QUEJA], [
    'no_paro', 'iba_lleno', 'mal_trato', 'conduccion', 'otra_ruta', 'estado_bus', 'otro',
  ]);
});

test('leerReporte: una queja completa sale limpia, con la hora redondeada a la hora', () => {
  assert.deepEqual(reportes.leerReporte({
    tipo: 'queja', motivo: 'no_paro', texto: ' No paró en la 72 ', routeId: 'R-901', busId: 'BUS-901',
    celda: CELDA, hora: '2026-11-10T17:25:00.000Z', plataforma: 'ios', version: '1.5.0',
  }, AHORA), {
    tipo: 'queja', texto: 'No paró en la 72', plataforma: 'ios', version: '1.5.0',
    queja: {
      motivo: 'no_paro', routeId: 'R-901', companyId: 'EMP-QUEJAS', busId: 'BUS-901',
      celda: CELDA, hora: Date.parse('2026-11-10T17:00:00.000Z'),
    },
  });
});

test('leerReporte: en la queja todo es opcional menos el motivo, y el texto puede faltar', () => {
  assert.deepEqual(reportes.leerReporte({ tipo: 'queja', motivo: 'iba_lleno' }, AHORA), {
    tipo: 'queja', texto: '',
    queja: { motivo: 'iba_lleno', routeId: null, companyId: null, busId: null, celda: null, hora: null },
  });
});

test('leerReporte: cada campo malo de la queja se rechaza y dice cuál', () => {
  const buena = { tipo: 'queja', motivo: 'mal_trato', routeId: 'R-901', busId: 'BUS-901' };
  const lejos = { lat: 4.6, lng: -74.08 }; // Bogotá: fuera del área de servicio
  const torcida = { lat: CELDA.lat + 0.0003, lng: CELDA.lng };
  for (const [mala, mensaje] of [
    [{ tipo: 'queja' }, 'motivo'],
    [{ ...buena, motivo: 'robo' }, 'motivo'],
    [{ ...buena, motivo: 3 }, 'motivo'],
    [{ ...buena, texto: 'ab' }, 'entre 3 y 1000'],
    [{ ...buena, routeId: 'R-999' }, 'ruta'],
    [{ ...buena, routeId: 42 }, 'ruta'],
    [{ ...buena, busId: 'BUS-902' }, 'bus'],
    [{ ...buena, busId: 'BUS-NADA' }, 'bus'],
    [{ ...buena, routeId: undefined }, 'bus'],
    [{ ...buena, celda: lejos }, 'celda'],
    [{ ...buena, celda: torcida }, 'celda'],
    [{ ...buena, celda: { lat: 'x', lng: CELDA.lng } }, 'celda'],
    [{ ...buena, celda: [CELDA.lat, CELDA.lng] }, 'celda'],
    [{ ...buena, hora: 'ayer' }, 'hora'],
    [{ ...buena, hora: AHORA }, 'hora'],
    [{ ...buena, hora: new Date(AHORA + 2 * 60 * 60_000).toISOString() }, 'hora'],
    [{ ...buena, hora: new Date(AHORA - 7 * DIA - 60 * 60_000).toISOString() }, 'hora'],
    // Problemas y sugerencias no llevan los campos de la queja.
    [{ tipo: 'problema', texto: 'hola mundo', motivo: 'no_paro' }, 'solo la queja'],
    [{ tipo: 'sugerencia', texto: 'hola mundo', routeId: 'R-901' }, 'solo la queja'],
  ] as const) {
    const r = reportes.leerReporte(mala, AHORA);
    assert.ok('error' in r && r.error.includes(mensaje), `${JSON.stringify(mala)} → ${JSON.stringify(r)}`);
  }
  // La hora de dentro de la hora en curso vale: el reloj del teléfono puede ir unos minutos adelante.
  assert.ok(!('error' in reportes.leerReporte({ ...buena, hora: new Date(AHORA + 10 * 60_000).toISOString() }, AHORA)));
  // Y la de hace 7 días justos, también.
  assert.ok(!('error' in reportes.leerReporte({ ...buena, hora: new Date(AHORA - 7 * DIA + 60_000).toISOString() }, AHORA)));
});

// ── El correo al equipo ──────────────────────────────────────────────

test('mensajeDeReporte: la queja dice motivo, ruta, bus, lugar y hora', () => {
  const creado = Date.UTC(2026, 10, 10, 17, 40);
  const m = reportes.mensajeDeReporte({
    id: 'q1', tipo: 'queja', texto: 'Pasó de largo', plataforma: 'android', version: null, creado, intentos: 0,
    motivo: 'no_paro', route_id: 'R-901', ruta_nombre: 'Ruta de la queja', bus_id: 'BUS-901',
    celda_lat: CELDA.lat, celda_lng: CELDA.lng, hora: Date.UTC(2026, 10, 10, 17),
  });
  assert.equal(m.asunto, 'Ya Viene · Queja');
  assert.match(m.texto, /^Tipo: Queja\nMotivo: No paró\nRuta: R-901 Ruta de la queja\nBus: BUS-901\n/);
  assert.match(m.texto, /\nLugar: 10\.99035, -74\.78967 \(celda de 150 m\)\n/);
  assert.match(m.texto, /\nHora del hecho: .*12:00.*\(hora de Colombia\)\n/);
  assert.match(m.texto, /\n\nPasó de largo\n/);
});

test('mensajeDeReporte: sin consentimiento el correo no lleva lugar, y sin dato no inventa', () => {
  const m = reportes.mensajeDeReporte({
    id: 'q2', tipo: 'queja', texto: '', plataforma: null, version: null, creado: 0, intentos: 0,
    motivo: 'otro', route_id: null, ruta_nombre: null, bus_id: null, celda_lat: null, celda_lng: null, hora: null,
  });
  assert.doesNotMatch(m.texto, /Lugar|celda|10\.9|-74\./);
  assert.doesNotMatch(m.texto, /Ruta:|Bus:|Hora del hecho/);
  assert.match(m.texto, /^Tipo: Queja\nMotivo: Otro\n/);
});

test('los problemas y sugerencias se escriben igual que en D14', () => {
  const m = reportes.mensajeDeReporte({
    id: 'r1', tipo: 'problema', texto: 'No carga', plataforma: 'ios', version: '1.4.0', creado: 0, intentos: 0,
    motivo: null, route_id: null, ruta_nombre: null, bus_id: null, celda_lat: null, celda_lng: null, hora: null,
  });
  assert.match(m.texto, /^Tipo: Problema\nDesde: iPhone · app 1\.4\.0\nRecibido: /);
  assert.doesNotMatch(m.texto, /Motivo|Lugar/);
});

// ── La ruta y lo que se guarda ───────────────────────────────────────

test('POST /api/reportes: la queja entra a la cola del correo y se guarda para su empresa', async () => {
  limpiar();
  const hora = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const r = await enviar({
    tipo: 'queja', motivo: 'conduccion', texto: 'Iba muy rápido', routeId: 'R-901', busId: 'BUS-901',
    celda: CELDA, hora, plataforma: 'android', nombre: 'Ana', ip: '1.2.3.4',
  });
  assert.equal(r.estado, 201);
  const cola = getDb().prepare('SELECT tipo, motivo, route_id, bus_id, celda_lat FROM reportes').all();
  assert.deepEqual(cola, [{ tipo: 'queja', motivo: 'conduccion', route_id: 'R-901', bus_id: 'BUS-901', celda_lat: CELDA.lat }]);
  const guardada = getDb().prepare('SELECT * FROM quejas').get() as Record<string, unknown>;
  assert.equal(guardada.company_id, 'EMP-QUEJAS');
  assert.equal(guardada.motivo, 'conduccion');
  // Ni IP, ni dispositivo, ni plataforma, ni versión: la queja guardada es solo la queja.
  assert.deepEqual(Object.keys(guardada).sort(), [
    'bus_id', 'celda_lat', 'celda_lng', 'company_id', 'creado', 'hora', 'id', 'motivo', 'route_id', 'texto',
  ]);
  assert.ok(!Object.values(guardada).includes('Ana'));
  assert.ok(!Object.values(guardada).includes('1.2.3.4'));
  assert.ok(!Object.values(guardada).includes('android'));
});

test('POST /api/reportes: una queja sin ruta va al correo pero no se guarda, porque no tiene dueño', async () => {
  limpiar();
  assert.equal((await enviar({ tipo: 'queja', motivo: 'otro', texto: 'Algo pasó' })).estado, 201);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM reportes').get() as { n: number }).n, 1);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM quejas').get() as { n: number }).n, 0);
});

test('POST /api/reportes: queja mala, 400 y nada guardado', async () => {
  limpiar();
  const r = await enviar({ tipo: 'queja', motivo: 'no_paro', routeId: 'R-901', busId: 'BUS-902' });
  assert.equal(r.estado, 400);
  assert.equal((r.cuerpo.error as { code: string }).code, 'INVALID_INPUT');
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM quejas').get() as { n: number }).n, 0);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM reportes').get() as { n: number }).n, 0);
});

test('las quejas guardadas se borran a los 13 meses; los problemas y sugerencias no se guardan', () => {
  limpiar();
  const vieja = AHORA - 397 * DIA;
  quejas.guardarQueja({ motivo: 'otro', routeId: 'R-901', companyId: 'EMP-QUEJAS', busId: null, celda: null, hora: null }, 'vieja', vieja);
  quejas.guardarQueja({ motivo: 'otro', routeId: 'R-901', companyId: 'EMP-QUEJAS', busId: null, celda: null, hora: null }, 'nueva', AHORA - 395 * DIA);
  assert.equal(quejas.limpiarQuejas(AHORA), 1);
  assert.deepEqual(getDb().prepare('SELECT texto FROM quejas').all(), [{ texto: 'nueva' }]);
});

// ── El panel ─────────────────────────────────────────────────────────

test('GET /api/panel/quejas: cada empresa ve solo las de sus rutas, la más nueva arriba', async () => {
  limpiar();
  const ahora = Date.now();
  quejas.guardarQueja({ motivo: 'no_paro', routeId: 'R-901', companyId: 'EMP-QUEJAS', busId: 'BUS-901', celda: CELDA, hora: ahora - 3 * 60 * 60_000 }, 'Primera', ahora - 2 * 60 * 60_000);
  quejas.guardarQueja({ motivo: 'iba_lleno', routeId: 'R-901', companyId: 'EMP-QUEJAS', busId: null, celda: CELDA, hora: null }, '', ahora - 60 * 60_000);
  quejas.guardarQueja({ motivo: 'mal_trato', routeId: 'R-901', companyId: 'EMP-QUEJAS', busId: null, celda: null, hora: null }, 'Sin lugar', ahora - 30 * 60_000);
  quejas.guardarQueja({ motivo: 'otro', routeId: 'R-902', companyId: 'EMP-OTRA', busId: 'BUS-902', celda: CELDA, hora: null }, 'Ajena', ahora);

  const propia = await panel(tokenDe('EMP-QUEJAS'));
  assert.equal(propia.estado, 200);
  const lista = propia.cuerpo.quejas as Array<Record<string, unknown>>;
  assert.deepEqual(lista.map((q) => q.texto), ['Sin lugar', '', 'Primera']);
  assert.deepEqual(Object.keys(lista[2]).sort(), ['busId', 'celda', 'creado', 'hora', 'id', 'motivo', 'routeId', 'ruta', 'texto']);
  assert.equal(lista[2].ruta, 'Ruta de la queja');
  assert.deepEqual(lista[2].celda, CELDA);
  assert.equal(lista[0].celda, null);
  // El mapa agrega por celda, sin bus ni placa.
  assert.deepEqual(propia.cuerpo.celdas, [{ lat: CELDA.lat, lng: CELDA.lng, total: 2 }]);
  assert.ok(!JSON.stringify(propia.cuerpo).includes('ABC123'), 'la placa no sale del backend');

  const otra = await panel(tokenDe('EMP-OTRA'));
  assert.deepEqual((otra.cuerpo.quejas as Array<Record<string, unknown>>).map((q) => q.texto), ['Ajena']);
});

test('GET /api/panel/quejas: filtra por ruta, motivo y fechas; sin sesión, 401; filtro malo, 400', async () => {
  const token = tokenDe('EMP-QUEJAS');
  const porMotivo = await panel(token, '?motivo=no_paro');
  assert.deepEqual((porMotivo.cuerpo.quejas as Array<Record<string, unknown>>).map((q) => q.texto), ['Primera']);
  assert.deepEqual(porMotivo.cuerpo.celdas, [{ lat: CELDA.lat, lng: CELDA.lng, total: 1 }]);
  const porRuta = await panel(token, '?routeId=R-901');
  assert.equal((porRuta.cuerpo.quejas as unknown[]).length, 3);
  // La ruta de otra empresa no se puede pedir: no es suya.
  assert.equal((await panel(token, '?routeId=R-902')).estado, 404);
  const manana = new Date(Date.now() + 2 * DIA).toISOString();
  const vacio = await panel(token, `?desde=${manana}&hasta=${new Date(Date.now() + 3 * DIA).toISOString()}`);
  assert.deepEqual(vacio.cuerpo, { quejas: [], celdas: [] });
  assert.equal((await panel(null)).estado, 401);
  assert.equal((await panel(token, '?motivo=robo')).estado, 400);
  assert.equal((await panel(token, '?desde=ayer')).estado, 400);
});

test('el limitador de D14 sigue: la sexta queja en 10 minutos es 429', async () => {
  limpiar();
  olvidarLimitador();
  const una = () => fetch(`${base}/api/reportes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tipo: 'queja', motivo: 'otro' }),
  });
  for (let i = 0; i < 5; i++) assert.equal((await una()).status, 201);
  assert.equal((await una()).status, 429);
});
