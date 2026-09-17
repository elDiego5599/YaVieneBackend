// Un nombre con eñe partido entre dos paquetes.
//
// El cuerpo de una petición no llega entero: llega en trozos, y el corte
// cae donde quiera la red. Armarlo con `chunk.toString()` decodifica cada
// trozo por separado, así que una letra de dos bytes que quede a caballo
// entre dos se pierde: lo que sale al otro lado es «Mu<?><?>oz», con el
// rombo del carácter de reemplazo, y ya no hay forma de recuperarla. En
// esta ciudad eso es el pan de cada día —Muñoz, Peñalosa, Ibáñez— y el
// nombre queda escrito así para siempre en la base.
//
// El corte no se puede pedir por `fetch`, que manda el cuerpo de una vez,
// así que la petición se escribe a mano por el socket en dos tandas con
// una pausa en medio, que es lo que obliga al servidor a leer dos veces.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const CLAVE_ADMIN = 'clave-de-administracion-de-prueba';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-cuerpo-'));
process.env.YA_VIENE_DB_PATH = join(tmp, 'test.db');
process.env.ADMIN_API_KEY = CLAVE_ADMIN;

// require y no import: estos módulos abren la base al evaluarse, y un import
// se izaría por encima de la línea que fija la ruta.
const { handleAPI } = require('../src/api/routes') as typeof import('../src/api/routes');

const servidor: Server = createServer((req, res) => {
  if (!handleAPI(req, res)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

let puerto = 0;

test.before(async () => {
  await new Promise<void>((listo) => servidor.listen(0, '127.0.0.1', listo));
  const dir = servidor.address();
  puerto = typeof dir === 'object' && dir ? dir.port : 0;
});

test.after(async () => {
  await new Promise<void>((listo) => servidor.close(() => listo()));
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Manda un POST cuyo cuerpo sale en dos tandas, cortado justo por donde
 * diga `corte` (en bytes). Devuelve el JSON de la respuesta.
 */
function postPartido(ruta: string, cuerpo: Buffer, corte: number): Promise<Record<string, unknown>> {
  return new Promise((listo, falla) => {
    const socket = connect(puerto, '127.0.0.1', () => {
      socket.write(
        `POST ${ruta} HTTP/1.1\r\n` +
          'Host: 127.0.0.1\r\n' +
          'Content-Type: application/json\r\n' +
          `X-Admin-Key: ${CLAVE_ADMIN}\r\n` +
          `Content-Length: ${cuerpo.length}\r\n` +
          'Connection: close\r\n\r\n',
      );
      socket.write(cuerpo.subarray(0, corte));
      // La pausa es la que separa las dos lecturas: sin ella el sistema
      // junta los dos trozos y el servidor los ve como uno solo.
      setTimeout(() => socket.end(cuerpo.subarray(corte)), 50);
    });

    const trozos: Buffer[] = [];
    socket.on('data', (t: Buffer) => trozos.push(t));
    socket.on('error', falla);
    socket.on('end', () => {
      const texto = Buffer.concat(trozos).toString('utf8');
      // La respuesta viaja troceada, con el tamaño de cada trozo en medio:
      // el JSON es el de la primera llave a la última, sin ese andamiaje.
      const json = texto.slice(texto.indexOf('{'), texto.lastIndexOf('}') + 1);
      try {
        listo(JSON.parse(json) as Record<string, unknown>);
      } catch {
        falla(new Error(`respuesta ilegible: ${texto}`));
      }
    });
  });
}

const alta = (nombre: string): Buffer =>
  Buffer.from(
    JSON.stringify({
      phoneNumber: '3009990001',
      name: nombre,
      routeId: 'R-101',
      busId: 'BUS-UTF8',
      companyId: 'EMP-01',
      pin: '1234',
    }),
    'utf8',
  );

test('un nombre con eñe llega entero aunque se parta entre dos trozos', async () => {
  const cuerpo = alta('Muñoz');
  // Justo en medio de la eñe: el primer byte va en una tanda y el segundo
  // en la otra, que es el peor corte posible y el que la red hace sola.
  const corte = cuerpo.indexOf(Buffer.from('ñ', 'utf8')) + 1;
  assert.ok(corte > 1, 'la eñe tiene que estar en el cuerpo');

  const respuesta = await postPartido('/api/admin/drivers', cuerpo, corte);
  const driver = respuesta.driver as Record<string, unknown> | undefined;

  assert.equal(respuesta.status, 'provisioned', JSON.stringify(respuesta));
  assert.equal(driver?.name, 'Muñoz');
});

test('el corte tampoco rompe un cuerpo de puro alfabeto inglés', async () => {
  const cuerpo = alta('Smith');
  const respuesta = await postPartido('/api/admin/drivers', cuerpo, cuerpo.indexOf('Smith') + 2);
  const driver = respuesta.driver as Record<string, unknown> | undefined;

  assert.equal(driver?.name, 'Smith');
});
