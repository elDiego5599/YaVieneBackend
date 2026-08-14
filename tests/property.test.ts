import assert from 'node:assert/strict';
import test from 'node:test';
import * as fc from 'fast-check';

import { haversineDistanceKm, sanityCheck, MAX_SPEED_KMH, EARTH_RADIUS_KM } from '../src/security/physics';
import { FixedWindowRateLimiter } from '../src/security/rate_limiter';
import { hashPin, verifyPin } from '../src/auth/passwords';

const lat = fc.float({ min: -90, max: 90, noNaN: true, noInteger: true });
const lon = fc.float({ min: -180, max: 180, noNaN: true, noInteger: true });

test('haversine: simetria, identidad, acotacion y consistencia a pequenas distancias', () => {
  fc.assert(
    fc.property(lat, lon, lat, lon, (lat1, lon1, lat2, lon2) => {
      const d = haversineDistanceKm(lat1, lon1, lat2, lon2);
      assert.equal(d, haversineDistanceKm(lat2, lon2, lat1, lon1), 'debe ser simetrica');
      assert.ok(Number.isFinite(d), 'nunca NaN/Infinity');
      assert.ok(d >= 0, 'nunca negativa');
      assert.ok(d <= Math.PI * EARTH_RADIUS_KM + 0.001, 'acotada por media circunferencia');
      return true;
    }),
    { numRuns: 400 },
  );
});

test('haversine: punto identico es cero y un grado de latitud mide ~111 km (lejos de los polos)', () => {
  fc.assert(
    fc.property(lat, lon, (a, b) => {
      assert.ok(haversineDistanceKm(a, b, a, b) <= 1e-9);
      return true;
    }),
    { numRuns: 200 },
  );
  const nearEquator = fc.float({ min: -2, max: 2, noNaN: true });
  fc.assert(
    fc.property(nearEquator, (a) => {
      const d = haversineDistanceKm(a, 0, a, 1);
      assert.ok(d > 110 && d < 112, `un grado de latitud debe ser ~111.19 km, dio ${d}`);
      return true;
    }),
    { numRuns: 100 },
  );
});

test('physics: cualquier velocidad fuera de [0, MAX] o no finita es rechazada', () => {
  fc.assert(
    fc.property(fc.oneof(fc.float({ min: Math.fround(MAX_SPEED_KMH + 0.1), max: 1e6, noNaN: true }), fc.float({ min: -1e6, max: Math.fround(-0.1), noNaN: true }), fc.constant(NaN), fc.constant(Infinity)), (speed) => {
      const result = sanityCheck('B-X', 'S1', null, 10.94, -74.78, speed, Date.now());
      assert.equal(result.accepted, false);
      assert.equal(result.reason, 'INVALID_REPORTED_SPEED');
      return true;
    }),
    { numRuns: 200 },
  );
});

test('physics: reloj en el futuro o mas de 15 min atras es rechazado', () => {
  fc.assert(
    fc.property(fc.integer({ min: 31_000, max: 86_400_000 }), (skew) => {
      const r = sanityCheck('B-X', 'S1', null, 10.94, -74.78, 30, Date.now() + skew);
      assert.equal(r.accepted, false);
      assert.equal(r.reason, 'FUTURE_CAPTURE_TIME');
      return true;
    }),
    { numRuns: 100 },
  );
  fc.assert(
    fc.property(fc.integer({ min: 15 * 60 * 1000 + 1, max: 86_400_000 }), (skew) => {
      const r = sanityCheck('B-X', 'S1', null, 10.94, -74.78, 30, Date.now() - skew);
      assert.equal(r.accepted, false);
      assert.equal(r.reason, 'CLOCK_DRIFT_EXCEEDED');
      return true;
    }),
    { numRuns: 100 },
  );
});

test('physics: secuencias desordenadas (capturedAt no creciente) son rechazadas', () => {
  fc.assert(
    fc.property(fc.nat({ max: 20_000 }), (n) => {
      const r = sanityCheck('B-X', 'S1', { sessionId: 'S1', lat: 10.94, lon: -74.78, capturedAt: Date.now() - 5_000 }, 10.94, -74.78, 30, Date.now() - 5_000 - n);
      assert.equal(r.accepted, false);
      assert.equal(r.reason, 'OUT_OF_ORDER_CAPTURE');
      return true;
    }),
    { numRuns: 100 },
  );
});

test('physics: teleportacion violando la velocidad maxima calculada es rechazada', () => {
  fc.assert(
    fc.property(fc.float({ min: Math.fround(0.1), max: 5, noNaN: true }), fc.float({ min: 1, max: 60, noNaN: true }), (distKm, elapsedSec) => {
      const speed = (distKm / elapsedSec) * 3600;
      if (speed <= MAX_SPEED_KMH) return true;
      const prev = { sessionId: 'S1', lat: 10.94, lon: -74.78, capturedAt: Date.now() - elapsedSec * 1000 };
      const r = sanityCheck('B-X', 'S1', prev, 10.94 + distKm / 111, -74.78, 30, Date.now());
      assert.equal(r.accepted, false, `salto de ${distKm} km en ${elapsedSec}s (${speed.toFixed(1)} km/h) debio rechazarse`);
      assert.equal(r.reason, 'SANITY_REJECTED');
      return true;
    }),
    { numRuns: 200 },
  );
});

test('physics: avance realista (~30 km/h) siempre es aceptado', () => {
  fc.assert(
    fc.property(fc.float({ min: Math.fround(0.01), max: 2, noNaN: true }), (distKm) => {
      const elapsedSec = (distKm / 8.33) * 3600;
      const prev = { sessionId: 'S1', lat: 10.94, lon: -74.78, capturedAt: Date.now() - elapsedSec * 1000 };
      const r = sanityCheck('B-X', 'S1', prev, 10.94 + distKm / 111, -74.78, 30, Date.now());
      assert.equal(r.accepted, true, `avance de ${distKm} km a 30 km/h debio aceptarse`);
      return true;
    }),
    { numRuns: 100 },
  );
});

test('rate limiter: el presupuesto exacto pasa, el primero extra se bloquea y la ventana se resetea', async () => {
  fc.assert(
    fc.property(fc.nat({ max: 30 }), fc.nat({ max: 50 }), (windowMs, leadMs) => {
      const limiter = new FixedWindowRateLimiter(3, Math.max(windowMs, 5));
      assert.equal(limiter.allow('k'), true);
      assert.equal(limiter.allow('k'), true);
      assert.equal(limiter.allow('k'), true);
      assert.equal(limiter.allow('k'), false, 'el 4o en la misma ventana debe bloquearse');
      assert.equal(limiter.allow('otra-clave'), true, 'claves independientes no se afectan');
      return true;
    }),
    { numRuns: 50 },
  );
  const limiter = new FixedWindowRateLimiter(2, 30);
  assert.equal(limiter.allow('k'), true);
  assert.equal(limiter.allow('k'), true);
  assert.equal(limiter.allow('k'), false);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(limiter.allow('k'), true, 'tras vencer la ventana el presupuesto se renueva');
});

test('passwords: hash nunca valida otro PIN, incluso con PINs casi identicos', () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 12 }), fc.string({ minLength: 1, maxLength: 12 }), (a, b) => {
      const hashA = hashPin(a);
      const r1 = verifyPin(a, hashA);
      const r2 = verifyPin(b, hashA);
      const ok = r1 === true && r2 === (a === b) && hashA !== b;
      if (!ok) console.log('  FAIL-PINS:', JSON.stringify(a), JSON.stringify(b), 'r1:', r1, 'r2:', r2);
      return ok;
    }),
    { numRuns: 200, verbose: 1 },
  );
});