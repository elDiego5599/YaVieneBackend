// El JSON de la API viaja en gzip cuando el cliente lo pide.
//
// Por ngrok gratis la conexión es lenta, y el JSON es texto repetido: la
// flota de una empresa bajaba de 4,5 KB a 0,5 KB comprimida. El cliente de
// Dart (app y panel) manda `Accept-Encoding: gzip` y descomprime solo, igual
// que el navegador. Lo pequeño se queda como está: en gzip crecería.
//
// Servidores de usar y tirar en el puerto que dé el sistema, como en
// api_rutas.test.ts.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http, { createServer, IncomingHttpHeaders, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-respuesta-json-'));
process.env.YA_VIENE_DB_PATH = join(tmp, 'test.db');

// require y no import: estos módulos abren la base al evaluarse.
const { escribirJson, aceptaGzip } = require('../src/api/respuesta_json') as typeof import('../src/api/respuesta_json');
const { handleAPI } = require('../src/api/routes') as typeof import('../src/api/routes');
const { addCompanyRoute } = require('../src/data/routes_store') as typeof import('../src/data/routes_store');
const { getDb } = require('../src/data/database') as typeof import('../src/data/database');

const GRANDE = { buses: Array.from({ length: 60 }, (_, i) => ({ busId: `BUS-${i}`, routeId: 'R-101', lat: 10.98, lng: -74.8 })) };
const PEQUENO = { status: 'ready' };

const servidores: Server[] = [];

async function levantar(manejador: http.RequestListener): Promise<string> {
  const servidor = createServer(manejador);
  servidores.push(servidor);
  await new Promise<void>((listo) => servidor.listen(0, '127.0.0.1', listo));
  return `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
}

/** Sin descomprimir nada: los bytes tal como salen del servidor. */
function pedirBruta(url: string, cabeceras: Record<string, string> = {}): Promise<{ status: number; headers: IncomingHttpHeaders; cuerpo: Buffer }> {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: cabeceras }, (res) => {
      const trozos: Buffer[] = [];
      res.on('data', (t: Buffer) => trozos.push(t));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, cuerpo: Buffer.concat(trozos) }));
    }).on('error', reject);
  });
}

let base = '';

test.before(async () => {
  base = await levantar((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.searchParams.has('vary')) res.setHeader('Vary', 'Origin');
    escribirJson(res, Number(url.searchParams.get('status') ?? 200), url.pathname === '/grande' ? GRANDE : PEQUENO);
  });
});

test.after(async () => {
  for (const s of servidores) await new Promise<void>((listo) => s.close(() => listo()));
  try {
    getDb().close();
  } catch {
    // ya cerrada
  }
  rmSync(tmp, { recursive: true, force: true });
});

test('JSON grande con Accept-Encoding gzip sale comprimido y se lee igual', async () => {
  const r = await pedirBruta(`${base}/grande`, { 'accept-encoding': 'gzip, deflate, br' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-encoding'], 'gzip');
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(r.headers.vary, 'Accept-Encoding');
  assert.equal(Number(r.headers['content-length']), r.cuerpo.length);
  assert.ok(r.cuerpo.length < JSON.stringify(GRANDE).length / 3, `comprimido ${r.cuerpo.length} B`);
  assert.deepEqual(JSON.parse(gunzipSync(r.cuerpo).toString('utf8')), GRANDE);
});

test('sin pedir gzip, o con gzip;q=0, sale en claro', async () => {
  for (const cabeceras of [{}, { 'accept-encoding': 'gzip;q=0, deflate' }, { 'accept-encoding': 'identity' }]) {
    const r = await pedirBruta(`${base}/grande`, cabeceras);
    assert.equal(r.headers['content-encoding'], undefined, JSON.stringify(cabeceras));
    assert.equal(r.headers.vary, 'Accept-Encoding');
    assert.deepEqual(JSON.parse(r.cuerpo.toString('utf8')), GRANDE);
  }
});

test('lo pequeño no se comprime: en gzip crecería', async () => {
  const r = await pedirBruta(`${base}/pequeno`, { 'accept-encoding': 'gzip' });
  assert.equal(r.headers['content-encoding'], undefined);
  assert.deepEqual(JSON.parse(r.cuerpo.toString('utf8')), PEQUENO);
});

test('el Vary de CORS se conserva y se le suma Accept-Encoding', async () => {
  const r = await pedirBruta(`${base}/grande?vary=1`, { 'accept-encoding': 'gzip' });
  assert.equal(r.headers.vary, 'Origin, Accept-Encoding');
});

test('los errores grandes también van comprimidos con su código', async () => {
  const r = await pedirBruta(`${base}/grande?status=409`, { 'accept-encoding': 'gzip' });
  assert.equal(r.status, 409);
  assert.equal(r.headers['content-encoding'], 'gzip');
});

test('aceptaGzip lee Accept-Encoding como dice la RFC 9110', () => {
  assert.equal(aceptaGzip(undefined), false);
  assert.equal(aceptaGzip(''), false);
  assert.equal(aceptaGzip('gzip'), true);
  assert.equal(aceptaGzip('GZIP'), true);
  assert.equal(aceptaGzip('br, gzip;q=0.8'), true);
  assert.equal(aceptaGzip('gzip;q=0'), false);
  assert.equal(aceptaGzip('gzip; q=0.0'), false);
  assert.equal(aceptaGzip('deflate, br'), false);
  assert.equal(aceptaGzip('x-gzip'), false);
});

test('la API de verdad comprime: las rutas de una empresa con muchas rutas', async () => {
  for (let i = 0; i < 40; i++) addCompanyRoute('EMP-01', `R-9${String(i).padStart(2, '0')}`, `Ruta de prueba número ${i}`);
  const api = await levantar((req, res) => {
    if (!handleAPI(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  const r = await pedirBruta(`${api}/api/companies/EMP-01/routes`, { 'accept-encoding': 'gzip' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-encoding'], 'gzip');
  const rutas = JSON.parse(gunzipSync(r.cuerpo).toString('utf8')) as unknown;
  assert.ok(JSON.stringify(rutas).includes('Ruta de prueba número 39'));
});
