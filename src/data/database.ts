import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DB_DIR, 'yaviene.db');

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
  `);

  ensureColumn(d, 'drivers', 'driver_id', 'TEXT');
  ensureColumn(d, 'drivers', 'company_id', 'TEXT');
  ensureColumn(d, 'drivers', 'bus_id', 'TEXT');
  ensureColumn(d, 'drivers', 'pin_hash', 'TEXT');
  ensureColumn(d, 'positions', 'session_id', 'TEXT');

  d.exec(`
    UPDATE drivers
    SET driver_id = phone_number
    WHERE driver_id IS NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_drivers_driver_id
    ON drivers(driver_id)
    WHERE driver_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_positions_session_id
    ON positions(session_id);
  `);
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
