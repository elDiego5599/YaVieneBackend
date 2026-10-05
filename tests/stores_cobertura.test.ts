// Cobertura unitaria de los stores: funciones que solo se ejercían vía hijo
// (spawn) o no se ejercían, y el trinquete 92/79/92 las pedía. Todo en
// proceso contra una base temporal, sin puertos: el patrón require-tras-env
// de fleet_store.test.ts (la ruta se lee al cargar el módulo).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-stores-cob-'));
process.env.YA_VIENE_DB_PATH = join(tmp, 'test.db');
process.env.ADMIN_API_KEY = 'stores-cob-admin-key';
process.env.JWT_SECRET = 'cob-jwt-secret';

// Los módulos se cargan con require y no con import porque abren la base y
// leen ADMIN_API_KEY al evaluarse: el import se izaría por encima del env.
const { getDb } = require('../src/data/database') as typeof import('../src/data/database');
const empresas = require('../src/data/empresas') as typeof import('../src/data/empresas');
const rutas = require('../src/data/routes_store') as typeof import('../src/data/routes_store');
const sesiones = require('../src/data/sessions') as typeof import('../src/data/sessions');
const posiciones = require('../src/data/positions_store') as typeof import('../src/data/positions_store');
const conductores = require('../src/data/drivers_store') as typeof import('../src/data/drivers_store');
const flota = require('../src/data/fleet_admin') as typeof import('../src/data/fleet_admin');
const { dispatchBusEvents } = require('../src/data/despacho') as typeof import('../src/data/despacho');
const { isAdminRequest } = require('../src/auth/http') as typeof import('../src/auth/http');
const { validateConfig } = require('../src/config') as typeof import('../src/config');
const sock = require('../src/socket/handler') as typeof import('../src/socket/handler');

test.after(() => {
  // En Windows un archivo abierto no se borra (EBUSY): se cierra antes.
  try {
    getDb().close();
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

function nuevaEmpresa(id: string): void {
  getDb().prepare(
    'INSERT OR IGNORE INTO empresas (company_id, name, created_at) VALUES (?, ?, ?)',
  ).run(id, `Empresa ${id}`, Date.now());
}

// positions.driver_phone y driver_sessions.phone_number tienen FK a
// drivers(phone_number): sin fila del conductor, el insert falla.
function registrarConductor(phone: string, driverId: string, busId?: string): void {
  conductores.registerDriver(phone, `N ${driverId}`, 'R-900', {
    driverId, companyId: 'COB-S', ...(busId ? { busId } : {}),
  });
}

test('sweep sin candidatos no abre transacción', () => {
  assert.deepEqual(posiciones.sweepPositions(60_000), { toGhost: [] });
});

test('empresas: alta, lectura y ciclo del admin', () => {
  // empresa_admins.company_id tiene FK a empresas.
  empresas.ensureEmpresa('COB-E1');
  empresas.ensureEmpresa('COB-E2');
  empresas.ensureEmpresa('COB-E1', 'Otra');
  assert.equal(empresas.getEmpresa('COB-E1')?.name, 'COB-E1');
  assert.equal(empresas.getEmpresa('COB-NO'), null);
  assert.ok(empresas.getEmpresas().some((e) => e.companyId === 'COB-E1'));

  assert.equal(empresas.getCompanyAdminByUsername('cob-admin@x'), null);
  const creado = empresas.createOrUpdateCompanyAdmin('COB-E1', '  Cob-Admin@X ', 'hash1');
  assert.equal(creado.username, 'cob-admin@x');
  assert.equal(creado.companyId, 'COB-E1');
  assert.equal(empresas.getCompanyAdminByUsername('cob-admin@x')?.adminId, creado.adminId);

  const movido = empresas.createOrUpdateCompanyAdmin('COB-E2', 'cob-admin@x', 'hash2');
  assert.equal(movido.companyId, 'COB-E2');
  assert.equal(movido.tokenVersion, creado.tokenVersion + 1);

  assert.equal(empresas.isAdminTokenCurrent(movido.adminId, 'COB-E2', movido.tokenVersion), true);
  assert.equal(empresas.isAdminTokenCurrent(movido.adminId, 'COB-E2', creado.tokenVersion), false);
  assert.equal(empresas.isAdminTokenCurrent(movido.adminId, 'COB-E1', movido.tokenVersion), false);
  assert.equal(empresas.isAdminTokenCurrent('inexistente', 'COB-E2', 0), false);

  assert.equal(empresas.revokeAdminTokens(movido.adminId, 'COB-E2', movido.tokenVersion), true);
  assert.equal(empresas.revokeAdminTokens(movido.adminId, 'COB-E2', movido.tokenVersion), false);
  assert.equal(
    empresas.revokeAdminTokens(movido.adminId, 'COB-E2', movido.tokenVersion + 1),
    true,
  );
});

test('rutas: existe por nombre, auto-id, renombre y choques', () => {
  nuevaEmpresa('COB-R');
  assert.equal(rutas.routeNameExists('COB-R', '   '), false);
  assert.equal(rutas.routeNameExists('COB-R', 'Mi Ruta'), false);

  // La cuenta global sigue desde R-110 (la mayor con trazado en la app).
  const auto = rutas.addCompanyRoute('COB-R', '', 'Auto');
  assert.equal(auto?.routeId, 'R-111');

  const alta = rutas.addCompanyRoute('COB-R', 'R-900', 'Mi Ruta');
  assert.equal(alta?.routeId, 'R-900');
  assert.equal(rutas.routeNameExists('COB-R', 'mi ruta'), true);
  assert.equal(rutas.routeNameExists('COB-R', 'mi ruta', 'R-900'), false);
  assert.equal(rutas.routeNameExists('COB-R', 'otra'), false);

  assert.equal(rutas.addCompanyRoute('COB-R', 'R-900', 'Otra'), 'taken');
  assert.equal(rutas.addCompanyRoute('COB-R', 'R-101', 'Demo'), 'taken');
  assert.equal(rutas.addCompanyRoute('COB-R', 'R-901', ''), null);
  assert.equal(rutas.addCompanyRoute('COB-R', 'R-902', 'x'.repeat(61)), null);
  assert.equal(rutas.addCompanyRoute('COB-R', '!', 'Mala'), null);

  // Sin catálogo pero con bus rodando en ella: el nombre derivado vale.
  const der = flota.createBus('COB-R', 'DER001', 'R-950');
  assert.notEqual(typeof der, 'string');
  assert.equal(rutas.routeNameExists('COB-R', 'ruta r-950'), true);
  assert.equal(rutas.routeNameExists('COB-R', 'ruta r-950', 'R-950'), false);

  assert.deepEqual(rutas.renameCompanyRoute('COB-R', 'R-900', 'Renombrada'), {
    routeId: 'R-900',
    name: 'Renombrada',
  });
  assert.equal(rutas.renameCompanyRoute('COB-R', 'R-900', ''), null);
  assert.equal(rutas.renameCompanyRoute('COB-R', 'R-999', 'Nada'), null);
});

test('sesiones: reclamo, autorización, entrega y revocación', () => {
  const s = (id: string, driver: string, bus: string): void => {
    registrarConductor(`+57${driver}`, driver, bus);
    sesiones.createDriverSession({
      sessionId: id, driverId: driver, phoneNumber: `+57${driver}`, companyId: 'COB-S',
      busId: bus, routeId: 'R-900',
    });
  };
  s('cob-s1', 'D1', 'B1');
  assert.equal(sesiones.claimSession('cob-s1', 'A'), true);
  assert.equal(sesiones.claimSession('cob-s1', 'A'), true);
  assert.equal(sesiones.claimSession('cob-s1', 'B'), false);
  assert.equal(sesiones.isSessionAuthorized('cob-s1', 'A'), true);
  assert.equal(sesiones.isSessionAuthorized('cob-s1', 'B'), false);

  // createDriverSession vacía la caché: el reclamo vuelve por la base.
  s('cob-s2', 'D2', 'B2');
  assert.equal(sesiones.claimSession('cob-s1', 'B'), false);
  assert.equal(sesiones.claimSession('cob-s1', 'A'), true);
  assert.equal(sesiones.isSessionAuthorized('cob-s1', 'A'), true);

  assert.equal(sesiones.releaseSession('cob-s1', 'A'), true);
  assert.equal(sesiones.isSessionAuthorized('cob-s1', 'A'), false);
  assert.equal(sesiones.releaseSession('cob-s1', 'A'), false);

  assert.equal(sesiones.claimSession('cob-no', 'A'), false);
  assert.equal(sesiones.isSessionAuthorized('cob-no', 'A'), false);
  assert.equal(sesiones.getSession('cob-no'), null);

  s('cob-s3', 'D3', 'B3');
  assert.equal(sesiones.revokeSession('cob-s3'), true);
  assert.equal(sesiones.isSessionAuthorized('cob-s3', 'cualquiera'), false);
  assert.equal(sesiones.revokeSession('cob-s3'), false);

  // El alta nueva revoca la activa anterior del mismo conductor.
  s('cob-s4', 'D1', 'B1');
  assert.equal(sesiones.getSession('cob-s4')?.status, 'active');
  assert.ok(sesiones.revokeSessionsForDriver('D1') >= 1);
  assert.ok(sesiones.revokeSessionsForBus('B2') >= 0);
  assert.ok(sesiones.cleanupRevokedSessions(-1) >= 1);
});

test('posiciones: secuencia, borrados y fantasma que caduca', () => {
  const bus = flota.createBus('COB-P', 'COB001', 'R-900');
  assert.notEqual(typeof bus, 'string');
  const busId = 'BUS-COB001';
  registrarConductor('+571', 'COB-P1');

  // Sin fila en el catálogo no publica, aunque la sesión valga.
  assert.equal(posiciones.upsertPosition('+571', {
    busId: 'BUS-NOPE', routeId: 'R-900', lat: 10.9, lon: -74.8, driverValidated: true,
  }), null);

  const viva = posiciones.upsertPosition('+571', {
    busId, routeId: 'R-900', lat: 10.9, lon: -74.8,
    sessionId: 'cob-ps1', capturedAt: Date.now(), sequence: 1, driverValidated: true,
  });
  assert.ok(viva);
  const publica = posiciones.toPublicPosition(viva);
  assert.equal('driverPhone' in publica, false);
  assert.equal('companyId' in publica, false);
  assert.equal(publica.busId, busId);
  assert.equal(posiciones.getPositionSequence(busId, 'cob-ps1'), 1);
  assert.equal(posiciones.getPositionSequence(busId, 'otra'), null);
  assert.ok(posiciones.getAllPositions().some((p) => p.busId === busId));
  const estado = posiciones.getPositionValidationState(busId);
  assert.equal(estado?.sequence, 1);
  assert.equal(posiciones.getPositionValidationState('BUS-NO'), null);
  assert.equal(posiciones.isGhostEventStillValid(busId, Date.now()), false);
  assert.equal(posiciones.isGhostEventStillValid('BUS-NO', Date.now()), false);

  assert.equal(posiciones.removePositionOwned(busId, 'otra'), null);
  const borradaPropia = posiciones.removePositionOwned(busId, 'cob-ps1');
  assert.equal(borradaPropia?.busId, busId);
  assert.equal(posiciones.removePositionOwned(busId, 'cob-ps1'), null);

  posiciones.upsertPosition('+571', {
    busId, routeId: 'R-900', lat: 10.9, lon: -74.8,
    sessionId: 'cob-ps2', capturedAt: Date.now(), sequence: 5, driverValidated: true,
  });
  const borrada = posiciones.removePosition(busId);
  assert.equal(borrada?.busId, busId);
  assert.equal(posiciones.getPosition(busId), null);
  assert.equal(posiciones.removePosition(busId), null);

  // Fantasma: el barrido la marca y encola el aviso; al volver el bus, el
  // aviso viejo se descarta en el despacho sin emitirse.
  posiciones.upsertPosition('+571', {
    busId, routeId: 'R-900', lat: 10.9, lon: -74.8,
    sessionId: 'cob-ps3', capturedAt: Date.now(), sequence: 6, driverValidated: true,
  });
  // ghostMs negativo = todo lo anterior a dentro-de-1ms es candidato: sin
  // depender de que Date.now() avance entre el upsert y el barrido.
  const barrido = posiciones.sweepPositions(-1);
  assert.equal(barrido.toGhost.length, 1);
  const fantasma = posiciones.getPosition(busId);
  assert.equal(fantasma?.isGhost, true);
  assert.equal(
    posiciones.isGhostEventStillValid(busId, fantasma!.capturedAt),
    true,
  );
  posiciones.upsertPosition('+571', {
    busId, routeId: 'R-900', lat: 10.91, lon: -74.81,
    sessionId: 'cob-ps3', capturedAt: Date.now() + 1000, sequence: 7, driverValidated: true,
  });

  const emitidos: { tipo: string }[] = [];
  dispatchBusEvents((ev) => {
    emitidos.push({ tipo: ev.eventType });
  });
  assert.ok(emitidos.some((e) => e.tipo === 'bus:left'));
  assert.ok(!emitidos.some((e) => e.tipo === 'bus:position'));
});

test('conductores: registro con turno, caché y cierre', () => {
  const d = conductores.registerDriver('+572', 'Cob', 'R-900', {
    driverId: 'COB-DRV1', companyId: 'COB-D', busId: 'BUS-COBDRV1',
  });
  assert.equal(d.driverId, 'COB-DRV1');
  assert.equal(conductores.getDriver('+572')?.name, 'Cob');
  assert.equal(conductores.getDriverById('COB-DRV1')?.phoneNumber, '+572');
  assert.equal(conductores.getDriverById('nadie'), null);

  // Sin caché va a la base; sin fila, null.
  conductores.driverCache.delete('+572');
  assert.equal(conductores.getDriver('+572')?.driverId, 'COB-DRV1');
  assert.equal(conductores.getDriver('+57999'), null);

  conductores.endAssignment('COB-DRV1', 'BUS-COBDRV1');
  const turno = getDb().prepare(
    "SELECT status FROM turn_assignments WHERE driver_id = ? AND bus_id = ?",
  ).get('COB-DRV1', 'BUS-COBDRV1') as { status: string };
  assert.equal(turno.status, 'ended');
});

test('flota: visibilidad, edición y borrado total', () => {
  nuevaEmpresa('COB-F');
  const b = flota.createBus('COB-F', 'VIS001', 'R-900');
  assert.notEqual(typeof b, 'string');
  const busId = 'BUS-VIS001';

  flota.loadVisibilityCache();
  flota.loadBusCompanyCache();
  assert.equal(flota.getBusVisibility(busId), false);
  const visible = flota.setBusVisibility(busId, true);
  assert.equal(visible?.visible, true);
  assert.equal(flota.getBusVisibility(busId), true);
  assert.equal(flota.setBusVisibility('BUS-NO', true), null);

  assert.equal(flota.updateBus('BUS-NO', { interno: '9' }), null);
  assert.equal(flota.updateBus(busId, { tipologia: 'COLECTIVO' }), null);
  assert.equal(flota.updateBus(busId, { capacidad: 'xx' }), null);
  const editado = flota.updateBus(busId, {
    interno: '007', tipologia: 'PADRON', capacidad: 60,
  });
  assert.notEqual(editado, null);
  assert.equal((editado as { interno: string }).interno, '007');

  // Cambiar la ruta mueve también la posición viva en la misma transacción.
  registrarConductor('+574', 'COB-F2');
  const rutero = flota.createBus('COB-F', 'RUT001', 'R-900');
  assert.notEqual(typeof rutero, 'string');
  posiciones.upsertPosition('+574', {
    busId: 'BUS-RUT001', routeId: 'R-900', lat: 10.9, lon: -74.8, driverValidated: true,
  });
  const movidoRuta = flota.updateBus('BUS-RUT001', { routeId: 'R-901' });
  assert.equal((movidoRuta as { routeId: string | null }).routeId, 'R-901');
  assert.equal(posiciones.getPosition('BUS-RUT001')?.routeId, 'R-901');

  assert.equal(flota.createBus('COB-F', '!!', 'R-900'), 'invalid');
  assert.equal(flota.createBus('COB-F', 'VIS002', '---'), 'invalid');
  const conTipo = flota.createBus('COB-F', 'VIS002', 'R-900', undefined, {
    tipologia: 'ARTICULADO', capacidad: 80,
  });
  assert.notEqual(typeof conTipo, 'string');

  registrarConductor('+573', 'COB-F1');
  posiciones.upsertPosition('+573', {
    busId: 'BUS-VIS002', routeId: 'R-900', lat: 10.9, lon: -74.8, driverValidated: true,
  });
  const quitados = flota.deleteAllBuses('COB-F');
  assert.equal(quitados, 3);
  assert.deepEqual(flota.getCompanyBuses('COB-F'), []);
  assert.equal(flota.deleteAllBuses('COB-F'), 0);
});

test('socket: avisos de salida, borrado y visibilidad', async () => {
  const servidor = createServer();
  await new Promise<void>((listo) => servidor.listen(0, '127.0.0.1', listo));
  try {
    sock.setupSocketServer(servidor);
    // Sin clientes no hay a quién emitir, pero el camino corre entero.
    sock.broadcastBusLeft('BUS-X', 'R-900', 'ev1', 'COB-X');
    sock.broadcastBusRemoved('BUS-X', 'R-900', 'ev2', 'COB-X');
    sock.broadcastBusHidden('BUS-X', 'R-900', 'ev3', 'COB-X');
    sock.broadcastBusVisible('BUS-X', 'R-900', 'ev4', undefined, 'COB-X');
    sock.broadcastBusVisible('BUS-X', 'R-900', 'ev5', {
      busId: 'BUS-X', routeId: 'R-900', lat: 10.9, lon: -74.8, heading: null,
      speedKmh: 0, sentido: null, timestamp: new Date().toISOString(),
      capturedAt: Date.now(), receivedAt: Date.now(), sequence: 1,
      driverPhone: '', companyId: 'COB-X', isGhost: false,
    }, 'COB-X');
    sock.closeSocketServer();
    assert.equal(sock.activeTimerCount(), 0);
    assert.equal(sock.getIO(), null);
  } finally {
    await new Promise<void>((listo) => {
      if (!servidor.listening) return listo();
      servidor.close(() => listo());
    });
  }
});

test('admin y config: clave y ramas de producción', () => {
  const req = (headers: Record<string, string>): IncomingMessage =>
    ({ headers }) as unknown as IncomingMessage;
  assert.equal(isAdminRequest(req({ 'x-admin-key': 'stores-cob-admin-key' })), true);
  assert.equal(isAdminRequest(req({ 'x-admin-key': 'otra-clave-admin' })), false);
  assert.equal(isAdminRequest(req({ 'x-admin-key': 'corta' })), false);
  assert.equal(isAdminRequest(req({})), false);

  const prod = {
    NODE_ENV: 'production', JWT_SECRET: 'j'.repeat(64), ADMIN_API_KEY: 'k'.repeat(48),
  };
  assert.deepEqual(validateConfig({
    ...prod, HTTP_TLS_CERT_PATH: '/c.pem', HTTP_TLS_KEY_PATH: '/k.pem',
  }).errores, []);
  assert.deepEqual(validateConfig({ ...prod, HTTP_TLS_EXTERNO: '1' }).errores, []);
  assert.match(validateConfig(prod).errores[0], /HTTP_TLS_EXTERNO/);
});

test('broker idle: ready falso y closeBroker idempotente sin servidor', async () => {
  const broker = require('../src/mqtt/broker') as typeof import('../src/mqtt/broker');
  assert.equal(broker.isBrokerReady(), false);
  await broker.closeBroker();
  assert.equal(broker.isBrokerReady(), false);
  await broker.closeBroker();
});
