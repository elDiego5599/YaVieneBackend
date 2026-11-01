// AUD29-12: las cabeceras de seguridad se ponen en un solo sitio.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';

import { HSTS_MAX_AGE_S, ponerCabecerasSeguridad } from '../src/security/cabeceras';

function cabecerasPara(proto?: string | string[]): Record<string, string> {
  const puestas: Record<string, string> = {};
  const res = { setHeader: (k: string, v: string) => (puestas[k.toLowerCase()] = v) };
  const req = { headers: proto === undefined ? {} : { 'x-forwarded-proto': proto } };
  ponerCabecerasSeguridad(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  return puestas;
}

test('HSTS de un año solo cuando el cliente llegó por HTTPS', () => {
  assert.equal(HSTS_MAX_AGE_S, 31_536_000);
  assert.equal(cabecerasPara('https')['strict-transport-security'], 'max-age=31536000');
  assert.equal(cabecerasPara('HTTPS')['strict-transport-security'], 'max-age=31536000');
  // Tras varios proxies manda el primero, el del cliente.
  assert.equal(cabecerasPara('https, http')['strict-transport-security'], 'max-age=31536000');
  assert.equal(cabecerasPara('http, https')['strict-transport-security'], undefined);
  assert.equal(cabecerasPara('http')['strict-transport-security'], undefined);
  assert.equal(cabecerasPara()['strict-transport-security'], undefined);
  assert.deepEqual(
    Object.keys(cabecerasPara()).sort(),
    ['referrer-policy', 'x-content-type-options', 'x-frame-options'],
  );
});

test('nadie más que el ayudante escribe esas cabeceras', () => {
  for (const archivo of ['src/index.ts', 'src/api/routes.ts']) {
    const fuente = readFileSync(join(__dirname, '..', archivo), 'utf8');
    assert.doesNotMatch(fuente, /'X-Content-Type-Options'|'X-Frame-Options'|'Referrer-Policy'/, archivo);
  }
});
