import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const source = process.env.DB_PATH || path.join(process.cwd(), 'data', 'yaviene.db');
const target = process.argv[2] || path.join(process.cwd(), 'data', `yaviene-${Date.now()}.db`);

if (!fs.existsSync(source)) {
  throw new Error(`Database not found: ${source}`);
}

const db = new Database(source, { readonly: true });
await db.backup(target);
db.close();
console.log(`Backup created: ${target}`);
