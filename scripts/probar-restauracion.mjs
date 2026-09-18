// Abrir el último respaldo y ver si de verdad se puede volver de él.
//
// Un respaldo que nadie ha abierto nunca es un archivo con nombre de
// respaldo. Esto toma el más nuevo, lo copia a un temporal —nunca se
// trabaja sobre el original ni sobre la base viva—, lo revisa entero y
// cuenta el catálogo: empresas, rutas y buses. Si algo no cuadra sale con
// código distinto de cero, que es lo que hace ruido en launchd o en la
// consola de quien lo corre.
//
// Lo que se considera «no cuadra»:
//   · no hay ningún respaldo;
//   · el más nuevo es más viejo que MAX_EDAD_HORAS (por defecto 3: las
//     copias son cada hora, así que a las tres ya se perdieron dos);
//   · la copia no pasa integrity_check;
//   · le falta alguna de las tres tablas del catálogo;
//   · la copia trae cero filas de algo que la base viva sí tiene.
//
// Que la copia tenga menos filas que la viva no es error: entre la copia y
// ahora pudo darse de alta un bus. Sale impreso para que se vea.
//
// Uso:
//   node scripts/probar-restauracion.mjs
//   DB_PATH=... BACKUP_DIR=... MAX_EDAD_HORAS=3
import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// YA_VIENE_DB_PATH es la que mira el backend: si algún día local.env la
// fija, la copia tiene que salir de esa base y no de la de por defecto.
const DB_PATH =
  process.env.DB_PATH || process.env.YA_VIENE_DB_PATH || path.join(process.cwd(), 'data', 'yaviene.db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');
const MAX_EDAD_HORAS = Number(process.env.MAX_EDAD_HORAS ?? 3);

const PATRON = /^yaviene-\d{8}-\d{6}\.db$/;
const TABLAS = ['empresas', 'company_routes', 'buses'];

// `process.exit` no corre los `finally`, así que el temporal se barre aquí:
// si no, cada ejecución fallida dejaría una carpeta suelta en /tmp.
let tmp = null;

function fallar(mensaje) {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  console.error(mensaje);
  process.exit(1);
}

function contar(db, tabla) {
  try {
    return db.prepare(`SELECT count(*) AS n FROM ${tabla}`).get().n;
  } catch {
    return null;
  }
}

const desde = Date.now();

if (!existsSync(BACKUP_DIR)) fallar(`No hay ningún respaldo: la carpeta ${BACKUP_DIR} ni siquiera existe.`);

const candidatos = readdirSync(BACKUP_DIR)
  .filter((nombre) => PATRON.test(nombre))
  .map((nombre) => ({ ruta: path.join(BACKUP_DIR, nombre), mtime: statSync(path.join(BACKUP_DIR, nombre)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

if (candidatos.length === 0) fallar(`No hay ningún respaldo en ${BACKUP_DIR}.`);

const ultimo = candidatos[0];
const edadHoras = (Date.now() - ultimo.mtime) / 3_600_000;
if (edadHoras > MAX_EDAD_HORAS) {
  fallar(`La copia más nueva está vieja: ${edadHoras.toFixed(1)} h (${ultimo.ruta}), y el tope es ${MAX_EDAD_HORAS} h. ¿Sigue corriendo el servicio de respaldo?`);
}

// Sobre una copia de la copia: abrir el respaldo directamente le crearía
// archivos -wal y -shm al lado y lo dejaría de otra forma que como se
// guardó.
tmp = mkdtempSync(path.join(tmpdir(), 'yaviene-restauracion-'));
const ensayo = path.join(tmp, 'restaurada.db');
copyFileSync(ultimo.ruta, ensayo);

try {
  const copia = new Database(ensayo, { readonly: true });
  const estado = copia.pragma('integrity_check', { simple: true });
  if (estado !== 'ok') {
    copia.close();
    fallar(`Integridad: ${estado}. La copia ${ultimo.ruta} no sirve para restaurar.`);
  }
  console.log(`Copia ${ultimo.ruta} (${statSync(ultimo.ruta).size} bytes, ${edadHoras.toFixed(1)} h): integridad ok.`);

  const vivaExiste = existsSync(DB_PATH);
  const viva = vivaExiste ? new Database(DB_PATH, { readonly: true }) : null;
  let problema = null;

  for (const tabla of TABLAS) {
    const enCopia = contar(copia, tabla);
    if (enCopia === null) {
      problema = `A la copia le falta la tabla ${tabla}.`;
      break;
    }
    const enViva = viva ? contar(viva, tabla) : null;
    console.log(`  ${tabla}: ${enCopia} en la copia${enViva === null ? '' : `, ${enViva} en la viva`}`);
    if (enCopia === 0 && enViva) problema = `La copia trae 0 filas de ${tabla} y la base viva tiene ${enViva}.`;
  }

  viva?.close();
  copia.close();
  if (problema) fallar(problema);

  console.log(`Restauración probada en ${Date.now() - desde} ms.`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
