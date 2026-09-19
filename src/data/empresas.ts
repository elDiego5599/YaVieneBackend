import { randomUUID } from 'crypto';
import { getDb } from './database';

export interface Empresa {
  companyId: string;
  name: string;
}

export interface EmpresaAdmin {
  adminId: string;
  companyId: string;
  username: string;
  passwordHash: string;
  tokenVersion: number;
}

interface AdminRow {
  admin_id: string;
  company_id: string;
  username: string;
  password_hash: string;
  token_version: number;
}

export function getEmpresa(companyId: string): Empresa | null {
  const row = getDb().prepare(
    'SELECT company_id, name FROM empresas WHERE company_id = ?',
  ).get(companyId) as { company_id: string; name: string } | undefined;
  return row ? { companyId: row.company_id, name: row.name } : null;
}

export function getEmpresas(): Empresa[] {
  const rows = getDb().prepare(
    'SELECT company_id, name FROM empresas ORDER BY name ASC',
  ).all() as { company_id: string; name: string }[];
  return rows.map((row) => ({ companyId: row.company_id, name: row.name }));
}

export function ensureEmpresa(companyId: string, name?: string): void {
  getDb().prepare(`
    INSERT OR IGNORE INTO empresas (company_id, name, created_at)
    VALUES (?, ?, ?)
  `).run(companyId, name ?? companyId, Date.now());
}

export function getCompanyAdminByUsername(username: string): EmpresaAdmin | null {
  const row = getDb().prepare(`
    SELECT admin_id, company_id, username, password_hash, token_version
    FROM empresa_admins
    WHERE username = ?
  `).get(username) as AdminRow | undefined;
  return row ? rowToAdmin(row) : null;
}

export function createOrUpdateCompanyAdmin(
  companyId: string,
  username: string,
  passwordHash: string,
): EmpresaAdmin {
  // El login busca por `username.trim().toLowerCase()`, así que guardarlo
  // con mayúsculas creaba una cuenta que nunca podía entrar. Se normaliza
  // aquí para que ningún camino de creación pueda dejarla inservible.
  const normalized = username.trim().toLowerCase();
  const db = getDb();
  // Actualizar una cuenta siempre es cambiarle la contraseña (el hash lleva
  // sal, así que ni repetir la misma clave da el mismo) y puede además
  // moverla de empresa. En los dos casos los tokens firmados antes tienen
  // que dejar de valer, así que la versión de la credencial sube siempre.
  db.prepare(`
    INSERT INTO empresa_admins (admin_id, company_id, username, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET
      company_id = excluded.company_id,
      password_hash = excluded.password_hash,
      token_version = token_version + 1
  `).run(randomUUID(), companyId, normalized, passwordHash, Date.now());

  const row = db.prepare(`
    SELECT admin_id, company_id, username, password_hash, token_version
    FROM empresa_admins
    WHERE username = ?
  `).get(normalized) as AdminRow;
  return rowToAdmin(row);
}

/**
 * ¿Sigue vigente la credencial con la que se firmó este token de panel?
 *
 * Una consulta por clave primaria en cada petición del panel, que hace pocas
 * por minuto. A cambio, cambiarle la contraseña a la cuenta, moverla de
 * empresa o borrarla (`scripts/borrar-admin-empresa.mjs`) corta el acceso en
 * la siguiente petición y no cuando el token caduque a las 8 horas.
 */
export function isAdminTokenCurrent(
  adminId: string,
  companyId: string,
  tokenVersion: number,
): boolean {
  const row = getDb().prepare(
    'SELECT company_id, token_version FROM empresa_admins WHERE admin_id = ?',
  ).get(adminId) as { company_id: string; token_version: number } | undefined;
  return !!row && row.company_id === companyId && row.token_version === tokenVersion;
}

/**
 * Cierra todas las sesiones de una cuenta de panel: sube la versión de su
 * credencial y los tokens firmados con la anterior dejan de valer, los de
 * este equipo y los de cualquier otro donde se haya entrado con ella. Es lo
 * que hace un cambio de contraseña, sin cambiarla.
 *
 * Solo sube si la versión sigue siendo la del token que lo pide: dos cierres
 * a la vez con el mismo token suben una vez, y un token ya revocado no puede
 * volver a mover la versión de nadie.
 */
export function revokeAdminTokens(
  adminId: string,
  companyId: string,
  tokenVersion: number,
): boolean {
  const resultado = getDb().prepare(`
    UPDATE empresa_admins SET token_version = token_version + 1
    WHERE admin_id = ? AND company_id = ? AND token_version = ?
  `).run(adminId, companyId, tokenVersion);
  return resultado.changes === 1;
}

function rowToAdmin(row: AdminRow): EmpresaAdmin {
  return {
    adminId: row.admin_id,
    companyId: row.company_id,
    username: row.username,
    passwordHash: row.password_hash,
    tokenVersion: row.token_version,
  };
}
