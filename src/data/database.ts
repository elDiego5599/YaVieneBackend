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
          SELECT DISTINCT company_id, ? AS name, ? AS created_at
          FROM buses WHERE company_id IS NOT NULL
          UNION
          SELECT DISTINCT company_id, ? AS name, ? AS created_at
          FROM drivers WHERE company_id IS NOT NULL
        `).run(now, now, now, now);
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
