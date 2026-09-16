import assert from 'node:assert/strict';
import { createServer, IncomingMessage, request } from 'node:http';
import test from 'node:test';

process.env.JWT_SECRET = 'test-jwt-secret';
process.env.ADMIN_API_KEY = 'test-admin-key';

import { hashPin, verifyPin } from '../src/auth/passwords';
import { signToken, verifyToken } from '../src/auth/tokens';
import { requestKey, SlidingWindowRateLimiter } from '../src/security/rate_limiter';

function peticionFalsa(remoteAddress: string, headers: Record<string, string> = {}): IncomingMessage {
  return { socket: { remoteAddress }, headers } as unknown as IncomingMessage;
}

test('requestKey: X-Forwarded-For solo cuenta si la conexión viene del túnel en loopback', () => {
  // Desde internet la cabecera la escribe el cliente: si contara, cada
  // intento traería una IP inventada y un cupo nuevo.
  assert.equal(
    requestKey(peticionFalsa('203.0.113.5', { 'x-forwarded-for': '1.2.3.4' })),
    '203.0.113.5',
  );
  // Detrás de ngrok manda el último salto, el que añadió el túnel.
  assert.equal(
    requestKey(peticionFalsa('127.0.0.1', { 'x-forwarded-for': '9.9.9.9, 1.2.3.4' }), 'read'),
    '1.2.3.4:read',
  );
});

test('requestKey: en Fly cuenta por Fly-Client-IP, y fuera de Fly la cabecera no vale nada', () => {
  const previo = process.env.FLY_APP_NAME;
  try {
    delete process.env.FLY_APP_NAME;
    assert.equal(
      requestKey(peticionFalsa('172.16.0.2', { 'fly-client-ip': '1.2.3.4' })),
      '172.16.0.2',
      'fuera de Fly cualquiera podría mandar la cabecera',
    );

    // En Fly todas las conexiones llegan desde el proxy: sin la cabecera,
    // dos pasajeros distintos compartían cupo.
    process.env.FLY_APP_NAME = 'yaviene-backend';
    assert.equal(
      requestKey(peticionFalsa('172.16.0.2', { 'fly-client-ip': '1.2.3.4' }), 'login'),
      '1.2.3.4:login',
    );
    assert.equal(
      requestKey(peticionFalsa('172.16.0.2', { 'fly-client-ip': '5.6.7.8' }), 'login'),
      '5.6.7.8:login',
    );
  } finally {
    if (previo === undefined) delete process.env.FLY_APP_NAME;
    else process.env.FLY_APP_NAME = previo;
  }
});

// El servidor escucha en '::', así que una conexión IPv4 desde loopback no
// llega como '127.0.0.1' sino como '::ffff:127.0.0.1' (IPv4 mapeada). Si la
// comparación mira la cadena tal cual, el túnel deja de ser de confianza
// —se ignora X-Forwarded-For— y todos los que entren por él comparten una
// sola clave: 120 lecturas por minuto entre todas las apps.
test('requestKey: loopback IPv4 mapeado es el mismo túnel de confianza', () => {
  assert.equal(
    requestKey(peticionFalsa('::ffff:127.0.0.1', { 'x-forwarded-for': '9.9.9.9, 1.2.3.4' }), 'read'),
    '1.2.3.4:read',
  );
  // Y sin cabecera, la clave va sin el prefijo: si no, el mismo cliente
  // ocupa dos cupos distintos según por dónde entre.
  assert.equal(requestKey(peticionFalsa('::ffff:203.0.113.5')), '203.0.113.5');
});

// La de arriba usa una petición construida a mano; esta comprueba contra un
// socket de verdad que el sistema produce esa forma, que es justo lo que la
// anterior da por supuesto. Vale para cualquiera de las dos formas: lo que
// se exige es que una conexión real por loopback sea de confianza.
test('requestKey: socket real por loopback IPv4 contra listen(::)', async () => {
  const visto: { direccion?: string; clave?: string } = {};
  const server = createServer((req, res) => {
    visto.direccion = req.socket.remoteAddress ?? undefined;
    visto.clave = requestKey(req, 'read');
    res.end('ok');
  });
  await new Promise<void>((listo) => server.listen(0, '::', listo));
  const { port } = server.address() as { port: number };
  try {
    await new Promise<void>((listo, falla) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          family: 4,
          headers: { 'x-forwarded-for': '9.9.9.9, 1.2.3.4' },
        },
        (res) => {
          res.resume();
          res.on('end', listo);
        },
      );
      req.on('error', falla);
      req.end();
    });
  } finally {
    await new Promise<void>((listo) => server.close(() => listo()));
  }
  assert.equal(
    visto.clave,
    '1.2.3.4:read',
    `el socket llegó como ${visto.direccion}, así que el túnel no contó como de confianza`,
  );
});

test('PIN hashing never validates the wrong PIN', () => {
  const hash = hashPin('2468');
  assert.notEqual(hash, '2468');
  assert.equal(verifyPin('2468', hash), true);
  assert.equal(verifyPin('0000', hash), false);
});

test('JWT validates canonical claims and rejects tampering', () => {
  const token = signToken({
    sub: 'driver-1',
    driverId: 'driver-1',
    phoneNumber: '3000000000',
    role: 'driver',
    companyId: 'EMP-01',
    busId: 'B-042',
    routeId: 'R-101',
    sessionId: 'session-1',
  });

  assert.equal(verifyToken(token)?.sessionId, 'session-1');
  assert.equal(verifyToken(`${token}tampered`), null);
});

// El token del panel lleva la versión de la credencial; uno emitido antes de
// que existiera no la trae y no debe seguir abriendo la flota.
test('JWT de panel sin versión de credencial no valida', () => {
  const admin = { sub: 'admin-1', role: 'admin', companyId: 'EMP-01', username: 'jefa' } as const;
  assert.equal(verifyToken(signToken({ ...admin, tv: 3 }))?.role, 'admin');
  assert.equal(verifyToken(signToken(admin as never)), null);
  assert.equal(verifyToken(signToken({ ...admin, tv: '3' } as never)), null);
});

test('rate limiter rejects after the configured window budget', () => {
  const limiter = new SlidingWindowRateLimiter(2, 60_000);
  assert.equal(limiter.allow('test-key'), true);
  assert.equal(limiter.allow('test-key'), true);
  assert.equal(limiter.allow('test-key'), false);
  assert.equal(limiter.allow('other-key'), true);
});
