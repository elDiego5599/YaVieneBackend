import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = process.env.YA_VIENE_DB_PATH || path.join(DB_DIR, 'yaviene.db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    initSchema();
    db.prepare(`
      UPDATE driver_sessions SET client_id = NULL WHERE status = 'active'
    `).run();
    console.log(`[DB] SQLite abierta en ${DB_PATH} (WAL mode)`);
  }
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

function initSchema(): void {
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS drivers (
      phone_number TEXT PRIMARY KEY,
      driver_id TEXT,
      name TEXT NOT NULL,
      route_id TEXT NOT NULL,
      company_id TEXT,
      bus_id TEXT,
      pin_hash TEXT,
      registered_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS positions (
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

    CREATE TABLE IF NOT EXISTS driver_sessions (
      session_id TEXT PRIMARY KEY,
      driver_id TEXT NOT NULL,
      phone_number TEXT NOT NULL,
      company_id TEXT NOT NULL,
      bus_id TEXT NOT NULL,
      route_id TEXT NOT NULL,
      client_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      revoked_at INTEGER,
      FOREIGN KEY (phone_number) REFERENCES drivers(phone_number) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_positions_timestamp ON positions(timestamp);
    CREATE INDEX IF NOT EXISTS idx_positions_route_id ON positions(route_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_bus_status ON driver_sessions(bus_id, status);
    CREATE INDEX IF NOT EXISTS idx_sessions_driver_status ON driver_sessions(driver_id, status);

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lifecycle_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT UNIQUE NOT NULL,
      event_type TEXT NOT NULL,
      route_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_at INTEGER,
      delivered_at INTEGER,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS buses (
      bus_id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      plate_number TEXT,
      capacity INTEGER NOT NULL DEFAULT 40,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS turn_assignments (
      assignment_id TEXT PRIMARY KEY,
      driver_id TEXT NOT NULL,
      bus_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      route_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      status TEXT NOT NULL DEFAULT 'active'
    );
  `);

  const applied = new Set(
    (d.prepare('SELECT version FROM schema_migrations').all() as { version: number }[])
      .map((row) => row.version),
  );
  const migrations: { version: number; apply: () => void }[] = [
    {
      version: 1,
      apply: () => {
        ensureColumn(d, 'drivers', 'driver_id', 'TEXT');
        ensureColumn(d, 'drivers', 'company_id', 'TEXT');
        ensureColumn(d, 'drivers', 'bus_id', 'TEXT');
        ensureColumn(d, 'drivers', 'pin_hash', 'TEXT');
        d.exec(`
          UPDATE drivers SET driver_id = phone_number WHERE driver_id IS NULL;
          CREATE UNIQUE INDEX IF NOT EXISTS idx_drivers_driver_id
          ON drivers(driver_id) WHERE driver_id IS NOT NULL;
        `);
      },
    },
    {
      version: 2,
      apply: () => {
        ensureColumn(d, 'positions', 'session_id', 'TEXT');
        ensureColumn(d, 'positions', 'captured_at', 'INTEGER');
        ensureColumn(d, 'positions', 'sequence', 'INTEGER');
        d.exec(`
          CREATE INDEX IF NOT EXISTS idx_positions_session_id
          ON positions(session_id);
          CREATE INDEX IF NOT EXISTS idx_positions_sequence
          ON positions(bus_id, sequence);
        `);
      },
    },
    {
      version: 3,
      apply: () => {
        d.exec(`
          CREATE INDEX IF NOT EXISTS idx_sessions_bus_status
          ON driver_sessions(bus_id, status);
          CREATE INDEX IF NOT EXISTS idx_sessions_driver_status
          ON driver_sessions(driver_id, status);
        `);
      },
    },
    {
      version: 4,
      apply: () => {
        d.exec(`
          CREATE TABLE IF NOT EXISTS lifecycle_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT UNIQUE NOT NULL,
            event_type TEXT NOT NULL,
            route_id TEXT NOT NULL,
            payload TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            claimed_at INTEGER,
            delivered_at INTEGER,
            last_error TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_lifecycle_pending
          ON lifecycle_events(delivered_at, claimed_at, created_at);
        `);
      },
    },
    {
      version: 5,
      apply: () => {
        d.exec(`
          CREATE TABLE IF NOT EXISTS buses (
            bus_id TEXT PRIMARY KEY,
            company_id TEXT NOT NULL,
            plate_number TEXT,
            capacity INTEGER NOT NULL DEFAULT 40,
            status TEXT NOT NULL DEFAULT 'active',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS turn_assignments (
            assignment_id TEXT PRIMARY KEY,
            driver_id TEXT NOT NULL,
            bus_id TEXT NOT NULL,
            company_id TEXT NOT NULL,
            route_id TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            status TEXT NOT NULL DEFAULT 'active'
          );
          CREATE UNIQUE INDEX IF NOT EXISTS idx_active_assignment_bus
          ON turn_assignments(bus_id) WHERE status = 'active';
          CREATE UNIQUE INDEX IF NOT EXISTS idx_active_assignment_driver
          ON turn_assignments(driver_id) WHERE status = 'active';
          CREATE INDEX IF NOT EXISTS idx_assignments_route
          ON turn_assignments(route_id, status);
          INSERT OR IGNORE INTO buses (
            bus_id, company_id, created_at, updated_at
          )
          SELECT bus_id, company_id, registered_at, registered_at
          FROM drivers
          WHERE bus_id IS NOT NULL AND company_id IS NOT NULL;
          INSERT OR IGNORE INTO turn_assignments (
            assignment_id, driver_id, bus_id, company_id, route_id, started_at, status
          )
          SELECT 'legacy-' || phone_number, driver_id, bus_id, company_id, route_id,
                 registered_at, 'active'
          FROM drivers
          WHERE bus_id IS NOT NULL AND company_id IS NOT NULL;
        `);
      },
    },
    {
      version: 6,
      apply: () => {
        ensureColumn(d, 'buses', 'visible', 'INTEGER NOT NULL DEFAULT 1');
        d.exec(`
          CREATE TABLE IF NOT EXISTS empresas (
            company_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS empresa_admins (
            admin_id TEXT PRIMARY KEY,
            company_id TEXT NOT NULL,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (company_id) REFERENCES empresas(company_id)
          );
        `);
        const now = Date.now();
        d.prepare(`
          INSERT OR IGNORE INTO empresas (company_id, name, created_at)
          SELECT DISTINCT company_id, 'Terminal Central' AS name, ? AS created_at
          FROM buses WHERE company_id IS NOT NULL
          UNION
          SELECT DISTINCT company_id, 'Terminal Central' AS name, ? AS created_at
          FROM drivers WHERE company_id IS NOT NULL
        `).run(now, now);
      },
    },
    {
      version: 7,
      apply: () => {
        ensureColumn(d, 'buses', 'route_id', 'TEXT');
        const plates = [
          'SFA-482', 'TUH-513', 'LKA-794', 'RQT-106', 'DMV-238',
          'WNP-659', 'JCB-871', 'PGX-340', 'HLF-925', 'XRD-617',
          'MNP-083', 'TKG-462', 'VLC-579', 'BDR-214', 'QWF-731',
        ];
        d.exec(`
          UPDATE buses SET route_id = (
            SELECT route_id FROM turn_assignments ta
            WHERE ta.bus_id = buses.bus_id AND ta.status = 'active'
            LIMIT 1
          ) WHERE route_id IS NULL;
          UPDATE buses SET route_id = (
            SELECT route_id FROM positions p
            WHERE p.bus_id = buses.bus_id
            LIMIT 1
          ) WHERE route_id IS NULL;
        `);
        const rows = d.prepare('SELECT bus_id FROM buses WHERE plate_number IS NULL OR plate_number = \'\'').all() as { bus_id: string }[];
        const assign = d.prepare('UPDATE buses SET plate_number = ?, updated_at = ? WHERE bus_id = ?');
        let i = 0;
        for (const row of rows) {
          assign.run(plates[i % plates.length], Date.now(), row.bus_id);
          i += 1;
        }
      },
    },
    {
      version: 8,
      apply: () => {
        ensureColumn(d, 'buses', 'interno', 'TEXT');
        d.exec(`
          CREATE TABLE IF NOT EXISTS company_routes (
            company_id TEXT NOT NULL,
            route_id TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (company_id, route_id)
          );
        `);
        const routeNames: Record<string, string> = {
          'R-101': 'Tcherassi',
          'R-102': 'Carrera 14 - Silencio',
          'R-103': 'Vivero Paraíso',
          'R-104': 'Carrera 50 - Paraiso',
          'R-105': 'Carrera 54 - Uninorte',
          'R-106': 'Calle 72 - Uninorte',
          '101': 'Tcherassi',
          '102': 'Carrera 14 - Silencio',
          '103': 'Vivero Paraíso',
        };
        const derived = d.prepare(`
          SELECT b.company_id AS company_id, COALESCE(p.route_id, b.route_id) AS route_id
          FROM buses b
          LEFT JOIN positions p ON p.bus_id = b.bus_id
          WHERE COALESCE(p.route_id, b.route_id) IS NOT NULL
        `).all() as { company_id: string; route_id: string }[];
        const insertRoute = d.prepare(`
          INSERT OR IGNORE INTO company_routes (company_id, route_id, name, created_at)
          VALUES (?, ?, ?, ?)
        `);
        const now = Date.now();
        for (const row of derived) {
          insertRoute.run(
            row.company_id,
            row.route_id,
            routeNames[row.route_id] ?? `Ruta ${row.route_id}`,
            now,
          );
        }
        const setCompanyName = d.prepare(
          'UPDATE empresas SET name = ? WHERE company_id = ? AND (name IS NULL OR name GLOB \'[0-9]*\')',
        );
        setCompanyName.run('Terminal Central', 'EMP-01');
        const buses = d.prepare('SELECT bus_id, company_id FROM buses ORDER BY bus_id ASC')
          .all() as { bus_id: string; company_id: string }[];
        const counters = new Map<string, number>();
        const setInterno = d.prepare(
          'UPDATE buses SET interno = ?, updated_at = ? WHERE bus_id = ?',
        );
        for (const bus of buses) {
          const next = (counters.get(bus.company_id) ?? 0) + 1;
          counters.set(bus.company_id, next);
          setInterno.run(String(next).padStart(3, '0'), Date.now(), bus.bus_id);
        }
      },
    },
    {
      version: 9,
      apply: () => {
        const sobusaRoutes: [string, string][] = [
          ['R-101', 'Tcherassi'],
          ['R-102', 'Carrera 14 - Silencio'],
          ['R-103', 'Vivero Paraíso'],
          ['R-104', 'Carrera 50 - Paraiso'],
          ['R-105', 'Carrera 54 - Uninorte'],
          ['R-106', 'Calle 72 - Uninorte'],
        ];
        const now = Date.now();
        d.prepare('DELETE FROM company_routes WHERE company_id = \'EMP-01\'').run();
        const insert = d.prepare(
          'INSERT INTO company_routes (company_id, route_id, name, created_at) VALUES (?, ?, ?, ?)',
        );
        for (const [routeId, name] of sobusaRoutes) {
          insert.run('EMP-01', routeId, name, now);
        }
      },
    },
    {
      version: 10,
      apply: () => {
        const companies = d.prepare(
          'SELECT DISTINCT company_id FROM buses WHERE route_id IS NULL OR route_id = \'\'',
        ).all() as { company_id: string }[];
        const firstRoute = d.prepare(
          'SELECT route_id FROM company_routes WHERE company_id = ? ORDER BY route_id ASC LIMIT 1',
        );
        const assign = d.prepare(
          'UPDATE buses SET route_id = ?, updated_at = ? WHERE company_id = ? AND (route_id IS NULL OR route_id = \'\')',
        );
        for (const company of companies) {
          const row = firstRoute.get(company.company_id) as { route_id: string } | undefined;
          if (row) {
            assign.run(row.route_id, Date.now(), company.company_id);
          }
        }
      },
    },
    {
      version: 11,
      apply: () => {
        ensureColumn(d, 'company_routes', 'terminal_a', 'TEXT');
        ensureColumn(d, 'company_routes', 'terminal_b', 'TEXT');
        const endpoints: Record<string, [string, string]> = {
          'R-101': ['Terminal Central', 'Tcherassi'],
          'R-102': ['Carrera 14', 'Silencio'],
          'R-103': ['Terminal Central', 'Vivero Paraíso'],
          'R-104': ['Carrera 50', 'Paraiso'],
          'R-105': ['Carrera 54', 'Uninorte'],
          'R-106': ['Calle 72', 'Uninorte'],
        };
        const now = Date.now();
        d.prepare('UPDATE empresas SET name = \'Sobusa\', created_at = ? WHERE company_id = \'EMP-01\' AND name = \'Terminal Central\'').run(now);
        const setEndpoints = d.prepare(
          'UPDATE company_routes SET terminal_a = ?, terminal_b = ? WHERE company_id = ? AND route_id = ?',
        );
        for (const [routeId, [terminalA, terminalB]] of Object.entries(endpoints)) {
          setEndpoints.run(terminalA, terminalB, 'EMP-01', routeId);
        }
        setEndpoints.run('Centro', 'Soledad', 'EMP-02', 'R-101');
      },
    },
  ];

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    const applyMigration = d.transaction(() => {
      migration.apply();
      d.prepare(
        'INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)',
      ).run(migration.version, Date.now());
    });
    applyMigration();
  }
}

function ensureColumn(
  d: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((item) => item.name === column)) return;
  d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
