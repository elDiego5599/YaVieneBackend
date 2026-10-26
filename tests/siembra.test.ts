// T9.3 (YV-13): Sobusa y su catálogo vivían en las migraciones 9, 12 y 16, y
// toda base nueva nacía con ellos, también la de un despliegue para otra
// empresa. Ahora la siembra la decide `siembraDemoHabilitada` (misma regla
// que la flota demo): encendida en desarrollo, apagada en producción salvo
// YA_VIENE_SEED_DEMO=1. Cada base va en su propio proceso porque
// `database.ts` fija la ruta al cargarse.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { siembraDemoHabilitada, validateConfig } from '../src/config';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-siembra-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

type Catalogo = {
  empresas: Array<{ company_id: string; name: string }>;
  rutas: Array<{ company_id: string; route_id: string; name: string; terminal_a: string; terminal_b: string }>;
  migraciones: number[];
};

function abrir(base: string, env: Record<string, string>): Catalogo {
  const hijo = spawnSync(
    process.execPath,
    ['--import', 'tsx', join(__dirname, 'fixtures', 'catalogo_siembra.ts')],
    {
      encoding: 'utf8',
      // Sin heredar YA_VIENE_SEED_DEMO ni NODE_ENV de quien corra la suite.
      env: { PATH: process.env.PATH ?? '', YA_VIENE_DB_PATH: join(tmp, base), ...env },
    },
  );
  assert.equal(hijo.status, 0, hijo.stderr);
  // El log de `[DB]` también sale por stdout: el JSON es la última línea.
  return JSON.parse(hijo.stdout.trim().split('\n').at(-1) ?? '') as Catalogo;
}

// El catálogo real de Sobusa tal como lo dejaba la base antes de T9.3
// (comparado fila a fila con una base creada por el código anterior).
const SOBUSA = [
  ['R-101', 'B18 Tcherassi', 'Ciudad Mallorquín', 'La Playa'],
  ['R-102', 'C11 Silencio', 'Nevada', 'El Silencio'],
  ['R-103', 'C12 Vivero Paraíso', 'Vía 40', 'Paraíso'],
  ['R-104', 'C13 Carrera 50 Paraíso', 'Nevada (Soledad)', 'Calle 76 (Vía 40)'],
  ['R-105', 'C14 Carrera 54 Uninorte', 'Granabastos', 'Uninorte'],
  ['R-106', 'C16 Calle 72 Uninorte', 'Granabastos', 'Uninorte'],
].map(([route_id, name, terminal_a, terminal_b]) => ({
  company_id: 'EMP-01', route_id, name, terminal_a, terminal_b,
}));

// Coolitoral entra con la migración 27 (dueño, 2026-10-05), con los mismos
// identificadores que sus trazados en `rutas.json`. La 28 le quita A2
// (R-108): era el mismo recorrido que A1 (dueño, el mismo día).
const COOLITORAL = [
  ['R-107', 'A1 Silencio Universidades', 'Silencio, Nogales', 'Universidades, Vía 40'],
  ['R-109', 'A3 Carrera 43 Peñita', 'Carrera 43', 'La Peñita'],
  ['R-110', 'A4 Carrera 50', 'Calle 17', 'Carrera 50'],
].map(([route_id, name, terminal_a, terminal_b]) => ({
  company_id: 'EMP-03', route_id, name, terminal_a, terminal_b,
}));

const EMPRESAS = [
  { company_id: 'EMP-01', name: 'Sobusa' },
  { company_id: 'EMP-03', name: 'Coolitoral' },
];
const CATALOGO = [...SOBUSA, ...COOLITORAL];

const SIEMBRA = [9, 12, 16, 27, 28];

test('la regla: sembrada en desarrollo, vacía en producción, y la variable manda', () => {
  assert.equal(siembraDemoHabilitada({}), true);
  assert.equal(siembraDemoHabilitada({ NODE_ENV: 'production' }), false);
  assert.equal(siembraDemoHabilitada({ NODE_ENV: 'production', YA_VIENE_SEED_DEMO: '1' }), true);
  assert.equal(siembraDemoHabilitada({ YA_VIENE_SEED_DEMO: '0' }), false);
});

test('una base nueva de producción nace sin Sobusa ni Coolitoral', () => {
  const base = abrir('produccion.db', { NODE_ENV: 'production' });
  assert.deepEqual(base.empresas, []);
  assert.deepEqual(base.rutas, []);
  // Las migraciones de siembra no quedan apuntadas: se pueden correr después.
  for (const version of SIEMBRA) assert.ok(!base.migraciones.includes(version), `migración ${version}`);
});

test('con la siembra encendida la base nueva queda como antes de T9.3', () => {
  const base = abrir('desarrollo.db', {});
  assert.deepEqual(base.empresas, EMPRESAS);
  assert.deepEqual(base.rutas, CATALOGO);
  for (const version of SIEMBRA) assert.ok(base.migraciones.includes(version), `migración ${version}`);
});

test('encender la siembra después llena una base que nació vacía', () => {
  const vacia = abrir('tarde.db', { YA_VIENE_SEED_DEMO: '0' });
  assert.deepEqual(vacia.rutas, []);
  const sembrada = abrir('tarde.db', { YA_VIENE_SEED_DEMO: '1' });
  assert.deepEqual(sembrada.empresas, EMPRESAS);
  assert.deepEqual(sembrada.rutas, CATALOGO);
});

test('siembra calor demo al arrancar, respeta búsquedas reales y es idempotente', () => {
  const ahoraFijo = Date.parse('2026-10-25T12:00:00Z');
  const ejecutar = (base: string, env: Record<string, string>) => {
    const hijo = spawnSync(process.execPath, ['--import', 'tsx', join(__dirname, 'fixtures', 'calor_demo.ts')], {
      encoding: 'utf8', env: { PATH: process.env.PATH ?? '', YA_VIENE_DB_PATH: join(tmp, base), SEED_NOW: String(ahoraFijo), ...env },
    });
    assert.equal(hijo.status, 0, hijo.stderr);
    return JSON.parse(hijo.stdout.trim().split('\n').at(-1) ?? '');
  };
  const primera = ejecutar('calor.db', { YA_VIENE_SEED_DEMO: '1', YA_VIENE_SEED_BUSQUEDAS_DEMO: '1' });
  const segunda = ejecutar('calor.db', { REAL_ROUTE: 'R-777', YA_VIENE_SEED_DEMO: '1', YA_VIENE_SEED_BUSQUEDAS_DEMO: '1' });
  assert.ok(primera.counts['R-101'] > 0);
  assert.equal(segunda.realCount, 17);
  assert.ok(segunda.counts['R-102'] > 0);
  for (const [routeId, total] of Object.entries(segunda.totals) as Array<[string, number]>) {
    if (routeId === 'R-101') continue;
    assert.ok(total >= 5_000 && total <= 80_000, `total fuera de rango: ${total}`);
  }
  for (const [routeId, horas] of Object.entries(segunda.activeHours) as Array<[string, number]>) {
    if (routeId === 'R-101') continue;
    assert.ok(horas >= 14, `solo ${horas} horas distintas`);
  }
  const reiniciada = ejecutar('calor.db', { YA_VIENE_SEED_DEMO: '1', YA_VIENE_SEED_BUSQUEDAS_DEMO: '1' });
  assert.deepEqual(reiniciada.counts, segunda.counts);
  assert.deepEqual(reiniciada.totals, segunda.totals);
  const ruta = segunda.seeded.find((r: { routeId: string }) => r.routeId === 'R-102');
  assert.ok(ruta.heat.length > 0);
  assert.ok(ruta.heat.every((c: { count: number }) => c.count >= 5));
  const conteos = ruta.heat.map((c: { count: number }) => c.count).sort((a: number, b: number) => a - b);
  const mediana = conteos[Math.floor(conteos.length / 2)];
  assert.ok(conteos.at(-1)! >= 1.2 * mediana, `foco ${conteos.at(-1)} / banda mediana ${mediana}`);
  const apagada = ejecutar('sin-calor.db', { YA_VIENE_SEED_DEMO: '1', YA_VIENE_SEED_BUSQUEDAS_DEMO: '0' });
  assert.ok(Object.values(apagada.counts).every((n: unknown) => n === 0));
  const sinSiembraDemo = ejecutar('sin-demo.db', { YA_VIENE_SEED_DEMO: '0', YA_VIENE_SEED_BUSQUEDAS_DEMO: '1' });
  assert.ok(Object.values(sinSiembraDemo.counts).every((n: unknown) => n === 0));
});

test('apagar la siembra no borra una base ya sembrada', () => {
  abrir('ya-sembrada.db', {});
  const despues = abrir('ya-sembrada.db', { NODE_ENV: 'production' });
  assert.deepEqual(despues.rutas, CATALOGO);
});

// La base viva ya tenía A2 cuando el dueño la quitó: sus dos buses de la
// demo rodaban y un bus dado de alta en el panel podía estar en ella. La
// migración 28 se lleva la ruta y la flota demo entera (conductor, sesión,
// turno, posición y aviso armado); el bus del panel no se borra, se muda a
// la primera ruta que le quede a la empresa, como al quitar una ruta desde
// el panel (`removeCompanyRoute`).
test('una base que ya tenía A2 la pierde, con sus buses de la demo', () => {
  abrir('con-a2.db', {});
  const db = new Database(join(tmp, 'con-a2.db'));
  const ahora = Date.now();
  db.prepare(`INSERT INTO company_routes (company_id, route_id, name, terminal_a, terminal_b, created_at)
              VALUES ('EMP-03', 'R-108', 'A2 Universidades Silencio', 'Vía 40, Universidades', 'Nogales, Silencio', ?)`)
    .run(ahora);
  for (const [busId, telefono] of [['BUS-YVA108', '300110801'], ['BUS-PNL001', '300110899']]) {
    db.prepare(`INSERT INTO buses (bus_id, company_id, route_id, created_at, updated_at)
                VALUES (?, 'EMP-03', 'R-108', ?, ?)`).run(busId, ahora, ahora);
    db.prepare(`INSERT INTO drivers (phone_number, driver_id, name, route_id, company_id, bus_id, registered_at)
                VALUES (?, ?, 'Conductor', 'R-108', 'EMP-03', ?, ?)`).run(telefono, `drv-${telefono}`, busId, ahora);
    db.prepare(`INSERT INTO driver_sessions (session_id, driver_id, phone_number, company_id, bus_id, route_id, created_at, last_seen_at)
                VALUES (?, ?, ?, 'EMP-03', ?, 'R-108', ?, ?)`).run(`s-${telefono}`, `drv-${telefono}`, telefono, busId, ahora, ahora);
    db.prepare(`INSERT INTO turn_assignments (assignment_id, driver_id, bus_id, company_id, route_id, started_at)
                VALUES (?, ?, ?, 'EMP-03', 'R-108', ?)`).run(`t-${telefono}`, `drv-${telefono}`, busId, ahora);
    db.prepare(`INSERT INTO positions (bus_id, route_id, lat, lon, speed_kmh, timestamp, device_id)
                VALUES (?, 'R-108', 10.99, -74.79, 20, ?, ?)`).run(busId, ahora, telefono);
  }
  db.prepare(`INSERT INTO avisos_push (id, token, bus_id, route_id, lat, lon, creado, vence)
              VALUES ('aviso-a2', 'token', 'BUS-YVA108', 'R-108', 10.99, -74.79, ?, ?)`).run(ahora, ahora + 60_000);
  db.prepare('DELETE FROM schema_migrations WHERE version = 28').run();
  db.close();

  const base = abrir('con-a2.db', {});
  assert.deepEqual(base.rutas, CATALOGO);
  assert.ok(base.migraciones.includes(28));

  const despues = new Database(join(tmp, 'con-a2.db'), { readonly: true });
  try {
    const cuenta = (sql: string) => (despues.prepare(sql).get() as { n: number }).n;
    for (const tabla of ['buses', 'drivers', 'driver_sessions', 'turn_assignments', 'positions', 'avisos_push']) {
      assert.equal(cuenta(`SELECT COUNT(*) AS n FROM ${tabla} WHERE bus_id = 'BUS-YVA108'`), 0, tabla);
    }
    for (const tabla of ['buses', 'drivers', 'driver_sessions', 'turn_assignments', 'positions', 'avisos_push']) {
      assert.equal(cuenta(`SELECT COUNT(*) AS n FROM ${tabla} WHERE route_id = 'R-108'`), 0, tabla);
    }
    assert.deepEqual(
      despues.prepare("SELECT route_id FROM buses WHERE bus_id = 'BUS-PNL001'").get(),
      { route_id: 'R-107' },
    );
  } finally {
    despues.close();
  }
});


test('calor de demo varía, se completa por hora y reemplaza su versión sin tocar rutas ajenas', () => {
  const database = join(tmp, 'busquedas-demo.db');
  const hijo = spawnSync(process.execPath, ['--import', 'tsx', join(__dirname, 'fixtures', 'busquedas_demo.ts')], {
    encoding: 'utf8', env: { PATH: process.env.PATH ?? '', YA_VIENE_DB_PATH: database, YA_VIENE_SEED_DEMO: '1' },
  });
  assert.equal(hijo.status, 0, hijo.stderr);
  const dato = JSON.parse(hijo.stdout.trim().split('\n').at(-1) ?? '') as {
    firstCount: number; secondCount: number; thirdCount: number; sentinel: number; realCount: number;
    daily: Array<{ day: string; n: number }>; visiblePeak: number; visibleHours: number[]; offRouteVisible: number; rawOffRoute: number; beyondLimit: number; maxHour: number; minHour: number; peaksByCompany: number[]; addedRows: number; nextHourRows: number;
    totals: Array<{ routeId: string; total: number }>; peakCells: { n: number; max: number }; todayRank: { routeId: string; horaPico: number | null }; localMidnight: number;
  };
  assert.equal(dato.secondCount, dato.firstCount);
  assert.ok(dato.thirdCount > dato.secondCount);
  assert.equal(dato.nextHourRows, dato.addedRows);
  assert.ok(dato.maxHour <= Date.parse('2026-10-26T15:00:00.000Z'));
  assert.ok(dato.minHour >= Date.parse('2026-10-26T15:00:00.000Z') - 35 * 86400000 - 3600000);
  assert.equal(dato.sentinel, 9);
  const totals = dato.totals.map(row => row.total);
  assert.ok(Math.max(...totals) / Math.min(...totals) >= 3);
  assert.ok(dato.visiblePeak >= 15, `celdas visibles en pico: ${dato.visiblePeak}; datos=${JSON.stringify(dato.peakCells)} ruta=${JSON.stringify(dato.todayRank)}`);
  assert.ok(dato.visibleHours.every(n => n >= 30), `visibles por hora 6-21: ${dato.visibleHours.join(",")}`);
  assert.ok(dato.offRouteVisible > 0, `celdas fuera de ruta visibles=${dato.offRouteVisible}; raw=${dato.rawOffRoute}, visibles=${dato.visibleHours.join(",")}`);
  assert.equal(dato.beyondLimit, 0);
  assert.ok(dato.peaksByCompany.reduce((sum, n) => sum + n, 0) >= 3, `picos distintos por empresa: ${dato.peaksByCompany}`);
  const weekend = dato.daily.filter(row => new Date(`${row.day}T12:00:00Z`).getUTCDay() === 0 || new Date(`${row.day}T12:00:00Z`).getUTCDay() === 6);
  const weekday = dato.daily.filter(row => !weekend.includes(row));
  assert.ok(weekend.length > 0 && weekday.length > 0);
  const average = (rows: Array<{ n: number }>) => rows.reduce((sum, row) => sum + row.n, 0) / rows.length;
  assert.ok(average(weekend) < average(weekday));
});

test('flota demo sin siembra: el arranque lo avisa', () => {
  const { avisos } = validateConfig({ JWT_SECRET: 'x'.repeat(32), PIN: '1234', YA_VIENE_SEED_DEMO: '0' });
  assert.ok(avisos.some((aviso) => /sin siembra/.test(aviso)), avisos.join('\n'));
});

// La suite entera asume la base sembrada; `tests/entorno.ts` la fija para que
// un YA_VIENE_SEED_DEMO=0 (o un NODE_ENV=production) exportado en la consola
// no tumbe caos_catalogo y carga ni cuelgue la corrida.
test('la suite corre sembrada aunque el entorno diga lo contrario', () => {
  const scripts = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
    .scripts as Record<string, string>;
  const sinEntorno = Object.entries(scripts)
    .filter(([, orden]) => /node .*--test\b/.test(orden))
    .filter(([, orden]) => !orden.includes('--import ./tests/entorno.ts'))
    .map(([nombre]) => nombre);
  assert.deepEqual(sinEntorno, [], 'scripts de prueba sin --import ./tests/entorno.ts');
  assert.equal(siembraDemoHabilitada(), true);
});

// Los backends de la suite heredan el entorno con secretos de prueba cortos:
// si pasara YA_VIENE_EXPUESTO=1 o NODE_ENV=production, las guardias de
// secretos los tumbaban al arrancar (38 pruebas rojas).
test('la suite no hereda las guardias de un backend expuesto', () => {
  const hijo = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--import', './tests/entorno.ts', '-e',
      'console.log(JSON.stringify([process.env.YA_VIENE_EXPUESTO, process.env.NODE_ENV]))'],
    {
      cwd: join(__dirname, '..'),
      env: { ...process.env, YA_VIENE_EXPUESTO: '1', NODE_ENV: 'production' },
      encoding: 'utf8',
    },
  );
  assert.equal(hijo.status, 0, hijo.stderr);
  assert.deepEqual(JSON.parse(hijo.stdout), [null, null]);
});
