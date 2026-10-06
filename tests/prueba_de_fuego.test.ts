// La prueba de fuego (`npm run fuego`) rompe `src/` a propósito y exige que la
// suite lo note. Su lista de mutaciones busca texto exacto: si alguien cambia
// una de esas líneas, la mutación dejaría de aplicar y la pieza quedaría sin
// vigilar sin que nadie se enterara. Esto lo dice en la suite normal.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

// @ts-expect-error: el script es .mjs sin tipos.
import { MUTACIONES } from '../scripts/prueba-de-fuego.mjs';

type Mutacion = { archivo: string; de: string; a: string; que: string };

test('cada mutación de la prueba de fuego aplica una sola vez y cambia algo', () => {
  const lista = MUTACIONES as Mutacion[];
  assert.ok(lista.length >= 30, 'la lista se encogió');
  for (const [i, m] of lista.entries()) {
    const fuente = readFileSync(join(__dirname, '..', m.archivo), 'utf8');
    assert.equal(fuente.split(m.de).length, 2, `#${i + 1} (${m.que}): «${m.de}» no está una sola vez en ${m.archivo}`);
    assert.notEqual(m.de, m.a, `#${i + 1} no cambia nada`);
  }
});
