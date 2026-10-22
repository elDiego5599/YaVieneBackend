// La flota demo con placas de verdad.
//
// Los buses simulados se llamaban B-042, B-201…: así salían en la app del
// pasajero («Ruta - B-042») y en el panel, y ningún bus de Barranquilla tiene
// esa placa. El dueño pidió que se vieran como las reales, tres letras y tres
// números (ABC123), 2026-09-30. Ahora nacen como nace un bus dado de alta en
// el panel: id `BUS-<placa>` con su placa guardada, y los B-0xx que quedaron
// en la base se retiran al arrancar para no quedarse en el panel como buses
// sin señal.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-flota-demo-'));
process.env.YA_VIENE_DB_PATH = join(tmp, 'test.db');

// require y no import: estos módulos abren la base al evaluarse.
const { getDb } = require('../src/data/database') as typeof import('../src/data/database');
const { getCompanyBuses } = require('../src/data/fleet_admin') as typeof import('../src/data/fleet_admin');
const { construirFlota, prepararFlota, retrasoArranque } =
  require('../src/demo/flota_demo') as typeof import('../src/demo/flota_demo');

test.after(() => {
  try {
    getDb().close();
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

const PLACA = /^[A-Z]{3}[0-9]{3}$/;

function sembrarBusViejo(busId: string, routeId: string, telefono: string): void {
  const d = getDb();
  const ahora = Date.now();
  d.prepare('INSERT INTO buses (bus_id, company_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(busId, 'EMP-01', ahora, ahora);
  d.prepare(`INSERT INTO drivers (phone_number, driver_id, name, route_id, company_id, bus_id, registered_at)
             VALUES (?, ?, ?, ?, 'EMP-01', ?, ?)`)
    .run(telefono, `drv-${telefono}`, `Conductor ${telefono}`, routeId, busId, ahora);
  d.prepare(`INSERT INTO positions (bus_id, route_id, lat, lon, heading, speed_kmh, timestamp, driver_phone, sequence)
             VALUES (?, ?, 10.99, -74.79, 0, 20, ?, ?, 1)`)
    .run(busId, routeId, ahora, telefono);
}

test('cada bus de la flota lleva placa colombiana y su id sale de ella', () => {
  const flota = construirFlota();
  assert.ok(flota.length >= 12, `flota de ${flota.length}`);
  for (const bus of flota) {
    assert.match(bus.placa, PLACA, bus.placa);
    assert.equal(bus.busId, `BUS-${bus.placa}`);
  }
  // Ni una placa repetida: el índice único de la base no dejaría guardarla.
  assert.equal(new Set(flota.map((b) => b.placa)).size, flota.length);
  // La que se toca en la presentación: viene hacia el pasajero en R-106.
  const destacada = flota.find((b) => b.placa === 'ABC123');
  assert.equal(destacada?.routeId, 'R-106');
  assert.equal(destacada?.sentido, 'venida');
  assert.equal(destacada?.fraccion, 1 - 5.5 / 12);
});

test('cada ruta tiene 10–15 buses distribuidos uniformemente y en ambos sentidos', () => {
  const flota = construirFlota();
  const rutas = new Map<string, typeof flota>();
  for (const bus of flota) rutas.set(bus.routeId, [...(rutas.get(bus.routeId) ?? []), bus]);
  for (const [ruta, buses] of rutas) {
    assert.ok(buses.length >= 10 && buses.length <= 15, `${ruta}: ${buses.length}`);
    const posiciones = buses.map((b) => b.sentido === 'venida' ? 1 - b.fraccion : b.fraccion).sort((a, b) => a - b);
    assert.equal(new Set(posiciones).size, buses.length, `${ruta}: posiciones repetidas`);
    const brechas = posiciones.slice(1).map((p, i) => p - posiciones[i]);
    const media = brechas.reduce((s, b) => s + b, 0) / brechas.length;
    assert.ok(Math.max(...brechas) <= 2 * media, `${ruta}: brechas ${brechas.join(',')}`);
    assert.ok(buses.some((b) => b.sentido === 'ida') && buses.some((b) => b.sentido === 'venida'), ruta);
  }
});

test('una ruta nueva también nace con placas de verdad', () => {
  const d = getDb();
  d.prepare('INSERT INTO company_routes (company_id, route_id, name, created_at) VALUES (?, ?, ?, ?)')
    .run('EMP-01', 'R-117', 'Ruta nueva', Date.now());
  try {
    const nuevos = construirFlota().filter((b) => b.routeId === 'R-117');
    assert.equal(nuevos.length, 12);
  } finally {
    d.prepare("DELETE FROM company_routes WHERE route_id = 'R-117'").run();
  }
});

test('al arrancar, retira ids antiguos y placas de la flota anterior, pero conserva ABC123', () => {
  const d = getDb();
  const viejos = [
    'B-042', 'B-201', 'B-107A', 'BUS-WGV705',
    'BUS-TNM901', 'BUS-SKR201', 'BUS-UBL202', 'BUS-VJD203',
    'BUS-SNZ204', 'BUS-TPH205', 'BUS-WGA206', 'BUS-UHE207',
    'BUS-VXR208', 'BUS-SDC209', 'BUS-WFK042',
    'BUS-YVA107', 'BUS-YVB107', 'BUS-YVA109', 'BUS-YVB109',
    'BUS-YVA110', 'BUS-YVB110', 'BUS-YVA117', 'BUS-YVB117',
  ];
  const rutas = ['R-106', 'R-101', 'R-107', 'R-106', 'R-101', 'R-101', 'R-102', 'R-102',
    'R-103', 'R-103', 'R-104', 'R-104', 'R-105', 'R-105', 'R-106',
    'R-107', 'R-107', 'R-109', 'R-109', 'R-110', 'R-110', 'R-117', 'R-117'];
  viejos.forEach((id, i) => sembrarBusViejo(id, rutas[i], `3000001${String(i).padStart(3, '0')}`));

  prepararFlota(construirFlota());

  const ids = (d.prepare("SELECT bus_id FROM buses WHERE company_id = 'EMP-01'").all() as { bus_id: string }[])
    .map((r) => r.bus_id);
  for (const viejo of viejos) {
    assert.equal(ids.includes(viejo), false, `${viejo} sigue en la base`);
  }
  const marcadores = viejos.map(() => '?').join(',');
  assert.equal(
    (d.prepare(`SELECT COUNT(*) AS n FROM positions WHERE bus_id IN (${marcadores})`).get(...viejos) as { n: number }).n,
    0,
  );

  // El panel lee `plate_number` y, sin ella, enseñaba el id entero.
  const panel = getCompanyBuses('EMP-01');
  const six = panel.find((b) => b.busId === 'BUS-ABC123');
  assert.equal(six?.placa, 'ABC123');
  assert.equal(six?.routeId, 'R-106');
  assert.equal(six?.visible, true);
  for (const bus of panel.filter((b) => b.busId.startsWith('BUS-'))) {
    assert.match(bus.placa, PLACA, bus.busId);
  }
});

// Coolitoral (EMP-03, migración 27) también rueda (dueño, 2026-10-05): sin
// buses, el pasajero elegía A1, A3 o A4 y el mapa se quedaba vacío. A2
// (R-108) ya no está (migración 28): no lleva buses. Cada bus va con
// su empresa: el simulador se registra con ella y el panel de Coolitoral lo
// ve como suyo, no como uno de Sobusa.
test('Coolitoral sale con doce buses por ruta, a su nombre', () => {
  const flota = construirFlota();
  const coolitoral = flota.filter((b) => b.companyId === 'EMP-03');
  assert.deepEqual(
    [...new Set(coolitoral.map((b) => b.routeId))],
    ['R-107', 'R-109', 'R-110'],
  );
  for (const routeId of ['R-107', 'R-109', 'R-110']) {
    assert.equal(coolitoral.filter((b) => b.routeId === routeId).length, 12);
  }
  assert.ok(flota.filter((b) => b.routeId === 'R-106').every((b) => b.companyId === 'EMP-01'));

  prepararFlota(flota);
  const panel = getCompanyBuses('EMP-03');
  assert.deepEqual(
    panel.filter((b) => coolitoral.some((demo) => demo.busId === b.busId)).map((b) => b.placa).sort(),
    coolitoral.map((b) => b.placa).sort(),
  );
  assert.equal(
    getCompanyBuses('EMP-01').some((b) => coolitoral.some((demo) => demo.busId === b.busId)),
    false,
  );
});

// El alta y el login del conductor admiten 20 por minuto desde una misma IP
// (`adminRateLimiter`, `loginIpRateLimiter`), y todos los simuladores salen
// de 127.0.0.1. Con 108 simuladores, de un tirón se llenaría el cupo; el
// tope deja margen para que un bus caído pueda registrarse al reintentar.
test('la flota arranca a 18 buses por minuto como mucho', () => {
  const arranques = Array.from({ length: 40 }, (_, i) => retrasoArranque(i));
  for (const desde of arranques) {
    const enUnMinuto = arranques.filter((t) => t >= desde && t < desde + 60_000).length;
    assert.ok(enUnMinuto <= 18, `${enUnMinuto} arranques en el minuto que empieza en ${desde} ms`);
  }
  // Los primeros 18 salen seguidos, como antes: la demo no espera.
  assert.equal(retrasoArranque(17), 17 * 400);
});

test('preparar dos veces no cambia nada, y una placa editada en el panel se respeta', () => {
  const d = getDb();
  d.prepare("UPDATE buses SET plate_number = 'ABC124' WHERE bus_id = 'BUS-ABC123'").run();
  prepararFlota(construirFlota());
  assert.equal(
    (d.prepare("SELECT plate_number FROM buses WHERE bus_id = 'BUS-ABC123'").get() as { plate_number: string }).plate_number,
    'ABC124',
  );
  d.prepare("UPDATE buses SET plate_number = 'ABC123' WHERE bus_id = 'BUS-ABC123'").run();
});

test('no le quita a otra empresa ni su bus ni su placa', () => {
  const d = getDb();
  const ahora = Date.now();
  d.prepare('INSERT OR IGNORE INTO empresas (company_id, name, created_at) VALUES (?, ?, ?)')
    .run('EMP-OTRA', 'Otra', ahora);
  // Otra empresa ya registró la placa de un bus de la demo (otro id).
  const flota = construirFlota();
  const [primero, segundo] = flota.filter((b) => b.routeId === 'R-101');
  d.prepare('DELETE FROM buses WHERE bus_id IN (?, ?)').run(primero.busId, segundo.busId);
  d.prepare(`INSERT INTO buses (bus_id, company_id, plate_number, created_at, updated_at)
             VALUES ('BUS-AJENO', 'EMP-OTRA', ?, ?, ?)`).run(primero.placa, ahora, ahora);
  // Y el id del segundo es de la otra empresa.
  d.prepare(`INSERT INTO buses (bus_id, company_id, created_at, updated_at)
             VALUES (?, 'EMP-OTRA', ?, ?)`).run(segundo.busId, ahora, ahora);

  const listos = prepararFlota(flota);

  assert.equal(listos.some((b) => b.busId === primero.busId), false);
  assert.equal(listos.some((b) => b.busId === segundo.busId), false);
  assert.equal(
    (d.prepare("SELECT company_id FROM buses WHERE bus_id = 'BUS-AJENO'").get() as { company_id: string }).company_id,
    'EMP-OTRA',
  );
  assert.equal(
    (d.prepare('SELECT company_id FROM buses WHERE bus_id = ?').get(segundo.busId) as { company_id: string }).company_id,
    'EMP-OTRA',
  );
  assert.equal(listos.length, flota.length - 2);
});
