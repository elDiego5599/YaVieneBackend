import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import test from 'node:test';

import Database from 'better-sqlite3';
import { io, Socket } from 'socket.io-client';

// Puertos propios: HTTP 3140-3149, MQTT 8910-8919. node --test corre los
// archivos en paralelo; si dos comparten puerto, uno no arranca y sus pruebas
// le hablan al backend del otro. Reparto: e2e 312x, chaos 313x, fleet 314x,
// arranque 315x, socket_abuso 316x. Cada test con backend propio toma el
// siguiente de la decena.
const HTTP_PORT = 3140;
const MQTT_PORT = 8910;
const ADMIN_API_KEY = 'e2e-admin-key';
const JWT_SECRET = 'e2e-jwt-secret';
// Clave de las cuentas admin que estas pruebas crean en su base temporal.
// No es de nadie; va en una constante porque gitleaks marca como secreto
// cualquier `password: '...'` escrito tal cual.
const CLAVE_PRUEBA = 'secret123-de-prueba';

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
      // Los buses de demostración son del backend de verdad, no de un
      // test: doce simuladores publicando encima de este vuelven ruido
      // cada aserción sobre la flota.
      YA_VIENE_FLOTA_DEMO: '0',
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
        body: JSON.stringify({ username, password: CLAVE_PRUEBA }),
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
        body: JSON.stringify({ username, password: CLAVE_PRUEBA }),
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

    // Cambiar la contraseña del panel echa a quien entró con la anterior.
    // Antes el token viejo seguía valiendo sus 8 horas, y a una empresa que
    // cambiaba la clave porque se la habían robado no le servía de nada.
    await createAdmin(company1, 'rotada');
    const viejo = await adminLogin('rotada');
    await fleetPositions(viejo.token);
    assert.equal(await createAdminConClave(company1, 'rotada', 'clave-nueva-de-prueba'), 201);
    const conViejo = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/positions`, {
      headers: { authorization: `Bearer ${viejo.token}` },
    });
    assert.equal(conViejo.status, 401, 'el token de antes del cambio ya no entra');
    const nuevo = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'rotada', password: 'clave-nueva-de-prueba' }),
    });
    assert.equal(nuevo.status, 200);
    await fleetPositions(((await nuevo.json()) as { token: string }).token);

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

    // Consultarlo por ID no filtra su posición ni delata que existe: contesta
    // lo mismo que un id inventado (T3.4).
    const hiddenById = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/buses/${bus1}`);
    const missingById = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/buses/BUS-NOEXISTE`);
    assert.equal(hiddenById.status, 404);
    assert.deepEqual(
      { status: hiddenById.status, body: await hiddenById.json() },
      { status: missingById.status, body: await missingById.json() },
    );

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

    // Oculto es para el pasajero, no para su empresa: el panel sigue
    // recibiendo cada posición, con su velocidad. Antes se callaba también
    // aquí, y el bus oculto quedaba quieto en el panel hasta la siguiente
    // foto de la flota, sin velocidad.
    const posicionOculta = await waitForSocketEvent(
      adminSocket, 'bus:position', (p) => p?.busId === bus1, 15_000,
    );
    assert.equal(typeof posicionOculta.speedKmh, 'number');

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
  const HTTP_PORT = 3141;
  const MQTT_PORT = 8911;

  try {
    backend = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      env: {
        ...process.env,
        HTTP_PORT: String(HTTP_PORT),
        MQTT_PORT: String(MQTT_PORT),
        ADMIN_API_KEY,
        JWT_SECRET,
        YA_VIENE_FLOTA_DEMO: '0',
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
        body: JSON.stringify({ username, password: CLAVE_PRUEBA }),
      });
      assert.equal(res.status, 201);
    };
    await createAdmin('crudboss');
    const login = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'crudboss', password: CLAVE_PRUEBA }),
    });
    assert.equal(login.status, 200);
    const { token } = (await login.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const fleet = async (): Promise<{ buses: any[] }> => {
      const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/positions`, { headers: auth });
      assert.equal(res.status, 200);
      return res.json() as Promise<{ buses: any[] }>;
    };

    // Las rutas del bus salen del catálogo de la empresa: la R-101 y la R-102
    // son de Sobusa (EMP-01), y un bus de otra empresa ya no entra en ellas
    // (auditoría 2026-09, P1-2).
    for (const [routeId, name] of [['R-131', 'Ruta 1 · Centro'], ['R-132', 'Ruta 2 · Norte']]) {
      const ruta = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/routes`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ routeId, name }),
      });
      assert.equal(ruta.status, 201);
    }

    // Crear bus con placa y ruta
    const created = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/buses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ placa: 'abc 123', routeId: 'R-131' }),
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
      // R-104 ya es de EMP-01 (la demo): el código de ruta es único entre
      // empresas, así que la ruta nueva de esta empresa lleva uno propio.
      body: JSON.stringify({ routeId: 'R-140', name: 'Ruta 4 · La Esperanza' }),
    });
    assert.equal(newRoute.status, 201);

    // Placa inválida → 400
    const bad = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/buses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ placa: '!!', routeId: 'R-131' }),
    });
    assert.equal(bad.status, 400);

    // Aparece en la flota (offline, sin posición)
    const fleet1 = await fleet();
    const listed = fleet1.buses.find((b) => b.busId === 'BUS-ABC123');
    assert.ok(listed, 'el bus creado aparece en la flota');
    assert.equal(listed.placa, 'ABC123');
    assert.equal(listed.routeId, 'R-131');
    assert.equal(listed.online, false);

    // Rutas: el catálogo incluye la ruta del bus y la ruta creada
    const routesRes = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/routes`, { headers: auth });
    assert.equal(routesRes.status, 200);
    const { routes } = (await routesRes.json()) as { routes: any[] };
    assert.ok(routes.some((r) => r.routeId === 'R-131'), 'catálogo incluye R-131');
    assert.ok(routes.some((r) => r.routeId === 'R-140'), 'catálogo incluye R-140 creada');
    const r131 = routes.find((r) => r.routeId === 'R-131');
    // El nombre sale del catálogo de la empresa, el mismo que ve el pasajero.
    assert.equal(r131.name, 'Ruta 1 · Centro');
    assert.ok(r131.total >= 1);

    // Editar placa, ruta e interno
    const patched = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/buses/BUS-ABC123`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ placa: 'XYZ987', routeId: 'R-132', interno: '042' }),
    });
    assert.equal(patched.status, 200);
    const updated = (await patched.json()) as any;
    assert.equal(updated.placa, 'XYZ987');
    assert.equal(updated.routeId, 'R-132');
    assert.equal(updated.interno, '042');

    // Pasajero suscrito a R-132 (ruta final del bus) recibe bus:removed al borrarlo
    const passenger = connectSocket({}, HTTP_PORT);
    sockets.push(passenger);
    await waitForConnection(passenger);
    passenger.emit('subscribe:route', 'R-132');
    const removed = waitForSocketEvent(passenger, 'bus:removed', (p) => p?.busId === 'BUS-ABC123');
    const deleted = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/buses/BUS-ABC123`, {
      method: 'DELETE',
      headers: auth,
    });
    assert.equal(deleted.status, 200);
    const removedEvent = await removed;
    assert.equal(removedEvent.routeId, 'R-132');

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
      body: JSON.stringify({ placa: 'QWE456', routeId: 'R-131' }),
    });
    assert.equal(noAuth.status, 401);

    // Borrar todos los buses de la empresa (debug)
    await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/buses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ placa: 'MNO789', routeId: 'R-131' }),
    });
    await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/buses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ placa: 'PQR234', routeId: 'R-131' }),
    });

    // Ruta con nombre duplicado (derivado del catálogo) → 400
    const dup = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fleet/routes`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ routeId: 'R-999', name: 'ruta 1 · CENTRO' }),
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
    assert.equal(moved.routeId, 'R-131', 'se movió a la primera ruta restante (orden alfabético)');
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

test('fleet: una empresa no puede tocar ni ver buses, rutas ni flota de otra', { timeout: 60_000 }, async () => {
  const HTTP_PORT = 3142;
  const MQTT_PORT = 8912;
  const base = `http://127.0.0.1:${HTTP_PORT}`;
  const suffix = Date.now().toString().slice(-6);
  const companyA = `EMP-MA-${suffix}`;
  const companyB = `EMP-MB-${suffix}`;
  const busA = 'BUS-AAA111';
  const backend = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      HTTP_PORT: String(HTTP_PORT),
      MQTT_PORT: String(MQTT_PORT),
      JWT_SECRET,
      ADMIN_API_KEY,
      MQTT_DEBUG_LOGS: 'false',
      YA_VIENE_FLOTA_DEMO: '0',
      YA_VIENE_DB_PATH: `/tmp/yaviene-tenant-${process.pid}-${suffix}.db`,
    },
    stdio: 'ignore',
  });
  const sockets: Socket[] = [];

  try {
    await waitForReady(HTTP_PORT);
    const conClave = { 'content-type': 'application/json', 'x-admin-key': ADMIN_API_KEY };

    const login = async (companyId: string, username: string): Promise<Record<string, string>> => {
      const created = await fetch(`${base}/api/admin/empresas/${companyId}/admin`, {
        method: 'POST',
        headers: conClave,
        body: JSON.stringify({ username, password: CLAVE_PRUEBA }),
      });
      assert.equal(created.status, 201);
      const res = await fetch(`${base}/api/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: CLAVE_PRUEBA }),
      });
      assert.equal(res.status, 200);
      const { token } = (await res.json()) as { token: string };
      return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    };
    const call = (headers: Record<string, string>, method: string, path: string, body?: unknown) =>
      fetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const a = await login(companyA, `jefa${suffix}`);
    const b = await login(companyB, `jefe${suffix}`);

    assert.equal((await call(a, 'POST', '/api/fleet/routes', { routeId: 'R-301', name: 'Ruta de A' })).status, 201);
    assert.equal(
      (await call(a, 'POST', '/api/fleet/buses', { placa: 'AAA111', routeId: 'R-301', interno: '077' })).status,
      201,
    );

    // Escrituras de B sobre lo de A: todas 404, el mismo que da un bus o una
    // ruta que no existe, para no confirmar que existen en otra empresa.
    assert.equal(
      (await call(b, 'PATCH', `/api/fleet/buses/${busA}`, { placa: 'ZZZ999', routeId: 'R-101', interno: '999' })).status,
      404,
    );
    assert.equal((await call(b, 'DELETE', `/api/fleet/buses/${busA}`)).status, 404);
    assert.equal((await call(b, 'POST', `/api/fleet/buses/${busA}/visibility`, { visible: true })).status, 404);
    assert.equal((await call(b, 'PATCH', '/api/fleet/routes/R-301', { name: 'Robada' })).status, 404);
    assert.equal((await call(b, 'DELETE', '/api/fleet/routes/R-301')).status, 404);

    // La placa ya es de A: 409 y el bus no cambia de dueña ni de ruta. B lo
    // intenta en una ruta suya: en una ajena el 404 de la ruta llega antes.
    assert.equal((await call(b, 'POST', '/api/fleet/routes', { routeId: 'R-401', name: 'Ruta de B' })).status, 201);
    const robo = await call(b, 'POST', '/api/fleet/buses', { placa: 'aaa 111', routeId: 'R-401' });
    assert.equal(robo.status, 409);
    const roboBody = (await robo.json()) as { error: { code: string } };
    assert.equal(roboBody.error.code, 'BUS_TAKEN');
    assert.equal(JSON.stringify(roboBody).includes(companyA), false, 'el 409 no dice de qué empresa es');

    // Por la edición tampoco: un bus propio no puede tomar la placa de otro.
    assert.equal((await call(a, 'POST', '/api/fleet/buses', { placa: 'CCC333', routeId: 'R-301' })).status, 201);
    const cambiazo = await call(a, 'PATCH', '/api/fleet/buses/BUS-CCC333', { placa: 'AAA111' });
    assert.equal(cambiazo.status, 409);
    assert.equal(((await cambiazo.json()) as { error: { code: string } }).error.code, 'BUS_TAKEN');

    // Un alta de ruta con un id que ya existe es un choque, no un renombre:
    // más abajo se comprueba que R-301 sigue llamándose «Ruta de A».
    const pisada = await call(a, 'POST', '/api/fleet/routes', { routeId: 'R-301', name: 'Pisada' });
    assert.equal(pisada.status, 409);
    assert.equal(((await pisada.json()) as { error: { code: string } }).error.code, 'ROUTE_EXISTS');

    // «Mostrar todos» de B solo cuenta los suyos: el de A sigue oculto.
    const todos = await call(b, 'POST', '/api/fleet/buses/visibility', { visible: true });
    assert.equal(todos.status, 200);
    assert.equal(((await todos.json()) as { count: number }).count, 0);

    // Lecturas de B: nada de A, ni por HTTP ni por el socket del panel.
    const flotaB = (await (await call(b, 'GET', '/api/fleet/positions')).json()) as any;
    assert.equal(flotaB.companyId, companyB);
    assert.equal(flotaB.buses.some((bus: any) => bus.busId === busA), false);
    const rutasB = (await (await call(b, 'GET', '/api/fleet/routes')).json()) as any;
    assert.equal(rutasB.routes.some((r: any) => r.routeId === 'R-301'), false);

    const panelB = connectSocket({ token: b.authorization.slice('Bearer '.length) }, HTTP_PORT);
    sockets.push(panelB);
    await waitForConnection(panelB);
    const loteB = new Promise<any>((resolve) => panelB.once('fleet:batch', resolve));
    panelB.emit('subscribe:fleet');
    const flotaSocketB = await loteB;
    assert.equal(flotaSocketB.companyId, companyB);
    assert.equal(flotaSocketB.buses.some((bus: any) => bus.busId === busA), false);

    // Y lo de A quedó exactamente como estaba.
    const flotaA = (await (await call(a, 'GET', '/api/fleet/positions')).json()) as any;
    const suyo = flotaA.buses.find((bus: any) => bus.busId === busA);
    assert.ok(suyo, 'el bus sigue en la flota de A');
    assert.equal(suyo.companyId, companyA);
    assert.equal(suyo.placa, 'AAA111');
    assert.equal(suyo.routeId, 'R-301');
    assert.equal(suyo.interno, '077');
    assert.equal(suyo.visible, false);
    const rutasA = (await (await call(a, 'GET', '/api/fleet/routes')).json()) as any;
    assert.equal(rutasA.routes.find((r: any) => r.routeId === 'R-301')?.name, 'Ruta de A');

    // Datos que antes entraban tal cual en la base.
    const rutaBasura = await call(a, 'POST', '/api/fleet/buses', { placa: 'BBB222', routeId: '<script>' });
    assert.equal(rutaBasura.status, 400);
    assert.equal(((await rutaBasura.json()) as any).error.code, 'INVALID_BUS');
    const edicionBasura = await call(a, 'PATCH', `/api/fleet/buses/${busA}`, { routeId: 'no vale!' });
    assert.equal(edicionBasura.status, 400);
    assert.equal(((await edicionBasura.json()) as any).error.code, 'INVALID_ROUTE');
    assert.equal((await call(a, 'PATCH', `/api/fleet/buses/${busA}`, { interno: '1'.repeat(13) })).status, 400);
    assert.equal((await call(a, 'POST', '/api/fleet/routes', { routeId: 'R-302', name: 'n'.repeat(61) })).status, 400);
    const renombreLargo = await call(a, 'PATCH', '/api/fleet/routes/R-301', { name: 'n'.repeat(61) });
    assert.equal(renombreLargo.status, 400, 'un nombre largo no es «ruta no encontrada»');
    const flotaA2 = (await (await call(a, 'GET', '/api/fleet/positions')).json()) as any;
    const intacto = flotaA2.buses.find((bus: any) => bus.busId === busA);
    assert.equal(intacto.routeId, 'R-301');
    assert.equal(intacto.interno, '077');

    const phone = `3009${suffix}`;
    const provision = await call(conClave, 'POST', '/api/admin/drivers', {
      phoneNumber: phone,
      name: 'Conductor A',
      pin: '2468',
      companyId: companyA,
      busId: `DRV-${suffix}`,
      routeId: 'R-101',
    });
    assert.equal(provision.status, 201);

    // Probar claves de administración también gasta cupo: antes solo
    // contaban los intentos con la clave buena. Con la provisión de arriba
    // ya va uno de 20.
    const malas = { 'content-type': 'application/json', 'x-admin-key': 'no-es-la-clave' };
    for (let i = 0; i < 19; i++) {
      assert.equal((await call(malas, 'POST', '/api/admin/drivers', {})).status, 401);
    }
    assert.equal((await call(malas, 'POST', '/api/admin/drivers', {})).status, 429);
  } finally {
    for (const socket of sockets) socket.close();
    await stopProcess(backend);
  }
});

// La sala del pasajero y la consulta de posiciones van por `routeId` a secas
// (`route:{id}` en socket/handler.ts): si dos empresas tienen el mismo
// código, los pasajeros de una ven los buses de la otra.
test('fleet: el código de ruta es único entre empresas', { timeout: 60_000 }, async () => {
  const HTTP_PORT = 3143;
  const MQTT_PORT = 8913;
  const base = `http://127.0.0.1:${HTTP_PORT}`;
  const suffix = Date.now().toString().slice(-6);
  const backend = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      HTTP_PORT: String(HTTP_PORT),
      MQTT_PORT: String(MQTT_PORT),
      JWT_SECRET,
      ADMIN_API_KEY,
      MQTT_DEBUG_LOGS: 'false',
      YA_VIENE_FLOTA_DEMO: '0',
      YA_VIENE_DB_PATH: `/tmp/yaviene-rutas-${process.pid}-${suffix}.db`,
    },
    stdio: 'ignore',
  });

  try {
    await waitForReady(HTTP_PORT);
    const login = async (companyId: string, username: string): Promise<Record<string, string>> => {
      const created = await fetch(`${base}/api/admin/empresas/${companyId}/admin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_API_KEY },
        body: JSON.stringify({ username, password: CLAVE_PRUEBA }),
      });
      assert.equal(created.status, 201);
      const res = await fetch(`${base}/api/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: CLAVE_PRUEBA }),
      });
      const { token } = (await res.json()) as { token: string };
      return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    };
    const alta = async (headers: Record<string, string>, routeId: string, name: string) => {
      const res = await fetch(`${base}/api/fleet/routes`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ routeId, name }),
      });
      return { status: res.status, body: (await res.json()) as any };
    };

    const a = await login(`EMP-UA-${suffix}`, `ua${suffix}`);
    const b = await login(`EMP-UB-${suffix}`, `ub${suffix}`);

    // Dos empresas nuevas autonumeran rutas distintas. Antes la cuenta era
    // por empresa y las dos nacían con R-001, en la misma sala.
    const primeraA = await alta(a, '', 'Primera de A');
    const primeraB = await alta(b, '', 'Primera de B');
    assert.equal(primeraA.status, 201);
    assert.equal(primeraB.status, 201);
    assert.notEqual(primeraA.body.routeId, primeraB.body.routeId);
    // La cuenta sigue desde las que tienen trazado en la app (R-101 a R-106
    // de Sobusa, R-107 a R-110 de Coolitoral).
    assert.equal(primeraA.body.routeId, 'R-111');
    assert.equal(primeraB.body.routeId, 'R-112');

    // Una empresa no puede crear un id que ya usa otra, ni uno de la demo.
    const copia = await alta(b, primeraA.body.routeId, 'Copia de A');
    assert.equal(copia.status, 409);
    assert.equal(copia.body.error.code, 'ROUTE_EXISTS');
    assert.equal(JSON.stringify(copia.body).includes(`EMP-UA-${suffix}`), false, 'el 409 no dice de quién es');
    assert.equal((await alta(b, 'r-101', 'Tcherassi de B')).status, 409);
    assert.equal((await alta(b, 'R-110', 'Carrera 50 de B')).status, 409);
    const rutasB = (await (await fetch(`${base}/api/fleet/routes`, { headers: b })).json()) as any;
    assert.deepEqual(rutasB.routes.map((r: any) => r.routeId), ['R-112']);

    // Después de R-999 viene R-1000 y luego R-1001. Antes el máximo salía de
    // ordenar texto: 'R-999' > 'R-1000', así que la tercera volvía a pedir
    // R-1000 y chocaba para siempre.
    assert.equal((await alta(a, 'R-999', 'Novecientos')).status, 201);
    const mil = await alta(a, '', 'Mil');
    assert.equal(mil.body.routeId, 'R-1000');
    const milUno = await alta(b, '', 'Mil uno');
    assert.equal(milUno.body.routeId, 'R-1001');
  } finally {
    await stopProcess(backend);
  }
});

// Auditoría 2026-09, P1-2. Las rutas son de una sola empresa desde la
// migración 20, pero el alta y la edición del bus solo miraban la forma del
// código: la empresa B daba de alta un bus con `routeId: R-301`, que es de A,
// y sus posiciones salían en el mapa de los pasajeros de A. Ahora el bus solo
// entra en rutas del catálogo de su empresa, y la respuesta es el mismo 404
// que ya da una ruta ajena en /api/fleet/routes: no confirma que la ruta
// exista en otra parte.
test('fleet: un bus solo entra en las rutas del catálogo de su empresa', { timeout: 60_000 }, async () => {
  const HTTP_PORT = 3144;
  const MQTT_PORT = 8914;
  const base = `http://127.0.0.1:${HTTP_PORT}`;
  const suffix = Date.now().toString().slice(-6);
  const companyA = `EMP-PA-${suffix}`;
  const companyB = `EMP-PB-${suffix}`;
  const dbPath = `/tmp/yaviene-ruta-ajena-${process.pid}-${suffix}.db`;
  const backend = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      HTTP_PORT: String(HTTP_PORT),
      MQTT_PORT: String(MQTT_PORT),
      JWT_SECRET,
      ADMIN_API_KEY,
      MQTT_DEBUG_LOGS: 'false',
      YA_VIENE_FLOTA_DEMO: '0',
      YA_VIENE_DB_PATH: dbPath,
    },
    stdio: 'ignore',
  });

  try {
    await waitForReady(HTTP_PORT);
    const login = async (companyId: string, username: string): Promise<Record<string, string>> => {
      const created = await fetch(`${base}/api/admin/empresas/${companyId}/admin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_API_KEY },
        body: JSON.stringify({ username, password: CLAVE_PRUEBA }),
      });
      assert.equal(created.status, 201);
      const res = await fetch(`${base}/api/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: CLAVE_PRUEBA }),
      });
      assert.equal(res.status, 200);
      const { token } = (await res.json()) as { token: string };
      return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    };
    const call = async (headers: Record<string, string>, method: string, path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const texto = await res.text();
      return { status: res.status, texto, json: texto ? JSON.parse(texto) : null };
    };

    const a = await login(companyA, `ana${suffix}`);
    const b = await login(companyB, `beto${suffix}`);
    assert.equal((await call(a, 'POST', '/api/fleet/routes', { routeId: 'R-301', name: 'Ruta de A' })).status, 201);
    assert.equal((await call(b, 'POST', '/api/fleet/routes', { routeId: 'R-401', name: 'Ruta de B' })).status, 201);
    assert.equal((await call(a, 'POST', '/api/fleet/buses', { placa: 'AAA111', routeId: 'R-301' })).status, 201);

    // Alta de B en la ruta de A: 404, y sin nombrar a A.
    const alta = await call(b, 'POST', '/api/fleet/buses', { placa: 'BBB222', routeId: 'R-301' });
    assert.equal(alta.status, 404, alta.texto);
    assert.equal(alta.json.error.code, 'ROUTE_NOT_FOUND');
    assert.equal(alta.texto.includes(companyA), false, 'el 404 no dice de quién es la ruta');
    assert.equal(alta.texto.includes('Ruta de A'), false);
    // Una ruta que no está en ningún catálogo, igual: si no, B la ocupa
    // antes y el día que A la cree hereda el bus de B.
    const inventada = await call(b, 'POST', '/api/fleet/buses', { placa: 'BBB222', routeId: 'R-999' });
    assert.equal(inventada.status, 404, inventada.texto);
    assert.equal(inventada.json.error.code, 'ROUTE_NOT_FOUND');

    // El bus no quedó creado a medias, y la ruta de A no lo lista.
    let flotaB = (await call(b, 'GET', '/api/fleet/positions')).json;
    assert.equal(flotaB.buses.some((bus: any) => bus.busId === 'BUS-BBB222'), false);
    const rutasB = (await call(b, 'GET', '/api/fleet/routes')).json;
    assert.deepEqual(rutasB.routes.map((r: any) => r.routeId), ['R-401']);

    // En su propia ruta, sí.
    const propio = await call(b, 'POST', '/api/fleet/buses', { placa: 'BBB222', routeId: 'R-401' });
    assert.equal(propio.status, 201, propio.texto);

    // La edición: pasar el bus a la ruta de A, o a una que no existe, es el
    // mismo 404 y el bus sigue donde estaba.
    const edicion = await call(b, 'PATCH', '/api/fleet/buses/BUS-BBB222', { routeId: 'R-301', interno: '555' });
    assert.equal(edicion.status, 404, edicion.texto);
    assert.equal(edicion.json.error.code, 'ROUTE_NOT_FOUND');
    assert.equal(edicion.texto.includes(companyA), false);
    assert.equal((await call(b, 'PATCH', '/api/fleet/buses/BUS-BBB222', { routeId: 'R-998' })).status, 404);
    flotaB = (await call(b, 'GET', '/api/fleet/positions')).json;
    const suyo = flotaB.buses.find((bus: any) => bus.busId === 'BUS-BBB222');
    assert.equal(suyo.routeId, 'R-401');
    assert.notEqual(suyo.interno, '555', 'un PATCH rechazado no aplica nada');

    // Lo que ya valía sigue valiendo: su propia ruta, y la cadena vacía
    // para dejarlo sin ruta.
    assert.equal((await call(b, 'PATCH', '/api/fleet/buses/BUS-BBB222', { routeId: 'R-401', interno: '12' })).status, 200);
    const sinRuta = await call(b, 'PATCH', '/api/fleet/buses/BUS-BBB222', { routeId: '' });
    assert.equal(sinRuta.status, 200, sinRuta.texto);
    assert.equal(sinRuta.json.routeId, null);

    // Un bus que ya tenía una ruta fuera del catálogo (bases de antes de
    // esta regla) se sigue pudiendo editar si el panel reenvía la ruta que
    // ya tiene: no es un cambio de ruta. La API ya no deja armar ese caso,
    // así que se escribe en la base, como lo dejó el código de antes.
    const baseDatos = new Database(dbPath);
    baseDatos.pragma('busy_timeout = 5000');
    baseDatos.prepare("UPDATE buses SET route_id = 'R-777' WHERE bus_id = 'BUS-BBB222'").run();
    baseDatos.close();
    const heredado = await call(b, 'PATCH', '/api/fleet/buses/BUS-BBB222', { routeId: 'R-777', interno: '31' });
    assert.equal(heredado.status, 200, heredado.texto);
    assert.equal(heredado.json.routeId, 'R-777');
    assert.equal(heredado.json.interno, '31');

    // Y lo de A quedó como estaba: su ruta solo tiene su bus.
    const rutasA = (await call(a, 'GET', '/api/fleet/routes')).json;
    const r301 = rutasA.routes.find((r: any) => r.routeId === 'R-301');
    assert.equal(r301.name, 'Ruta de A');
    assert.equal(r301.total, 1);
  } finally {
    await stopProcess(backend);
    for (const sufijo of ['', '-wal', '-shm']) rmSync(`${dbPath}${sufijo}`, { force: true });
  }
});
