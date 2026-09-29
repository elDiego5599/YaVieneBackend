// Que el respaldo sirva para restaurar, no solo que exista.
//
// Hasta aquí la copia se hacía a mano (`npm run backup`) cuando alguien se
// acordaba, y nadie había abierto nunca una para ver si se podía volver de
// ella. Un respaldo que no se prueba no es un respaldo: es un archivo con
// nombre de respaldo. Y una copia por hora sin retención llena el disco del
// Mac en unas semanas, que es la otra forma de quedarse sin base.
//
// Aquí se prueban las dos piezas de T2.8 —`respaldar.mjs`, que copia y poda,
// y `probar-restauracion.mjs`, que abre la última copia y la compara con la
// base viva— y se corre entero el simulacro T10.5-c: base sana, copia, base
// rota a propósito, arranque rechazado, restauración, arranque bien. El
// simulacro va cronometrado porque el plan pide el tiempo.
//
// Nada de esto toca la base viva ni el backend en pie: cada caso trabaja en
// su carpeta temporal, y el arranque del simulacro usa puertos propios
// (HTTP 3190, MQTT 8960; el reparto de los demás está en arranque.test.ts).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { HOST_PRUEBAS } from './red_pruebas';

const JWT_LARGO = 'j'.repeat(64);

/** Una base con las tres tablas que la restauración cuenta, y datos dentro. */
function baseDeMentira(ruta: string, buses: number): void {
  const db = new Database(ruta);
  db.exec(`
    CREATE TABLE empresas (id TEXT PRIMARY KEY, nombre TEXT);
    CREATE TABLE company_routes (company_id TEXT, route_id TEXT, nombre TEXT);
    CREATE TABLE buses (bus_id TEXT PRIMARY KEY, route_id TEXT);
  `);
  db.prepare('INSERT INTO empresas VALUES (?, ?)').run('EMP-01', 'Sobusa');
  const ruta101 = db.prepare('INSERT INTO company_routes VALUES (?, ?, ?)');
  ruta101.run('EMP-01', 'R-101', 'Ruta 101');
  ruta101.run('EMP-01', 'R-106', 'Ruta 106');
  const bus = db.prepare('INSERT INTO buses VALUES (?, ?)');
  for (let i = 0; i < buses; i++) bus.run(`B-${900 + i}`, 'R-101');
  db.close();
}

/** Sobrescribe la página 2, que es el daño que SQLite no ve al abrir. */
function romper(ruta: string): void {
  const fd = openSync(ruta, 'r+');
  writeSync(fd, Buffer.alloc(4096, 0xa5), 0, 4096, 4096);
  closeSync(fd);
}

function correr(script: string, env: Record<string, string>): { code: number; salida: string } {
  const r = spawnSync(process.execPath, [`scripts/${script}`], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    encoding: 'utf8',
  });
  return { code: r.status ?? -1, salida: `${r.stdout}${r.stderr}` };
}

function carpeta(prefijo: string): string {
  return mkdtempSync(join(tmpdir(), `yaviene-${prefijo}-`));
}

test('respaldar: la copia se abre, está íntegra y trae los mismos datos', () => {
  const tmp = carpeta('respaldo-copia');
  const dbPath = join(tmp, 'yaviene.db');
  const destino = join(tmp, 'backups');
  baseDeMentira(dbPath, 12);

  const { code, salida } = correr('respaldar.mjs', { DB_PATH: dbPath, BACKUP_DIR: destino });
  assert.equal(code, 0, salida);

  // Un solo archivo por copia: si el -wal y el -shm se quedaran al lado,
  // restaurar sería elegir tres archivos que casen entre sí.
  assert.deepEqual(
    readdirSync(destino).filter((n) => !n.endsWith('.db')),
    [],
    'la copia dejó archivos sueltos al lado',
  );
  const copias = readdirSync(destino).filter((n) => n.endsWith('.db'));
  assert.equal(copias.length, 1, salida);
  const copia = new Database(join(destino, copias[0]), { readonly: true });
  assert.equal(copia.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal((copia.prepare('SELECT count(*) n FROM buses').get() as { n: number }).n, 12);
  copia.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('respaldar: la poda deja los recientes y un diario por día', () => {
  const tmp = carpeta('respaldo-poda');
  const dbPath = join(tmp, 'yaviene.db');
  const destino = join(tmp, 'backups');
  baseDeMentira(dbPath, 1);
  mkdirSync(destino, { recursive: true });

  // Cinco días de copias cada hora, todas anteriores a la que va a hacerse
  // ahora. Con 6 recientes y 3 diarios tienen que quedar 9: la nueva, las
  // cinco últimas de antes, y la más nueva de cada uno de los tres días
  // anteriores que no estén ya representados.
  const ahora = Date.now();
  const falsas = new Set<string>();
  for (let h = 1; h <= 120; h++) {
    const cuando = new Date(ahora - h * 3_600_000);
    const iso = cuando.toISOString();
    const nombre = `yaviene-${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}.db`;
    const archivo = join(destino, nombre);
    writeFileSync(archivo, 'x');
    utimesSync(archivo, cuando, cuando);
    falsas.add(nombre);
  }

  const { code, salida } = correr('respaldar.mjs', {
    DB_PATH: dbPath, BACKUP_DIR: destino, RETENCION_HORARIOS: '6', RETENCION_DIARIOS: '3',
  });
  assert.equal(code, 0, salida);

  const quedan = readdirSync(destino).filter((n) => n.endsWith('.db')).sort().reverse();
  assert.equal(quedan.length, 9, `quedaron ${quedan.join(', ')}\n${salida}`);

  // La copia que se acaba de hacer nunca se poda, aunque el reloj del día
  // ya tenga una más nueva de ese mismo día.
  const nuevas = quedan.filter((n) => !falsas.has(n));
  assert.equal(nuevas.length, 1, `la copia nueva no sobrevivió: ${quedan.join(', ')}`);

  // Las tres más viejas que quedan son de tres días distintos y cada una es
  // la última de su día: eso es «un diario por día».
  const dia = (n: string) => n.slice(8, 16);
  const diarias = quedan.slice(6);
  assert.equal(new Set(diarias.map(dia)).size, 3, `los diarios repiten día: ${diarias.join(', ')}`);
  for (const copia of diarias) {
    const ultimaDeSuDia = [...falsas].filter((n) => dia(n) === dia(copia)).sort().at(-1);
    assert.equal(copia, ultimaDeSuDia, 'el diario guardado no es el último de su día');
  }
  rmSync(tmp, { recursive: true, force: true });
});

test('probar-restauracion: una copia sana pasa y dice cuánto tardó', () => {
  const tmp = carpeta('restaurar-ok');
  const dbPath = join(tmp, 'yaviene.db');
  const destino = join(tmp, 'backups');
  baseDeMentira(dbPath, 12);
  assert.equal(correr('respaldar.mjs', { DB_PATH: dbPath, BACKUP_DIR: destino }).code, 0);

  const { code, salida } = correr('probar-restauracion.mjs', { DB_PATH: dbPath, BACKUP_DIR: destino });
  assert.equal(code, 0, salida);
  assert.match(salida, /integridad ok/i);
  assert.match(salida, /\bempresas\b.*1/);
  assert.match(salida, /\bbuses\b.*12/);
  assert.match(salida, /\d+ ms/, 'el simulacro pide el tiempo');
  rmSync(tmp, { recursive: true, force: true });
});

test('probar-restauracion: falla si no hay copia, si está rota o si está vieja', () => {
  const tmp = carpeta('restaurar-mal');
  const dbPath = join(tmp, 'yaviene.db');
  const destino = join(tmp, 'backups');
  baseDeMentira(dbPath, 12);

  const sinNada = correr('probar-restauracion.mjs', { DB_PATH: dbPath, BACKUP_DIR: destino });
  assert.notEqual(sinNada.code, 0, sinNada.salida);
  assert.match(sinNada.salida, /no hay ning[uú]n respaldo/i);

  assert.equal(correr('respaldar.mjs', { DB_PATH: dbPath, BACKUP_DIR: destino }).code, 0);
  const copia = join(destino, readdirSync(destino).filter((n) => n.endsWith('.db'))[0]);

  // Vieja: el reloj del archivo se corre tres días atrás.
  const viejo = new Date(Date.now() - 72 * 3_600_000);
  utimesSync(copia, viejo, viejo);
  const antigua = correr('probar-restauracion.mjs', { DB_PATH: dbPath, BACKUP_DIR: destino });
  assert.notEqual(antigua.code, 0, antigua.salida);
  assert.match(antigua.salida, /vieja|antigua/i);

  // Rota: la copia se corrompe y el reloj vuelve a ahora.
  const ahora = new Date();
  utimesSync(copia, ahora, ahora);
  romper(copia);
  const rota = correr('probar-restauracion.mjs', { DB_PATH: dbPath, BACKUP_DIR: destino });
  assert.notEqual(rota.code, 0, rota.salida);
  assert.match(rota.salida, /integridad/i);
  rmSync(tmp, { recursive: true, force: true });
});

// Una copia íntegra puede no servir igual: vacía (la copia se hizo de una
// base recién creada, o de otra ruta) o sin una tabla del catálogo. Las dos
// pasaban `integrity_check` y la auditoría del 2026-09-27 (R-07: M06 y M09)
// vio que quitar su comprobación no rompía ninguna prueba.
test('probar-restauracion: falla si la copia viene vacía o le falta una tabla', () => {
  const tmp = carpeta('restaurar-hueca');
  const dbPath = join(tmp, 'yaviene.db');
  const destino = join(tmp, 'backups');
  baseDeMentira(dbPath, 12);
  assert.equal(correr('respaldar.mjs', { DB_PATH: dbPath, BACKUP_DIR: destino }).code, 0);
  const copia = join(destino, readdirSync(destino).filter((n) => n.endsWith('.db'))[0]);

  const vaciar = new Database(copia);
  vaciar.exec('DELETE FROM buses');
  vaciar.close();
  const vacia = correr('probar-restauracion.mjs', { DB_PATH: dbPath, BACKUP_DIR: destino });
  assert.notEqual(vacia.code, 0, vacia.salida);
  assert.match(vacia.salida, /0 filas de buses y la base viva tiene 12/);

  const mutilar = new Database(copia);
  mutilar.exec('DROP TABLE buses');
  mutilar.close();
  const sinTabla = correr('probar-restauracion.mjs', { DB_PATH: dbPath, BACKUP_DIR: destino });
  assert.notEqual(sinTabla.code, 0, sinTabla.salida);
  assert.match(sinTabla.salida, /falta la tabla buses/);
  rmSync(tmp, { recursive: true, force: true });
});

// launchd y plutil son de macOS: en la CI, que corre en Linux, el
// instalador ni encuentra ngrok ni tiene con qué validar el plist, y la
// prueba fallaba por el sistema, no por el servicio. Se corre en el Mac,
// que es la única máquina donde este servicio existe.
const SOLO_MAC = process.platform === 'darwin' ? false : 'launchd solo existe en macOS';

test('el servicio de launchd sale instalable y apunta a este repo', { skip: SOLO_MAC }, () => {
  // Sin esto, el error del plist —una marca sin reemplazar, un XML mal
  // cerrado— sólo se ve el día que se carga el servicio, que es el día de
  // la demo. `DESTINO` lo manda a una carpeta de usar y tirar: esta prueba
  // no escribe en ~/Library/LaunchAgents ni carga nada.
  const tmp = carpeta('respaldo-servicio');
  const r = spawnSync('/bin/bash', ['scripts/servicio/instalar-servicios.sh'], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      DESTINO: join(tmp, 'agentes'),
      LOGS_YAVIENE: join(tmp, 'logs'),
    },
    encoding: 'utf8',
  });
  const salida = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, salida);

  const plist = join(tmp, 'agentes', 'com.yaviene.respaldo.plist');
  const texto = readFileSync(plist, 'utf8');
  assert.doesNotMatch(texto, /@@/, 'quedó una marca sin reemplazar en el plist');
  assert.match(texto, /servicio\/respaldar\.sh/);
  assert.match(texto, /<key>StartInterval<\/key>\s*<integer>3600<\/integer>/);
  // El plist se lee solo si es XML válido; plutil es el mismo que usa
  // launchd al cargarlo.
  assert.equal(spawnSync('/usr/bin/plutil', ['-lint', plist]).status, 0);
  rmSync(tmp, { recursive: true, force: true });
});

// ── Simulacro T10.5-c, entero y cronometrado ──────────────────────────
function arrancar(dbPath: string) {
  return spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      YA_VIENE_FLOTA_DEMO: '0',
      MQTT_DEBUG_LOGS: 'false',
      // El entorno limpio no hereda el HTTP_HOST de tests/entorno.ts.
      HTTP_HOST: HOST_PRUEBAS,
      JWT_SECRET: JWT_LARGO,
      HTTP_PORT: '3190',
      MQTT_PORT: '8960',
      YA_VIENE_DB_PATH: dbPath,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

/** ¿Hay alguien contestando ya en 3190? */
async function contesta(): Promise<boolean> {
  try {
    const r = await fetch('http://127.0.0.1:3190/api/health', {
      signal: AbortSignal.timeout(500),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Espera a que el puerto quede en silencio. Se llama antes de cada arranque
 * y después de cada muerte: un backend olvidado de una corrida anterior
 * contestaría por el que esta prueba cree estar levantando, y el simulacro
 * daría verde midiendo milisegundos que no son de nadie.
 */
async function esperarPuertoQuieto(limiteMs: number): Promise<void> {
  const hasta = Date.now() + limiteMs;
  while (await contesta()) {
    if (Date.now() > hasta) {
      throw new Error('el puerto 3190 lo tiene ocupado otro proceso; mátalo antes de correr esto');
    }
    await new Promise((sigue) => setTimeout(sigue, 100));
  }
}

async function arrancaBien(dbPath: string, limiteMs: number): Promise<number> {
  await esperarPuertoQuieto(5_000);
  const desde = Date.now();
  const hijo = arrancar(dbPath);
  try {
    for (;;) {
      // Sólo cuenta como arranque si contesta mientras el hijo sigue vivo:
      // si se murió, lo que conteste el puerto es de otro.
      if (hijo.exitCode !== null || hijo.signalCode !== null) {
        throw new Error(`el backend se murió al arrancar (código ${hijo.exitCode})`);
      }
      if (await contesta()) return Date.now() - desde;
      if (Date.now() - desde > limiteMs) throw new Error('no levantó a tiempo');
      await new Promise((sigue) => setTimeout(sigue, 100));
    }
  } finally {
    hijo.kill('SIGKILL');
    await new Promise((listo) => hijo.once('exit', listo));
    await esperarPuertoQuieto(10_000);
  }
}

async function seNiegaAArrancar(dbPath: string, limiteMs: number): Promise<string> {
  await esperarPuertoQuieto(5_000);
  const hijo = arrancar(dbPath);
  let stderr = '';
  hijo.stderr?.on('data', (t: Buffer) => { stderr += t.toString(); });
  return new Promise((listo, falla) => {
    const reloj = setTimeout(() => {
      hijo.kill('SIGKILL');
      falla(new Error(`arrancó con la base rota. stderr:\n${stderr}`));
    }, limiteMs);
    hijo.once('exit', (code) => {
      clearTimeout(reloj);
      if (code === 0) falla(new Error('salió en cero con la base rota'));
      else listo(stderr);
    });
  });
}

test('simulacro T10.5-c: base rota no arranca, restaurada sí', { timeout: 180_000 }, async () => {
  const tmp = carpeta('simulacro-c');
  const dbPath = join(tmp, 'yaviene.db');
  const destino = join(tmp, 'backups');

  // 1) Base sana: la crea el propio backend al arrancar (esquema y siembra).
  const primer = await arrancaBien(dbPath, 60_000);

  // Con el servidor muerto de golpe, lo escrito sigue en el -wal y el archivo
  // principal es solo la cabecera. Se vuelca aquí para que la base que se
  // copia y se rompe sea la de verdad y no un archivo de 4 KB.
  const volcar = new Database(dbPath);
  volcar.pragma('wal_checkpoint(TRUNCATE)');
  volcar.close();

  // 2) Copia, con el mismo script que correría launchd cada hora.
  const respaldo = correr('respaldar.mjs', { DB_PATH: dbPath, BACKUP_DIR: destino });
  assert.equal(respaldo.code, 0, respaldo.salida);
  const copia = join(destino, readdirSync(destino).filter((n) => n.endsWith('.db'))[0]);

  // 3) Daño de verdad, con el servidor parado, y el arranque lo rechaza.
  for (const sufijo of ['-wal', '-shm']) rmSync(`${dbPath}${sufijo}`, { force: true });
  romper(dbPath);
  const stderr = await seNiegaAArrancar(dbPath, 60_000);
  assert.match(stderr, /dañada/);

  // 4) Restauración y arranque bueno, cronometrado de punta a punta.
  const desde = Date.now();
  copyFileSync(copia, dbPath);
  const segundo = await arrancaBien(dbPath, 60_000);
  const total = Date.now() - desde;

  console.log(
    `[simulacro c] arranque inicial ${primer} ms · restauración ${total - segundo} ms · ` +
      `arranque restaurado ${segundo} ms · total ${total} ms`,
  );
  // Que los dos arranques sean del backend que levanta esta prueba lo
  // garantizan `esperarPuertoQuieto` —nadie contesta en 3190 antes de
  // arrancar— y la vigilancia del hijo mientras se espera: si muriera por
  // el puerto ocupado, la espera falla en vez de dar por bueno lo que
  // conteste otro.
  assert.ok(total < 60_000, `la restauración tardó ${total} ms`);
  rmSync(tmp, { recursive: true, force: true });
});
