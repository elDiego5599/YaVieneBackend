// La sesión del panel cuando corre en el navegador.
//
// En macOS y Windows el panel guarda el token en el llavero y lo manda como
// `Authorization: Bearer`. En el navegador ese token tendría que vivir en el
// almacenamiento de la página, donde cualquier script inyectado lo lee y se
// lleva la llave de toda la flota. Así que en web el token va en una cookie
// HttpOnly (el código de la página no la ve), Secure y SameSite=Strict (el
// navegador no la manda desde otro sitio), y el login no lo devuelve en el
// cuerpo. Qué petición es «del navegador» lo dice su Origin: solo un origen
// de CORS_ORIGINS recibe cookie; sin Origin (escritorio) todo sigue igual.
//
// Una cookie viaja sola, así que lo que escribe con ella exige además un
// Origin autorizado (defensa contra CSRF aunque SameSite ya la frene), y el
// socket con cookie también.
//
// Puertos propios, HTTP 3290 y MQTT 9060: node --test corre los archivos en
// paralelo (el reparto de los demás está en arranque.test.ts).
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { io } from 'socket.io-client';

import { HOST_PRUEBAS } from './red_pruebas';

const HTTP_PORT = '3290';
const MQTT_PORT = '9060';
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const ORIGEN = 'http://localhost:8095';
const AJENO = 'http://ajeno.example';
// Valores de usar y tirar para esta base temporal; no son de nadie.
const CLAVE_ADMIN = 'panel-cookie-admin-key';
// Cuatro cuentas: el login admite 5 intentos por usuario y minuto, y cerrar
// sesión corta todas las de su cuenta.
const USUARIO = 'panel-web';
const USUARIO_FLOTA = 'panel-web-flota';
const USUARIO_CIERRE = 'panel-web-cierre';
const USUARIO_TOPE = 'panel-web-tope';
const CLAVE = 'clave-de-usar-y-tirar';
const EMPRESA = 'EMP-WEB';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-panel-cookie-'));
let servidor: ChildProcess | undefined;

async function esperarListo(limiteMs: number): Promise<void> {
  const hasta = Date.now() + limiteMs;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/ready`);
      if (r.ok) return;
    } catch {
      // todavía no escucha
    }
    if (Date.now() > hasta) throw new Error('el backend no levantó a tiempo');
    await new Promise((sigue) => setTimeout(sigue, 100));
  }
}

test.before(async () => {
  servidor = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      YA_VIENE_FLOTA_DEMO: '0',
      MQTT_DEBUG_LOGS: 'false',
      HTTP_HOST: HOST_PRUEBAS,
      JWT_SECRET: 'panel-cookie-jwt-secret',
      ADMIN_API_KEY: CLAVE_ADMIN,
      HTTP_PORT,
      MQTT_PORT,
      CORS_ORIGINS: ORIGEN,
      YA_VIENE_DB_PATH: join(tmp, 'test.db'),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await esperarListo(30_000);
  for (const username of [USUARIO, USUARIO_FLOTA, USUARIO_CIERRE, USUARIO_TOPE]) {
    const alta = await fetch(`${BASE}/api/admin/empresas/${EMPRESA}/admin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-key': CLAVE_ADMIN },
      body: JSON.stringify({ username, password: CLAVE }),
    });
    assert.equal(alta.status, 201);
  }
  cookieFlota = await entrarWeb(USUARIO_FLOTA);
  tokenFlota = await entrarEscritorio(USUARIO_FLOTA);
});

let cookieFlota = '';
let tokenFlota = '';

test.after(async () => {
  if (servidor && servidor.exitCode === null) {
    await new Promise<void>((listo) => {
      servidor!.once('exit', () => listo());
      servidor!.kill('SIGKILL');
      setTimeout(() => listo(), 5000);
    });
  }
  rmSync(tmp, { recursive: true, force: true });
});

function entrar(origen?: string, username = USUARIO): Promise<Response> {
  return fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(origen ? { origin: origen } : {}),
    },
    body: JSON.stringify({ username, password: CLAVE }),
  });
}

/** El `nombre=valor` de la cookie del panel que puso [r], o null. */
function cookieDe(r: Response): string | null {
  const puesta = r.headers.getSetCookie().find((c) => c.startsWith('yv_panel='));
  return puesta ? puesta.split(';')[0] : null;
}

async function entrarWeb(username: string): Promise<string> {
  const r = await entrar(ORIGEN, username);
  assert.equal(r.status, 200);
  const cookie = cookieDe(r);
  assert.ok(cookie, 'el login web debió poner la cookie');
  return cookie;
}

async function entrarEscritorio(username: string): Promise<string> {
  const r = await entrar(undefined, username);
  assert.equal(r.status, 200);
  return ((await r.json()) as { token: string }).token;
}

test('el login desde el origen del panel pone la cookie y no devuelve el token', { timeout: 60_000 }, async () => {
  const r = await entrar(ORIGEN);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), ORIGEN);
  assert.equal(r.headers.get('access-control-allow-credentials'), 'true');

  const puesta = r.headers.getSetCookie().find((c) => c.startsWith('yv_panel='));
  assert.ok(puesta, 'falta la cookie yv_panel');
  const atributos = puesta.split(';').slice(1).map((a) => a.trim().toLowerCase());
  assert.ok(atributos.includes('httponly'));
  assert.ok(atributos.includes('secure'));
  assert.ok(atributos.includes('samesite=strict'));
  assert.ok(atributos.includes('path=/'));
  // Lo que dura el token del panel (8 h), nunca más.
  const maxAge = Number(atributos.find((a) => a.startsWith('max-age='))?.split('=')[1]);
  assert.ok(maxAge > 8 * 3600 - 60 && maxAge <= 8 * 3600, `max-age=${maxAge}`);

  const cuerpo = (await r.json()) as Record<string, unknown>;
  assert.equal(cuerpo.token, undefined);
  assert.deepEqual(cuerpo.company, { companyId: EMPRESA, name: EMPRESA });
});

test('el login sin Origin (escritorio) sigue devolviendo el token y no pone cookie', { timeout: 60_000 }, async () => {
  const r = await entrar();
  assert.equal(r.status, 200);
  assert.equal(cookieDe(r), null);
  assert.equal(typeof ((await r.json()) as { token?: unknown }).token, 'string');
});

test('el login desde un origen ajeno se rechaza', { timeout: 60_000 }, async () => {
  const r = await entrar(AJENO);
  assert.equal(r.status, 403);
  assert.equal(cookieDe(r), null);
});

test('el tope de intentos del login es el mismo con cookie que con token', { timeout: 60_000 }, async () => {
  // Tres por el navegador y dos por el escritorio agotan los cinco del minuto.
  for (const origen of [ORIGEN, ORIGEN, ORIGEN, undefined, undefined]) {
    assert.equal((await entrar(origen, USUARIO_TOPE)).status, 200);
  }
  assert.equal((await entrar(ORIGEN, USUARIO_TOPE)).status, 429);
  assert.equal((await entrar(undefined, USUARIO_TOPE)).status, 429);
});

test('la cookie abre la flota para leer, y para escribir solo con el Origin del panel', { timeout: 60_000 }, async () => {
  const cookie = cookieFlota;
  const leer = await fetch(`${BASE}/api/fleet/routes`, { headers: { cookie } });
  assert.equal(leer.status, 200);

  const crearRuta = (origen?: string) => fetch(`${BASE}/api/fleet/routes`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
      ...(origen ? { origin: origen } : {}),
    },
    body: JSON.stringify({ name: `Ruta ${origen ?? 'sin origen'}` }),
  });
  assert.equal((await crearRuta()).status, 403);
  assert.equal((await crearRuta(AJENO)).status, 403);
  assert.equal((await crearRuta(ORIGEN)).status, 201);
});

test('con Bearer y cookie a la vez manda el Bearer', { timeout: 60_000 }, async () => {
  const cookie = cookieFlota;
  const r = await fetch(`${BASE}/api/fleet/routes`, {
    headers: { cookie, authorization: 'Bearer no-es-un-token' },
  });
  assert.equal(r.status, 401);
  // Y un Bearer bueno escribe sin Origin aunque traiga cookie: es el escritorio.
  const token = tokenFlota;
  const escribir = await fetch(`${BASE}/api/fleet/routes`, {
    method: 'POST',
    headers: { cookie, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Ruta escritorio' }),
  });
  assert.equal(escribir.status, 201);
});

test('/api/admin/sesion dice de quién es la cookie, o 401', { timeout: 60_000 }, async () => {
  const cookie = cookieFlota;
  const r = await fetch(`${BASE}/api/admin/sesion`, { headers: { cookie } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { company: { companyId: EMPRESA, name: EMPRESA } });

  assert.equal((await fetch(`${BASE}/api/admin/sesion`)).status, 401);
  const basura = await fetch(`${BASE}/api/admin/sesion`, { headers: { cookie: 'yv_panel=basura' } });
  assert.equal(basura.status, 401);
});

test('cerrar sesión con la cookie la borra y la deja sin valor', { timeout: 60_000 }, async () => {
  const cookie = await entrarWeb(USUARIO_CIERRE);
  const r = await fetch(`${BASE}/api/fleet/logout`, {
    method: 'POST',
    headers: { cookie, origin: ORIGEN },
  });
  assert.equal(r.status, 204);
  const borrada = r.headers.getSetCookie().find((c) => c.startsWith('yv_panel='));
  assert.ok(borrada, 'el cierre debió reescribir la cookie');
  assert.match(borrada, /Max-Age=0/i);

  const despues = await fetch(`${BASE}/api/fleet/routes`, { headers: { cookie } });
  assert.equal(despues.status, 401);
});

function abrirSocket(opciones: { cookie?: string; origen?: string; token?: string }) {
  const cabeceras: Record<string, string> = {};
  if (opciones.cookie) cabeceras.cookie = opciones.cookie;
  if (opciones.origen) cabeceras.origin = opciones.origen;
  return io(BASE, {
    path: '/ws',
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    extraHeaders: cabeceras,
    ...(opciones.token ? { auth: { token: opciones.token } } : {}),
  });
}

/** 'lote' si el socket recibe la flota tras suscribirse; 'fuera' si lo echan. */
async function suscribir(s: ReturnType<typeof io>): Promise<'lote' | 'fuera'> {
  try {
    await new Promise<void>((listo, falla) => {
      s.once('connect', () => listo());
      s.once('connect_error', falla);
    });
    const resultado = new Promise<'lote' | 'fuera'>((listo) => {
      s.once('fleet:batch', () => listo('lote'));
      s.once('disconnect', () => listo('fuera'));
    });
    s.emit('subscribe:fleet');
    return await Promise.race([
      resultado,
      new Promise<never>((_, falla) =>
        setTimeout(() => falla(new Error('el socket no contestó')), 5_000)),
    ]);
  } finally {
    s.close();
  }
}

test('el socket del panel web entra con la cookie y el Origin del panel', { timeout: 60_000 }, async () => {
  const cookie = cookieFlota;
  assert.equal(await suscribir(abrirSocket({ cookie, origen: ORIGEN })), 'lote');
  assert.equal(await suscribir(abrirSocket({ cookie, origen: AJENO })), 'fuera');
  assert.equal(await suscribir(abrirSocket({ cookie })), 'fuera');
  assert.equal(await suscribir(abrirSocket({})), 'fuera');
  // El escritorio, con su token en el handshake, igual que siempre.
  assert.equal(await suscribir(abrirSocket({ token: tokenFlota })), 'lote');
});

test('el socket deja viajar la cookie también por polling', { timeout: 60_000 }, async () => {
  // El panel usa solo websocket, pero si un día entra el polling (origen
  // cruzado), sin Allow-Credentials el navegador no mandaría la cookie.
  const r = await fetch(`${BASE}/ws/?EIO=4&transport=polling`, { headers: { origin: ORIGEN } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), ORIGEN);
  assert.equal(r.headers.get('access-control-allow-credentials'), 'true');
});
