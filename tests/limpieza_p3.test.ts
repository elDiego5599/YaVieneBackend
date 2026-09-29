// Auditoría 2026-09, lo que se arregla de P3 sin cambiar el contrato ni lo
// que ve un cliente normal:
// - P3-1: los dos logins tardan lo mismo exista o no la cuenta.
// - P3-2: borrar-admin-empresa.mjs dice lo que de verdad pasa con el token.
// - P3-3: crear-admin-empresa.mjs no recibe la contraseña por argumento.
// - P3-7: los tokens se firman y se aceptan solo con HS256.
// - P3-8: listar las rutas de una empresa no hace una consulta por ruta, ni
//   pone el nombre que otra empresa le dio a la suya.
// - P3-10: la provisión rechaza identificadores que nunca pueden funcionar.
//
// Lo de los stores y los scripts corre en proceso, contra una base
// temporal; los logins y la provisión, contra un backend propio en HTTP
// 3280 y MQTT 9050 (reparto en arranque.test.ts).
import assert from 'node:assert/strict';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import jwt from 'jsonwebtoken';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-limpieza-p3-'));
const DB_EN_PROCESO = join(tmp, 'en-proceso.db');
process.env.YA_VIENE_DB_PATH = DB_EN_PROCESO;
process.env.JWT_SECRET = 'limpieza-p3-jwt-secret';

// require tras fijar el entorno: los módulos abren la base al cargarse.
const { getDb } = require('../src/data/database') as typeof import('../src/data/database');
const rutas = require('../src/data/routes_store') as typeof import('../src/data/routes_store');
const empresas = require('../src/data/empresas') as typeof import('../src/data/empresas');
const { hashSecret, verifySecret } = require('../src/auth/passwords') as typeof import('../src/auth/passwords');
const { signToken, verifyToken } = require('../src/auth/tokens') as typeof import('../src/auth/tokens');

const HTTP_PORT = 3280;
const MQTT_PORT = 9050;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const ADMIN_API_KEY = 'limpieza-p3-admin-key';
const DB_BACKEND = join(tmp, 'backend.db');
let backend: ChildProcess;

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

function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function provisionar(datos: Record<string, string>) {
  return postJson('/api/admin/drivers', {
    phoneNumber: '3008000001', name: 'Equipo', pin: '135790', companyId: 'EMP-P3', busId: 'BUS-P3A001', routeId: 'R-801',
    ...datos,
  }, { 'x-admin-key': ADMIN_API_KEY });
}

function mediana(valores: number[]): number {
  const orden = [...valores].sort((a, b) => a - b);
  return orden[Math.floor(orden.length / 2)];
}

before(async () => {
  backend = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      HTTP_PORT: String(HTTP_PORT),
      MQTT_PORT: String(MQTT_PORT),
      JWT_SECRET: 'limpieza-p3-backend-jwt',
      ADMIN_API_KEY,
      MQTT_DEBUG_LOGS: 'false',
      YA_VIENE_FLOTA_DEMO: '0',
      YA_VIENE_DB_PATH: DB_BACKEND,
    },
    stdio: 'ignore',
  });
  await esperarListo();
});

after(async () => {
  await parar(backend);
  try {
    getDb().close();
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

test('P3-1: el login del equipo tarda lo mismo exista o no la línea', async () => {
  assert.equal((await provisionar({})).status, 201);
  // Cada intento desde una IP y, los que no existen, con una línea distinta:
  // ningún tope por IP ni por cuenta se mete en la medida.
  const medir = async (i: number, phoneNumber: string) => {
    const desde = performance.now();
    const res = await postJson('/api/auth/login', { phoneNumber, pin: '000000' }, { 'x-forwarded-for': `10.31.0.${i}` });
    const ms = performance.now() - desde;
    assert.equal(res.status, 401);
    return ms;
  };
  const existe: number[] = [];
  const noExiste: number[] = [];
  for (let i = 1; i <= 5; i++) {
    existe.push(await medir(i, '3008000001'));
    noExiste.push(await medir(100 + i, `30080099${String(i).padStart(2, '0')}`));
  }
  // scrypt cuesta decenas de ms y lo demás menos de uno: sin el relleno, la
  // línea que no existe contesta en una fracción del tiempo.
  assert.ok(
    mediana(noExiste) >= 0.5 * mediana(existe),
    `existe ${mediana(existe).toFixed(1)} ms, no existe ${mediana(noExiste).toFixed(1)} ms`,
  );
});

test('P3-1: el login del panel tarda lo mismo exista o no el usuario', async () => {
  const alta = await postJson('/api/admin/empresas/EMP-P3/admin', { username: 'ana-p3', password: 'clave-de-prueba-p3' }, { 'x-admin-key': ADMIN_API_KEY });
  assert.equal(alta.status, 201);
  const medir = async (i: number, username: string) => {
    const desde = performance.now();
    const res = await postJson('/api/admin/login', { username, password: 'no-es-la-clave' }, { 'x-forwarded-for': `10.32.0.${i}` });
    const ms = performance.now() - desde;
    assert.equal(res.status, 401);
    return ms;
  };
  const existe: number[] = [];
  const noExiste: number[] = [];
  for (let i = 1; i <= 5; i++) {
    existe.push(await medir(i, 'ana-p3'));
    noExiste.push(await medir(100 + i, `nadie-p3-${i}`));
  }
  assert.ok(
    mediana(noExiste) >= 0.5 * mediana(existe),
    `existe ${mediana(existe).toFixed(1)} ms, no existe ${mediana(noExiste).toFixed(1)} ms`,
  );
});

test('P3-10: la provisión rechaza identificadores con los que el equipo nunca podría publicar', async () => {
  // Un busId o companyId con /, + o # arma un topic MQTT que el broker no
  // acepta jamás; una ruta sin forma de ruta no la ve ningún pasajero. Hoy
  // entraban con 201 y el equipo quedaba mudo sin que nadie supiera por qué.
  const malos: Record<string, string>[] = [
    { busId: 'BUS/P3' },
    { busId: 'BUS+P3' },
    { busId: 'BUS#P3' },
    { companyId: 'EMP/P3' },
    { companyId: 'EMP#P3' },
    { busId: 'B'.repeat(65) },
    { routeId: 'ruta 801' },
    { phoneNumber: '3'.repeat(33) },
    { phoneNumber: '300\n8000001' },
    { name: 'N'.repeat(121) },
  ];
  for (const malo of malos) {
    const res = await provisionar({ phoneNumber: '3008000002', ...malo });
    assert.equal(res.status, 400, `${JSON.stringify(malo)} tendría que ser 400`);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'INVALID_DRIVER_PROVISION');
  }
  // Lo de siempre sigue entrando: los de la demo, los de las pruebas y los
  // que salen de una placa.
  for (const bueno of [
    { busId: 'B-901', routeId: 'R-101', companyId: 'EMP-01' },
    { busId: 'B-106A', routeId: 'R-106', companyId: 'EMP-01' },
    { busId: 'BUS-ABC123', routeId: 'R-801', companyId: 'EMP-P3', name: 'N'.repeat(120) },
  ]) {
    const res = await provisionar({ phoneNumber: `30080001${bueno.busId.length}`, ...bueno });
    assert.equal(res.status, 201, JSON.stringify(bueno));
  }
});

test('P3-7: un token firmado con otro algoritmo no vale aunque la clave sea la buena', () => {
  const valido = signToken({
    sub: 'd1', driverId: 'd1', phoneNumber: '300', role: 'driver',
    companyId: 'EMP-01', busId: 'B-1', routeId: 'R-101', sessionId: 's1',
  });
  assert.equal((jwt.decode(valido, { complete: true }) as jwt.Jwt).header.alg, 'HS256');
  assert.ok(verifyToken(valido));
  const payload = jwt.decode(valido) as Record<string, unknown>;
  const otro = jwt.sign(payload, process.env.JWT_SECRET!, { algorithm: 'HS512' });
  assert.equal(verifyToken(otro), null, 'HS512 con la misma clave no se acepta');
});

test('P3-2: borrar-admin-empresa dice que el acceso se corta, no que el token sigue valiendo', () => {
  getDb().prepare('INSERT OR IGNORE INTO empresas (company_id, name, created_at) VALUES (?, ?, ?)')
    .run('EMP-BORRAR', 'Borrar', Date.now());
  empresas.createOrUpdateCompanyAdmin('EMP-BORRAR', 'uno-borrar', hashSecret('clave-de-prueba-uno'));
  empresas.createOrUpdateCompanyAdmin('EMP-BORRAR', 'dos-borrar', hashSecret('clave-de-prueba-dos'));
  const r = spawnSync(process.execPath, ['scripts/borrar-admin-empresa.mjs', 'uno-borrar'], {
    env: { PATH: process.env.PATH ?? '', YA_VIENE_DB_PATH: DB_EN_PROCESO },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /sigue siendo válido/);
  assert.match(r.stdout, /siguiente petición/);
});

test('P3-3: crear-admin-empresa lee la contraseña de la entrada o del entorno, nunca del argumento', () => {
  const crear = (args: string[], input?: string, extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['scripts/crear-admin-empresa.mjs', ...args], {
      env: { PATH: process.env.PATH ?? '', YA_VIENE_DB_PATH: DB_EN_PROCESO, ...extra },
      input,
      encoding: 'utf8',
    });
  const hashDe = (username: string) =>
    (getDb().prepare('SELECT password_hash FROM empresa_admins WHERE username = ?').get(username) as
      { password_hash: string } | undefined)?.password_hash ?? null;

  // «-» en el sitio de la contraseña: se lee de la entrada estándar.
  const porEntrada = crear(['EMP-CLI', 'ana-cli', '-', 'Empresa CLI'], 'clave-por-la-entrada\n');
  assert.equal(porEntrada.status, 0, porEntrada.stderr);
  assert.ok(verifySecret('clave-por-la-entrada', hashDe('ana-cli')));
  assert.equal(
    (getDb().prepare('SELECT name FROM empresas WHERE company_id = ?').get('EMP-CLI') as { name: string }).name,
    'Empresa CLI',
  );

  // O de CLAVE_PANEL, para quien la tenga en un gestor que exporta variables.
  const porEntorno = crear(['EMP-CLI', 'beto-cli', '-'], undefined, { CLAVE_PANEL: 'clave-por-el-entorno' });
  assert.equal(porEntorno.status, 0, porEntorno.stderr);
  assert.ok(verifySecret('clave-por-el-entorno', hashDe('beto-cli')));

  // Escrita en el argumento: queda en el historial y en `ps`. No se crea
  // nada y el mensaje dice cómo hacerlo.
  const porArgumento = crear(['EMP-CLI', 'caro-cli', 'clave-en-el-argumento']);
  assert.notEqual(porArgumento.status, 0);
  assert.match(porArgumento.stderr, /entrada estándar|CLAVE_PANEL/);
  assert.equal(hashDe('caro-cli'), null);

  // Las reglas de siempre siguen: corta es corta, venga de donde venga.
  const corta = crear(['EMP-CLI', 'dani-cli', '-'], 'corta\n');
  assert.notEqual(corta.status, 0);
  assert.equal(hashDe('dani-cli'), null);
});

test('P3-8: listar las rutas no hace una consulta por ruta ni enseña nombres ajenos', () => {
  const db = getDb();
  const ahora = Date.now();
  db.prepare('INSERT OR IGNORE INTO empresas (company_id, name, created_at) VALUES (?, ?, ?)').run('EMP-X', 'X', ahora);
  db.prepare('INSERT OR IGNORE INTO empresas (company_id, name, created_at) VALUES (?, ?, ?)').run('EMP-Y', 'Y', ahora);
  db.prepare('INSERT INTO company_routes (company_id, route_id, name, created_at) VALUES (?, ?, ?, ?)')
    .run('EMP-Y', 'R-790', 'Centro de Y', ahora);
  const bus = db.prepare('INSERT INTO buses (bus_id, company_id, route_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
  // Seis rutas que X usa sin tenerlas en su catálogo (buses viejos), una de
  // ellas del catálogo de Y, como pudo quedar antes de P1-2.
  for (let i = 1; i <= 5; i++) bus.run(`BUS-X${i}`, 'EMP-X', `R-78${i}`, ahora, ahora);
  bus.run('BUS-X9', 'EMP-X', 'R-790', ahora, ahora);

  const prepare = db.prepare.bind(db);
  let consultas = 0;
  db.prepare = ((sql: string) => {
    consultas += 1;
    return prepare(sql);
  }) as typeof db.prepare;
  let lista: ReturnType<typeof rutas.getCompanyRoutes>;
  let nombreOcupado: boolean;
  let consultasNombre: number;
  try {
    lista = rutas.getCompanyRoutes('EMP-X');
    const consultasLista = consultas;
    consultas = 0;
    nombreOcupado = rutas.routeNameExists('EMP-X', 'Centro de Y');
    consultasNombre = consultas;
    assert.ok(consultasLista <= 2, `getCompanyRoutes hizo ${consultasLista} consultas para 6 rutas`);
  } finally {
    db.prepare = prepare;
  }
  assert.ok(consultasNombre <= 2, `routeNameExists hizo ${consultasNombre} consultas`);
  assert.equal(lista.length, 6);
  const r790 = lista.find((r) => r.routeId === 'R-790');
  assert.equal(r790?.name, 'Ruta R-790', 'el nombre que Y le dio a su ruta no sale en el panel de X');
  assert.equal(nombreOcupado, false, 'ni sirve para adivinarlo');
  assert.equal(rutas.routeNameExists('EMP-X', 'Ruta R-781'), true, 'el nombre por defecto de una ruta sin catálogo sigue ocupado');
  // Una ruta del catálogo propio se llama por su nombre, no por el de por
  // defecto: «Ruta R-791» queda libre aunque R-791 tenga buses.
  db.prepare('INSERT INTO company_routes (company_id, route_id, name, created_at) VALUES (?, ?, ?, ?)')
    .run('EMP-X', 'R-791', 'Norte de X', ahora);
  bus.run('BUS-X10', 'EMP-X', 'R-791', ahora, ahora);
  assert.equal(rutas.routeNameExists('EMP-X', 'Norte de X'), true);
  assert.equal(rutas.routeNameExists('EMP-X', 'Ruta R-791'), false);
});
