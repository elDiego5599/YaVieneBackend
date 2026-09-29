// `npm test` no compila antes de correr. Una prueba que arranca el
// `dist/` compilado prueba lo que haya en disco —una build vieja o ninguna—,
// no el `src/` que se está revisando: la auditoría del 2026-09-27 (R-06) vio
// el CRUD de flota caer con «Backend did not become ready» en una copia sin
// `dist/`, y pasar en verde con un `dist/` viejo aunque `src/` estuviera roto.
//
// Esta prueba exige que ninguna prueba arranque el `dist/`: todas levantan el
// servidor con `--import tsx src/index.ts`.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const carpeta = __dirname;
// Armado por partes para que este archivo no se delate a sí mismo.
const prohibido = ['dist', 'index.js'].join('/');

test('ninguna prueba arranca el dist/ compilado en vez de src/', () => {
  const culpables = readdirSync(carpeta)
    .filter((nombre) => nombre.endsWith('.test.ts'))
    .filter((nombre) => readFileSync(join(carpeta, nombre), 'utf8').includes(prohibido));
  assert.deepEqual(culpables, [], `Arrancan ${prohibido}; usar --import tsx src/index.ts`);
});
