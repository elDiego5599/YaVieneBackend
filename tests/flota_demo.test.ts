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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-flota-demo-'));
process.env.YA_VIENE_DB_PATH = join(tmp, 'test.db');

// require y no import: estos módulos abren la base al evaluarse.
const { getDb } = require('../src/data/database') as typeof import('../src/data/database');
const { getCompanyBuses } = require('../src/data/fleet_admin') as typeof import('../src/data/fleet_admin');
const { upsertPosition } = require('../src/data/positions_store') as typeof import('../src/data/positions_store');
const { construirFlota, prepararFlota, retrasoArranque, relevoTerminal, velocidadDemo, metrosAvanceDemo } =
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
  d.prepare(`INSERT INTO positions (bus_id, route_id, lat, lon, heading, speed_kmh, timestamp, device_id, sequence)
             VALUES (?, ?, 10.99, -74.79, 0, 20, ?, ?, 1)`)
    .run(busId, routeId, ahora, telefono);
}

test('cada bus de la flota lleva placa colombiana y su id sale de ella', () => {
  const flota = construirFlota();
  assert.ok(flota.length >= 16, `flota de ${flota.length}`);
  for (const bus of flota) {
    assert.match(bus.placa, PLACA, bus.placa);
    assert.equal(bus.busId, `BUS-${bus.placa}`);
  }
  // Ni una placa repetida: el índice único de la base no dejaría guardarla.
  assert.equal(new Set(flota.map((b) => b.placa)).size, flota.length);
  // La que se toca en la presentación, en R-106.
  const destacada = flota.find((b) => b.placa === 'ABC123');
  assert.equal(destacada?.routeId, 'R-106');
  assert.equal(destacada?.fraccion, 5.5 / 8);
  // Cada ruta es un circuito cerrado: un bus que lo recorriera al revés
  // subiría por la calle de bajada (dueño, 2026-11-05).
  assert.ok(flota.every((b) => !('sentido' in b)), 'ningún bus va en contravía');
});

test('cada ruta conserva dieciséis placas: ocho rodando y ocho en espera terminal', () => {
  const flota = construirFlota();
  const rutas = new Map<string, typeof flota>();
  for (const bus of flota) rutas.set(bus.routeId, [...(rutas.get(bus.routeId) ?? []), bus]);
  for (const [ruta, buses] of rutas) {
    assert.equal(buses.length, 16, `${ruta}: plantilla`);
    const activos = buses.filter((b) => b.activo);
    assert.equal(activos.length, 8, ruta);
    // El circuito empieza y termina en la misma terminal: ahí esperan todos.
    assert.equal(buses.filter((b) => !b.activo && b.fraccion === 0).length, 8, `${ruta}: espera`);
    const posiciones = activos.map((b) => b.fraccion).sort((a, b) => a - b);
    const brechas = posiciones.slice(1).map((p, i) => p - posiciones[i]);
    const media = brechas.reduce((s, b) => s + b, 0) / brechas.length;
    assert.ok(Math.max(...brechas) <= 2 * media, `${ruta}: brechas ${brechas.join(',')}`);
  }
});

test('arrancar sobre base vieja retira sobrantes demo y deja 8 activos y 8 en terminal', () => {
  const d = getDb();
  const flota = construirFlota();
  const ahora = Date.now();
  d.prepare(`INSERT OR IGNORE INTO empresas (company_id, name, created_at) VALUES ('EMP-OTRA', 'Ajena', ?)`)
    .run(ahora);
  d.prepare(`INSERT INTO buses (bus_id, company_id, plate_number, route_id, visible, en_terminal, created_at, updated_at)
             VALUES ('BUS-AJENO-1', 'EMP-OTRA', 'ZZZ999', 'R-101', 1, 0, ?, ?)`)
    .run(ahora, ahora);
  d.prepare(`INSERT INTO buses (bus_id, company_id, plate_number, route_id, visible, en_terminal, is_demo, created_at, updated_at)
             VALUES ('BUS-SOBRANTE1', 'EMP-01', 'QZX991', 'R-101', 1, 0, 1, ?, ?)`)
    .run(ahora, ahora);
  d.prepare(`INSERT INTO positions (bus_id, route_id, lat, lon, speed_kmh, timestamp, device_id, route_fraction)
             VALUES ('BUS-SOBRANTE1', 'R-101', 10.99, -74.79, 0, ?, 'sobrante', 0.5)`)
    .run(ahora - 86_400_000);
  for (const ruta of new Set(flota.map((bus) => bus.routeId))) {
    const anteriores = flota.filter((bus) => bus.routeId === ruta).slice(0, 12);
    assert.equal(anteriores.length, 12, ruta);
    anteriores.forEach((bus, i) => {
      const telefono = bus.telefono;
      const visible = i < 2 ? 1 : 0;
      d.prepare(`INSERT INTO buses (bus_id, company_id, plate_number, route_id, visible, en_terminal, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(bus.busId, bus.companyId, bus.placa, ruta, visible, visible ? 0 : 1, ahora, ahora);
      d.prepare(`INSERT INTO drivers (phone_number, driver_id, name, route_id, company_id, bus_id, registered_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(telefono, `drv-${telefono}`, `Conductor ${telefono}`, ruta, bus.companyId, bus.busId, ahora);
      d.prepare(`INSERT INTO positions (bus_id, route_id, lat, lon, speed_kmh, timestamp, device_id, route_fraction, route_direction)
                 VALUES (?, ?, 10.99, -74.79, 0, ?, ?, 0.98, 'ida')`)
        .run(bus.busId, ruta, ahora, telefono);
    });
  }

  prepararFlota(flota);

  const datosRuta = JSON.parse(readFileSync(join(__dirname, '..', 'scripts', 'data', 'rutas.json'), 'utf8')) as {
    rutas: Array<{ routeId: string; waypoints: Array<{ lat: number; lon: number }> }>;
  };
  for (const ruta of new Set(flota.map((bus) => bus.routeId))) {
    const bus = flota.find((candidato) => candidato.routeId === ruta && candidato.activo)!;
    const punto = datosRuta.rutas.find((candidato) => candidato.routeId === ruta)!.waypoints[
      Math.floor(datosRuta.rutas.find((candidato) => candidato.routeId === ruta)!.waypoints.length / 2)
    ];
    const publicada = upsertPosition(bus.telefono, {
      busId: bus.busId, routeId: ruta, ...punto, speedKmh: 24, sentido: 'ida',
      sequence: 1, capturedAt: ahora + 1,
      driverValidated: true, companyId: bus.companyId,
    });
    assert.ok(publicada, `${ruta}: primer punto del bus activo`);
    assert.equal(publicada.enTerminal, false, `${ruta}: primer punto activo no debe quedar oculto`);
  }

  for (const ruta of new Set(flota.map((bus) => bus.routeId))) {
    const conteo = d.prepare(`SELECT COUNT(*) AS total, SUM(visible = 1) AS visibles,
                                     SUM(en_terminal = 1) AS terminal
                              FROM buses WHERE route_id = ? AND company_id IN ('EMP-01', 'EMP-03', 'EMP-04')`)
      .get(ruta) as { total: number; visibles: number; terminal: number };
    assert.equal(conteo.visibles, 8, `${ruta}: visibles`);
    assert.equal(conteo.terminal, 8, `${ruta}: terminal`);
    assert.equal(conteo.total, 16, `${ruta}: total`);
  }
  // Un sobrante de una generación anterior se retira con su posición: oculto
  // se quedaba en el panel a mitad de ruta y sin señal (dueño, 2026-10-26).
  assert.equal(d.prepare("SELECT 1 FROM buses WHERE bus_id = 'BUS-SOBRANTE1'").get(), undefined);
  assert.equal(d.prepare("SELECT 1 FROM positions WHERE bus_id = 'BUS-SOBRANTE1'").get(), undefined);
  assert.equal((d.prepare("SELECT COUNT(*) AS total FROM buses WHERE bus_id = 'BUS-AJENO-1'").get() as { total: number }).total, 1);
});

test('una ruta nueva también nace con placas de verdad', () => {
  const d = getDb();
  d.prepare('INSERT INTO company_routes (company_id, route_id, name, created_at) VALUES (?, ?, ?, ?)')
    .run('EMP-01', 'R-117', 'Ruta nueva', Date.now());
  try {
    const nuevos = construirFlota().filter((b) => b.routeId === 'R-117');
      assert.equal(nuevos.length, 16);
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
test('Coolitoral sale con dieciséis buses por ruta, a su nombre', () => {
  const flota = construirFlota();
  const coolitoral = flota.filter((b) => b.companyId === 'EMP-03');
  assert.deepEqual(
    [...new Set(coolitoral.map((b) => b.routeId))],
    ['R-107', 'R-109', 'R-110'],
  );
  for (const routeId of ['R-107', 'R-109', 'R-110']) {
    assert.equal(coolitoral.filter((b) => b.routeId === routeId).length, 16);
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

// Coochofal (EMP-04, migración 37) rueda igual (dueño, 2026-10-28): sus
// seis rutas con su flota completa y cada bus en su panel.
test('Coochofal sale con dieciséis buses por ruta, a su nombre', () => {
  const flota = construirFlota();
  const rutas = ['R-111', 'R-112', 'R-113', 'R-114', 'R-115', 'R-116'];
  const coochofal = flota.filter((b) => b.companyId === 'EMP-04');
  assert.deepEqual([...new Set(coochofal.map((b) => b.routeId))], rutas);
  for (const routeId of rutas) {
    assert.equal(coochofal.filter((b) => b.routeId === routeId).length, 16);
  }

  prepararFlota(flota);
  const panel = getCompanyBuses('EMP-04');
  assert.deepEqual(
    panel.filter((b) => coochofal.some((demo) => demo.busId === b.busId)).map((b) => b.placa).sort(),
    coochofal.map((b) => b.placa).sort(),
  );
});

test('los primeros ocho buses arrancan de inmediato sin esperar el limitador HTTP', () => {
  const arranques = Array.from({ length: 40 }, (_, i) => retrasoArranque(i));
  assert.deepEqual(arranques, Array(40).fill(0));
});

// Uno llega y uno sale: el relevo de a dos dejaba al primero quieto en la
// terminal esperando pareja y despachaba dos buses juntos, que rodaban
// pegados toda la vuelta (dueño, 2026-10-26: «hay 8 en el mismo lugar»).
test('un relevo despacha un bus por cada llegada, el que más lleva esperando', () => {
  const esperando = ['BUS-ESP001', 'BUS-ESP002'];
  assert.deepEqual(relevoTerminal('BUS-LLE001', esperando), { retirar: 'BUS-LLE001', sale: 'BUS-ESP001' });
  assert.deepEqual(esperando, ['BUS-ESP002', 'BUS-LLE001']);
  assert.deepEqual(relevoTerminal('BUS-LLE002', esperando), { retirar: 'BUS-LLE002', sale: 'BUS-ESP002' });
  assert.deepEqual(esperando, ['BUS-LLE001', 'BUS-LLE002']);
});

test('sin nadie esperando, el que llega da la vuelta solo', () => {
  const esperando: string[] = [];
  assert.deepEqual(relevoTerminal('BUS-LLE001', esperando), { retirar: 'BUS-LLE001', sale: 'BUS-LLE001' });
  assert.deepEqual(esperando, []);
});

test('la velocidad demo respeta rectas, curvas y frenadas suaves deterministas', () => {
  const [busA, busB] = construirFlota().filter((b) => b.activo);
  const a0 = velocidadDemo(busA, 0);
  assert.equal(a0, velocidadDemo(busA, 0));
  assert.notEqual(a0, velocidadDemo(busB, 0));
  assert.ok(a0 >= 28 && a0 <= 48);
  assert.notEqual(a0, velocidadDemo(busA, 20_000));
  const recta = [{ lat: 0, lon: 0 }, { lat: 0.01, lon: 0 }, { lat: 0.02, lon: 0 }];
  const curva = [{ lat: 0, lon: 0 }, { lat: 0.01, lon: 0 }, { lat: 0.01, lon: 0.01 }];
  assert.ok(velocidadDemo(busA, 15_000, recta, 500) >= 28);
  assert.ok(velocidadDemo(busA, 15_000, curva, 500) >= 12);
  assert.ok(velocidadDemo(busA, 15_000, curva, 500) <= 22);
  const velocidades = Array.from({ length: 800 }, (_, i) => velocidadDemo(busA, i * 100, recta, 500));
  assert.ok(velocidades.some((v) => v <= 8), 'debe incluir frenadas cortas');
  const intervalo = 1_000;
  const t = 15_000;
  assert.equal(metrosAvanceDemo(busA, t, intervalo, recta, 500), velocidadDemo(busA, t, recta, 500) / 3.6);
});

// D24: la app saca el rango de la hora de llegada de lo que avanzaron los
// buses en tramos de un minuto, y descarta los que pasan de 25 m/s (90 km/h)
// por salto de GPS. A 60-100 km/h por la calle, la mitad de los minutos de la
// flota de ejemplo se tiraba y el rango salía de la otra mitad, imposible
// para un bus urbano.
test('cada minuto de la flota demo anda a ritmo de bus urbano, medible por el core', () => {
  const [bus] = construirFlota().filter((b) => b.activo);
  const recta = [{ lat: 0, lon: 0 }, { lat: 0.1, lon: 0 }, { lat: 0.2, lon: 0 }];
  for (const [puntos, nombre] of [[recta, 'recta']] as const) {
    let metros = 0;
    for (let s = 0; s < 3600; s++) {
      metros += metrosAvanceDemo(bus, s * 1000, 1000, [...puntos], 500);
      if ((s + 1) % 60 === 0) {
        const ms = metros / 60;
        assert.ok(ms >= 3 && ms <= 14, `${nombre}: minuto ${(s + 1) / 60} a ${ms.toFixed(1)} m/s`);
        metros = 0;
      }
    }
  }
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

test('una colisión de placa deriva a otra placa sin quitarle el bus a otra empresa', () => {
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
  assert.equal(listos.length, flota.length);
  assert.ok(listos.some((b) => b.telefono === primero.telefono && b.placa !== primero.placa));
  assert.ok(listos.some((b) => b.telefono === segundo.telefono && b.busId !== segundo.busId));
});
