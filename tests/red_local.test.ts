// El API escucha en '::' y, fuera de producción, solo atiende a esta misma
// máquina.
//
// En el Mac el backend corre en desarrollo y el público entra por ngrok, que
// llega por loopback. Pero '::' abre también el puerto a la Wi-Fi donde esté
// el Mac: en la sala del pitch cualquiera alcanzaba el API en HTTP plano, sin
// túnel ni TLS. Estas pruebas fijan el cierre: loopback pasa, lo demás se
// cierra al conectar, y Fly (producción, detrás de su proxy) no se ve
// afectado.
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import test from 'node:test';
import { validateConfig } from '../src/config';
import {
  aceptaRemotos,
  cerrarRedLocal,
  esLoopback,
} from '../src/security/red_local';

const JWT_LARGO = 'j'.repeat(64);

test('esLoopback: las tres formas en que llega esta misma máquina', () => {
  assert.equal(esLoopback('127.0.0.1'), true);
  // Todo 127/8 es loopback, no solo la .1.
  assert.equal(esLoopback('127.4.5.6'), true);
  assert.equal(esLoopback('::1'), true);
  // En doble pila una conexión IPv4 llega con la dirección mapeada a IPv6.
  assert.equal(esLoopback('::ffff:127.0.0.1'), true);
});

test('esLoopback: la red local y lo desconocido no pasan', () => {
  assert.equal(esLoopback('192.168.1.20'), false);
  assert.equal(esLoopback('::ffff:192.168.1.20'), false);
  assert.equal(esLoopback('10.0.0.5'), false);
  assert.equal(esLoopback('fe80::1'), false);
  // Parecido no es igual: 127 tiene que ser el primer octeto entero.
  assert.equal(esLoopback('1127.0.0.1'), false);
  assert.equal(esLoopback('::ffff:1127.0.0.1'), false);
  // Un socket que ya se cerró no tiene dirección: se trata como remoto.
  assert.equal(esLoopback(undefined), false);
  assert.equal(esLoopback(''), false);
});

test('aceptaRemotos: solo producción o la variable explícita', () => {
  assert.equal(aceptaRemotos({}), false);
  assert.equal(aceptaRemotos({ NODE_ENV: 'development' }), false);
  assert.equal(aceptaRemotos({ NODE_ENV: 'production' }), true);
  assert.equal(aceptaRemotos({ HTTP_ALLOW_REMOTE: '1' }), true);
  // Solo «1» abre: un «0» o un «true» escrito a medias no.
  assert.equal(aceptaRemotos({ HTTP_ALLOW_REMOTE: '0' }), false);
  assert.equal(aceptaRemotos({ HTTP_ALLOW_REMOTE: 'true' }), false);
});

test('validateConfig: abrir el API a la red local fuera de producción avisa', () => {
  const abierto = validateConfig({ JWT_SECRET: JWT_LARGO, HTTP_ALLOW_REMOTE: '1' });
  assert.deepEqual(abierto.errores, []);
  assert.equal(abierto.avisos.length, 1);
  assert.match(abierto.avisos[0], /HTTP_ALLOW_REMOTE/);

  // Sin la variable no hay nada que avisar: el cierre es lo normal.
  assert.deepEqual(validateConfig({ JWT_SECRET: JWT_LARGO }).avisos, []);
});

/** Pide `/` a `host` y resuelve con el código, o con el error de red. */
function pedir(host: string, puerto: number): Promise<number | string> {
  return new Promise((resolve) => {
    const req = get({ host, port: puerto, path: '/', timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? e.message));
  });
}

async function servidor(env: NodeJS.ProcessEnv) {
  const server = createServer((_req, res) => res.end('ok'));
  cerrarRedLocal(server, env);
  await new Promise<void>((r) => server.listen(0, '::', r));
  const puerto = (server.address() as AddressInfo).port;
  return { server, puerto };
}

/** Una dirección IPv4 de esta máquina que no es loopback (la de la Wi-Fi). */
function ipDeLaRed(): string | undefined {
  for (const lista of Object.values(networkInterfaces())) {
    for (const d of lista ?? []) {
      if (d.family === 'IPv4' && !d.internal) return d.address;
    }
  }
  return undefined;
}

test('cerrarRedLocal: loopback entra por IPv4 y por IPv6', async () => {
  const { server, puerto } = await servidor({});
  try {
    assert.equal(await pedir('127.0.0.1', puerto), 200);
    assert.equal(await pedir('::1', puerto), 200);
  } finally {
    server.close();
  }
});

const ip = ipDeLaRed();

test('cerrarRedLocal: desde la red local se cierra al conectar', { skip: ip ? false : 'sin interfaz de red' }, async () => {
  const { server, puerto } = await servidor({});
  try {
    const r = await pedir(ip!, puerto);
    assert.notEqual(r, 200, 'la red local no debería recibir respuesta');
  } finally {
    server.close();
  }
});

test('cerrarRedLocal: en producción la red sí entra', { skip: ip ? false : 'sin interfaz de red' }, async () => {
  const { server, puerto } = await servidor({ NODE_ENV: 'production' });
  try {
    assert.equal(await pedir(ip!, puerto), 200);
  } finally {
    server.close();
  }
});
