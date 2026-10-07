// La zona de servicio: toda posición tiene que caer en el área metropolitana.
// Antes la primera posición de cada sesión entraba sin mirar dónde, y un
// equipo mal configurado —o uno robado— podía poner un bus en Bogotá.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { haversineDistanceKm, sanityCheck } from '../src/security/physics';
import { ZONA, dentroDeZona } from '../src/security/zona';

// El mismo archivo que dibuja la app del pasajero:
// ya_viene_core/assets/data/rutas.json es una copia byte a byte.
const { rutas } = JSON.parse(
  readFileSync(join(__dirname, '..', 'scripts', 'data', 'rutas.json'), 'utf8'),
) as { rutas: { routeId: string; waypoints: { lat: number; lon: number }[] }[] };
const puntos = rutas.flatMap((r) => r.waypoints.map((w) => ({ ...w, routeId: r.routeId })));

const medioLat = (ZONA.latMin + ZONA.latMax) / 2;
const medioLon = (ZONA.lonMin + ZONA.lonMax) / 2;

// Los municipios del área metropolitana, por su plaza principal. El dueño
// decidió el 18 de septiembre de 2026 que Malambo entra («si es necesario
// aceptemos malambo»), y con él el resto del área: un bus de cualquiera de
// estos pueblos tiene que poder publicar sin que la zona lo rechace.
const MUNICIPIOS: Array<[string, number, number]> = [
  ['Barranquilla', 10.9639, -74.7964],
  ['Soledad', 10.9179, -74.7646],
  ['Malambo', 10.8592, -74.7739],
  ['Galapa', 10.8981, -74.8861],
  ['Puerto Colombia', 10.9878, -74.9547],
];

test('zona: todos los waypoints de rutas.json caen dentro', () => {
  assert.ok(puntos.length > 2_000, `se esperaban los ~2.100 waypoints, hay ${puntos.length}`);
  assert.deepEqual(puntos.filter((p) => !dentroDeZona(p.lat, p.lon)), []);
});

test('zona: el área metropolitana entera entra, Malambo incluido', () => {
  for (const [nombre, lat, lon] of MUNICIPIOS) {
    assert.ok(dentroDeZona(lat, lon), `${nombre} (${lat}, ${lon}) quedó fuera de la zona`);
  }
});

test('zona: es la misma caja que el mapa de la app', () => {
  // Copiados a mano de `map_constants.dart` (`areaSurLat`, `areaNorteLat`,
  // `areaOesteLon`, `areaEsteLon`), que vive en el otro repositorio y por eso
  // no se puede leer desde aquí. Si allá cambian, esta prueba se cae y hay
  // que moverlos en los dos sitios: un bus que publique fuera del mapa no se
  // vería en la app aunque el servidor lo aceptara.
  assert.deepEqual(ZONA, { latMin: 10.79, latMax: 11.164, lonMin: -75.0035, lonMax: -74.6251 });

  // Y es cuadrada en kilómetros, no en grados, como la del mapa: el lado
  // norte-sur y el este-oeste miden lo mismo con menos de 1 km de diferencia.
  const alto = haversineDistanceKm(ZONA.latMin, medioLon, ZONA.latMax, medioLon);
  const ancho = haversineDistanceKm(medioLat, ZONA.lonMin, medioLat, ZONA.lonMax);
  assert.ok(Math.abs(alto - ancho) < 1, `la caja mide ${alto.toFixed(1)} × ${ancho.toFixed(1)} km`);
  assert.ok(alto > 40 && alto < 43, `el lado mide ${alto.toFixed(1)} km`);
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

test('zona: Cartagena y Santa Marta siguen fuera', () => {
  // Las dos ciudades de la costa a las que llega una carretera desde aquí:
  // ampliar la caja al área metropolitana no las mete dentro.
  for (const [nombre, lat, lon] of [
    ['Cartagena', 10.391, -75.4794],
    ['Santa Marta', 11.2408, -74.199],
  ] as Array<[string, number, number]>) {
    assert.equal(dentroDeZona(lat, lon), false, `${nombre} quedó dentro de la zona`);
  }
});

test('zona: una posición en el borde se acepta y un paso más allá no', () => {
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
