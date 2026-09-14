// La zona de servicio: toda posición tiene que caer en el área metropolitana.
// Antes la primera posición de cada sesión entraba sin mirar dónde, y un
// equipo mal configurado —o uno robado— podía poner un bus en Bogotá.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { haversineDistanceKm, sanityCheck } from '../src/security/physics';
import { MARGEN_ZONA_KM, ZONA, dentroDeZona } from '../src/security/zona';

// El mismo archivo que dibuja la app del pasajero:
// app_pasajero/assets/data/rutas.json es una copia byte a byte.
const { rutas } = JSON.parse(
  readFileSync(join(__dirname, '..', 'scripts', 'data', 'rutas.json'), 'utf8'),
) as { rutas: { routeId: string; waypoints: { lat: number; lon: number }[] }[] };
const puntos = rutas.flatMap((r) => r.waypoints.map((w) => ({ ...w, routeId: r.routeId })));

const lats = puntos.map((p) => p.lat);
const lons = puntos.map((p) => p.lon);
const extremos = {
  latMin: Math.min(...lats),
  latMax: Math.max(...lats),
  lonMin: Math.min(...lons),
  lonMax: Math.max(...lons),
};
const medioLat = (ZONA.latMin + ZONA.latMax) / 2;
const medioLon = (ZONA.lonMin + ZONA.lonMax) / 2;

test('zona: todos los waypoints de rutas.json caen dentro', () => {
  assert.ok(puntos.length > 2_000, `se esperaban los ~2.100 waypoints, hay ${puntos.length}`);
  assert.deepEqual(puntos.filter((p) => !dentroDeZona(p.lat, p.lon)), []);
});

test('zona: el margen es de 2 km por cada lado, ni menos ni mucho más', () => {
  const margenes = {
    sur: haversineDistanceKm(extremos.latMin, medioLon, ZONA.latMin, medioLon),
    norte: haversineDistanceKm(extremos.latMax, medioLon, ZONA.latMax, medioLon),
    // Un grado de longitud mide menos cuanto más al norte: el margen este y
    // oeste se mide en las dos latitudes extremas.
    oesteSur: haversineDistanceKm(extremos.latMin, extremos.lonMin, extremos.latMin, ZONA.lonMin),
    oesteNorte: haversineDistanceKm(extremos.latMax, extremos.lonMin, extremos.latMax, ZONA.lonMin),
    esteSur: haversineDistanceKm(extremos.latMin, extremos.lonMax, extremos.latMin, ZONA.lonMax),
    esteNorte: haversineDistanceKm(extremos.latMax, extremos.lonMax, extremos.latMax, ZONA.lonMax),
  };
  for (const [lado, km] of Object.entries(margenes)) {
    assert.ok(km >= MARGEN_ZONA_KM, `margen ${lado} de ${km.toFixed(3)} km`);
    assert.ok(km < MARGEN_ZONA_KM + 0.1, `margen ${lado} de ${km.toFixed(3)} km: la caja quedó vieja`);
  }
});

test('zona: la primera posición de una sesión en Bogotá se rechaza', () => {
  assert.deepEqual(
    sanityCheck('B-X', 'S1', null, 4.711, -74.0721, 30, Date.now()),
    { accepted: false, reason: 'FUERA_DE_ZONA' },
  );
  // Y con una anterior de la misma sesión también: la zona va primero.
  const anterior = { sessionId: 'S1', lat: 10.97, lon: -74.8, capturedAt: Date.now() - 600_000 };
  assert.equal(sanityCheck('B-X', 'S1', anterior, 4.711, -74.0721, 30, Date.now()).reason, 'FUERA_DE_ZONA');
});

test('zona: una posición en el borde del margen se acepta y un paso más allá no', () => {
  const PASO = 0.0005; // ~55 m
  const bordes: Array<[string, number, number, number, number]> = [
    ['sur', ZONA.latMin, medioLon, ZONA.latMin - PASO, medioLon],
    ['norte', ZONA.latMax, medioLon, ZONA.latMax + PASO, medioLon],
    ['oeste', medioLat, ZONA.lonMin, medioLat, ZONA.lonMin - PASO],
    ['este', medioLat, ZONA.lonMax, medioLat, ZONA.lonMax + PASO],
  ];
  for (const [lado, lat, lon, latFuera, lonFuera] of bordes) {
    assert.deepEqual(sanityCheck('B-X', `S-${lado}`, null, lat, lon, 30, Date.now()), { accepted: true }, lado);
    assert.equal(
      sanityCheck('B-X', `S-${lado}`, null, latFuera, lonFuera, 30, Date.now()).reason,
      'FUERA_DE_ZONA',
      `${lado}, un paso fuera`,
    );
  }
});
