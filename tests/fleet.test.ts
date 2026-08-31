import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import test from 'node:test';

import { io, Socket } from 'socket.io-client';

const HTTP_PORT = 3130;
const MQTT_PORT = 8891;
const ADMIN_API_KEY = 'e2e-admin-key';
const JWT_SECRET = 'e2e-jwt-secret';

async function waitForReady(port = HTTP_PORT): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/ready`);
      if (response.status === 200) return;
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

function waitForSocketEvent(
  socket: Socket,
  event: string,
  predicate: (payload: any) => boolean,
  timeoutMs = 15_000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Timed out waiting for Socket.io event ${event}`));
    }, timeoutMs);

    const listener = (payload: any) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(payload);
    };
    socket.on(event, listener);
  });
}

async function waitForSilence(
  socket: Socket,
  event: string,
  predicate: (payload: any) => boolean,
  ms: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEvent = (payload: any) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, onEvent);
      reject(new Error(`Unexpected ${event} while expecting silence`));
    };
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      resolve();
    }, ms);
    socket.on(event, onEvent);
  });
}

function connectSocket(extraAuth: Record<string, unknown> = {}, port = HTTP_PORT): Socket {
  const socket = io(`http://127.0.0.1:${port}`, {
    path: '/ws',
    transports: ['websocket'],
    autoConnect: false,
    auth: extraAuth,
  });
  const connected = new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  socket.connect();
  return socket;
}

async function waitForConnection(socket: Socket): Promise<void> {
  if (socket.connected) return;
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (err) => reject(err));
  });
}

test('fleet: admin por empresa, visibilidad oculta/difunde y aislamiento', { timeout: 90_000 }, async () => {
  const suffix = Date.now().toString().slice(-6);
  const phone1 = `3001${suffix}`;
  const phone2 = `3002${suffix}`;
  const bus1 = `F1-${suffix}`;
  const bus2 = `F2-${suffix}`;
  const company1 = `EMP-A-${suffix}`;
  const company2 = `EMP-B-${suffix}`;

  const backend = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      HTTP_PORT: String(HTTP_PORT),
      MQTT_PORT: String(MQTT_PORT),
      JWT_SECRET,
      ADMIN_API_KEY,
      MQTT_DEBUG_LOGS: 'false',
      YA_VIENE_DB_PATH: `/tmp/yaviene-fleet-${process.pid}.db`,
    },
    stdio: 'ignore',
  });
  let simulator: ChildProcess | undefined;
  const sockets: Socket[] = [];

  try {
    await waitForReady();

    async function provisionDriver(phone: string, busId: string, companyId: string) {
      const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/admin/drivers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_API_KEY },
        body: JSON.stringify({
          phoneNumber: phone,
          name: 'Fleet Driver',
          pin: '2468',
          companyId,
          busId,
          routeId: 'R-101',
        }),
      });
      assert.equal(res.status, 201);
    }

    async function createAdmin(companyId: string, username: string) {
      const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/admin/empresas/${companyId}/admin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_API_KEY },
        body: JSON.stringify({ username, password: 'secret123-de-prueba' }),
      });
      assert.equal(res.status, 201);
    }

    // El panel es la llave de toda la flota: la ruta HTTP pedía 8 caracteres
    // mientras crear-admin-empresa.mjs pedía 12, así que por HTTP entraban
    // cuentas más débiles que las que el propio proyecto acepta. Ahora las
    // dos piden 12, y esto lo deja clavado.
    async function createAdminConClave(
      companyId: string,
      username: string,
      password: string,
    ): Promise<number> {
      const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/admin/empresas/${companyId}/admin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_API_KEY },
        body: JSON.stringify({ username, password }),
      });
      return res.status;
    }

    async function adminLogin(username: string): Promise<{ token: string; companyId: string }> {
      const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: 'secret123-de-prueba' }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { token: string; company: { companyId: string } };
      return { token: body.token, companyId: body.company.companyId };
    }

    async function toggleVisibility(token: string, busId: string, visible: boolean): Promise<number> {
      const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/buses/${busId}/visibility`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ visible }),
      });
      return res.status;
    }

    async function fleetPositions(token: string): Promise<{ buses: any[] }> {
      const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/positions`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      return res.json() as Promise<{ buses: any[] }>;
    }

    await provisionDriver(phone1, bus1, company1);
    await provisionDriver(phone2, bus2, company2);
    await createAdmin(company1, 'boss1');
    await createAdmin(company2, 'boss2');

    assert.equal(
      await createAdminConClave(company1, 'debilucho', 'secret123'),
      400,
      'una clave de 9 caracteres no debe crear cuenta de panel',
    );
    assert.equal(
      await createAdminConClave(company1, 'justito', 'doceexactos'.padEnd(12, '!')),
      201,
      'doce caracteres sí deben bastar',
    );
    const admin1 = await adminLogin('boss1');
    const admin2 = await adminLogin('boss2');

    // Flota scoped: cada admin solo ve su empresa
    const fleet1 = await fleetPositions(admin1.token);
    assert.equal(fleet1.buses.length, 1);
    assert.equal(fleet1.buses[0].busId, bus1);
    assert.equal(fleet1.buses[0].visible, true);
    const fleet2 = await fleetPositions(admin2.token);
    assert.equal(fleet2.buses.length, 1);
    assert.equal(fleet2.buses[0].busId, bus2);

    // Aislamiento: admin de EMP-02 no puede togglear bus de EMP-01
    assert.equal(await toggleVisibility(admin2.token, bus1, false), 404);

    // Pasajero: se suscribe a R-101
    const passenger = connectSocket();
    sockets.push(passenger);
    await waitForConnection(passenger);
    const firstPosition = waitForSocketEvent(passenger, 'bus:position', (p) => p?.busId === bus1);
    passenger.emit('subscribe:route', 'R-101');

    // Conductor empieza a transmitir
    simulator = spawn(process.execPath, ['scripts/simulate-bus.mjs'], {
      env: {
        ...process.env,
        BACKEND_URL: `http://127.0.0.1:${HTTP_PORT}`,
        MQTT_PORT: String(MQTT_PORT),
        ADMIN_API_KEY,
        PHONE: phone1,
        PIN: '2468',
        BUS_ID: bus1,
        ROUTE_ID: 'R-101',
        EMPRESA_ID: company1,
        CAPTURE_INTERVAL_MS: '10000',
        CAPTURE_BASE_LAG_MS: '60000',
      },
      stdio: 'ignore',
    });

    const position1 = await firstPosition;
    assert.equal(position1.busId, bus1);

    // Ocultar: el pasajero recibe bus:hidden y deja de recibir posiciones
    const hiddenEvent = waitForSocketEvent(passenger, 'bus:hidden', (p) => p?.busId === bus1);
    assert.equal(await toggleVisibility(admin1.token, bus1, false), 200);
    const hidden = await hiddenEvent;
    assert.equal(typeof hidden.eventId, 'string');
    assert.equal(hidden.busId, bus1);

    // Ventana que cubre la siguiente publicación del simulador (10s): debe quedar retenida
    await waitForSilence(passenger, 'bus:position', (p) => p?.busId === bus1, 12_000);

    // Carga inicial filtrada: re-suscribir ya no trae el bus oculto
    const batch2 = new Promise<any>((resolve) => {
      passenger.once('positions:batch', resolve);
    });
    passenger.emit('subscribe:route', 'R-101');
    const batch = await batch2;
    assert.equal(batch.buses.some((b: any) => b.busId === bus1), false);

    // Bug corregido: consultarlo por ID tampoco debe filtrar su posición real
    const hiddenById = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/buses/${bus1}`);
    assert.equal(hiddenById.status, 200);
    assert.deepEqual(await hiddenById.json(), { busId: bus1, visible: false });

    // Mostrar: el pasajero recibe bus:visible con posición y vuelven las posiciones
    const visibleEvent = waitForSocketEvent(passenger, 'bus:visible', (p) => p?.busId === bus1);
    assert.equal(await toggleVisibility(admin1.token, bus1, true), 200);
    const visible = await visibleEvent;
    assert.equal(typeof visible.eventId, 'string');
    assert.ok(visible.position?.busId === bus1, 'bus:visible debe incluir la posición');

    const position2 = waitForSocketEvent(passenger, 'bus:position', (p) => p?.busId === bus1);
    const revived = await position2;
    assert.equal(revived.busId, bus1);

    // Panel admin: sala admin recibe flota y cambios de visibilidad
    const adminSocket = connectSocket({ token: admin1.token });
    sockets.push(adminSocket);
    await waitForConnection(adminSocket);
    const fleetBatch = new Promise<any>((resolve) => {
      adminSocket.once('fleet:batch', resolve);
    });
    adminSocket.emit('subscribe:fleet');
    const fleet = await fleetBatch;
    assert.equal(fleet.companyId, company1);
    assert.ok(fleet.buses.some((b: any) => b.busId === bus1 && b.visible === true));

    const adminHidden = waitForSocketEvent(adminSocket, 'bus:hidden', (p) => p?.busId === bus1);
    assert.equal(await toggleVisibility(admin1.token, bus1, false), 200);
    await adminHidden;

    // Sin token de admin no se puede entrar a la sala de flota
    const rogue = connectSocket();
    sockets.push(rogue);
    await waitForConnection(rogue);
    rogue.emit('subscribe:fleet');
    await new Promise<void>((resolve) => {
      rogue.once('disconnect', () => resolve());
      setTimeout(() => resolve(), 3000);
    });
    assert.equal(rogue.connected, false, 'cliente sin token de admin debe ser desconectado');

  } finally {
    for (const socket of sockets) socket.close();
    await stopProcess(simulator);
    await stopProcess(backend);
  }
});

test('fleet: CRUD de buses por admin (crear/editar/borrar, placa, filtros de ruta)', { timeout: 90_000 }, async () => {
  let backend: ChildProcess | undefined;
  const sockets: Socket[] = [];
  const HTTP_PORT = 3131;
  const MQTT_PORT = 8892;

  try {
    backend = spawn(process.execPath, ['dist/index.js'], {
      env: {
        ...process.env,
        HTTP_PORT: String(HTTP_PORT),
        MQTT_PORT: String(MQTT_PORT),
        ADMIN_API_KEY,
        JWT_SECRET,
        YA_VIENE_DB_PATH: `/tmp/yaviene-test-fleet2-${Date.now()}.db`,
        ALLOWED_ORIGINS: '*',
      },
      stdio: 'ignore',
    });
    await waitForReady(HTTP_PORT);

    const company = 'EMP-CRUD';
    const createAdmin = async (username: string) => {
      const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/admin/empresas/${company}/admin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_API_KEY },
        body: JSON.stringify({ username, password: 'secret123-de-prueba' }),
      });
      assert.equal(res.status, 201);
    };
    await createAdmin('crudboss');
    const login = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'crudboss', password: 'secret123-de-prueba' }),
    });
    assert.equal(login.status, 200);
    const { token } = (await login.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const fleet = async (): Promise<{ buses: any[] }> => {
      const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/positions`, { headers: auth });
      assert.equal(res.status, 200);
      return res.json() as Promise<{ buses: any[] }>;
    };

    // Crear bus con placa y ruta
    const created = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/buses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ placa: 'abc 123', routeId: 'R-101' }),
    });
    assert.equal(created.status, 201);
    const newBus = (await created.json()) as any;
    assert.equal(newBus.busId, 'BUS-ABC123', 'busId deriva de la placa');
    assert.equal(newBus.placa, 'ABC123', 'placa normalizada a mayúsculas');
    assert.equal(newBus.interno, '001', 'interno autogenerado secuencial');

    // Crear una ruta nueva en el catálogo
    const newRoute = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/routes`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ routeId: 'R-104', name: 'Ruta 4 · La Esperanza' }),
    });
    assert.equal(newRoute.status, 201);

    // Placa inválida → 400
    const bad = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/buses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ placa: '!!', routeId: 'R-101' }),
    });
    assert.equal(bad.status, 400);

    // Aparece en la flota (offline, sin posición)
    const fleet1 = await fleet();
    const listed = fleet1.buses.find((b) => b.busId === 'BUS-ABC123');
    assert.ok(listed, 'el bus creado aparece en la flota');
    assert.equal(listed.placa, 'ABC123');
    assert.equal(listed.routeId, 'R-101');
    assert.equal(listed.online, false);

    // Rutas: el catálogo incluye la ruta del bus y la ruta creada
    const routesRes = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/routes`, { headers: auth });
    assert.equal(routesRes.status, 200);
    const { routes } = (await routesRes.json()) as { routes: any[] };
    assert.ok(routes.some((r) => r.routeId === 'R-101'), 'catálogo incluye R-101');
    assert.ok(routes.some((r) => r.routeId === 'R-104'), 'catálogo incluye R-104 creada');
    const r101 = routes.find((r) => r.routeId === 'R-101');
    assert.equal(r101.name, 'Tcherassi');
    assert.ok(r101.total >= 1);

    // Editar placa, ruta e interno
    const patched = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/buses/BUS-ABC123`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ placa: 'XYZ987', routeId: 'R-102', interno: '042' }),
    });
    assert.equal(patched.status, 200);
    const updated = (await patched.json()) as any;
    assert.equal(updated.placa, 'XYZ987');
    assert.equal(updated.routeId, 'R-102');
    assert.equal(updated.interno, '042');

    // Pasajero suscrito a R-102 (ruta final del bus) recibe bus:removed al borrarlo
    const passenger = connectSocket({}, HTTP_PORT);
    sockets.push(passenger);
    await waitForConnection(passenger);
    passenger.emit('subscribe:route', 'R-102');
    const removed = waitForSocketEvent(passenger, 'bus:removed', (p) => p?.busId === 'BUS-ABC123');
    const deleted = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/buses/BUS-ABC123`, {
      method: 'DELETE',
      headers: auth,
    });
    assert.equal(deleted.status, 200);
    const removedEvent = await removed;
    assert.equal(removedEvent.routeId, 'R-102');

    // Ya no está en la flota
    const fleet2 = await fleet();
    assert.equal(fleet2.buses.some((b) => b.busId === 'BUS-ABC123'), false);

    // Borrar bus inexistente / de otra empresa → 404
    const gone = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/buses/BUS-ABC123`, {
      method: 'DELETE',
      headers: auth,
    });
    assert.equal(gone.status, 404);
    const noAuth = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/buses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ placa: 'QWE456', routeId: 'R-101' }),
    });
    assert.equal(noAuth.status, 401);

    // Borrar todos los buses de la empresa (debug)
    await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/buses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ placa: 'MNO789', routeId: 'R-101' }),
    });
    await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/buses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ placa: 'PQR234', routeId: 'R-101' }),
    });

    // Ruta con nombre duplicado (derivado del catálogo) → 400
    const dup = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/routes`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ routeId: 'R-999', name: 'TCherassi' }),
    });
    assert.equal(dup.status, 400);
    assert.equal(((await dup.json()) as any).error.code, 'DUPLICATE_ROUTE');

    // Sin confirmar la empresa el borrado masivo no ocurre
    const sinConfirmar = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/buses`, {
      method: 'DELETE',
      headers: auth,
    });
    assert.equal(sinConfirmar.status, 400);
    assert.equal(((await sinConfirmar.json()) as any).error.code, 'CONFIRMATION_REQUIRED');
    const otraEmpresa = await fetch(
      `http://127.0.0.1:${HTTP_PORT}/api/fleet/buses?confirm=EMP-01`,
      { method: 'DELETE', headers: auth },
    );
    assert.equal(otraEmpresa.status, 400, 'confirmar otra empresa tampoco vale');
    assert.ok((await fleet()).buses.length >= 2, 'la flota sigue intacta tras los intentos sin confirmar');

    const wipe = await fetch(
      `http://127.0.0.1:${HTTP_PORT}/api/fleet/buses?confirm=${company}`,
      { method: 'DELETE', headers: auth },
    );
    assert.equal(wipe.status, 200);
    const wiped = (await wipe.json()) as any;
    assert.ok(wiped.count >= 2, 'al menos 2 buses eliminados');
    const fleetAfterWipe = await fleet();
    assert.equal(fleetAfterWipe.buses.length, 0, 'flota vacía tras borrado masivo');

    // Bus sin ruta → 400 (ningún bus puede quedar sin ruta)
    const noRoute = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/buses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ placa: 'CCC222' }),
    });
    assert.equal(noRoute.status, 400);

    // Eliminar ruta: los buses asignados se mueven a la primera ruta restante
    await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/routes`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ routeId: 'R-150', name: 'A Ruta' }),
    });
    await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/routes`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ routeId: 'R-200', name: 'Z Ruta' }),
    });
    await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/buses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ placa: 'BBB111', routeId: 'R-200' }),
    });
    const delRoute = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/routes/R-200`, {
      method: 'DELETE',
      headers: auth,
    });
    assert.equal(delRoute.status, 200);
    const fleet3 = await fleet();
    const moved = fleet3.buses.find((b) => b.placa === 'BBB111');
    assert.ok(moved, 'bus reasignado sigue en la flota');
    assert.equal(moved.routeId, 'R-104', 'se movió a la primera ruta restante (orden alfabético)');
    const routesAfterDelete = (await (
      await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/routes`, { headers: auth })
    ).json()) as { routes: any[] };
    assert.ok(
      !routesAfterDelete.routes.some((r) => r.routeId === 'R-200'),
      'ruta eliminada no aparece en el catálogo',
    );

  } finally {
    for (const socket of sockets) socket.close();
    await stopProcess(backend);
  }
});
