/**
 * Crea o actualiza la cuenta de un admin de empresa para app_control.
 *
 * Uso:
 *   node scripts/crear-admin-empresa.mjs <companyId> <username> <password> [nombreEmpresa]
 *
 * Reemplaza el hardcodeo de admin/admin123: cada empresa real del piloto
 * recibe su propia cuenta corriendo esto, en vez de tocar la base a mano.
 */
import Database from 'better-sqlite3';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DB_PATH = process.env.YA_VIENE_DB_PATH || path.join(ROOT, 'data', 'yaviene.db');
const KEY_LENGTH = 64;

const MIN_PASSWORD = 12;

const [companyId, rawUsername, password, name] = process.argv.slice(2);
if (!companyId || !rawUsername || !password) {
  console.error('Uso: node scripts/crear-admin-empresa.mjs <companyId> <username> <password> [nombreEmpresa]');
  process.exit(1);
}

// El login normaliza el usuario a minúsculas antes de buscarlo; guardarlo
// de otra forma crea una cuenta que nunca puede entrar.
const username = rawUsername.trim().toLowerCase();

if (password.length < MIN_PASSWORD) {
  console.error(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres (el panel es la llave de toda la flota).`);
  process.exit(1);
}

function hashSecret(secret) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(secret, salt, KEY_LENGTH).toString('hex');
  return `${salt}:${hash}`;
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.prepare(`
  INSERT OR IGNORE INTO empresas (company_id, name, created_at)
  VALUES (?, ?, ?)
`).run(companyId, name ?? companyId, Date.now());

// Igual que createOrUpdateCompanyAdmin en el backend: cambiar la contraseña
// sube la versión de la credencial y los tokens de panel emitidos con la
// anterior dejan de valer. La columna la crea la migración 19 al arrancar el
// backend; si esta base todavía no la tiene, tampoco hay tokens con versión
// que invalidar y basta con cambiar el hash.
const conVersion = db.prepare('PRAGMA table_info(empresa_admins)').all()
  .some((columna) => columna.name === 'token_version');

db.prepare(`
  INSERT INTO empresa_admins (admin_id, company_id, username, password_hash, created_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(username) DO UPDATE SET
    company_id = excluded.company_id,
    password_hash = excluded.password_hash${conVersion ? ',\n    token_version = token_version + 1' : ''}
`).run(randomUUID(), companyId, username, hashSecret(password), Date.now());

db.close();
console.log(`[OK] Admin '${username}' listo para la empresa '${companyId}'.`);
