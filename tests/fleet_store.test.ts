// Pruebas de las funciones puras de flota y catálogo sobre una base de datos
// desechable. Cubren los tres arreglos de la auditoría del 29/08/2026: el
// número interno que se repetía tras borrar un bus, el identificador de ruta
// que aceptaba guiones sueltos, y el fallback 'R-101' inventado al borrar la
// última ruta de una empresa.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-fleet-'));
process.env.YA_VIENE_DB_PATH = join(tmp, 'test.db');

// Los módulos se cargan con require y no con import porque abren la base al
// evaluarse: el import se izaría por encima de la línea que fija la ruta.
const {
  createBus, deleteBus, updateBus, getCompanyBuses, getBusCompanyId, getFleetPositions,
  setAllBusVisibility,
} = require('../src/data/fleet_admin') as typeof import('../src/data/fleet_admin');
const { addCompanyRoute, removeCompanyRoute, getCompanyRoutes, routeExists } =
  require('../src/data/routes_store') as typeof import('../src/data/routes_store');
const { upsertPosition, getPosition } =
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
  assert.equal(addCompanyRoute(empresa, 'R-940', 'Buena')?.routeId, 'R-940');
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

// ── Código de ruta único entre empresas ──────────────────────────────
// La sala del pasajero es `route:{id}`, sin empresa. Desde ahora un índice
// único lo impide, pero una base que ya trae el choque no se arregla sola:
// decidir de quién es la ruta es cosa de una persona, así que el arranque se
// detiene y dice cuál.

test('una ruta de otra empresa o de la demo no se puede dar de alta', () => {
  const empresa = 'EMP-GLOBAL';
  nuevaEmpresa(empresa);
  assert.equal(addCompanyRoute(empresa, 'R-106', 'La de la demo'), 'taken');
  assert.equal(addCompanyRoute(empresa, 'R-900', 'La de EMP-INT'), 'taken');
  assert.equal(getCompanyRoutes(empresa).length, 0);
  // La base lo impide aunque alguien se salte la comprobación.
  assert.throws(
    () => getDb().prepare(
      'INSERT INTO company_routes (company_id, route_id, name, created_at) VALUES (?, ?, ?, ?)',
    ).run(empresa, 'R-101', 'Colada', Date.now()),
    /UNIQUE/,
  );
});

test('la migración se niega a arrancar con ids de ruta repetidos entre empresas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yaviene-dup-'));
  const ruta = join(dir, 'dup.db');
  const modulo = join(__dirname, '..', 'src', 'data', 'database.ts');
  const abrir = () => spawnSync(
    process.execPath,
    ['--import', 'tsx', '--eval', `require(${JSON.stringify(modulo)}).getDb()`],
    { env: { ...process.env, YA_VIENE_DB_PATH: ruta }, encoding: 'utf8', timeout: 30_000 },
  );
  try {
    const nueva = abrir();
    assert.equal(nueva.status, 0, `una base nueva tiene que arrancar: ${nueva.stderr}`);

    // Una base de antes del índice, con R-101 en dos empresas.
    const d = new Database(ruta);
    d.exec('DROP INDEX IF EXISTS idx_company_routes_route_id');
    d.prepare('DELETE FROM schema_migrations WHERE version = 20').run();
    d.prepare(
      'INSERT INTO company_routes (company_id, route_id, name, created_at) VALUES (?, ?, ?, ?)',
    ).run('EMP-COPIA', 'R-101', 'Copia', Date.now());
    d.close();

    const vieja = abrir();
    assert.notEqual(vieja.status, 0, 'con el choque dentro no arranca');
    assert.match(vieja.stderr, /R-101/);
    assert.match(vieja.stderr, /EMP-01/);
    assert.match(vieja.stderr, /EMP-COPIA/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Rumbo que falta ──────────────────────────────────────────────────
// La validación descarta el rumbo fuera de [0, 360), y el que no llega no
// existe. Guardarlo como 0 lo volvía el norte, y el mapa dibujaba el bus
// apuntando hacia arriba.

test('una posición sin rumbo lo guarda vacío, y el 0 sigue siendo el norte', () => {
  const empresa = 'EMP-RUMBO';
  const telefono = '3000000840';
  nuevaEmpresa(empresa);
  addCompanyRoute(empresa, 'R-840', 'Rumbos');
  const bus = alta(empresa, 'OOO111', 'R-840');
  conductor(telefono);
  const guardado = () => (getDb().prepare('SELECT heading FROM positions WHERE bus_id = ?')
    .get(bus.busId) as { heading: number | null }).heading;

  assert.equal(publicar(bus.busId, 'R-840', telefono, 1)?.heading, null);
  assert.equal(guardado(), null);
  assert.equal(getPosition(bus.busId)?.heading, null);
  assert.equal(getFleetPositions(empresa).find((b) => b.busId === bus.busId)?.heading, null);

  const norte = upsertPosition(telefono, {
    busId: bus.busId,
    routeId: 'R-840',
    lat: 10.98,
    lon: -74.8,
    heading: 0,
    sessionId: `ses-${bus.busId}`,
    sequence: 2,
    driverValidated: true,
  });
  assert.equal(norte?.heading, 0);
  assert.equal(guardado(), 0);
});

test('la migración 21 deja el rumbo opcional sin perder posiciones ni índices', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yaviene-rumbo-'));
  const ruta = join(dir, 'rumbo.db');
  const modulo = join(__dirname, '..', 'src', 'data', 'database.ts');
  const abrir = () => spawnSync(
    process.execPath,
    ['--import', 'tsx', '--eval', `require(${JSON.stringify(modulo)}).getDb()`],
    { env: { ...process.env, YA_VIENE_DB_PATH: ruta }, encoding: 'utf8', timeout: 30_000 },
  );
  try {
    const nueva = abrir();
    assert.equal(nueva.status, 0, `una base nueva tiene que arrancar: ${nueva.stderr}`);

    // Una base de antes: `heading` NOT NULL DEFAULT 0 y una posición dentro.
    const d = new Database(ruta);
    d.exec(`
      DROP TABLE positions;
      CREATE TABLE positions (
        bus_id TEXT PRIMARY KEY,
        route_id TEXT NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        heading REAL NOT NULL DEFAULT 0,
        speed_kmh REAL NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL,
        driver_phone TEXT NOT NULL,
        session_id TEXT,
        captured_at INTEGER,
        sequence INTEGER,
        is_ghost INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (driver_phone) REFERENCES drivers(phone_number) ON DELETE CASCADE
      );
      ALTER TABLE positions ADD COLUMN sentido TEXT;
      CREATE INDEX idx_positions_timestamp ON positions(timestamp);
      CREATE INDEX idx_positions_route_id ON positions(route_id);
      CREATE INDEX idx_positions_session_id ON positions(session_id);
      CREATE INDEX idx_positions_sequence ON positions(bus_id, sequence);
      DELETE FROM schema_migrations WHERE version = 21;
    `);
    d.prepare(`
      INSERT INTO drivers (phone_number, driver_id, name, route_id, registered_at)
      VALUES ('3000000850', '3000000850', 'Conductor de prueba', 'R-101', ?)
    `).run(Date.now());
    d.prepare(`
      INSERT INTO positions (bus_id, route_id, lat, lon, heading, timestamp, driver_phone, sentido)
      VALUES ('BUS-VIEJO', 'R-101', 10.98, -74.8, 45, ?, '3000000850', 'ida')
    `).run(Date.now());
    d.close();

    const vieja = abrir();
    assert.equal(vieja.status, 0, `la base vieja tiene que arrancar: ${vieja.stderr}`);

    const despues = new Database(ruta);
    try {
      const columnas = despues.prepare('PRAGMA table_info(positions)').all() as
        { name: string; notnull: number }[];
      assert.equal(columnas.find((c) => c.name === 'heading')?.notnull, 0);
      const filas = despues.prepare('SELECT bus_id, heading, sentido FROM positions').all() as
        { bus_id: string; heading: number | null; sentido: string | null }[];
      assert.deepEqual(filas.map((f) => [f.bus_id, f.heading, f.sentido]), [['BUS-VIEJO', 45, 'ida']]);
      const indices = (despues.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'positions' AND sql IS NOT NULL ORDER BY name",
      ).all() as { name: string }[]).map((i) => i.name);
      assert.deepEqual(indices, [
        'idx_positions_route_id',
        'idx_positions_sequence',
        'idx_positions_session_id',
        'idx_positions_timestamp',
      ]);
    } finally {
      despues.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('«ocultar todos» no deja media flota oculta si falla por el camino', () => {
  // El panel tiene un botón que oculta la flota entera. Lo hacía bus por bus,
  // cada uno en su transacción: si el tercero fallaba —un disco lleno, un
  // bloqueo, un disparador— los dos primeros ya estaban ocultos y nadie los
  // devolvía. El dueño de la flota veía la mitad de sus buses desaparecer y
  // el botón contestando error, sin saber qué quedó de qué lado.
  const empresa = 'EMP-TODOS';
  nuevaEmpresa(empresa);
  addCompanyRoute(empresa, 'R-901', 'Ruta de prueba');
  const buses = ['PPP111', 'QQQ222', 'RRR333'].map((placa) => alta(empresa, placa, 'R-901'));
  const db = getDb();

  // Un bus recién dado de alta nace oculto, así que primero se muestran los
  // tres: lo que se prueba es el camino de vuelta.
  assert.equal(setAllBusVisibility(empresa, true), 3);
  assert.deepEqual(getCompanyBuses(empresa).map((bus) => bus.visible), [true, true, true]);

  // El fallo del medio, provocado: el tercer bus se niega a actualizarse.
  // Da igual el motivo; lo que se prueba es qué pasa con los otros dos.
  db.exec(`
    CREATE TRIGGER bus_terco BEFORE UPDATE ON buses WHEN NEW.bus_id = '${buses[2].busId}'
    BEGIN SELECT RAISE(ABORT, 'bus terco'); END;
  `);

  const antes = (db.prepare('SELECT count(*) AS n FROM lifecycle_events').get() as { n: number }).n;
  assert.throws(() => setAllBusVisibility(empresa, false), /terco/);

  // Ni un bus oculto ni un evento en la cola: o se ocultan los tres o ninguno.
  assert.deepEqual(
    getCompanyBuses(empresa).map((bus) => bus.visible),
    [true, true, true],
    'quedaron buses ocultos después de un fallo a la mitad',
  );
  assert.equal(
    (db.prepare('SELECT count(*) AS n FROM lifecycle_events').get() as { n: number }).n,
    antes,
    'quedaron eventos de un cambio que no ocurrió',
  );

  db.exec('DROP TRIGGER bus_terco');
  assert.equal(setAllBusVisibility(empresa, false), 3);
  assert.deepEqual(getCompanyBuses(empresa).map((bus) => bus.visible), [false, false, false]);
});
