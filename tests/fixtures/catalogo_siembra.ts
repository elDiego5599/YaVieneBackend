// Abre (o crea) la base de YA_VIENE_DB_PATH con el entorno que le pasen y
// escribe en stdout lo que la siembra decide: empresas, catálogo de rutas y
// migraciones aplicadas. Lo usa `siembra.test.ts`: la ruta de la base se lee
// al cargar `database.ts`, así que cada base necesita su propio proceso.
import { closeDb, getDb } from '../../src/data/database';

const db = getDb();
const salida = {
  empresas: db.prepare('SELECT company_id, name FROM empresas ORDER BY company_id').all(),
  rutas: db.prepare(`
    SELECT company_id, route_id, name, terminal_a, terminal_b
    FROM company_routes ORDER BY route_id
  `).all(),
  migraciones: (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as
    Array<{ version: number }>).map((fila) => fila.version),
};
closeDb();
process.stdout.write(JSON.stringify(salida));
