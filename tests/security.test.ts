import assert from 'node:assert/strict';
import { IncomingMessage } from 'node:http';
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

test('rate limiter rejects after the configured window budget', () => {
  const limiter = new SlidingWindowRateLimiter(2, 60_000);
  assert.equal(limiter.allow('test-key'), true);
  assert.equal(limiter.allow('test-key'), true);
  assert.equal(limiter.allow('test-key'), false);
  assert.equal(limiter.allow('other-key'), true);
});
