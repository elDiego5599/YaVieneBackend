// El parche de `broker.ts` sobre mqemitter, y lo que lo mantiene en pie.
//
// mqemitter drena su cola de forma síncrona, un `_do()` por mensaje; con una
// ráfaga grande la recursión revienta la pila. `broker.ts` reemplaza
// `MQEmitter.prototype._do` por uno que difiere cada paso a otro tick. Es un
// parche sobre un método privado, así que se rompe en silencio de tres
// maneras, y esta prueba falla con cada una:
//
// 1. una versión nueva de mqemitter renombra o quita `_do`: el parche
//    envolvería `undefined` y el primer mensaje tumbaría el broker;
// 2. el `require('mqemitter')` de `broker.ts` resuelve a una copia distinta
//    de la que usa aedes (dos versiones en el árbol): se parchea una que
//    nadie usa y la pila vuelve a reventar con la ráfaga;
// 3. un `npm install` sube aedes o mqemitter por el `^` a una versión que
//    nadie probó con el parche. Por eso van fijas en package.json.
//
// Subir a aedes 1.x no quita el parche: con aedes 1.2.0 y mqemitter 7.1.0,
// el replay del túnel (tests/e2e/h1_tunnel.js, 5 000 posiciones en 24 ms)
// sin el parche tumba el backend con «Maximum call stack size exceeded» a
// las 100 aceptadas, y con el parche las acepta todas. Se queda en 0.51.3
// hasta que una subida traiga su propia razón.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-mqemitter-'));
process.env.YA_VIENE_DB_PATH = join(tmp, 'test.db');
process.env.JWT_SECRET = 'mqemitter-jwt-secret';

// require y no import: broker.ts abre la base al evaluarse, y un import se
// izaría por encima de las líneas de arriba.
require('../src/mqtt/broker');

test.after(() => rmSync(tmp, { recursive: true, force: true }));

test('broker.ts parchea el mismo mqemitter que usa aedes', () => {
  const desdeAedes = require.resolve('mqemitter', { paths: [dirname(require.resolve('aedes'))] });
  assert.equal(require.resolve('mqemitter'), desdeAedes);

  const modulo = require(desdeAedes);
  const MQEmitter = modulo.MQEmitter ?? modulo;
  assert.equal(typeof MQEmitter.prototype._do, 'function');
  assert.equal(MQEmitter.prototype._do.name, 'patchedDo');
});

// El parche difiere cada entrega a otro tick. Lo que no puede costar es
// perder un mensaje o desordenarlos: la regla de «posición más nueva» de las
// apps se apoya en que llegan en el orden en que se publicaron.
test('con el parche, una ráfaga grande llega entera y en orden', async () => {
  const modulo = require('mqemitter');
  const crear = modulo.MQEmitter ? (o: object) => new modulo.MQEmitter(o) : modulo;
  const emisor = crear({ concurrency: 1 });
  const recibidos: number[] = [];
  const TOTAL = 20_000;
  await new Promise<void>((listo) => emisor.on('rafaga', (m: { n: number }, cb: () => void) => {
    recibidos.push(m.n);
    cb();
    if (recibidos.length === TOTAL) listo();
  }, () => {
    for (let n = 0; n < TOTAL; n++) emisor.emit({ topic: 'rafaga', n });
  }));
  assert.equal(recibidos.length, TOTAL);
  assert.ok(recibidos.every((n, i) => n === i));
});

test('aedes y mqemitter van fijos, sin rango', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  for (const nombre of ['aedes', 'mqemitter']) {
    const version = pkg.dependencies?.[nombre];
    assert.match(String(version), /^\d+\.\d+\.\d+$/, `${nombre}: «${version}»`);
    assert.equal(require(`${nombre}/package.json`).version, version, nombre);
  }
});
