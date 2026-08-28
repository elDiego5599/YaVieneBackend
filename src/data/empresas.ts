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
}

interface AdminRow {
  admin_id: string;
  company_id: string;
  username: string;
  password_hash: string;
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
    SELECT admin_id, company_id, username, password_hash
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
  db.prepare(`
    INSERT INTO empresa_admins (admin_id, company_id, username, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET
      company_id = excluded.company_id,
      password_hash = excluded.password_hash
  `).run(randomUUID(), companyId, normalized, passwordHash, Date.now());

  const row = db.prepare(`
    SELECT admin_id, company_id, username, password_hash
    FROM empresa_admins
    WHERE username = ?
  `).get(normalized) as AdminRow;
  return rowToAdmin(row);
}

function rowToAdmin(row: AdminRow): EmpresaAdmin {
  return {
    adminId: row.admin_id,
    companyId: row.company_id,
    username: row.username,
    passwordHash: row.password_hash,
  };
}
