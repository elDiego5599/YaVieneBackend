/**
 * Crea o actualiza la cuenta de un admin de empresa para app_control.
 *
 * Uso:
 *   node scripts/crear-admin-empresa.mjs <companyId> <username> - [nombreEmpresa]
 *
 * La contraseña no va en el argumento (auditoría 2026-09, P3-3): ahí queda
 * en el historial de la consola y se ve en `ps` mientras corre. El «-» en su
 * sitio dice «pídemela»: se lee de CLAVE_PANEL si está en el entorno, si no
 * de la entrada estándar —tecleada sin eco, o por una tubería—. Una
 * contraseña escrita en el argumento se rechaza sin tocar la base.
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

const USO = 'Uso: node scripts/crear-admin-empresa.mjs <companyId> <username> - [nombreEmpresa]';
const [companyId, rawUsername, marcaClave, name] = process.argv.slice(2);
if (!companyId || !rawUsername || !marcaClave) {
  console.error(USO);
  process.exit(1);
}
if (marcaClave !== '-') {
  console.error(
    'La contraseña no va en el argumento: queda en el historial y se ve en `ps`.\n'
    + 'Pon «-» en su sitio y tecléala cuando la pida (o pásala por la entrada estándar, o en CLAVE_PANEL).\n'
    + USO,
  );
  process.exit(1);
}

/** La contraseña: de CLAVE_PANEL, de una tubería, o tecleada sin eco. */
async function leerClave() {
  if (process.env.CLAVE_PANEL) return process.env.CLAVE_PANEL;
  if (!process.stdin.isTTY) {
    let datos = '';
    for await (const trozo of process.stdin) datos += trozo;
    return datos.split(/\r?\n/)[0];
  }
  process.stderr.write('Contraseña del panel (no se ve al teclear): ');
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let clave = '';
    const alTeclear = (trozo) => {
      for (const c of trozo) {
        if (c === '\r' || c === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', alTeclear);
          process.stderr.write('\n');
          resolve(clave);
          return;
        }
        if (c === '\u0003') {
          process.stdin.setRawMode(false);
          process.stderr.write('\n');
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') clave = clave.slice(0, -1);
        else clave += c;
      }
    };
    process.stdin.on('data', alTeclear);
    process.stdin.resume();
  });
}

const password = await leerClave();

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
