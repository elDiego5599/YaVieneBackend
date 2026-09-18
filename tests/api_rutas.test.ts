// El identificador de ruta que llega por la vía REST.
//
// El socket lo revisa desde que se cerró YV-09 (`handler.ts:243`): si no
// tiene forma de ruta, no abre sala. La vía REST no lo revisaba, así que
// `GET /api/routes/<lo que sea>/positions` bajaba hasta la base con
// cualquier cadena y contestaba 200 con esa misma cadena escrita en el
// cuerpo. Lo que hace daño no es la consulta —sale vacía— sino la
// respuesta: cualquiera puede elegir qué le devuelve el servidor y con qué
// forma, y el pasajero se queda sin saber si preguntó mal.
//
// Aquí no se levanta el backend entero: basta con el mismo manejador que
// monta `index.ts` sobre un servidor de usar y tirar, en el puerto que dé
// el sistema. Así la prueba no se pelea por puertos con las demás, que
// corren a la vez.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-api-rutas-'));
process.env.YA_VIENE_DB_PATH = join(tmp, 'test.db');

// require y no import: estos módulos abren la base al evaluarse, y un import
// se izaría por encima de la línea que fija la ruta.
const { handleAPI } = require('../src/api/routes') as typeof import('../src/api/routes');
const { addCompanyRoute } = require('../src/data/routes_store') as typeof import('../src/data/routes_store');

const servidor: Server = createServer((req, res) => {
  if (!handleAPI(req, res)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

let base = '';

test.before(async () => {
  await new Promise<void>((listo) => servidor.listen(0, '127.0.0.1', listo));
  const dir = servidor.address();
  base = `http://127.0.0.1:${typeof dir === 'object' && dir ? dir.port : 0}`;
});

test.after(async () => {
  await new Promise<void>((listo) => servidor.close(() => listo()));
  rmSync(tmp, { recursive: true, force: true });
});

async function posiciones(routeId: string): Promise<{ estado: number; cuerpo: Record<string, unknown> }> {
  // Sin codificar: lo que se prueba es lo que viaja por la URL tal cual, que
  // es como lo escribe quien quiera probar suerte.
  const r = await fetch(`${base}/api/routes/${routeId}/positions`);
  return { estado: r.status, cuerpo: (await r.json()) as Record<string, unknown> };
}

test('la vía REST rechaza un identificador de ruta con mala forma', async () => {
  // Los cuatro de la ficha: demasiado corto, demasiado largo, con espacio y
  // con un byte nulo colado en la URL. El de 21 se pasa por uno del tope.
  const malos = ['R', 'R'.repeat(21), 'R-1%20mala', 'R-101%00'];

  for (const routeId of malos) {
    const { estado, cuerpo } = await posiciones(routeId);
    assert.equal(estado, 400, `${routeId} debería dar 400 y dio ${estado}`);
    // El mismo error para los cuatro, palabra por palabra: la respuesta no
    // repite nada de lo que le mandaron, que es justo lo que se corrige.
    assert.deepEqual(cuerpo.error, {
      code: 'INVALID_ROUTE',
      message: 'routeId debe tener forma de ruta (ej. R-101)',
    });
  }
});

test('una ruta bien formada sigue contestando, exista o no', async () => {
  // `isRouteId` solo mira la forma, igual que en el socket: una ruta que no
  // existe contesta 200 con la lista vacía, que es lo que la app espera
  // cuando todavía no hay buses.
  const { estado, cuerpo } = await posiciones('R-101');
  assert.equal(estado, 200);
  assert.equal(cuerpo.routeId, 'R-101');
  assert.deepEqual(cuerpo.buses, []);
});

test('las rutas de una empresa traen su identificador como routeId', async () => {
  // El resto del contrato —posiciones, panel, sockets— lo llama `routeId`, y
  // esta lista era la única que lo llamaba `id`. Durante una versión van los
  // dos con el mismo valor: las apps ya instaladas leen `id`, las nuevas
  // leen `routeId`. Cuando no quede una app vieja, `id` se retira.
  assert.deepEqual(addCompanyRoute('EMP-CONTRATO', 'R-777', 'Contrato'), {
    routeId: 'R-777',
    name: 'Contrato',
  });
  const r = await fetch(`${base}/api/companies/EMP-CONTRATO/routes`);
  assert.equal(r.status, 200);
  const [ruta] = (await r.json()) as Record<string, unknown>[];
  assert.equal(ruta.routeId, 'R-777');
  assert.equal(ruta.id, 'R-777');
  assert.equal(ruta.companyId, 'EMP-CONTRATO');
});
