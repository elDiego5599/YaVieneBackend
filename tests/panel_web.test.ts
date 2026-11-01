// El panel web servido por el backend en /panel/, en el mismo origen que la
// API: así la cookie SameSite=Strict del panel viaja sin depender de la
// Public Suffix List (ver `auth/cookie_panel.ts`).
//
// Primero los estáticos contra un servidor de esta prueba (tipos, CSP,
// caché y lo que no se sirve); después el backend de verdad: sin
// YA_VIENE_PANEL_WEB no hay panel, y con ella el login del mismo origen
// pone la cookie sin abrir CORS_ORIGINS a nadie.
//
// Puertos propios, HTTP 3300-3302 y MQTT 9070-9072: node --test corre los
// archivos en paralelo (el reparto de los demás está en arranque.test.ts).
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

import { panelWeb } from '../src/api/panel_web';
import { HOST_PRUEBAS } from './red_pruebas';

const CSP = "default-src 'self'; frame-ancestors 'none'";
const tmp = mkdtempSync(join(tmpdir(), 'yaviene-panel-web-'));
const build = join(tmp, 'web');
mkdirSync(join(build, 'canvaskit'), { recursive: true });
writeFileSync(join(build, 'index.html'), '<!DOCTYPE html><title>Ya Viene Control</title>');
writeFileSync(join(build, 'main.dart.js'), 'console.log(1)');
writeFileSync(join(build, 'canvaskit', 'canvaskit.wasm'), Buffer.from([0, 97, 115, 109]));
writeFileSync(join(build, 'canvaskit', 'canvaskit.js.symbols'), '1 x');
writeFileSync(join(build, '.last_build_id'), 'oculto');
writeFileSync(join(build, 'csp.txt'), `${CSP}\n`);
// Lo que está al lado de la build y no se puede servir.
writeFileSync(join(tmp, 'secreto.txt'), 'SECRETO');
symlinkSync(join(tmp, 'secreto.txt'), join(build, 'enlace.txt'));

let base = '';
const servidorPrueba = http.createServer((req, res) => {
  if (!panelWeb(build)(req, res)) {
    res.writeHead(404);
    res.end('fuera del panel');
  }
});

test.before(async () => {
  await new Promise<void>((listo) => servidorPrueba.listen(0, HOST_PRUEBAS, listo));
  base = `http://${HOST_PRUEBAS}:${(servidorPrueba.address() as AddressInfo).port}`;
});

test.after(async () => {
  await new Promise((listo) => servidorPrueba.close(listo));
  for (const s of backends) await apagar(s);
  rmSync(tmp, { recursive: true, force: true });
});

/** Sin normalizar la ruta: `fetch` resuelve `..` antes de mandarla. */
function pedirCruda(ruta: string, metodo = 'GET'): Promise<{ status: number; cuerpo: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const req = http.request(
      { host: url.hostname, port: url.port, path: ruta, method: metodo },
      (res) => {
        let cuerpo = '';
        res.on('data', (c) => { cuerpo += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, cuerpo }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('/panel/ entrega el index con la CSP de la build y sin caché a ciegas', async () => {
  const r = await fetch(`${base}/panel/`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(r.headers.get('content-security-policy'), CSP);
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  assert.match(await r.text(), /Ya Viene Control/);
});

test('/panel sin barra lleva a /panel/: la base de la build es relativa a ella', async () => {
  const r = await fetch(`${base}/panel`, { redirect: 'manual' });
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), '/panel/');
});

test('cada archivo con su tipo, el wasm como application/wasm', async () => {
  const tipos: Record<string, string> = {
    '/panel/main.dart.js': 'text/javascript; charset=utf-8',
    '/panel/canvaskit/canvaskit.wasm': 'application/wasm',
    '/panel/canvaskit/canvaskit.js.symbols': 'application/octet-stream',
  };
  for (const [ruta, tipo] of Object.entries(tipos)) {
    const r = await fetch(`${base}${ruta}`);
    assert.equal(r.status, 200, ruta);
    assert.equal(r.headers.get('content-type'), tipo, ruta);
    assert.equal(r.headers.get('content-security-policy'), CSP, ruta);
  }
  const wasm = await fetch(`${base}/panel/canvaskit/canvaskit.wasm`);
  assert.deepEqual([...new Uint8Array(await wasm.arrayBuffer())], [0, 97, 115, 109]);
});

test('con el ETag de vuelta contesta 304 sin cuerpo', async () => {
  const primera = await fetch(`${base}/panel/main.dart.js`);
  const etag = primera.headers.get('etag');
  assert.ok(etag);
  const segunda = await fetch(`${base}/panel/main.dart.js`, { headers: { 'if-none-match': etag } });
  assert.equal(segunda.status, 304);
  assert.equal(await segunda.text(), '');
});

/** Con las cabeceras dadas y el cuerpo en bruto: `fetch` descomprime solo. */
function pedirBruta(ruta: string, cabeceras: Record<string, string>): Promise<{ res: http.IncomingMessage; cuerpo: Buffer }> {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    http.get({ host: url.hostname, port: url.port, path: ruta, headers: cabeceras }, (res) => {
      const trozos: Buffer[] = [];
      res.on('data', (c: Buffer) => trozos.push(c));
      res.on('end', () => resolve({ res, cuerpo: Buffer.concat(trozos) }));
    }).on('error', reject);
  });
}

// Por ngrok gratis el panel baja a unos 140 KB/s: main.dart.js y el wasm de
// CanvasKit pesan 9 MB y comprimidos 3,2. Gzip solo si el navegador lo pide.
test('el js y el wasm van con gzip si se piden así, y su ETag es otro', async () => {
  for (const [ruta, original] of [
    ['/panel/main.dart.js', Buffer.from('console.log(1)')],
    ['/panel/canvaskit/canvaskit.wasm', Buffer.from([0, 97, 115, 109])],
  ] as const) {
    const plano = await pedirBruta(ruta, {});
    assert.equal(plano.res.headers['content-encoding'], undefined, ruta);
    assert.deepEqual(plano.cuerpo, original, ruta);
    assert.equal(plano.res.headers.vary, 'Accept-Encoding', ruta);

    const gz = await pedirBruta(ruta, { 'accept-encoding': 'br, gzip;q=0.8' });
    assert.equal(gz.res.headers['content-encoding'], 'gzip', ruta);
    assert.equal(gz.res.headers.vary, 'Accept-Encoding', ruta);
    assert.deepEqual(gunzipSync(gz.cuerpo), original, ruta);
    assert.notEqual(gz.res.headers.etag, plano.res.headers.etag, ruta);

    const otra = await pedirBruta(ruta, { 'accept-encoding': 'gzip', 'if-none-match': String(gz.res.headers.etag) });
    assert.equal(otra.res.statusCode, 304, ruta);
    // El ETag del comprimido no vale para el plano: se manda entero.
    const cruzada = await pedirBruta(ruta, { 'if-none-match': String(gz.res.headers.etag) });
    assert.equal(cruzada.res.statusCode, 200, ruta);
  }
});

test('gzip;q=0 o un archivo ya comprimido van tal cual', async () => {
  const rechazo = await pedirBruta('/panel/main.dart.js', { 'accept-encoding': 'gzip;q=0, deflate' });
  assert.equal(rechazo.res.headers['content-encoding'], undefined);
  assert.equal(rechazo.cuerpo.toString(), 'console.log(1)');
  const simbolos = await pedirBruta('/panel/canvaskit/canvaskit.js.symbols', { 'accept-encoding': 'gzip' });
  assert.equal(simbolos.res.headers['content-encoding'], undefined);
});

test('HEAD da las cabeceras sin cuerpo; lo que escribe no entra', async () => {
  const head = await pedirCruda('/panel/main.dart.js', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.cuerpo, '');
  const post = await fetch(`${base}/panel/`, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
});

test('una carpeta no se lista', async () => {
  for (const ruta of ['/panel/canvaskit/', '/panel/canvaskit']) {
    const r = await pedirCruda(ruta);
    assert.equal(r.status, 404, ruta);
    assert.doesNotMatch(r.cuerpo, /canvaskit\.wasm/, ruta);
  }
});

test('ni ../ ni %2e%2e ni un enlace sacan nada de la build', async () => {
  for (const ruta of [
    '/panel/../secreto.txt',
    '/panel/%2e%2e/secreto.txt',
    '/panel/%2E%2E%2Fsecreto.txt',
    '/panel/..%2fsecreto.txt',
    '/panel/canvaskit/..%2F..%2Fsecreto.txt',
    '/panel/%252e%252e/secreto.txt',
    '/panel/..%5csecreto.txt',
    '/panel/enlace.txt',
    '/panel/index.html%00.js',
    '/panel/%E0%A4%A',
    '/panel/.last_build_id',
    '/panel/csp.txt/',
  ]) {
    const r = await pedirCruda(ruta);
    assert.equal(r.status, 404, ruta);
    assert.doesNotMatch(r.cuerpo, /SECRETO|oculto/, ruta);
  }
});

test('lo que no es /panel no lo toca', async () => {
  for (const ruta of ['/', '/panelx', '/api/ready', '/panel.html']) {
    assert.equal((await pedirCruda(ruta)).cuerpo, 'fuera del panel', ruta);
  }
});

test('sin carpeta no hay panel; sin csp.txt o sin index.html no arranca', () => {
  assert.equal(panelWeb(undefined)({ url: '/panel/' } as http.IncomingMessage, {} as http.ServerResponse), false);

  const sinCsp = join(tmp, 'sin-csp');
  mkdirSync(sinCsp);
  writeFileSync(join(sinCsp, 'index.html'), '');
  assert.throws(() => panelWeb(sinCsp), /csp\.txt/);

  const sinIndex = join(tmp, 'sin-index');
  mkdirSync(sinIndex);
  writeFileSync(join(sinIndex, 'csp.txt'), CSP);
  assert.throws(() => panelWeb(sinIndex), /index\.html/);

  assert.throws(() => panelWeb(join(tmp, 'no-existe')), /YA_VIENE_PANEL_WEB/);
});

// ── El backend de verdad ────────────────────────────────────────────

const backends: ChildProcess[] = [];

const errores: Record<string, string> = {};

async function arrancar(httpPort: string, mqttPort: string, extra: Record<string, string>): Promise<string> {
  const url = `http://${HOST_PRUEBAS}:${httpPort}`;
  const hijo = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      YA_VIENE_FLOTA_DEMO: '0',
      MQTT_DEBUG_LOGS: 'false',
      HTTP_HOST: HOST_PRUEBAS,
      JWT_SECRET: 'panel-web-jwt-secret',
      ADMIN_API_KEY: 'panel-web-admin-key',
      HTTP_PORT: httpPort,
      MQTT_PORT: mqttPort,
      YA_VIENE_DB_PATH: join(tmp, `${httpPort}.db`),
      ...extra,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  backends.push(hijo);
  errores[httpPort] = '';
  hijo.stderr?.on('data', (c) => { errores[httpPort] += c; });
  const hasta = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${url}/api/ready`)).ok) return url;
    } catch {
      // todavía no escucha
    }
    if (Date.now() > hasta) throw new Error(`el backend de ${httpPort} no levantó a tiempo`);
    await new Promise((sigue) => setTimeout(sigue, 100));
  }
}

async function apagar(hijo: ChildProcess): Promise<void> {
  if (hijo.exitCode !== null) return;
  await new Promise<void>((listo) => {
    hijo.once('exit', () => listo());
    hijo.kill('SIGKILL');
    setTimeout(() => listo(), 5000);
  });
}

test('sin YA_VIENE_PANEL_WEB, /panel/ es el 404 de siempre', { timeout: 60_000 }, async () => {
  const url = await arrancar('3301', '9071', {});
  for (const ruta of ['/panel', '/panel/', '/panel/index.html']) {
    const r = await fetch(`${url}${ruta}`, { redirect: 'manual' });
    assert.equal(r.status, 404, ruta);
    assert.deepEqual(await r.json(), { error: 'No encontrado' }, ruta);
  }
});

test('una carpeta del panel a medias no tumba la API: el panel queda en 404 y lo dice', { timeout: 60_000 }, async () => {
  const url = await arrancar('3302', '9072', { YA_VIENE_PANEL_WEB: join(tmp, 'no-existe') });
  assert.equal((await fetch(`${url}/panel/`)).status, 404);
  assert.match(errores['3302'], /\[Panel\] No se sirve el panel web: YA_VIENE_PANEL_WEB/);
});

test('con YA_VIENE_PANEL_WEB, el panel y su login van por el mismo origen', { timeout: 60_000 }, async () => {
  // Sin CORS_ORIGINS: el mismo origen no la necesita y no se abre a nadie.
  const url = await arrancar('3300', '9070', { YA_VIENE_PANEL_WEB: build });

  const index = await fetch(`${url}/panel/`);
  assert.equal(index.status, 200);
  assert.equal(index.headers.get('content-security-policy'), CSP);
  assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(index.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(index.headers.get('x-frame-options'), 'DENY');
  assert.equal(index.headers.get('access-control-allow-origin'), null);

  const alta = await fetch(`${url}/api/admin/empresas/EMP-WEB/admin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': 'panel-web-admin-key' },
    body: JSON.stringify({ username: 'panel-mismo-origen', password: 'clave-de-usar-y-tirar' }),
  });
  assert.equal(alta.status, 201);

  const entrar = (origen: string) => fetch(`${url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: origen },
    body: JSON.stringify({ username: 'panel-mismo-origen', password: 'clave-de-usar-y-tirar' }),
  });

  // Lo que manda el navegador desde /panel/: su Origin es el de la API.
  const propio = await entrar(url);
  assert.equal(propio.status, 200);
  assert.ok(propio.headers.getSetCookie().some((c) => c.startsWith('yv_panel=')));
  assert.equal(((await propio.json()) as { token?: unknown }).token, undefined);
  // Mismo origen: el navegador no pide CORS y no se le da.
  assert.equal(propio.headers.get('access-control-allow-origin'), null);

  for (const ajeno of [
    'http://ajeno.example',
    `http://${HOST_PRUEBAS}:3399`,
    `http://${HOST_PRUEBAS}`,
    'null',
  ]) {
    const r = await entrar(ajeno);
    assert.equal(r.status, 403, ajeno);
    assert.equal(r.headers.getSetCookie().length, 0, ajeno);
  }
});
