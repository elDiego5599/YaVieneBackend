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
    const abierta = new Database(DB_PATH);
    revisarIntegridad(abierta);
    db = abierta;
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
    {
      version: 12,
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

  // El orden importa: `positions` y `driver_sessions` tienen FOREIGN KEY a
  // `drivers(phone_number)` con ON DELETE CASCADE, así que los hijos salen
  // antes que sus padres y ningún borrado arrastra de más.
  const borrar = [
    'DELETE FROM turn_assignments WHERE company_id = ?',
    'DELETE FROM driver_sessions WHERE company_id = ?',
    'DELETE FROM drivers WHERE company_id = ?',
    'DELETE FROM buses WHERE company_id = ?',
    'DELETE FROM company_routes WHERE company_id = ?',
    'DELETE FROM empresas WHERE company_id = ?',
  ].map((sql) => d.prepare(sql));

  const borradas: string[] = [];
  for (const { company_id: companyId } of fantasmas) {
    for (const stmt of borrar) stmt.run(companyId);
    borradas.push(companyId);
    console.log(`[DB] Empresa fantasma ${companyId} eliminada`);
  }
  return borradas;
}
