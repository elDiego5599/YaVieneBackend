// Copia de la base, con poda.
//
// `backup-db.mjs` hace una copia y nada más: sin nombre con fecha, sin
// revisar que la copia sirva y sin borrar las viejas. Una copia por hora
// con ese script llena el disco del Mac en unas semanas —la base de hoy
// pesa unos 3,6 MB— y el día del apuro hay que adivinar cuál de los
// cuatrocientos archivos es el bueno.
//
// Esto es lo que corre launchd cada hora (ver scripts/servicio). Copia con
// el backup en línea de SQLite, que es seguro con WAL y con el servidor
// escribiendo; revisa la copia recién hecha, porque una copia corrupta que
// nadie abre es peor que no tenerla; y poda: se quedan las últimas
// RETENCION_HORARIOS y, de lo más viejo, la última de cada día hasta
// RETENCION_DIARIOS días. La copia que se acaba de hacer nunca se borra.
//
// Uso:
//   node scripts/respaldar.mjs
//   DB_PATH=... BACKUP_DIR=... RETENCION_HORARIOS=48 RETENCION_DIARIOS=30
//   BACKUP_DIR_EXTERNO=/Volumes/USB/yaviene   (copia fuera del disco, opcional)
import Database from 'better-sqlite3';
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// YA_VIENE_DB_PATH es la que mira el backend: si algún día local.env la
// fija, la copia tiene que salir de esa base y no de la de por defecto.
const DB_PATH =
  process.env.DB_PATH || process.env.YA_VIENE_DB_PATH || path.join(process.cwd(), 'data', 'yaviene.db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');
const HORARIOS = Number(process.env.RETENCION_HORARIOS ?? 48);
const DIARIOS = Number(process.env.RETENCION_DIARIOS ?? 30);
// Auditoría 2026-09, P2-5: con las copias en el mismo disco que la base, un
// disco que muere se lleva las dos. Este segundo destino —una USB, una
// carpeta sincronizada con iCloud— recibe cada copia ya revisada y se poda
// igual. Tiene que existir: si no está montado no se crea (sería una carpeta
// más en el mismo disco con nombre de USB), la copia local sale igual y el
// log avisa cuando la última copia de fuera pasa de 24 h.
const EXTERNO = process.env.BACKUP_DIR_EXTERNO || '';
const MARCA_EXTERNA = '.ultima-copia-externa';
const AVISO_EXTERNA_MS = 24 * 3_600_000;

const PATRON = /^yaviene-(\d{8})-\d{6}\.db$/;

function sello(fecha) {
  // En UTC a propósito: el nombre ordena igual que el reloj del archivo y no
  // se repite ni se salta una hora cuando cambia la hora del sistema.
  const iso = fecha.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
}

function copias(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((nombre) => PATRON.test(nombre))
    .map((nombre) => ({ nombre, dia: nombre.match(PATRON)[1], mtime: statSync(path.join(dir, nombre)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime || b.nombre.localeCompare(a.nombre));
}

function podar(dir, reciente) {
  const todas = copias(dir);
  // Las más nuevas se quedan tal cual; de lo que queda, la más nueva de cada
  // día que no esté ya representado, hasta DIARIOS días. Así una semana
  // tranquila no ocupa lo mismo que una semana de pruebas.
  const recientes = todas.slice(0, HORARIOS);
  const guardadas = new Set(recientes.map((copia) => copia.nombre));
  const dias = new Set(recientes.map((copia) => copia.dia));
  guardadas.add(reciente);

  let diarios = 0;
  for (const copia of todas.slice(HORARIOS)) {
    if (diarios >= DIARIOS) break;
    if (dias.has(copia.dia)) continue;
    guardadas.add(copia.nombre);
    dias.add(copia.dia);
    diarios += 1;
  }

  let borradas = 0;
  for (const copia of todas) {
    if (guardadas.has(copia.nombre)) {
      // Las de antes de 2026-09-30 nacieron en 644: se cierran al pasar.
      chmodSync(path.join(dir, copia.nombre), 0o600);
      continue;
    }
    rmSync(path.join(dir, copia.nombre), { force: true });
    borradas += 1;
  }
  return { guardadas: guardadas.size, borradas };
}

if (!existsSync(DB_PATH)) {
  console.error(`No existe la base ${DB_PATH}.`);
  process.exit(1);
}

// La base trae teléfonos y hashes: las copias son solo del dueño. umask
// para lo que nazca aquí (la copia, sus -wal/-shm de la prueba, la marca)
// y chmod explícito para lo que ya existía con permisos de antes.
process.umask(0o077);
mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
chmodSync(BACKUP_DIR, 0o700);

const desde = Date.now();
const nombre = `yaviene-${sello(new Date())}.db`;
const destino = path.join(BACKUP_DIR, nombre);

const viva = new Database(DB_PATH, { readonly: true });
await viva.backup(destino);
chmodSync(destino, 0o600);
viva.close();

// Una copia que no se abre no es una copia. Se revisa aquí y no en el
// arranque de dentro de dos meses, que es cuando hace falta.
//
// Se abre para escritura, no de sólo lectura: la copia hereda el modo WAL
// de la base viva, y una conexión de sólo lectura no puede volcar el -wal
// ni barrer el -shm al cerrar. Quedarían tres archivos por copia en vez de
// uno, y el día de restaurar hay que adivinar cuáles van juntos.
const copia = new Database(destino);
const estado = copia.pragma('integrity_check', { simple: true });
copia.pragma('wal_checkpoint(TRUNCATE)');
copia.pragma('journal_mode = DELETE');
copia.close();
for (const sufijo of ['-wal', '-shm']) rmSync(`${destino}${sufijo}`, { force: true });
if (estado !== 'ok') {
  rmSync(destino, { force: true });
  console.error(`La copia recién hecha no pasa la revisión (${estado}); se borró. La base ${DB_PATH} puede estar dañada.`);
  process.exit(1);
}

const bytes = statSync(destino).size;
const { guardadas, borradas } = podar(BACKUP_DIR, nombre);
console.log(`Respaldo ${destino} (${bytes} bytes, ${Date.now() - desde} ms), integridad ok.`);
console.log(`Guardados: ${guardadas} (hasta ${HORARIOS} recientes y ${DIARIOS} diarios) · borrados: ${borradas}`);

// La marca vive junto a las copias locales y no en el destino de fuera: es
// justo cuando ese destino no está cuando hace falta saber de cuándo es la
// última copia que llegó ahí.
const marca = path.join(BACKUP_DIR, MARCA_EXTERNA);
if (!EXTERNO) {
  console.warn('[AVISO] Sin copia fuera del disco: define BACKUP_DIR_EXTERNO (una USB o una carpeta sincronizada).');
} else if (!existsSync(EXTERNO)) {
  const ultima = existsSync(marca) ? statSync(marca).mtimeMs : 0;
  const horas = ultima ? ((Date.now() - ultima) / 3_600_000).toFixed(1) : null;
  const linea = `${EXTERNO} no está (¿desmontado?): la copia se quedó solo en este disco`;
  if (!ultima || Date.now() - ultima > AVISO_EXTERNA_MS) {
    console.warn(`[AVISO] ${linea}, y la última copia de fuera ${horas ? `es de hace ${horas} h` : 'no existe'} (más de 24 h).`);
  } else {
    console.log(`${linea}; la última copia de fuera es de hace ${horas} h.`);
  }
} else {
  copyFileSync(destino, path.join(EXTERNO, nombre));
  // Explícito y no fiado al umask: sobre un archivo que ya existía (misma
  // hora, disco con otros permisos) se conservaría el modo viejo.
  chmodSync(path.join(EXTERNO, nombre), 0o600);
  const fuera = podar(EXTERNO, nombre);
  writeFileSync(marca, `${new Date().toISOString()}\n`);
  chmodSync(marca, 0o600);
  const ahora = new Date();
  utimesSync(marca, ahora, ahora);
  console.log(`Copia fuera del disco: ${path.join(EXTERNO, nombre)} · guardados ${fuera.guardadas}, borrados ${fuera.borradas}`);
}
