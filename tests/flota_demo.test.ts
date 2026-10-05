// La flota demo con placas de verdad.
//
// Los buses simulados se llamaban B-042, B-201…: así salían en la app del
// pasajero («Ruta - B-042») y en el panel, y ningún bus de Barranquilla tiene
// esa placa. El dueño pidió que se vieran como las reales, tres letras y tres
// números (WGV705), 2026-09-30. Ahora nacen como nace un bus dado de alta en
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
  const destacada = flota.find((b) => b.placa === 'WGV705');
  assert.equal(destacada?.routeId, 'R-106');
});

test('una ruta nueva también nace con placas de verdad', () => {
  const d = getDb();
  d.prepare('INSERT INTO company_routes (company_id, route_id, name, created_at) VALUES (?, ?, ?, ?)')
    .run('EMP-01', 'R-117', 'Ruta nueva', Date.now());
  try {
    const nuevos = construirFlota().filter((b) => b.routeId === 'R-117');
    assert.deepEqual(nuevos.map((b) => b.placa), ['YVA117', 'YVB117']);
  } finally {
    d.prepare("DELETE FROM company_routes WHERE route_id = 'R-117'").run();
  }
});

test('al arrancar, los B-0xx viejos se van y los nuevos salen con su placa en el panel', () => {
  const d = getDb();
  sembrarBusViejo('B-042', 'R-106', '3000000000');
  sembrarBusViejo('B-201', 'R-101', '3000000201');
  sembrarBusViejo('B-107A', 'R-107', '3001107001');

  prepararFlota(construirFlota());

  const ids = (d.prepare("SELECT bus_id FROM buses WHERE company_id = 'EMP-01'").all() as { bus_id: string }[])
    .map((r) => r.bus_id);
  for (const viejo of ['B-042', 'B-201', 'B-107A']) {
    assert.equal(ids.includes(viejo), false, `${viejo} sigue en la base`);
  }
  assert.equal(
    (d.prepare("SELECT COUNT(*) AS n FROM positions WHERE bus_id IN ('B-042', 'B-201', 'B-107A')").get() as { n: number }).n,
    0,
  );

  // El panel lee `plate_number` y, sin ella, enseñaba el id entero.
  const panel = getCompanyBuses('EMP-01');
  const six = panel.find((b) => b.busId === 'BUS-WGV705');
  assert.equal(six?.placa, 'WGV705');
  assert.equal(six?.routeId, 'R-106');
  assert.equal(six?.visible, true);
  for (const bus of panel.filter((b) => b.busId.startsWith('BUS-'))) {
    assert.match(bus.placa, PLACA, bus.busId);
  }
});

// Coolitoral (EMP-03, migración 27) también rueda (dueño, 2026-10-05): sin
// buses, el pasajero elegía A1–A4 y el mapa se quedaba vacío. Cada bus va con
// su empresa: el simulador se registra con ella y el panel de Coolitoral lo
// ve como suyo, no como uno de Sobusa.
test('Coolitoral sale con dos buses por ruta, a su nombre', () => {
  const flota = construirFlota();
  const coolitoral = flota.filter((b) => b.companyId === 'EMP-03');
  assert.deepEqual(
    coolitoral.map((b) => `${b.routeId} ${b.placa}`),
    [
      'R-107 YVA107', 'R-107 YVB107', 'R-108 YVA108', 'R-108 YVB108',
      'R-109 YVA109', 'R-109 YVB109', 'R-110 YVA110', 'R-110 YVB110',
    ],
  );
  assert.ok(flota.filter((b) => b.routeId === 'R-106').every((b) => b.companyId === 'EMP-01'));

  prepararFlota(flota);
  const panel = getCompanyBuses('EMP-03');
  assert.deepEqual(
    panel.filter((b) => b.busId.startsWith('BUS-YV')).map((b) => b.placa).sort(),
    coolitoral.map((b) => b.placa).sort(),
  );
  assert.equal(getCompanyBuses('EMP-01').some((b) => b.placa.startsWith('YVA10')), false);
});

// El alta y el login del conductor admiten 20 por minuto desde una misma IP
// (`adminRateLimiter`, `loginIpRateLimiter`), y todos los simuladores salen
// de 127.0.0.1. Con Coolitoral la flota es de 20: de un tirón llenaba el cupo
// y un bus que se cayera en ese minuto no podía volver a entrar.
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
  d.prepare("UPDATE buses SET plate_number = 'WGV706' WHERE bus_id = 'BUS-WGV705'").run();
  prepararFlota(construirFlota());
  assert.equal(
    (d.prepare("SELECT plate_number FROM buses WHERE bus_id = 'BUS-WGV705'").get() as { plate_number: string }).plate_number,
    'WGV706',
  );
  d.prepare("UPDATE buses SET plate_number = 'WGV705' WHERE bus_id = 'BUS-WGV705'").run();
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
