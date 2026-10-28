import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { siembraDemoHabilitada } from '../config';

const DB_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = process.env.YA_VIENE_DB_PATH || path.join(DB_DIR, 'yaviene.db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }
    const abierta = new Database(DB_PATH);
    revisarIntegridad(abierta);
    db = abierta;
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    initSchema();
    db.prepare(`
      UPDATE device_sessions SET client_id = NULL WHERE status = 'active'
    `).run();
    console.log(`[DB] SQLite abierta en ${DB_PATH} (WAL mode)`);
  }
  return db;
}

/**
 * SQLite abre sin quejarse un archivo con la cabecera sana y páginas rotas
 * (un apagón a mitad de escritura, un disco que falla): el daño aparecía
 * después, en la primera consulta que tocara esa página, con el servidor ya
 * aceptando buses. `quick_check` recorre la base entera al abrir —en la de
 * hoy (3,6 MB) son milisegundos— y si algo no cuadra el arranque se detiene
 * diciendo qué hacer. Un archivo que ni siquiera es una base lanza en vez de
 * devolver texto, y se trata igual.
 *
 * No todo lo que hace fallar la revisión es daño: otro proceso con la base
 * bloqueada, los permisos o un disco lleno también la tumban con el archivo
 * sano, y mandar a restaurar el backup ahí perdía lo escrito desde la última
 * copia. Por eso solo `SQLITE_CORRUPT` y `SQLITE_NOTADB`, además del texto
 * que devuelve `quick_check`, cuentan como base dañada.
 */
function revisarIntegridad(d: Database.Database): void {
  let estado: unknown;
  try {
    estado = d.pragma('quick_check', { simple: true });
  } catch (error) {
    const codigo = (error as { code?: unknown } | null)?.code;
    const esDanio = typeof codigo === 'string'
      && (codigo.startsWith('SQLITE_CORRUPT') || codigo === 'SQLITE_NOTADB');
    if (!esDanio) {
      d.close();
      const detalle = error instanceof Error ? error.message : String(error);
      throw new Error(
        `No se pudo revisar la base ${DB_PATH} (${String(codigo ?? 'sin código')}: ${detalle}). `
        + 'Eso no dice que el archivo tenga daño: revisa que otro proceso no la tenga bloqueada, '
        + 'los permisos y el espacio en disco, y vuelve a arrancar. No restaures el backup por esto.',
      );
    }
    estado = String(error);
  }
  if (estado === 'ok') return;
  d.close();
  throw new Error(
    `La base ${DB_PATH} está dañada (${String(estado)}). Restaura el último backup `
    + '(scripts/backup-db.mjs) y vuelve a arrancar.',
  );
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
      heading REAL,
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
      tipologia TEXT NOT NULL DEFAULT 'SENCILLO',
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
  // `siembra`: la migración solo mete datos de Sobusa (ni tablas ni
  // columnas). Con la siembra apagada se salta SIN registrarse, así que
  // encenderla después las corre en su orden (9 → 12 → 16) y la base queda
  // igual que si hubiera nacido sembrada. Las rutas R-101…R-106 están
  // reservadas (`routes_store.ts`), así que ninguna empresa puede ocuparlas
  // mientras tanto y chocar con el índice único de la migración 20.
  const sembrar = siembraDemoHabilitada();
  const migrations: { version: number; siembra?: true; apply: () => void }[] = [
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
            tipologia TEXT NOT NULL DEFAULT 'SENCILLO',
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
          // Sin guion, como las de verdad y como las valida `normalizePlaca`.
          'SFA482', 'TUH513', 'LKA794', 'RQT106', 'DMV238',
          'WNP659', 'JCB871', 'PGX340', 'HLF925', 'XRD617',
          'MNP083', 'TKG462', 'VLC579', 'BDR214', 'QWF731',
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
      siembra: true,
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
        // Sin efecto en ninguna base conocida: EMP-02 nunca tuvo R-101 en su
        // catálogo (la migración 20 hace además `route_id` único y R-101 es
        // de EMP-01). Se deja porque esta migración ya está aplicada en todas
        // las bases vivas y editarla no cambiaría nada (T9.3).
        setEndpoints.run('Centro', 'Soledad', 'EMP-02', 'R-101');
      },
    },
    {
      version: 12,
      siembra: true,
      apply: () => {
        // Catálogo real de Sobusa (códigos de servicio desde los KMZ oficiales).
        const sobusa: Record<string, [string, string, string]> = {
          'R-101': ['B18 Tcherassi', 'Ciudad Mallorquín', 'La Playa'],
          'R-102': ['C11 Silencio', 'Nevada', 'El Silencio'],
          'R-103': ['C12 Vivero Paraíso', 'Vía 40', 'Paraíso'],
          'R-104': ['C13 Carrera 50 Paraíso', 'Nevada (Soledad)', 'Calle 76 (Vía 40)'],
          'R-105': ['C14 Carrera 54 Uninorte', 'Granabastos', 'Uninorte'],
          'R-106': ['C16 Calle 72 Uninorte', 'Granabastos', 'Uninorte'],
        };
        const upsert = d.prepare(`
          INSERT INTO company_routes (company_id, route_id, name, terminal_a, terminal_b, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (company_id, route_id) DO UPDATE SET
            name = excluded.name,
            terminal_a = excluded.terminal_a,
            terminal_b = excluded.terminal_b
        `);
        const now = Date.now();
        for (const [routeId, [name, terminalA, terminalB]] of Object.entries(sobusa)) {
          upsert.run('EMP-01', routeId, name, terminalA, terminalB, now);
        }
      },
    },
    {
      version: 13,
      apply: () => {
        // Sentido de marcha reportado por el bus ("ida"/"venida"): la app lo
        // usa para el ETA sin adivinar por el rumbo (rutas con subida/giro
        // confunden el heading). Null = dispositivo antiguo, se asume ida.
        ensureColumn(d, 'positions', 'sentido', 'TEXT');
      },
    },
    {
      version: 14,
      apply: () => {
        // Dead-letter del outbox: un evento que falla MAX_ATTEMPTS veces se
        // marca con dead_at y deja de reclamarse (antes un evento venenoso
        // reintenteaba cada 250 ms para siempre). El índice de created_at
        // hace barata la purga de entregados y muertos.
        ensureColumn(d, 'lifecycle_events', 'dead_at', 'INTEGER');
        d.exec(
          'CREATE INDEX IF NOT EXISTS idx_lifecycle_created ON lifecycle_events(created_at)',
        );
      },
    },
    {
      version: 15,
      apply: () => {
        // Métricas persistidas: los contadores sobreviven al reinicio.
        // Sin esto, cada deploy borraba la única señal operativa que
        // teníamos de aceptación/rechazo de posiciones y autenticación.
        d.exec(`
          CREATE TABLE IF NOT EXISTS metrics (
            name TEXT PRIMARY KEY,
            value INTEGER NOT NULL
          )
        `);
      },
    },
    {
      version: 16,
      siembra: true,
      apply: () => {
        // Sobusa nunca se insertó en `empresas`: las migraciones 8 y 11 solo
        // la ACTUALIZAN ("SET name = 'Terminal Central'", "SET name =
        // 'Sobusa'"), y el catálogo de rutas se sembraba aparte en
        // company_routes. En un portátil que ya se usó eso no se nota,
        // porque ensureEmpresa creó la fila en algún momento y los UPDATE
        // encontraron a quién actualizar. Sobre una base nueva —que es
        // exactamente lo que hay en un volumen recién creado en Fly— los dos
        // UPDATE no tocan nada, `empresas` queda vacía y GET /api/companies
        // devuelve []: el pasajero abre la app y el selector de empresa no
        // tiene ninguna que elegir, aunque las rutas sí estén sembradas.
        d.prepare(`
          INSERT INTO empresas (company_id, name, created_at)
          VALUES ('EMP-01', 'Sobusa', ?)
          ON CONFLICT(company_id) DO UPDATE SET name = 'Sobusa'
        `).run(Date.now());
      },
    },
    {
      version: 17,
      apply: () => {
        eliminarEmpresasFantasma(d);
      },
    },
    {
      version: 18,
      apply: () => {
        // Una placa es de un solo bus. El alta ya lo comprobaba contra otras
        // empresas, pero la edición no miraba nada: cambiarle la placa a un
        // bus por la de otro dejaba dos filas con la misma, y el pasajero
        // leía «Bus SQA223» en dos puntos del mapa. El índice lo cierra en
        // la base, que es el único sitio donde no hay carrera posible.
        //
        // Antes de crearlo hay que deshacer los repetidos que ya existan, o
        // el CREATE falla y el backend no arranca. El relleno de la
        // migración 7 reparte placas en ciclo sobre una lista de diez, así
        // que una base con más de diez buses sin placa las tiene. Se queda
        // la placa el bus cuyo id sale de ella (BUS-SQA223 para SQA223),
        // que es el que dio de alta el panel; si ninguno, el más antiguo.
        // Los demás pierden la placa y el panel les enseña el id, que es lo
        // que ya hace con cualquier bus sin placa.
        const repetidas = d.prepare(`
          SELECT plate_number FROM buses
          WHERE plate_number IS NOT NULL
          GROUP BY plate_number HAVING COUNT(*) > 1
        `).all() as { plate_number: string }[];
        const duenos = d.prepare(`
          SELECT bus_id FROM buses WHERE plate_number = ?
          ORDER BY (bus_id = 'BUS-' || replace(plate_number, '-', '')) DESC,
                   created_at ASC, bus_id ASC
        `);
        const soltar = d.prepare(
          'UPDATE buses SET plate_number = NULL, updated_at = ? WHERE bus_id = ?',
        );
        for (const { plate_number } of repetidas) {
          const [, ...sobran] = duenos.all(plate_number) as { bus_id: string }[];
          for (const { bus_id } of sobran) soltar.run(Date.now(), bus_id);
        }
        d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_buses_plate ON buses(plate_number)');

        // Posiciones de buses que ya no están en el catálogo: las dejaba
        // `deleteBus` cuando el teléfono seguía publicando después del
        // borrado, y el LEFT JOIN de la lectura pública las enseñaba como
        // buses sin empresa. `upsertPosition` ya no las crea; éstas son las
        // que quedaron de antes.
        d.exec('DELETE FROM positions WHERE bus_id NOT IN (SELECT bus_id FROM buses)');
      },
    },
    {
      version: 19,
      apply: () => {
        // Versión de la credencial del panel. Va dentro del token (`tv`) y
        // la sube cada cambio de contraseña, para que cambiar la clave eche
        // a quien entró con la anterior; antes el token seguía valiendo sus
        // 8 horas. Todas las cuentas arrancan en 0. Los tokens emitidos
        // antes de esto no traen `tv` y dejan de validar: cada panel abierto
        // pide entrar una vez después de desplegar.
        ensureColumn(d, 'empresa_admins', 'token_version', 'INTEGER NOT NULL DEFAULT 0');
      },
    },
    {
      version: 20,
      apply: () => {
        // Un código de ruta es de una sola empresa. La sala del pasajero
        // (`route:{id}`) y la consulta de posiciones van por identificador a
        // secas: con R-001 en dos empresas, los pasajeros de una veían los
        // buses de la otra. La clave (empresa, ruta) no lo impedía.
        //
        // Si la base ya trae el choque, no se arregla sola: decidir de quién
        // es la ruta es cosa de una persona. El arranque se detiene con la
        // lista y no crea el índice a medias.
        const repetidas = d.prepare(`
          SELECT route_id, GROUP_CONCAT(company_id, ', ') AS empresas
          FROM company_routes
          GROUP BY route_id
          HAVING COUNT(DISTINCT company_id) > 1
          ORDER BY route_id
        `).all() as { route_id: string; empresas: string }[];
        if (repetidas.length > 0) {
          const lista = repetidas.map((r) => `${r.route_id} (${r.empresas})`).join('; ');
          throw new Error(
            `Hay códigos de ruta en más de una empresa: ${lista}. Deja cada código en una `
            + 'sola empresa (renombra o borra la de sobra en company_routes) y vuelve a arrancar.',
          );
        }
        d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_company_routes_route_id ON company_routes(route_id)');
      },
    },
    {
      version: 21,
      apply: () => {
        // El rumbo que falta se guarda como NULL. La columna era NOT NULL
        // DEFAULT 0, y un rumbo que no llegaba (el equipo no lo manda, o la
        // validación lo descarta por estar fuera de [0, 360)) quedaba en 0,
        // que es el norte: el mapa dibujaba el bus apuntando hacia arriba.
        // SQLite no quita un NOT NULL con ALTER TABLE, así que la tabla se
        // rehace con las mismas filas y los mismos índices. Los ceros que ya
        // había se quedan: no hay forma de saber cuáles eran norte de verdad.
        const columnas = d.prepare('PRAGMA table_info(positions)').all() as {
          name: string;
          notnull: number;
        }[];
        if (columnas.find((c) => c.name === 'heading')?.notnull !== 1) return;
        const lista = [
          'bus_id', 'route_id', 'lat', 'lon', 'heading', 'speed_kmh', 'timestamp',
          'driver_phone', 'session_id', 'captured_at', 'sequence', 'is_ghost', 'sentido',
        ];
        // Una columna que esta lista no conoce se perdería al copiar: mejor
        // no arrancar que tirar datos sin avisar.
        const extra = columnas.map((c) => c.name).filter((nombre) => !lista.includes(nombre));
        if (extra.length > 0) {
          throw new Error(`positions trae columnas que la migración 21 no conoce: ${extra.join(', ')}`);
        }
        const indices = d.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'positions' AND sql IS NOT NULL",
        ).all() as { sql: string }[];
        d.exec(`
          CREATE TABLE positions_nueva (
            bus_id TEXT PRIMARY KEY,
            route_id TEXT NOT NULL,
            lat REAL NOT NULL,
            lon REAL NOT NULL,
            heading REAL,
            speed_kmh REAL NOT NULL DEFAULT 0,
            timestamp INTEGER NOT NULL,
            driver_phone TEXT NOT NULL,
            session_id TEXT,
            captured_at INTEGER,
            sequence INTEGER,
            is_ghost INTEGER NOT NULL DEFAULT 0,
            sentido TEXT,
            FOREIGN KEY (driver_phone) REFERENCES drivers(phone_number) ON DELETE CASCADE
          );
          INSERT INTO positions_nueva (${lista.join(', ')}) SELECT ${lista.join(', ')} FROM positions;
          DROP TABLE positions;
          ALTER TABLE positions_nueva RENAME TO positions;
        `);
        for (const { sql } of indices) d.exec(sql);
      },
    },
    {
      version: 22,
      apply: () => {
        // Índices para las consultas que corren todo el tiempo y recorrían la
        // tabla entera. Con la flota demo no se nota; con una flota real cada
        // recorrido crece con ella, y varias de estas corren por cada
        // suscripción o cada vuelta de un barrido:
        //
        // - `buses(company_id, route_id)`: el panel pide su flota, sus rutas y
        //   el borrado de una ruta por empresa (y por ruta dentro de ella).
        //   Sin índice cada pedido del panel leía los buses de todas las
        //   empresas para quedarse con los suyos.
        // - `buses(route_id)`: `routeExists` corre en cada `subscribe:route`
        //   del pasajero; la parte de buses era la única de las tres que no
        //   tenía índice por ruta.
        // - `lifecycle_events(dead_at)` y `driver_sessions(revoked_at)`: las
        //   purgas periódicas. Son parciales porque solo miran las filas
        //   muertas o revocadas, que son pocas; las vivas no pagan el índice
        //   al escribirse.
        // - `turn_assignments(bus_id)`: borrar un bus borra sus turnos, todos
        //   y no solo el activo, y el índice parcial de los activos no sirve
        //   para eso.
        //
        // La prueba de `fleet_store.test.ts` pasa estas consultas por EXPLAIN
        // QUERY PLAN: si una vuelve a recorrer la tabla, falla.
        d.exec(`
          CREATE INDEX IF NOT EXISTS idx_buses_company_route
            ON buses(company_id, route_id);
          CREATE INDEX IF NOT EXISTS idx_buses_route
            ON buses(route_id);
          CREATE INDEX IF NOT EXISTS idx_lifecycle_dead
            ON lifecycle_events(dead_at) WHERE dead_at IS NOT NULL;
          CREATE INDEX IF NOT EXISTS idx_sessions_revoked
            ON driver_sessions(revoked_at) WHERE status = 'revoked';
          CREATE INDEX IF NOT EXISTS idx_assignments_bus
            ON turn_assignments(bus_id);
        `);
      },
    },
    {
      version: 23,
      apply: () => {
        // Tipología del bus para el aforo por % (SENCILLO | PADRON |
        // ARTICULADO) y adopción de `capacity` como aforo por bus. La
        // columna `capacity` existía desde la migración 5 pero nadie la
        // escribía ni la leía: todo bus valía 40. El DEFAULT 'SENCILLO'
        // rellena las filas viejas sin backfill; `capacity` ya trae su
        // propio DEFAULT 40. La lista cerrada se valida en la API, no aquí.
        ensureColumn(d, 'buses', 'tipologia', "TEXT NOT NULL DEFAULT 'SENCILLO'");
        ensureColumn(d, 'buses', 'capacity', 'INTEGER NOT NULL DEFAULT 40');
      },
    },
    {
      version: 24,
      apply: () => {
        // Avisos de «tu bus está cerca» que el servidor manda por FCM cuando
        // la app del pasajero ya no puede (cerrada o dormida). Ver
        // `avisos_push.ts` y docs/decisiones/D13. Cada fila vive como mucho
        // tres horas (`vence`) y guarda un token de FCM y el punto donde el
        // pasajero armó el aviso: lo justo para avisar y nada más.
        // `vigilado_hasta` era el arriendo que renovaba la app viva; la
        // migración 25 lo quita.
        // `enviado_en` queda escrito hasta `vence` para responder 410 al
        // latido de una app que vuelve y no sabe que ya se avisó.
        d.exec(`
          CREATE TABLE IF NOT EXISTS avisos_push (
            id TEXT PRIMARY KEY,
            token TEXT NOT NULL,
            bus_id TEXT NOT NULL,
            route_id TEXT NOT NULL,
            lat REAL NOT NULL,
            lon REAL NOT NULL,
            creado INTEGER NOT NULL,
            vence INTEGER NOT NULL,
            vigilado_hasta INTEGER NOT NULL,
            enviado_en INTEGER
          );
          CREATE INDEX IF NOT EXISTS idx_avisos_push_bus ON avisos_push(bus_id);
          CREATE INDEX IF NOT EXISTS idx_avisos_push_token ON avisos_push(token);
        `);
      },
    },
    {
      version: 25,
      apply: () => {
        // El servidor vigila los avisos desde que se arman, sin esperar a que
        // venza el arriendo de la app: con la app recién cerrada el aviso
        // llegaba un minuto tarde (dueño, 2026-10-02). Ver D13.
        d.exec('ALTER TABLE avisos_push DROP COLUMN vigilado_hasta');
      },
    },
    {
      version: 26,
      apply: () => {
        // El buzón de problemas y sugerencias del pasajero (D14). Cada fila
        // espera aquí hasta que el correo sale y entonces se borra: la base
        // no guarda los reportes, solo los que aún no llegan al equipo.
        d.exec(`
          CREATE TABLE IF NOT EXISTS reportes (
            id TEXT PRIMARY KEY,
            tipo TEXT NOT NULL CHECK (tipo IN ('problema', 'sugerencia')),
            texto TEXT NOT NULL,
            plataforma TEXT,
            version TEXT,
            creado INTEGER NOT NULL,
            intentos INTEGER NOT NULL DEFAULT 0,
            proximo_intento INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_reportes_proximo ON reportes(proximo_intento);
        `);
      },
    },
    {
      version: 27,
      siembra: true,
      apply: () => {
        // Coolitoral y sus cuatro rutas (dueño, 2026-10-05). Los trazados
        // están en `rutas.json` con estos mismos identificadores
        // (`scripts/convert-rutas.mjs`, desde los GPX de la empresa). Si
        // otra empresa ya usa uno de ellos, heredaría en el mapa el trazado
        // de Coolitoral: mejor no arrancar y decirlo que mezclar recorridos.
        const coolitoral: Record<string, [string, string, string]> = {
          'R-107': ['A1 Silencio Universidades', 'Silencio, Nogales', 'Universidades, Vía 40'],
          'R-108': ['A2 Universidades Silencio', 'Vía 40, Universidades', 'Nogales, Silencio'],
          'R-109': ['A3 Carrera 43 Peñita', 'Carrera 43', 'La Peñita'],
          'R-110': ['A4 Carrera 50', 'Calle 17', 'Carrera 50'],
        };
        const ocupadas = d.prepare(`
          SELECT route_id FROM company_routes
          WHERE route_id IN ('R-107', 'R-108', 'R-109', 'R-110') AND company_id <> 'EMP-03'
        `).all() as { route_id: string }[];
        if (ocupadas.length > 0) {
          throw new Error(
            `Las rutas ${ocupadas.map((r) => r.route_id).join(', ')} ya son de otra empresa: `
            + 'cámbiales el identificador antes de sembrar Coolitoral (migración 27).',
          );
        }
        const now = Date.now();
        d.prepare(`
          INSERT INTO empresas (company_id, name, created_at)
          VALUES ('EMP-03', 'Coolitoral', ?)
          ON CONFLICT(company_id) DO UPDATE SET name = 'Coolitoral'
        `).run(now);
        const upsert = d.prepare(`
          INSERT INTO company_routes (company_id, route_id, name, terminal_a, terminal_b, created_at)
          VALUES ('EMP-03', ?, ?, ?, ?, ?)
          ON CONFLICT (company_id, route_id) DO UPDATE SET
            name = excluded.name,
            terminal_a = excluded.terminal_a,
            terminal_b = excluded.terminal_b
        `);
        for (const [routeId, [name, terminalA, terminalB]] of Object.entries(coolitoral)) {
          upsert.run(routeId, name, terminalA, terminalB, now);
        }
      },
    },
    {
      version: 28,
      siembra: true,
      apply: () => {
        // Coolitoral sin A2 (R-108; dueño, 2026-10-05): era el mismo
        // recorrido que A1. Sale de su catálogo con los dos buses de la
        // demo y todo lo suyo. Un bus del panel que estuviera en A2 no se
        // borra: se muda a la primera ruta que le quede a la empresa, como
        // al quitar una ruta desde el panel (`removeCompanyRoute`). El
        // número no se reusa: las apps instaladas aún dibujan A2 con él.
        const demo = ['BUS-YVA108', 'BUS-YVB108'];
        const porBus = [
          'DELETE FROM avisos_push WHERE bus_id = ?',
          'DELETE FROM turn_assignments WHERE bus_id = ?',
          'DELETE FROM driver_sessions WHERE bus_id = ?',
          'DELETE FROM positions WHERE bus_id = ?',
          'DELETE FROM drivers WHERE bus_id = ?',
          'DELETE FROM buses WHERE bus_id = ?',
        ].map((sql) => d.prepare(sql));
        for (const busId of demo) {
          for (const stmt of porBus) stmt.run(busId);
        }

        d.prepare("DELETE FROM company_routes WHERE company_id = 'EMP-03' AND route_id = 'R-108'").run();
        const destino = (d.prepare(`
          SELECT route_id FROM company_routes WHERE company_id = 'EMP-03' ORDER BY route_id ASC LIMIT 1
        `).get() as { route_id: string } | undefined)?.route_id ?? null;
        const ajenos = `SELECT bus_id FROM buses WHERE company_id = 'EMP-03'`;
        if (destino) {
          for (const tabla of ['turn_assignments', 'driver_sessions', 'positions', 'avisos_push']) {
            d.prepare(`UPDATE ${tabla} SET route_id = ? WHERE route_id = 'R-108' AND bus_id IN (${ajenos})`)
              .run(destino);
          }
          d.prepare(`UPDATE drivers SET route_id = ? WHERE route_id = 'R-108' AND company_id = 'EMP-03'`)
            .run(destino);
        }
        d.prepare(`UPDATE buses SET route_id = ?, updated_at = ? WHERE company_id = 'EMP-03' AND route_id = 'R-108'`)
          .run(destino, Date.now());
      },
    },
    {
      version: 29,
      apply: () => {
        // La distancia del aviso la elige el pasajero (500 m a 3 km; dueño,
        // 2026-10-06). Los avisos que ya estaban armados se armaron a 1 km.
        ensureColumn(d, 'avisos_push', 'radio_m', 'INTEGER NOT NULL DEFAULT 1000');
      },
    },
    {
      version: 30,
      apply: () => {
        // La lista de «Avísame cuando salga» de la web (D15): el celular,
        // cuándo aceptó y qué versión del texto. Nada más.
        d.exec(`
          CREATE TABLE IF NOT EXISTS lanzamiento (
            telefono TEXT PRIMARY KEY,
            aceptado INTEGER NOT NULL,
            autorizacion INTEGER NOT NULL
          )
        `);
      },
    },
    {
      version: 31,
      apply: () => {
        // Mantiene la última fracción de ruta proyectada. Un punto de una
        // ruta circular puede estar físicamente en el mismo terminal al salir
        // y al llegar; sin progreso persistido un reinicio no puede distinguirlos.
        ensureColumn(d, 'positions', 'route_fraction', 'REAL');
      },
    },
    {
      version: 32,
      apply: () => {
        // El rumbo efectivo puede inferirse de fracciones sucesivas aunque
        // el equipo no mande `sentido`; se conserva para reconstruir loops.
        ensureColumn(d, 'positions', 'route_direction', 'TEXT');
      },
    },
    {
      version: 33,
      apply: () => {
        // Distingue el ocultamiento automático por terminal del apagado
        // manual, para que la flota de empresa pueda mostrar su motivo.
        ensureColumn(d, 'buses', 'en_terminal', 'INTEGER NOT NULL DEFAULT 0');
      },
    },
    {
      version: 34,
      apply: () => {
        // Marca explícitamente los buses mantenidos por la flota simulada;
        // el ID BUS-<placa> también lo usan buses normales.
        ensureColumn(d, 'buses', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');
      },
    },
    {
      version: 35,
      apply: () => {
        d.exec(`
          CREATE TABLE gps_devices (
            device_id TEXT PRIMARY KEY,
            company_id TEXT NOT NULL,
            bus_id TEXT NOT NULL,
            identifier TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL CHECK (kind IN ('sim', 'imei', 'serial')),
            secret_hash TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            name TEXT,
            route_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (bus_id) REFERENCES buses(bus_id) ON DELETE CASCADE
          );
          INSERT INTO gps_devices (
            device_id, company_id, bus_id, identifier, kind, secret_hash,
            status, name, route_id, created_at, updated_at
          )
          SELECT d.driver_id, d.company_id, d.bus_id, d.phone_number, 'sim',
                 COALESCE(d.pin_hash, ''), 'active', d.name, d.route_id,
                 d.registered_at, d.registered_at
          FROM drivers d
          -- Un equipo asociado a un bus inexistente no se migra: gps_devices
          -- exige que bus_id apunte a un bus real.
          WHERE d.company_id IS NOT NULL AND d.bus_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM buses b WHERE b.bus_id = d.bus_id);

          CREATE TABLE device_sessions (
            session_id TEXT PRIMARY KEY,
            device_id TEXT NOT NULL,
            identifier TEXT NOT NULL,
            company_id TEXT NOT NULL,
            bus_id TEXT NOT NULL,
            route_id TEXT NOT NULL,
            client_id TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            created_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            revoked_at INTEGER
          );
          INSERT OR IGNORE INTO device_sessions (
            session_id, device_id, identifier, company_id, bus_id, route_id,
            client_id, status, created_at, last_seen_at, revoked_at
          )
          SELECT s.session_id, s.driver_id, s.phone_number, s.company_id,
                 s.bus_id, s.route_id, s.client_id, s.status, s.created_at,
                 s.last_seen_at, s.revoked_at
          FROM driver_sessions s;
          CREATE INDEX IF NOT EXISTS idx_device_sessions_bus_status
            ON device_sessions(bus_id, status);
          CREATE INDEX IF NOT EXISTS idx_device_sessions_device_status
            ON device_sessions(device_id, status);
          CREATE INDEX IF NOT EXISTS idx_device_sessions_revoked_at
            ON device_sessions(revoked_at) WHERE status = 'revoked';
        `);

        // Mantener todas las columnas que las migraciones posteriores añadieron
        // y recrear todos los índices de positions sin la FK al identificador.
        const columnas = (d.pragma('table_info(positions)') as { name: string }[]).map((c) => c.name);
        const indices = (d.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'positions' AND sql IS NOT NULL").all() as { sql: string }[]).map((r) => r.sql);
        const original = d.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'positions'").get() as { sql: string };
        const tablaNueva = original.sql
          .replace(/CREATE TABLE(?: IF NOT EXISTS)?\s+["']?positions["']?/i, 'CREATE TABLE positions_nueva')
          .replace(/driver_phone/g, 'device_id')
          .replace(/,?\s*FOREIGN KEY \(device_id\) REFERENCES drivers\(phone_number\) ON DELETE CASCADE/i, '');
        const destino = columnas.map((c) => `"${c === 'driver_phone' ? 'device_id' : c}"`).join(', ');
        const origen = columnas.map((c) => c === 'driver_phone'
          ? `COALESCE((SELECT driver_id FROM drivers WHERE phone_number = positions.driver_phone), positions.driver_phone)`
          : `"${c}"`).join(', ');
        d.exec(`
          ${tablaNueva};
          INSERT INTO positions_nueva (${destino}) SELECT ${origen} FROM positions;
          DROP TABLE positions;
          ALTER TABLE positions_nueva RENAME TO positions;
        `);
        for (const sql of indices) d.exec(sql);
      },
    },
    {
      version: 36,
      apply: () => d.exec(`
        CREATE TABLE busquedas (
          route_id TEXT NOT NULL,
          hora INTEGER NOT NULL,
          celda_key TEXT NOT NULL,
          celda_lat REAL,
          celda_lng REAL,
          count INTEGER NOT NULL CHECK (count > 0),
          CHECK ((celda_lat IS NULL) = (celda_lng IS NULL)),
          PRIMARY KEY (route_id, hora, celda_key)
        );
        CREATE INDEX idx_busquedas_hora ON busquedas(hora);
      `),
    },
    {
      version: 37,
      siembra: true,
      apply: () => {
        // Coochofal y sus seis rutas (dueño, 2026-10-28), igual que
        // Coolitoral en la 27: los trazados están en `rutas.json` con estos
        // identificadores (`scripts/convert-rutas.mjs`, desde los KMZ de la
        // empresa), y si otra empresa ya usa uno, heredaría en el mapa un
        // recorrido de Coochofal: mejor no arrancar y decirlo. Los nombres
        // salen de los barrios donde arranca y voltea cada circuito; los
        // oficiales los confirma el dueño (FALTANTES).
        const coochofal: Record<string, [string, string, string]> = {
          'R-111': ['A15 Soledad El Golf', 'Soledad, La Central', 'El Golf'],
          'R-112': ['C2 Villa Valery Centro', 'Villa Valery', 'Centro'],
          'R-113': ['C4 Villa Valery San Francisco', 'Villa Valery', 'San Francisco'],
          'R-114': ['C9 Villa Valery Santa Ana', 'Villa Valery', 'Santa Ana'],
          'R-115': ['C18 Villa Valery Santa Ana', 'Villa Valery', 'Santa Ana'],
          'R-116': ['D20 Villa Valery El Golf', 'Villa Valery', 'El Golf'],
        };
        const ids = Object.keys(coochofal);
        const ocupadas = d.prepare(`
          SELECT route_id FROM company_routes
          WHERE route_id IN (${ids.map(() => '?').join(', ')}) AND company_id <> 'EMP-04'
        `).all(...ids) as { route_id: string }[];
        if (ocupadas.length > 0) {
          throw new Error(
            `Las rutas ${ocupadas.map((r) => r.route_id).join(', ')} ya son de otra empresa: `
            + 'cámbiales el identificador antes de sembrar Coochofal (migración 37).',
          );
        }
        const now = Date.now();
        d.prepare(`
          INSERT INTO empresas (company_id, name, created_at)
          VALUES ('EMP-04', 'Coochofal', ?)
          ON CONFLICT(company_id) DO UPDATE SET name = 'Coochofal'
        `).run(now);
        const upsert = d.prepare(`
          INSERT INTO company_routes (company_id, route_id, name, terminal_a, terminal_b, created_at)
          VALUES ('EMP-04', ?, ?, ?, ?, ?)
          ON CONFLICT (company_id, route_id) DO UPDATE SET
            name = excluded.name,
            terminal_a = excluded.terminal_a,
            terminal_b = excluded.terminal_b
        `);
        for (const [routeId, [name, terminalA, terminalB]] of Object.entries(coochofal)) {
          upsert.run(routeId, name, terminalA, terminalB, now);
        }
      },
    },
  ];

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    if (migration.siembra && !sembrar) continue;
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

/**
 * Borra las empresas fantasma: filas de `empresas` cuyo `name` es literalmente
 * su propio `company_id`, sin cuenta de panel y sin haber reportado nunca una
 * posición.
 *
 * El caso que lo motiva es `EMP-02`, que en el selector del pasajero salía
 * ANTES que Sobusa porque `getEmpresas()` ordena por `name ASC` y "EMP-02" va
 * alfabéticamente delante de "Sobusa": lo primero que veía un usuario al abrir
 * la app era una empresa que no existe. Además tenía tres turnos `active` que
 * ocupaban el índice único `idx_active_assignment_bus`.
 *
 * De dónde salió: una versión vieja del registro de conductores llamaba a
 * `ensureEmpresa(companyId)` sin nombre, y `ensureEmpresa` usa el
 * identificador como nombre cuando no le dan uno. Ese camino ya no existe (la
 * única llamada que queda está en la ruta de crear admin, protegida por
 * ADMIN_API_KEY), así que esto limpia lo que quedó de entonces.
 *
 * La firma que se exige es deliberadamente estrecha para que no pueda llevarse
 * por delante una empresa de verdad: un nombre que sea igual al identificador
 * es la marca de haber nacido sin nombre, y una empresa real termina teniendo
 * cuenta de panel o posiciones.
 *
 * Devuelve los identificadores borrados.
 */
export function eliminarEmpresasFantasma(d: Database.Database): string[] {
  const fantasmas = d.prepare(`
    SELECT company_id FROM empresas
    WHERE name = company_id
      AND company_id NOT IN (SELECT company_id FROM empresa_admins)
      AND company_id NOT IN (
        SELECT b.company_id FROM buses b
        JOIN positions p ON p.bus_id = b.bus_id
      )
  `).all() as { company_id: string }[];

  // El orden deja sesiones, equipos y posiciones fuera antes de borrar los
  // buses; `positions` ya no depende del identificador del equipo y se limpia
  // por la flota propietaria.
  const tables = new Set((d.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  ).all() as { name: string }[]).map((row) => row.name));
  const deleteSql = [
    'turn_assignments', 'device_sessions', 'driver_sessions',
    'gps_devices', 'drivers',
  ].filter((table) => tables.has(table)).map((table) =>
    `DELETE FROM ${table} WHERE company_id = ?`,
  );
  if (tables.has('positions') && tables.has('buses')) {
    deleteSql.push('DELETE FROM positions WHERE bus_id IN (SELECT bus_id FROM buses WHERE company_id = ?)');
  }
  deleteSql.push('DELETE FROM buses WHERE company_id = ?');
  if (tables.has('company_routes')) deleteSql.push('DELETE FROM company_routes WHERE company_id = ?');
  deleteSql.push('DELETE FROM empresas WHERE company_id = ?');
  const borrar = deleteSql.map((sql) => d.prepare(sql));

  const borradas: string[] = [];
  for (const { company_id: companyId } of fantasmas) {
    for (const stmt of borrar) stmt.run(companyId);
    borradas.push(companyId);
    console.log(`[DB] Empresa fantasma ${companyId} eliminada`);
  }
  return borradas;
}
