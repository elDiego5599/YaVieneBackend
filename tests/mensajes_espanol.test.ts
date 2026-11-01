// AUD29-15: quien lee un error del backend (el panel, la app, la landing o
// alguien con curl) lo lee en español. Los códigos (`RATE_LIMITED`…) siguen
// en inglés: son el contrato y los clientes deciden por ellos, no por el
// texto. Se lee el código fuente para atrapar también los errores que
// ninguna prueba provoca.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

// Palabras que solo salen en una frase en inglés; ninguna es español.
const INGLES = /\b(is|are|must|not|too|many|invalid|the|and|cannot|required|found|allowed|only|request|body)\b/i;

function fuente(archivo: string): string {
  return readFileSync(join(__dirname, '..', 'src', archivo), 'utf8');
}

/** Los textos de `writeError(res, 400, 'CODIGO', 'texto')`, literales o plantillas. */
function mensajesDeWriteError(codigo: string): string[] {
  return [...codigo.matchAll(/writeError\(\s*\w+,\s*\d+,\s*'[A-Z_]+',\s*(['`])((?:(?!\1).)*)\1/gs)].map((m) => m[2]);
}

test('los mensajes de error de la API están en español', () => {
  const mensajes = mensajesDeWriteError(fuente('api/routes.ts'));
  assert.ok(mensajes.length >= 90, `solo se leyeron ${mensajes.length} mensajes`);
  const enIngles = mensajes.filter((m) => INGLES.test(m.replace(/\$\{[^}]*\}/g, '')));
  assert.deepEqual(enIngles, []);
});

test('el 404, el socket y el arranque también hablan español', () => {
  assert.doesNotMatch(fuente('index.ts'), /error: 'Not found'/);
  assert.doesNotMatch(fuente('socket/handler.ts'), /'Too many connections'|'Forbidden event'/);
  assert.doesNotMatch(fuente('auth/http.ts'), /is required in production/);
});
