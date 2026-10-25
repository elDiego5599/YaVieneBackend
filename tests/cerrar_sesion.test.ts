// Qué pasa con un token del panel cuando su dueño cierra sesión.
//
// Antes cerrar sesión solo borraba el token del equipo: quien lo hubiera
// copiado seguía entrando hasta que caducara, a las 8 horas. Ahora
// `POST /api/fleet/logout` sube la versión de la credencial, igual que un
// cambio de contraseña, y eso corta todas las sesiones de ese usuario: la
// del equipo que cierra y las de cualquier otro donde se haya entrado con
// la misma cuenta. Esta prueba fija las dos puertas: el REST responde 401 al
// token viejo, y el socket que ya estaba dentro sale en la siguiente
// revisión de paneles.
//
// Puertos propios, HTTP 3200 y MQTT 8970: node --test corre los archivos en
// paralelo (el reparto de los demás está en arranque.test.ts).
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import test from 'node:test';

import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';

const HTTP_PORT = 3200;
const MQTT_PORT = 8970;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const DB_PATH = `/tmp/yaviene-cerrar-sesion-${process.pid}-${Date.now()}.db`;
// Valores de usar y tirar para esta base temporal; no son de nadie.
const CLAVE_ADMIN = 'cerrar-sesion-admin-key';
const SECRETO_JWT = 'cerrar-sesion-jwt-secret';
const USUARIO = 'panel-cierre';
const CLAVE = 'clave-de-usar-y-tirar';

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/ready`);
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Backend did not become ready');
}

function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once('exit', finish);
    child.kill('SIGTERM');
    setTimeout(() => {
      child.kill('SIGKILL');
      finish();
    }, 3000);
  });
}

async function entrar(): Promise<string> {
  const r = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USUARIO, password: CLAVE }),
  });
  assert.equal(r.status, 200);
  return ((await r.json()) as { token: string }).token;
}

function rutas(token: string): Promise<Response> {
  return fetch(`${BASE}/api/fleet/routes`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

function salir(token?: string): Promise<Response> {
  return fetch(`${BASE}/api/fleet/logout`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function renovar(token?: string): Promise<Response> {
  return fetch(`${BASE}/api/fleet/renovar`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

test('cerrar sesión deja fuera al token viejo en REST y en el socket', { timeout: 40_000 }, async () => {
  const backend = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      HTTP_PORT: String(HTTP_PORT),
      MQTT_PORT: String(MQTT_PORT),
      JWT_SECRET: SECRETO_JWT,
      ADMIN_API_KEY: CLAVE_ADMIN,
      MQTT_DEBUG_LOGS: 'false',
      YA_VIENE_FLOTA_DEMO: '0',
      YA_VIENE_DB_PATH: DB_PATH,
      // La revisión de paneles corre cada minuto; aquí no se espera tanto.
      YA_VIENE_REVISION_PANEL_MS: '200',
    },
    stdio: 'ignore',
  });
  let socket: ReturnType<typeof io> | null = null;

  try {
    await waitForReady();
    const alta = await fetch(`${BASE}/api/admin/empresas/EMP-CIERRE/admin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-key': CLAVE_ADMIN },
      body: JSON.stringify({ username: USUARIO, password: CLAVE, name: 'Empresa cierre' }),
    });
    assert.equal(alta.status, 201);

    // Sin token no hay a quién sacar.
    assert.equal((await salir()).status, 401);

    // Dos sesiones de la misma cuenta, como el panel en dos equipos.
    const tokenReciente = await entrar();
    const decodificar = (valor: string) => JSON.parse(Buffer.from(valor.split('.')[1], 'base64url').toString());
    const claimsRecientes = decodificar(tokenReciente);
    delete claimsRecientes.iat;
    delete claimsRecientes.exp;
    delete claimsRecientes.iss;
    delete claimsRecientes.aud;
    const token = jwt.sign({
      ...claimsRecientes,
      iat: Math.floor(Date.now() / 1000) - 10,
    }, SECRETO_JWT, {
      algorithm: 'HS256',
      issuer: 'ya-viene-backend',
      audience: 'ya-viene-mqtt',
      expiresIn: 8 * 60 * 60,
    });
    const otroEquipo = await entrar();
    assert.equal((await rutas(token)).status, 200);

    assert.equal((await renovar()).status, 401);
    const renovacion = await renovar(token);
    assert.equal(renovacion.status, 200);
    const renovado = (await renovacion.json()) as { token: string; company: { companyId: string } };
    const claimsViejos = decodificar(token);
    const claimsNuevos = decodificar(renovado.token);
    assert.ok(claimsNuevos.exp > claimsViejos.exp);
    assert.deepEqual(
      { sub: claimsNuevos.sub, companyId: claimsNuevos.companyId, username: claimsNuevos.username, tv: claimsNuevos.tv },
      { sub: claimsViejos.sub, companyId: claimsViejos.companyId, username: claimsViejos.username, tv: claimsViejos.tv },
    );
    assert.equal(renovado.company.companyId, claimsViejos.companyId);

    const loginWeb = await fetch(`${BASE}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ username: USUARIO, password: CLAVE }),
    });
    assert.equal(loginWeb.status, 200);
    const cookie = loginWeb.headers.get('set-cookie');
    assert.ok(cookie?.startsWith('yv_panel='));
    const renovacionWeb = await fetch(`${BASE}/api/fleet/renovar`, {
      method: 'POST',
      headers: { cookie: cookie!.split(';')[0], origin: BASE },
    });
    assert.equal(renovacionWeb.status, 200);
    assert.deepEqual(Object.keys(await renovacionWeb.json() as object), ['company']);
    assert.ok(renovacionWeb.headers.get('set-cookie')?.startsWith('yv_panel='));

    const s = io(BASE, {
      path: '/ws',
      transports: ['websocket'],
      reconnection: false,
      autoConnect: false,
      auth: { token },
    });
    socket = s;
    const lote = new Promise<void>((resolve) => s.once('fleet:batch', () => resolve()));
    const expulsado = new Promise<string>((resolve) => s.once('disconnect', resolve));
    s.connect();
    await new Promise<void>((resolve, reject) => {
      s.once('connect', () => resolve());
      s.once('connect_error', reject);
    });
    s.emit('subscribe:fleet');
    await lote;

    const r = await salir(token);
    assert.equal(r.status, 204);

    assert.equal((await rutas(token)).status, 401);
    assert.equal((await renovar(token)).status, 401);
    assert.equal((await rutas(otroEquipo)).status, 401);
    // Repetir el cierre con el mismo token ya no toca nada.
    assert.equal((await salir(token)).status, 401);

    const motivo = await Promise.race([
      expulsado,
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('El socket del panel siguió dentro')), 5_000)),
    ]);
    assert.equal(motivo, 'io server disconnect');

    // Volver a entrar con la contraseña sigue funcionando.
    assert.equal((await rutas(await entrar())).status, 200);
  } finally {
    socket?.close();
    await stopProcess(backend);
    for (const sufijo of ['', '-wal', '-shm']) rmSync(`${DB_PATH}${sufijo}`, { force: true });
  }
});
