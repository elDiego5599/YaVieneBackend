/**
 * Borra la cuenta de un admin de empresa del panel (app_control).
 *
 * Uso:
 *   node scripts/borrar-admin-empresa.mjs <username>
 *
 * Hermano de crear-admin-empresa.mjs. Existe para no tocar la base a mano
 * —ni en el portátil ni dentro de `fly ssh console`— cuando hay que sacar
 * una cuenta, empezando por la de pruebas 'admin', que sigue viva sobre la
 * flota real de Sobusa (EMP-01).
 *
 * Antes de borrar la última cuenta de una empresa, avisa: quedarse sin
 * ninguna deja el panel de esa empresa sin forma de entrar.
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DB_PATH = process.env.YA_VIENE_DB_PATH || path.join(ROOT, 'data', 'yaviene.db');

const [rawUsername] = process.argv.slice(2);
if (!rawUsername) {
  console.error('Uso: node scripts/borrar-admin-empresa.mjs <username>');
  process.exit(1);
}

// El login normaliza a minúsculas antes de buscar; buscamos igual, para que
// 'Admin' y 'admin' se refieran a la misma cuenta.
const username = rawUsername.trim().toLowerCase();

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const admin = db.prepare(
  'SELECT admin_id, company_id FROM empresa_admins WHERE username = ?',
).get(username);

if (!admin) {
  console.error(`[NADA] No existe ningún admin llamado '${username}'.`);
  db.close();
  process.exit(1);
}

const { count } = db.prepare(
  'SELECT COUNT(*) AS count FROM empresa_admins WHERE company_id = ?',
).get(admin.company_id);

if (count === 1 && !process.env.FORZAR) {
  console.error(
    `[ALTO] '${username}' es el único admin de la empresa '${admin.company_id}'.\n` +
    '       Si lo borras, nadie puede entrar al panel de esa empresa.\n' +
    '       Crea primero la cuenta nueva con scripts/crear-admin-empresa.mjs,\n' +
    '       o repite esto con FORZAR=1 si de verdad es lo que quieres.',
  );
  db.close();
  process.exit(1);
}

db.prepare('DELETE FROM empresa_admins WHERE username = ?').run(username);
db.close();

console.log(`[OK] Admin '${username}' borrado de la empresa '${admin.company_id}'.`);
// El backend mira la cuenta en cada petición del panel (isAdminTokenCurrent,
// src/data/empresas.ts) y revisa los paneles conectados cada minuto: borrar
// la fila corta el acceso sin esperar a que el token caduque.
console.log('     Su token deja de valer en la siguiente petición, y un panel abierto se cierra en menos de un minuto.');
