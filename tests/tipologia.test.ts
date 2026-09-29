// Tipología y aforo por bus (SENCILLO | PADRON | ARTICULADO, 30/60/80).
// El panel manda desplegable + número al dar de alta; el backend valida la
// lista cerrada y el rango, y devuelve tipología + capacidad en cada bus de
// la flota. Sin tipología entra como SENCILLO y sin capacidad con el ejemplo
// de su tipología: los buses viejos y los que no mandan nada no cambian.
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Puertos propios, HTTP 3240 y MQTT 9020: node --test corre los archivos en
// paralelo (el reparto de los demás está en arranque.test.ts). El 3160/8930
// es de socket_abuso.test.ts: compartirlo hacía fallar este test solo en
// suite completa (401 al crear el admin contra el servidor ajeno).
const HTTP_PORT = 3240;
const MQTT_PORT = 9020;
const ADMIN_API_KEY = 'e2e-admin-key';
const JWT_SECRET = 'e2e-jwt-secret';
// Ver fleet.test.ts: va en constante porque gitleaks marca como secreto
// cualquier `password: '...'` escrito tal cual.
const CLAVE_PRUEBA = 'secret123-de-prueba';

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${HTTP_PORT}/api/ready`)).status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Backend did not become ready');
}

function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return Promise.resolve();
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

test('fleet: tipologia cerrada y aforo por bus al dar de alta y editar', { timeout: 90_000 }, async () => {
  let backend: ChildProcess | undefined;
  try {
    backend = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      env: {
        ...process.env,
        HTTP_PORT: String(HTTP_PORT),
        MQTT_PORT: String(MQTT_PORT),
        ADMIN_API_KEY,
        JWT_SECRET,
        YA_VIENE_FLOTA_DEMO: '0',
        YA_VIENE_DB_PATH: join(mkdtempSync(join(tmpdir(), 'yaviene-test-tipo-')), 'test.db'),
      },
      stdio: 'ignore',
    });
    await waitForReady();

    const crearAdmin = async (empresa: string, username: string): Promise<string> => {
      const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/admin/empresas/${empresa}/admin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_API_KEY },
        body: JSON.stringify({ username, password: CLAVE_PRUEBA }),
      });
      assert.equal(res.status, 201);
      const login = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: CLAVE_PRUEBA }),
      });
      assert.equal(login.status, 200);
      return (await login.json() as { token: string }).token;
    };
    const token = await crearAdmin('EMP-TIPO', 'tipoboss');
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const alta = async (cuerpo: unknown): Promise<{ status: number; json: any }> => {
      const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/buses`, {
        method: 'POST', headers: auth, body: JSON.stringify(cuerpo),
      });
      return { status: res.status, json: await res.json() as any };
    };
    const editar = async (busId: string, cuerpo: unknown): Promise<{ status: number; json: any }> => {
      const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/buses/${busId}`, {
        method: 'PATCH', headers: auth, body: JSON.stringify(cuerpo),
      });
      return { status: res.status, json: await res.json() as any };
    };

    // Explícita: padrón con 60.
    const padron = await alta({ placa: 'AAA111', routeId: 'R-101', tipologia: 'PADRON', capacidad: 60 });
    assert.equal(padron.status, 201);
    assert.equal(padron.json.tipologia, 'PADRON');
    assert.equal(padron.json.capacidad, 60);

    // Defaults: sin nada → SENCILLO/30; articulado sin capacidad → 80.
    const defecto = await alta({ placa: 'BBB222', routeId: 'R-101' });
    assert.equal(defecto.status, 201);
    assert.equal(defecto.json.tipologia, 'SENCILLO');
    assert.equal(defecto.json.capacidad, 30);
    const arti = await alta({ placa: 'CCC333', routeId: 'R-101', tipologia: 'ARTICULADO' });
    assert.equal(arti.json.tipologia, 'ARTICULADO');
    assert.equal(arti.json.capacidad, 80);

    // Capacidad manual manda sobre el ejemplo; minúsculas valen.
    const manual = await alta({ placa: 'DDD444', routeId: 'R-101', tipologia: 'padron', capacidad: 55 });
    assert.equal(manual.status, 201);
    assert.equal(manual.json.tipologia, 'PADRON');
    assert.equal(manual.json.capacidad, 55);

    // Inválidos → 400 con su motivo.
    for (const cuerpo of [
      { placa: 'EEE555', routeId: 'R-101', tipologia: 'TRANSBORDO' },
      { placa: 'EEE555', routeId: 'R-101', tipologia: 'PADRÓN' },
      { placa: 'EEE555', routeId: 'R-101', capacidad: 0 },
      { placa: 'EEE555', routeId: 'R-101', capacidad: -5 },
      { placa: 'EEE555', routeId: 'R-101', capacidad: 3.5 },
      { placa: 'EEE555', routeId: 'R-101', capacidad: 301 },
      { placa: 'EEE555', routeId: 'R-101', capacidad: 'mucha' },
    ]) {
      assert.equal((await alta(cuerpo)).status, 400, JSON.stringify(cuerpo));
    }

    // Edición: cambia las dos; cambiar tipología no pisa la manual.
    const editado = await editar(padron.json.busId, { tipologia: 'ARTICULADO', capacidad: 80 });
    assert.equal(editado.status, 200);
    assert.equal(editado.json.tipologia, 'ARTICULADO');
    assert.equal(editado.json.capacidad, 80);
    const conserva = await editar(manual.json.busId, { tipologia: 'SENCILLO' });
    assert.equal(conserva.status, 200);
    assert.equal(conserva.json.tipologia, 'SENCILLO');
    assert.equal(conserva.json.capacidad, 55);
    assert.equal((await editar(padron.json.busId, { tipologia: 'BUSETA' })).status, 400);
    assert.equal((await editar(padron.json.busId, { capacidad: 0 })).status, 400);

    // Renovar (misma placa y empresa, sin mandar nada) conserva tipología
    // y aforo en vez de degradar a SENCILLO/30 en silencio.
    const renueva = await alta({ placa: 'DDD444', routeId: 'R-101' });
    assert.equal(renueva.status, 201);
    assert.equal(renueva.json.tipologia, 'SENCILLO');
    assert.equal(renueva.json.capacidad, 55);
    // Renovar con tipología nueva tampoco pisa la capacidad manual.
    const renueva2 = await alta({ placa: 'DDD444', routeId: 'R-101', tipologia: 'ARTICULADO' });
    assert.equal(renueva2.status, 201);
    assert.equal(renueva2.json.tipologia, 'ARTICULADO');
    assert.equal(renueva2.json.capacidad, 55);

    // La flota del panel trae tipología y capacidad de cada bus.
    const flota = await (await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/positions`, { headers: auth })).json() as { buses: any[] };
    const visto = flota.buses.find((b) => b.busId === padron.json.busId);
    assert.equal(visto.tipologia, 'ARTICULADO');
    assert.equal(visto.capacidad, 80);

    // Otra empresa no toca lo ajeno.
    const token2 = await crearAdmin('EMP-TIPO2', 'tipoboss2');
    const ajeno = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/buses/${padron.json.busId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token2}`, 'content-type': 'application/json' },
      body: JSON.stringify({ capacidad: 10 }),
    });
    assert.equal(ajeno.status, 404);
  } finally {
    await stopProcess(backend);
  }
});
