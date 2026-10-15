// La lista de «Avísame cuando salga» de la web (D15): la validación del
// número, la ruta pública, las del equipo para leerla y borrarla, y la
// guardia de WEB_ORIGINS. En proceso, con base temporal.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-lanzamiento-'));
process.env.YA_VIENE_DB_PATH = join(tmp, 'test.db');
process.env.JWT_SECRET = randomBytes(32).toString('hex');
const CLAVE_ADMIN = randomBytes(24).toString('hex');
process.env.ADMIN_API_KEY = CLAVE_ADMIN;

// require y no import: abren la base y leen el env al evaluarse.
const { handleAPI } = require('../src/api/routes') as typeof import('../src/api/routes');
const { getDb } = require('../src/data/database') as typeof import('../src/data/database');
const { validateConfig } = require('../src/config') as typeof import('../src/config');
const lanzamiento = require('../src/data/lanzamiento') as typeof import('../src/data/lanzamiento');

let base = '';
const servidor: Server = createServer((req, res) => {
  if (!handleAPI(req, res)) {
    res.writeHead(404);
    res.end();
  }
});

test.before(async () => {
  await new Promise<void>((listo) => servidor.listen(0, '127.0.0.1', listo));
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});

test.after(() => {
  servidor.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function pedir(
  metodo: string,
  ruta: string,
  opciones: { cuerpo?: unknown; admin?: boolean } = {},
): Promise<{ estado: number; cuerpo: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opciones.admin) headers['x-admin-key'] = CLAVE_ADMIN;
  const r = await fetch(`${base}${ruta}`, {
    method: metodo,
    headers,
    body: opciones.cuerpo === undefined ? undefined : JSON.stringify(opciones.cuerpo),
  });
  const texto = await r.text();
  return { estado: r.status, cuerpo: texto ? JSON.parse(texto) : null };
}

function telefonos(): string[] {
  return (getDb().prepare('SELECT telefono FROM lanzamiento ORDER BY telefono').all() as { telefono: string }[])
    .map((f) => f.telefono);
}

function codigo(cuerpo: unknown): string {
  return (cuerpo as { error: { code: string } }).error.code;
}

// ── El número ────────────────────────────────────────────────────────

test('el celular colombiano de 10 cifras gana el 57; el que ya trae indicativo se queda', () => {
  assert.deepEqual(lanzamiento.leerSuscripcion({ telefono: '300 123 4567', acepto: true }), { telefono: '573001234567' });
  assert.deepEqual(lanzamiento.leerSuscripcion({ telefono: '(300) 123-4567', acepto: true }), { telefono: '573001234567' });
  assert.deepEqual(lanzamiento.leerSuscripcion({ telefono: '+57 300 123 4567', acepto: true }), { telefono: '573001234567' });
  assert.deepEqual(lanzamiento.leerSuscripcion({ telefono: '573001234567', acepto: true }), { telefono: '573001234567' });
  // Otro país, con su indicativo: WhatsApp lo alcanza igual.
  assert.deepEqual(lanzamiento.leerSuscripcion({ telefono: '+1 305 555 0100', acepto: true }), { telefono: '13055550100' });
});

test('rechaza lo que no es un número al que se pueda escribir', () => {
  const malos: unknown[] = [
    '1234567', // fijo viejo, sin WhatsApp
    '12345678901234567', // más de 15 cifras: no existe en E.164
    '300 123 456a',
    '300+1234567', // el + solo va adelante
    '++573001234567',
    '',
    3001234567,
    null,
  ];
  for (const telefono of malos) {
    assert.ok('error' in lanzamiento.leerSuscripcion({ telefono, acepto: true }), String(telefono));
  }
});

test('sin el permiso marcado no se guarda nada', () => {
  for (const acepto of [undefined, false, 'true', 1]) {
    assert.ok('error' in lanzamiento.leerSuscripcion({ telefono: '3001234567', acepto }), String(acepto));
  }
  assert.ok('error' in lanzamiento.leerSuscripcion(null));
  assert.ok('error' in lanzamiento.leerSuscripcion(['3001234567']));
});

// ── La ruta pública ──────────────────────────────────────────────────

test('POST /api/lanzamiento guarda una vez, con la fecha y la versión del permiso, y frena al sexto', async () => {
  getDb().prepare('DELETE FROM lanzamiento').run();
  const antes = Date.now();

  const malo = await pedir('POST', '/api/lanzamiento', { cuerpo: { telefono: '3001234567' } });
  assert.equal(malo.estado, 400);
  assert.equal(codigo(malo.cuerpo), 'INVALID_INPUT');

  const bueno = await pedir('POST', '/api/lanzamiento', { cuerpo: { telefono: '300 123 4567', acepto: true, nombre: 'Ana' } });
  assert.equal(bueno.estado, 201);
  assert.deepEqual(bueno.cuerpo, { recibido: true });
  const fila = getDb().prepare('SELECT * FROM lanzamiento').get() as Record<string, unknown>;
  assert.deepEqual(Object.keys(fila).sort(), ['aceptado', 'autorizacion', 'telefono']);
  assert.equal(fila.telefono, '573001234567');
  assert.equal(fila.autorizacion, lanzamiento.VERSION_AUTORIZACION);
  assert.ok((fila.aceptado as number) >= antes);

  // El mismo número otra vez responde igual: quien pregunta no se entera
  // de si ya estaba, y la lista no se duplica.
  const repetido = await pedir('POST', '/api/lanzamiento', { cuerpo: { telefono: '+57 300 123 4567', acepto: true } });
  assert.equal(repetido.estado, 201);
  assert.deepEqual(telefonos(), ['573001234567']);

  assert.equal((await pedir('POST', '/api/lanzamiento', { cuerpo: { telefono: '3001112233', acepto: true } })).estado, 201);
  assert.equal((await pedir('POST', '/api/lanzamiento', { cuerpo: { telefono: '3001112244', acepto: true } })).estado, 201);
  const sexto = await pedir('POST', '/api/lanzamiento', { cuerpo: { telefono: '3001112255', acepto: true } });
  assert.equal(sexto.estado, 429);
  assert.deepEqual(telefonos(), ['573001112233', '573001112244', '573001234567']);
});

test('con la lista llena responde 503 y no crece', () => {
  getDb().prepare('DELETE FROM lanzamiento').run();
  const insertar = getDb().prepare('INSERT INTO lanzamiento (telefono, aceptado, autorizacion) VALUES (?, 0, 1)');
  getDb().transaction(() => {
    for (let i = 0; i < lanzamiento.MAX_LANZAMIENTO; i++) insertar.run(String(1e11 + i));
  })();
  assert.equal(lanzamiento.guardarSuscripcion('573009998877'), 'lleno');
  // Uno que ya está no ocupa sitio nuevo: se acepta igual.
  assert.equal(lanzamiento.guardarSuscripcion(String(1e11)), 'ok');
  assert.equal(telefonos().length, lanzamiento.MAX_LANZAMIENTO);
  getDb().prepare('DELETE FROM lanzamiento').run();
});

// ── Las rutas del equipo ─────────────────────────────────────────────

test('leer y borrar la lista pide la clave de administración', async () => {
  for (const [metodo, ruta] of [
    ['GET', '/api/admin/lanzamiento'],
    ['DELETE', '/api/admin/lanzamiento'],
    ['DELETE', '/api/admin/lanzamiento/573001234567'],
  ] as const) {
    const r = await pedir(metodo, ruta);
    assert.equal(r.estado, 401, `${metodo} ${ruta}`);
    assert.equal(codigo(r.cuerpo), 'ADMIN_AUTH_REQUIRED');
  }
});

test('el equipo lee la lista, borra un número a pedido de su dueño y la vacía tras avisar', async () => {
  getDb().prepare('DELETE FROM lanzamiento').run();
  lanzamiento.guardarSuscripcion('573001234567', 1000);
  lanzamiento.guardarSuscripcion('573007654321', 2000);

  const lista = await pedir('GET', '/api/admin/lanzamiento', { admin: true });
  assert.equal(lista.estado, 200);
  assert.deepEqual(lista.cuerpo, {
    telefonos: [
      { telefono: '573001234567', aceptado: 1000, autorizacion: lanzamiento.VERSION_AUTORIZACION },
      { telefono: '573007654321', aceptado: 2000, autorizacion: lanzamiento.VERSION_AUTORIZACION },
    ],
  });

  // Se pide como lo escribió la persona: el número se normaliza igual.
  const uno = await pedir('DELETE', `/api/admin/lanzamiento/${encodeURIComponent('300 123 4567')}`, { admin: true });
  assert.equal(uno.estado, 204);
  assert.deepEqual(telefonos(), ['573007654321']);
  // Idempotente: borrar uno que ya no está es lo mismo.
  assert.equal((await pedir('DELETE', '/api/admin/lanzamiento/3001234567', { admin: true })).estado, 204);
  const malo = await pedir('DELETE', '/api/admin/lanzamiento/abc', { admin: true });
  assert.equal(malo.estado, 400);

  assert.equal((await pedir('DELETE', '/api/admin/lanzamiento', { admin: true })).estado, 204);
  assert.deepEqual(telefonos(), []);
});

// ── WEB_ORIGINS ──────────────────────────────────────────────────────

test('WEB_ORIGINS se revisa como CORS_ORIGINS: origen exacto y https si da la cara', () => {
  const malos = validateConfig({ JWT_SECRET: 'x'.repeat(32), WEB_ORIGINS: 'https://yaviene.co/,*' }).errores;
  assert.ok(malos.some((e) => e.startsWith('WEB_ORIGINS: «https://yaviene.co/»')), malos.join('\n'));
  assert.ok(malos.some((e) => e.startsWith('WEB_ORIGINS: «*»')), malos.join('\n'));
  const plano = validateConfig({ JWT_SECRET: 'x'.repeat(32), YA_VIENE_EXPUESTO: '1', WEB_ORIGINS: 'http://yaviene.co' }).errores;
  assert.ok(plano.some((e) => e.includes('WEB_ORIGINS: «http://yaviene.co» no es https')), plano.join('\n'));
  const bien = validateConfig({ JWT_SECRET: 'x'.repeat(32), WEB_ORIGINS: 'https://yaviene.co, http://localhost:8091' }).errores;
  assert.ok(!bien.some((e) => e.startsWith('WEB_ORIGINS')), bien.join('\n'));
});
