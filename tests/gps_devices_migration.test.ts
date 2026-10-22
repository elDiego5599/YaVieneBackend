import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-equipos-'));
const dbPath = join(tmp, 'legacy.db');
const now = Date.now();
process.env.YA_VIENE_DB_PATH = dbPath;
process.env.YA_VIENE_SEED_DEMO = '0';

// Prepara una base en el estado anterior a la versión 35, con las columnas
// que las migraciones previas agregaron a positions y sus índices.
const legacy = new Database(dbPath);
legacy.pragma('foreign_keys = ON');
legacy.exec(`
  CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
  CREATE TABLE buses (
    bus_id TEXT PRIMARY KEY, company_id TEXT NOT NULL, plate_number TEXT,
    capacity INTEGER NOT NULL DEFAULT 40, tipologia TEXT NOT NULL DEFAULT 'SENCILLO',
    status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, route_id TEXT, interno TEXT,
    visible INTEGER NOT NULL DEFAULT 1, en_terminal INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE drivers (
    phone_number TEXT PRIMARY KEY, driver_id TEXT, name TEXT NOT NULL,
    route_id TEXT NOT NULL, company_id TEXT, bus_id TEXT, pin_hash TEXT,
    registered_at INTEGER NOT NULL
  );
  CREATE TABLE driver_sessions (
    session_id TEXT PRIMARY KEY, driver_id TEXT NOT NULL, phone_number TEXT NOT NULL,
    company_id TEXT NOT NULL, bus_id TEXT NOT NULL, route_id TEXT NOT NULL,
    client_id TEXT, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL, revoked_at INTEGER,
    FOREIGN KEY (phone_number) REFERENCES drivers(phone_number) ON DELETE CASCADE
  );
  CREATE TABLE empresas (company_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE empresa_admins (
    admin_id TEXT PRIMARY KEY, company_id TEXT NOT NULL, username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE company_routes (
    company_id TEXT NOT NULL, route_id TEXT NOT NULL, name TEXT NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY (company_id, route_id)
  );
  CREATE TABLE avisos_push (bus_id TEXT);
  CREATE TABLE positions (
    bus_id TEXT PRIMARY KEY, route_id TEXT NOT NULL, lat REAL NOT NULL,
    lon REAL NOT NULL, heading REAL, speed_kmh REAL NOT NULL DEFAULT 0,
    timestamp INTEGER NOT NULL, driver_phone TEXT NOT NULL, session_id TEXT,
    captured_at INTEGER, sequence INTEGER, is_ghost INTEGER NOT NULL DEFAULT 0,
    sentido TEXT, route_fraction REAL, route_direction TEXT,
    FOREIGN KEY (driver_phone) REFERENCES drivers(phone_number) ON DELETE CASCADE
  );
  CREATE INDEX idx_positions_timestamp ON positions(timestamp);
  CREATE INDEX idx_positions_route_id ON positions(route_id);
  CREATE INDEX idx_positions_session_id ON positions(session_id);
  CREATE INDEX idx_positions_sequence ON positions(bus_id, sequence);
  CREATE INDEX idx_sessions_bus_status ON driver_sessions(bus_id, status);
  CREATE INDEX idx_sessions_driver_status ON driver_sessions(driver_id, status);
`);
const marcaMigracion = legacy.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
for (let version = 1; version <= 34; version += 1) marcaMigracion.run(version, now);
legacy.prepare('INSERT INTO buses (bus_id, company_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
  .run('BUS-A', 'EMP-A', now, now);
legacy.prepare('INSERT INTO buses (bus_id, company_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
  .run('BUS-B', 'EMP-B', now, now);
legacy.prepare(`INSERT INTO drivers
  (phone_number, driver_id, name, route_id, company_id, bus_id, pin_hash, registered_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  .run('3000000001', 'GPS-A', 'Equipo A', 'R-101', 'EMP-A', 'BUS-A', 'hash-pin', now);
legacy.prepare(`INSERT INTO driver_sessions
  (session_id, driver_id, phone_number, company_id, bus_id, route_id, client_id, status, created_at, last_seen_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run('SESSION-A', 'GPS-A', '3000000001', 'EMP-A', 'BUS-A', 'R-101', null, 'active', now, now);
const insertPosition = legacy.prepare(`INSERT INTO positions
  (bus_id, route_id, lat, lon, heading, speed_kmh, timestamp, driver_phone,
   session_id, captured_at, sequence, is_ghost, sentido, route_fraction, route_direction)
  VALUES (?, 'R-101', ?, ?, 90, 20, ?, '3000000001', 'SESSION-A', ?, ?, 0, 'ida', 0.25, 'ida')`);
insertPosition.run('BUS-A', 10, 20, now, now, 1);
insertPosition.run('BUS-B', 11, 21, now + 1, now + 1, 2);
legacy.close();

const { getDb, closeDb, eliminarEmpresasFantasma } =
  require('../src/data/database') as typeof import('../src/data/database');
const { deleteBus, deleteAllBuses } = require('../src/data/fleet_admin') as typeof import('../src/data/fleet_admin');

test.after(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

test('la migración copia equipos y sesiones y conserva el esquema y las posiciones sin FK', () => {
  const d = getDb();
  const posiciones = d.prepare('SELECT * FROM positions ORDER BY bus_id').all() as Record<string, unknown>[];
  assert.equal(posiciones.length, 2);
  assert.equal(posiciones[0].device_id, 'GPS-A');
  assert.equal(posiciones[1].device_id, 'GPS-A');
  assert.equal(posiciones[0].route_fraction, 0.25);
  assert.equal(posiciones[0].route_direction, 'ida');
  assert.deepEqual(
    (d.pragma('table_info(positions)') as { name: string }[]).map((c) => c.name),
    ['bus_id', 'route_id', 'lat', 'lon', 'heading', 'speed_kmh', 'timestamp', 'device_id',
      'session_id', 'captured_at', 'sequence', 'is_ghost', 'sentido', 'route_fraction', 'route_direction'],
  );
  const indices = (d.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='positions' ORDER BY name").all() as { name: string }[])
    .map((r) => r.name);
  assert.deepEqual(indices, ['idx_positions_route_id', 'idx_positions_sequence', 'idx_positions_session_id', 'idx_positions_timestamp', 'sqlite_autoindex_positions_1']);
  assert.deepEqual(d.pragma('foreign_key_list(positions)'), []);

  assert.deepEqual(d.prepare('SELECT device_id, identifier, kind, secret_hash, name FROM gps_devices').get(), {
    device_id: 'GPS-A', identifier: '3000000001', kind: 'sim',
    secret_hash: 'hash-pin', name: 'Equipo A',
  });
  assert.deepEqual(d.prepare('SELECT session_id, device_id, identifier, status FROM device_sessions').get(), {
    session_id: 'SESSION-A', device_id: 'GPS-A', identifier: '3000000001', status: 'active',
  });

  d.prepare('DELETE FROM gps_devices WHERE device_id = ?').run('GPS-A');
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM positions').get()?.n, 2);
});

test('borrar un bus y una empresa limpia sesiones, equipos y posiciones de su flota', () => {
  const d = getDb();
  d.prepare(`INSERT INTO gps_devices
    (device_id, company_id, bus_id, identifier, kind, secret_hash, name, created_at, updated_at)
    VALUES ('GPS-B', 'EMP-B', 'BUS-B', '3000000002', 'sim', 'hash', 'Equipo B', ?, ?)`)
    .run(now, now);
  d.prepare(`INSERT INTO device_sessions
    (session_id, device_id, identifier, company_id, bus_id, route_id, created_at, last_seen_at)
    VALUES ('SESSION-B', 'GPS-B', '3000000002', 'EMP-B', 'BUS-B', 'R-102', ?, ?)`)
    .run(now, now);
  d.prepare('INSERT INTO empresas (company_id, name, created_at) VALUES (?, ?, ?)')
    .run('EMP-B', 'EMP-B', now);

  assert.ok(deleteBus('BUS-A'));
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM positions WHERE bus_id = ?').get('BUS-A')?.n, 0);
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM gps_devices WHERE bus_id = ?').get('BUS-A')?.n, 0);
  assert.equal(d.prepare('SELECT status FROM device_sessions WHERE bus_id = ?').get('BUS-A')?.status, 'revoked');

  assert.equal(deleteAllBuses('EMP-B'), 1);
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM positions WHERE bus_id = ?').get('BUS-B')?.n, 0);
  assert.equal(d.prepare('SELECT status FROM device_sessions WHERE bus_id = ?').get('BUS-B')?.status, 'revoked');
  // La limpieza de empresas fantasma solo elimina empresas sin posiciones.
  assert.deepEqual(eliminarEmpresasFantasma(d), ['EMP-B']);
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM positions WHERE bus_id = ?').get('BUS-B')?.n, 0);
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM gps_devices WHERE company_id = ?').get('EMP-B')?.n, 0);
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM device_sessions WHERE company_id = ?').get('EMP-B')?.n, 0);
});
