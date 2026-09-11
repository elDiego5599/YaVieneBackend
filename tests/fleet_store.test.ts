// Pruebas de las funciones puras de flota y catálogo sobre una base de datos
// desechable. Cubren los tres arreglos de la auditoría del 29/08/2026: el
// número interno que se repetía tras borrar un bus, el identificador de ruta
// que aceptaba guiones sueltos, y el fallback 'R-101' inventado al borrar la
// última ruta de una empresa.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-fleet-'));
process.env.YA_VIENE_DB_PATH = join(tmp, 'test.db');

// Los módulos se cargan con require y no con import porque abren la base al
// evaluarse: el import se izaría por encima de la línea que fija la ruta.
const { createBus, deleteBus, updateBus, getCompanyBuses, getBusCompanyId } =
  require('../src/data/fleet_admin') as typeof import('../src/data/fleet_admin');
const { addCompanyRoute, removeCompanyRoute, getCompanyRoutes, routeExists } =
  require('../src/data/routes_store') as typeof import('../src/data/routes_store');
const { upsertPosition } =
  require('../src/data/positions_store') as typeof import('../src/data/positions_store');
const { createDriverSession, getSession } =
  require('../src/data/sessions') as typeof import('../src/data/sessions');
const { getDb } = require('../src/data/database') as typeof import('../src/data/database');

test.after(() => rmSync(tmp, { recursive: true, force: true }));

// `createBus` devuelve el bus o el motivo por el que no se pudo dar de alta
// ('invalid' / 'taken'). Casi todas las pruebas de aquí dan de alta buses
// buenos, así que este envoltorio se queda con el caso feliz y falla con el
// motivo a la vista si algún día deja de serlo.
function alta(
  empresa: string,
  placa: string,
  ruta: string,
  interno?: string,
): import('../src/data/bus_types').FleetBus {
  const bus = createBus(empresa, placa, ruta, interno);
  assert.notEqual(typeof bus, 'string', `no se dio de alta ${placa}: ${bus}`);
  return bus as import('../src/data/bus_types').FleetBus;
}

function nuevaEmpresa(id: string): void {
  getDb().prepare(
    'INSERT OR IGNORE INTO empresas (company_id, name, created_at) VALUES (?, ?, ?)',
  ).run(id, `Empresa ${id}`, Date.now());
}

test('el interno no se repite después de borrar un bus del medio', () => {
  const empresa = 'EMP-INT';
  nuevaEmpresa(empresa);
  addCompanyRoute(empresa, 'R-900', 'Ruta de prueba');

  const uno = alta(empresa, 'AAA111', 'R-900');
  const dos = alta(empresa, 'BBB222', 'R-900');
  const tres = alta(empresa, 'CCC333', 'R-900');
  assert.deepEqual([uno.interno, dos.interno, tres.interno], ['001', '002', '003']);

  // Con COUNT(*)+1 el contador volvía a 2 y el siguiente nacía como '003',
  // chocando con un bus que sigue vivo.
  deleteBus(dos.busId);
  const cuatro = alta(empresa, 'DDD444', 'R-900');
  assert.equal(cuatro.interno, '004');

  const internos = getCompanyBuses(empresa).map((b) => b.interno);
  assert.equal(new Set(internos).size, internos.length, `internos repetidos: ${internos}`);
});

test('el interno explícito manda y no lo pisa el automático', () => {
  const empresa = 'EMP-INT2';
  nuevaEmpresa(empresa);
  addCompanyRoute(empresa, 'R-901', 'Otra');
  assert.equal(alta(empresa, 'EEE555', 'R-901', '042').interno, '042');
  // El siguiente automático continúa desde el mayor, no desde el conteo.
  assert.equal(alta(empresa, 'FFF666', 'R-901').interno, '043');
});

test('el identificador de ruta rechaza guiones sueltos', () => {
  const empresa = 'EMP-RUTA';
  nuevaEmpresa(empresa);
  assert.equal(addCompanyRoute(empresa, '---', 'Ruta rara'), null);
  assert.equal(addCompanyRoute(empresa, '-R-', 'Ruta rara'), null);
  assert.equal(addCompanyRoute(empresa, 'R-', 'Ruta rara'), null);
  assert.equal(addCompanyRoute(empresa, 'R', 'Muy corta'), null);
  assert.equal(addCompanyRoute(empresa, 'R-106', 'Buena')?.routeId, 'R-106');
  assert.equal(addCompanyRoute(empresa, 'RUTA-1A', 'Buena')?.routeId, 'RUTA-1A');
});

test('borrar la última ruta deja los buses sin ruta, no en una inventada', () => {
  const empresa = 'EMP-SOLA';
  nuevaEmpresa(empresa);
  addCompanyRoute(empresa, 'R-950', 'Única');
  const bus = alta(empresa, 'GGG777', 'R-950');

  assert.equal(removeCompanyRoute(empresa, 'R-950'), true);
  assert.equal(getCompanyRoutes(empresa).length, 0);

  const guardado = getCompanyBuses(empresa).find((b) => b.busId === bus.busId);
  // Antes quedaba apuntando a 'R-101', una ruta de otra empresa o de ninguna.
  assert.equal(guardado?.routeId ?? null, null);
});

test('borrar una ruta con otra viva mueve los buses a la que queda', () => {
  const empresa = 'EMP-DOS';
  nuevaEmpresa(empresa);
  addCompanyRoute(empresa, 'R-960', 'Primera');
  addCompanyRoute(empresa, 'R-961', 'Segunda');
  const bus = alta(empresa, 'HHH888', 'R-961');

  assert.equal(removeCompanyRoute(empresa, 'R-961'), true);
  const guardado = getCompanyBuses(empresa).find((b) => b.busId === bus.busId);
  assert.equal(guardado?.routeId, 'R-960');
});

test('una placa de otra empresa no se puede dar de alta', () => {
  const duena = 'EMP-DUENA';
  const ajena = 'EMP-AJENA';
  nuevaEmpresa(duena);
  nuevaEmpresa(ajena);
  addCompanyRoute(duena, 'R-970', 'De la dueña');
  addCompanyRoute(ajena, 'R-971', 'De la otra');
  const bus = alta(duena, 'III999', 'R-970');

  // Antes el INSERT resolvía el conflicto de placa pisando `company_id`: la
  // otra empresa daba de alta la misma placa y se quedaba con el bus y con
  // las posiciones que ya estaba publicando.
  assert.equal(createBus(ajena, 'III999', 'R-971'), 'taken');
  assert.equal(getCompanyBuses(ajena).length, 0);
  assert.equal(getBusCompanyId(bus.busId), duena);
  const guardado = getCompanyBuses(duena).find((b) => b.busId === bus.busId);
  assert.equal(guardado?.routeId, 'R-970');
});

test('una ruta bien escrita pero que no existe no cuenta como ruta', () => {
  const empresa = 'EMP-EXISTE';
  nuevaEmpresa(empresa);
  // Forma válida, pero nadie la ha dado de alta: el socket la aceptaba.
  assert.equal(routeExists('ZZ-999'), false);
  // Las de la demo existen aunque ninguna empresa las tenga en catálogo.
  assert.equal(routeExists('R-101'), true);

  addCompanyRoute(empresa, 'R-990', 'Recién creada');
  assert.equal(routeExists('R-990'), true);

  // Borrada del catálogo y sin buses que la usen, deja de existir.
  addCompanyRoute(empresa, 'R-991', 'Efímera');
  assert.equal(removeCompanyRoute(empresa, 'R-991'), true);
  assert.equal(routeExists('R-991'), false);
});

test('la placa mal escrita o sin ruta se distingue de la ocupada', () => {
  const empresa = 'EMP-MALA';
  nuevaEmpresa(empresa);
  addCompanyRoute(empresa, 'R-980', 'Buena');
  assert.equal(createBus(empresa, 'no-es-placa', 'R-980'), 'invalid');
  assert.equal(createBus(empresa, 'JJJ000', ''), 'invalid');
});

// ── Auditoría del 11/09/2026 ─────────────────────────────────────────
// Buses borrados que seguían publicando, rutas cambiadas a medias, placas
// repetidas por la edición y altas de ruta que renombraban la existente.

// Un conductor en la tabla: `positions.driver_phone` apunta a `drivers`.
function conductor(telefono: string): void {
  getDb().prepare(`
    INSERT OR IGNORE INTO drivers (phone_number, driver_id, name, route_id, registered_at)
    VALUES (?, ?, 'Conductor de prueba', 'R-101', ?)
  `).run(telefono, telefono, Date.now());
}

// Lo que hace el manejador MQTT con una posición que ya pasó sus candados.
function publicar(busId: string, ruta: string, telefono: string, sequence: number) {
  return upsertPosition(telefono, {
    busId,
    routeId: ruta,
    lat: 10.98,
    lon: -74.8,
    sessionId: `ses-${busId}`,
    sequence,
    driverValidated: true,
  });
}

const rutaViva = (busId: string) =>
  (getDb().prepare('SELECT route_id FROM positions WHERE bus_id = ?').get(busId) as
    { route_id: string } | undefined)?.route_id;

test('borrar un bus revoca sus sesiones y deja de aceptar sus posiciones', () => {
  const empresa = 'EMP-BORRA';
  const telefono = '3000000800';
  nuevaEmpresa(empresa);
  addCompanyRoute(empresa, 'R-800', 'Borrable');
  const bus = alta(empresa, 'KKK111', 'R-800');
  conductor(telefono);
  createDriverSession({
    sessionId: 'ses-800',
    driverId: telefono,
    phoneNumber: telefono,
    companyId: empresa,
    busId: bus.busId,
    routeId: 'R-800',
  });
  assert.ok(publicar(bus.busId, 'R-800', telefono, 1));

  deleteBus(bus.busId);
  // Antes la sesión seguía activa y el broker lo dejaba publicar.
  assert.equal(getSession('ses-800')?.status, 'revoked');
  // Y aunque se cuele una publicación antes del barrido, no resucita la fila.
  assert.equal(publicar(bus.busId, 'R-800', telefono, 2), null);
  assert.equal(rutaViva(bus.busId), undefined);
});

test('una posición de un bus que no está en el catálogo no se guarda', () => {
  conductor('3000000801');
  assert.equal(publicar('BUS-NOEXISTE', 'R-800', '3000000801', 1), null);
  assert.equal(rutaViva('BUS-NOEXISTE'), undefined);
});

test('cambiar la ruta de un bus mueve también su posición viva', () => {
  const empresa = 'EMP-MUDA';
  const telefono = '3000000810';
  nuevaEmpresa(empresa);
  addCompanyRoute(empresa, 'R-810', 'Vieja');
  addCompanyRoute(empresa, 'R-811', 'Nueva');
  const bus = alta(empresa, 'LLL111', 'R-810');
  conductor(telefono);
  publicar(bus.busId, 'R-810', telefono, 1);

  assert.notEqual(updateBus(bus.busId, { routeId: 'R-811' }), 'taken');
  // Antes sólo cambiaba `buses.route_id` y el pasajero lo seguía viendo en
  // la ruta vieja.
  assert.equal(rutaViva(bus.busId), 'R-811');
  // La sesión del conductor sigue diciendo R-810: la siguiente posición no
  // puede devolverlo allí.
  assert.equal(publicar(bus.busId, 'R-810', telefono, 2)?.routeId, 'R-811');
  assert.equal(rutaViva(bus.busId), 'R-811');

  // Sin ruta no queda mapa donde ponerlo.
  updateBus(bus.busId, { routeId: '' });
  assert.equal(rutaViva(bus.busId), undefined);
});

test('la edición no deja ponerle a un bus la placa de otro', () => {
  const empresa = 'EMP-PLACA';
  nuevaEmpresa(empresa);
  addCompanyRoute(empresa, 'R-820', 'Placas');
  const uno = alta(empresa, 'MMM111', 'R-820');
  const dos = alta(empresa, 'NNN222', 'R-820');

  assert.equal(updateBus(dos.busId, { placa: 'mmm 111' }), 'taken');
  assert.equal(getCompanyBuses(empresa).find((b) => b.busId === dos.busId)?.placa, 'NNN222');
  // Volver a guardar la propia no es un choque.
  assert.notEqual(updateBus(uno.busId, { placa: 'MMM111' }), 'taken');
  // Y la base lo impide aunque alguien se salte la comprobación.
  assert.throws(
    () => getDb().prepare('UPDATE buses SET plate_number = ? WHERE bus_id = ?').run('MMM111', dos.busId),
    /UNIQUE/,
  );
});

test('dar de alta una ruta con un id que ya existe no la renombra', () => {
  const empresa = 'EMP-RUTA2';
  nuevaEmpresa(empresa);
  addCompanyRoute(empresa, 'R-830', 'Original');
  // Antes el ON CONFLICT pisaba el nombre y respondía como un alta.
  assert.equal(addCompanyRoute(empresa, 'R-830', 'Pisada'), 'taken');
  assert.equal(getCompanyRoutes(empresa).find((r) => r.routeId === 'R-830')?.name, 'Original');
});
