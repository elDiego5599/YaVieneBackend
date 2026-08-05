import assert from 'node:assert/strict';
import test from 'node:test';

import { hashPin, verifyPin } from '../src/auth/passwords';
import { signToken, verifyToken } from '../src/auth/tokens';
import { FixedWindowRateLimiter } from '../src/security/rate_limiter';

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
  const limiter = new FixedWindowRateLimiter(2, 60_000);
  assert.equal(limiter.allow('test-key'), true);
  assert.equal(limiter.allow('test-key'), true);
  assert.equal(limiter.allow('test-key'), false);
  assert.equal(limiter.allow('other-key'), true);
});
