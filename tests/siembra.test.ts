// T9.3 (YV-13): Sobusa y su catálogo vivían en las migraciones 9, 12 y 16, y
// toda base nueva nacía con ellos, también la de un despliegue para otra
// empresa. Ahora la siembra la decide `siembraDemoHabilitada` (misma regla
// que la flota demo): encendida en desarrollo, apagada en producción salvo
// YA_VIENE_SEED_DEMO=1. Cada base va en su propio proceso porque
// `database.ts` fija la ruta al cargarse.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { siembraDemoHabilitada, validateConfig } from '../src/config';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-siembra-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

type Catalogo = {
  empresas: Array<{ company_id: string; name: string }>;
  rutas: Array<{ company_id: string; route_id: string; name: string; terminal_a: string; terminal_b: string }>;
  migraciones: number[];
};

function abrir(base: string, env: Record<string, string>): Catalogo {
  const hijo = spawnSync(
    process.execPath,
    ['--import', 'tsx', join(__dirname, 'fixtures', 'catalogo_siembra.ts')],
    {
      encoding: 'utf8',
      // Sin heredar YA_VIENE_SEED_DEMO ni NODE_ENV de quien corra la suite.
      env: { PATH: process.env.PATH ?? '', YA_VIENE_DB_PATH: join(tmp, base), ...env },
    },
  );
  assert.equal(hijo.status, 0, hijo.stderr);
  // El log de `[DB]` también sale por stdout: el JSON es la última línea.
  return JSON.parse(hijo.stdout.trim().split('\n').at(-1) ?? '') as Catalogo;
}

// El catálogo real de Sobusa tal como lo dejaba la base antes de T9.3
// (comparado fila a fila con una base creada por el código anterior).
const SOBUSA = [
  ['R-101', 'B18 Tcherassi', 'Ciudad Mallorquín', 'La Playa'],
  ['R-102', 'C11 Silencio', 'Nevada', 'El Silencio'],
  ['R-103', 'C12 Vivero Paraíso', 'Vía 40', 'Paraíso'],
  ['R-104', 'C13 Carrera 50 Paraíso', 'Nevada (Soledad)', 'Calle 76 (Vía 40)'],
  ['R-105', 'C14 Carrera 54 Uninorte', 'Granabastos', 'Uninorte'],
  ['R-106', 'C16 Calle 72 Uninorte', 'Granabastos', 'Uninorte'],
].map(([route_id, name, terminal_a, terminal_b]) => ({
  company_id: 'EMP-01', route_id, name, terminal_a, terminal_b,
}));

const SIEMBRA = [9, 12, 16];

test('la regla: sembrada en desarrollo, vacía en producción, y la variable manda', () => {
  assert.equal(siembraDemoHabilitada({}), true);
  assert.equal(siembraDemoHabilitada({ NODE_ENV: 'production' }), false);
  assert.equal(siembraDemoHabilitada({ NODE_ENV: 'production', YA_VIENE_SEED_DEMO: '1' }), true);
  assert.equal(siembraDemoHabilitada({ YA_VIENE_SEED_DEMO: '0' }), false);
});

test('una base nueva de producción nace sin Sobusa ni sus rutas', () => {
  const base = abrir('produccion.db', { NODE_ENV: 'production' });
  assert.deepEqual(base.empresas, []);
  assert.deepEqual(base.rutas, []);
  // Las migraciones de siembra no quedan apuntadas: se pueden correr después.
  for (const version of SIEMBRA) assert.ok(!base.migraciones.includes(version), `migración ${version}`);
});

test('con la siembra encendida la base nueva queda como antes de T9.3', () => {
  const base = abrir('desarrollo.db', {});
  assert.deepEqual(base.empresas, [{ company_id: 'EMP-01', name: 'Sobusa' }]);
  assert.deepEqual(base.rutas, SOBUSA);
  for (const version of SIEMBRA) assert.ok(base.migraciones.includes(version), `migración ${version}`);
});

test('encender la siembra después llena una base que nació vacía', () => {
  const vacia = abrir('tarde.db', { YA_VIENE_SEED_DEMO: '0' });
  assert.deepEqual(vacia.rutas, []);
  const sembrada = abrir('tarde.db', { YA_VIENE_SEED_DEMO: '1' });
  assert.deepEqual(sembrada.empresas, [{ company_id: 'EMP-01', name: 'Sobusa' }]);
  assert.deepEqual(sembrada.rutas, SOBUSA);
});

test('apagar la siembra no borra una base ya sembrada', () => {
  abrir('ya-sembrada.db', {});
  const despues = abrir('ya-sembrada.db', { NODE_ENV: 'production' });
  assert.deepEqual(despues.rutas, SOBUSA);
});

test('flota demo sin siembra: el arranque lo avisa', () => {
  const { avisos } = validateConfig({ JWT_SECRET: 'x'.repeat(32), PIN: '1234', YA_VIENE_SEED_DEMO: '0' });
  assert.ok(avisos.some((aviso) => /sin siembra/.test(aviso)), avisos.join('\n'));
});

// La suite entera asume la base sembrada; `tests/entorno.ts` la fija para que
// un YA_VIENE_SEED_DEMO=0 (o un NODE_ENV=production) exportado en la consola
// no tumbe caos_catalogo y carga ni cuelgue la corrida.
test('la suite corre sembrada aunque el entorno diga lo contrario', () => {
  const scripts = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
    .scripts as Record<string, string>;
  const sinEntorno = Object.entries(scripts)
    .filter(([, orden]) => /node .*--test\b/.test(orden))
    .filter(([, orden]) => !orden.includes('--import ./tests/entorno.ts'))
    .map(([nombre]) => nombre);
  assert.deepEqual(sinEntorno, [], 'scripts de prueba sin --import ./tests/entorno.ts');
  assert.equal(siembraDemoHabilitada(), true);
});

// Los backends de la suite heredan el entorno con secretos de prueba cortos:
// si pasara YA_VIENE_EXPUESTO=1 o NODE_ENV=production, las guardias de
// secretos los tumbaban al arrancar (38 pruebas rojas).
test('la suite no hereda las guardias de un backend expuesto', () => {
  const hijo = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--import', './tests/entorno.ts', '-e',
      'console.log(JSON.stringify([process.env.YA_VIENE_EXPUESTO, process.env.NODE_ENV]))'],
    {
      cwd: join(__dirname, '..'),
      env: { ...process.env, YA_VIENE_EXPUESTO: '1', NODE_ENV: 'production' },
      encoding: 'utf8',
    },
  );
  assert.equal(hijo.status, 0, hijo.stderr);
  assert.deepEqual(JSON.parse(hijo.stdout), [null, null]);
});
