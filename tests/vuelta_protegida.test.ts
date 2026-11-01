import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { getMetrics } from '../src/observability/metrics';
import { vueltaProtegida } from '../src/observability/vuelta_protegida';

test('una vuelta que lanza no sube: cuenta su métrica y deja seguir el reloj', (t) => {
  const errores = t.mock.method(console, 'error', () => {});
  const antes = getMetrics().counters['prueba.vuelta.error'] ?? 0;
  const vuelta = vueltaProtegida('Prueba', 'prueba.vuelta.error', () => {
    throw new Error('disco lleno');
  });
  assert.doesNotThrow(vuelta);
  assert.doesNotThrow(vuelta);
  assert.equal(getMetrics().counters['prueba.vuelta.error'], antes + 2);
  assert.equal(errores.mock.callCount(), 2);
});

test('cada reloj del servidor corre dentro de una vuelta protegida (AUD29-05)', () => {
  const codigo = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  const relojes = [...codigo.matchAll(/setInterval\(\s*([^\n]*)/g)].map((m) => m[1]);
  assert.ok(relojes.length >= 8, `solo ${relojes.length} relojes: ¿cambió la forma de index.ts?`);
  for (const reloj of relojes) assert.match(reloj, /^vueltaProtegida\(/);
});
