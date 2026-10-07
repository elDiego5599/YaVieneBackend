// ── La flota de demostración ────────────────────────────────────────
//
// Regla: mientras el backend esté encendido, hay buses rodando. Antes eso
// dependía de acordarse de correr `scripts/demo-buses.sh` en otra terminal,
// y de que esa terminal siguiera abierta. Cuando no se cumplía —la máquina
// se reinició, se cerró el portátil, se levantó el backend a las carreras—
// el pasajero abría el mapa, elegía una ruta y no había nada: la app
// funcionaba perfectamente y parecía rota.
//
// Los simuladores son los mismos de siempre (`scripts/simulate-bus.mjs`,
// geometría real de `rutas.json`) con los mismos identificadores de bus
// que usa el script, para que correr los dos a la vez no duplique la flota.
// La diferencia es quién los vigila: ahora el backend, que es justo el
// proceso que tiene que estar vivo para que haya demo.
//
// Ruedan Sobusa (EMP-01) y Coolitoral (EMP-03), cada bus a nombre de su
// empresa. Se apaga con YA_VIENE_FLOTA_DEMO=0 —los tests lo hacen: dieciocho simuladores
// publicando encima de un test de flota lo vuelven ruido— y no arranca sin
// ADMIN_API_KEY, que es lo que necesita el simulador para provisionarse.
import { ChildProcess, spawn } from 'child_process';
import { join } from 'path';
import { getDb } from '../data/database';
import { busCompanyCache, busIdFromPlaca, deleteBus } from '../data/fleet_admin';
import { flotaDemoHabilitada } from '../config';

/** Un bus simulado: dónde arranca y cada cuánto publica. */
export interface BusDemo {
  /** `BUS-<placa>`, como el id de un bus dado de alta en el panel. */
  busId: string;
  /** Tres letras y tres números, como las placas de verdad (ABC123). */
  placa: string;
  routeId: string;
  /** La empresa dueña de la ruta: con ella se registra el simulador. */
  companyId: string;
  /** Punto del recorrido donde nace, de 0 (terminal A) a 1 (terminal B). */
  fraccion: number;
  telefono: string;
  intervaloMs: string;
}

// Misma regla que decide index.ts: apagada en producción salvo que el
// despliegue escriba YA_VIENE_FLOTA_DEMO=1.
const HABILITADA = flotaDemoHabilitada();
// Las empresas cuya flota rueda, separadas por comas. Coolitoral entró el
// 2026-10-05 (dueño): sin buses, sus rutas se abrían vacías.
const EMPRESAS = (process.env.YA_VIENE_FLOTA_EMPRESA || 'EMP-01,EMP-03')
  .split(',')
  .map((e) => e.trim())
  .filter(Boolean);

// La ruta que se mira de cerca en la presentación publica cada 400 ms, que
// en pantalla se lee como movimiento continuo. Las demás a 1,5 s: se ve
// igual de fluido con la interpolación de la app y deja dieciocho simuladores
// cabiendo en un portátil.
const RUTA_DESTACADA = process.env.YA_VIENE_FLOTA_RUTA || 'R-106';
const INTERVALO_RAPIDO = process.env.CAPTURE_INTERVAL_MS || '400';
const INTERVALO_LENTO = process.env.CAPTURE_INTERVAL_MS_RESTO || '1500';

// Dos buses por ruta y en extremos opuestos del recorrido, para que en
// cualquier ruta que se abra haya uno acercándose y otro alejándose. Las
// placas son de tres letras y tres números como las de Barranquilla (dueño,
// 2026-09-30): con «B-042» la app decía «Ruta - B-042», una placa que no
// existe. Los números siguen los de los ids viejos (B-042 → WFK042, B-201 →
// SKR201) para que los registros de antes se lean contra los de ahora. En
// R-106, la de la presentación, ABC123 es el que viene hacia el pasajero:
// una placa inventada (dueño, 2026-10-06).
// `scripts/demo-buses.sh` usa las mismas: correr los dos no duplica buses.
const FLOTA_CONOCIDA: Record<string, Array<[string, number, string]>> = {
  'R-101': [['TNM901', 0.35, '3000000999'], ['SKR201', 0.7, '3000000201']],
  'R-102': [['UBL202', 0.2, '3000000202'], ['VJD203', 0.65, '3000000203']],
  'R-103': [['SNZ204', 0.25, '3000000204'], ['TPH205', 0.75, '3000000205']],
  'R-104': [['WGA206', 0.3, '3000000206'], ['UHE207', 0.6, '3000000207']],
  'R-105': [['VXR208', 0.1, '3000000208'], ['SDC209', 0.55, '3000000209']],
  'R-106': [['WFK042', 0.8, '3000000000'], ['ABC123', 0.15, '3000000001']],
};

/**
 * Los ids que usó la flota hasta el 2026-09-30. Se quedaban en la base al
 * cambiar de placa: el panel los enseñaba sin señal para siempre y el
 * pasajero los veía como fantasmas. Los derivados eran `B-<número>A/B`.
 */
const IDS_VIEJOS = [
  'B-042', 'B-055', 'B-901', 'B-201', 'B-202', 'B-203',
  'B-204', 'B-205', 'B-206', 'B-207', 'B-208', 'B-209',
  // El de la presentación hasta el 2026-10-06, hoy BUS-ABC123.
  'BUS-WGV705',
];
const ID_VIEJO_DERIVADO = /^B-[0-9]{3}[AB]$/;

/**
 * Las rutas del catálogo de una empresa, tal cual las ve el pasajero en el
 * selector.
 *
 * Se leen de la base y no de una lista escrita aquí: una ruta nueva creada
 * desde el panel nace con buses la próxima vez que arranque el backend, en
 * vez de aparecer vacía y parecer una ruta muerta.
 */
function rutasDelCatalogo(companyId: string): string[] {
  const filas = getDb()
    .prepare(
      'SELECT route_id FROM company_routes WHERE company_id = ? ORDER BY route_id ASC',
    )
    .all(companyId) as { route_id: string }[];
  return filas.map((f) => f.route_id);
}

/**
 * Para una ruta fuera de [FLOTA_CONOCIDA], dos buses derivados de su número:
 * YVA117 y YVB117 en R-117. Las letras YV no salen en ninguna de arriba, así
 * que no chocan con ellas.
 */
function busesDerivados(routeId: string): Array<[string, number, string]> {
  const numero = routeId.replace(/\D/g, '').padStart(3, '0').slice(-3);
  return [
    [`YVA${numero}`, 0.25, `3001${numero}01`],
    [`YVB${numero}`, 0.7, `3001${numero}02`],
  ];
}

export function construirFlota(): BusDemo[] {
  const flota: BusDemo[] = [];
  for (const companyId of EMPRESAS) {
    for (const routeId of rutasDelCatalogo(companyId)) {
      const buses = FLOTA_CONOCIDA[routeId] ?? busesDerivados(routeId);
      for (const [placa, fraccion, telefono] of buses) {
        flota.push({
          busId: busIdFromPlaca(placa),
          placa,
          routeId,
          companyId,
          fraccion,
          telefono,
          intervaloMs:
            routeId === RUTA_DESTACADA ? INTERVALO_RAPIDO : INTERVALO_LENTO,
        });
      }
    }
  }
  return flota;
}

/**
 * Deja la base lista para la flota y devuelve los buses que pueden rodar.
 *
 * Retira los ids viejos de las empresas demo con `deleteBus`, que también
 * avisa a los pasajeros y a los paneles que los tenían en pantalla. Y da de
 * alta cada bus con su placa antes de que el simulador se registre: el
 * registro del conductor solo crea el bus por su id, y sin `plate_number` el
 * panel enseñaba «BUS-ABC123». Una placa ya cambiada desde el panel se
 * respeta. Un bus cuyo id o cuya placa ya son de otra empresa se queda
 * fuera: el registro lo rechazaría igual y el simulador se reiniciaría en
 * bucle.
 */
export function prepararFlota(flota: BusDemo[]): BusDemo[] {
  const db = getDb();
  const deEmpresa = db.prepare('SELECT bus_id FROM buses WHERE company_id = ?');
  const viejos = EMPRESAS
    .flatMap((e) => (deEmpresa.all(e) as { bus_id: string }[]).map((r) => r.bus_id))
    .filter((id) => IDS_VIEJOS.includes(id) || ID_VIEJO_DERIVADO.test(id));
  for (const id of viejos) deleteBus(id);
  if (viejos.length > 0) {
    console.log(`[FLOTA] Retirados ${viejos.length} buses con ids viejos (${viejos.join(', ')}).`);
  }

  const dueno = db.prepare('SELECT company_id FROM buses WHERE bus_id = ?');
  const placaAjena = db.prepare('SELECT 1 FROM buses WHERE plate_number = ? AND bus_id <> ?');
  const alta = db.prepare(`
    INSERT INTO buses (bus_id, company_id, plate_number, route_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(bus_id) DO UPDATE SET
      plate_number = COALESCE(buses.plate_number, excluded.plate_number),
      route_id = COALESCE(buses.route_id, excluded.route_id)
  `);
  const listos: BusDemo[] = [];
  db.transaction(() => {
    for (const bus of flota) {
      const fila = dueno.get(bus.busId) as { company_id: string } | undefined;
      if (fila && fila.company_id !== bus.companyId) continue;
      if (placaAjena.get(bus.placa, bus.busId)) continue;
      const ahora = Date.now();
      alta.run(bus.busId, bus.companyId, bus.placa, bus.routeId, ahora, ahora);
      listos.push(bus);
    }
  })();
  for (const bus of listos) busCompanyCache.set(bus.busId, bus.companyId);
  const fuera = flota.filter((b) => !listos.includes(b));
  if (fuera.length > 0) {
    console.warn(
      `[FLOTA] ${fuera.map((b) => b.placa).join(', ')} ya son de otra empresa: no salen en la demo.`,
    );
  }
  return listos;
}

const SIMULADOR = join(__dirname, '..', '..', 'scripts', 'simulate-bus.mjs');

const procesos = new Map<string, ChildProcess>();
const reintentos = new Map<string, NodeJS.Timeout>();
const espera = new Map<string, number>();
let apagando = false;

const ESPERA_MINIMA_MS = 5_000;
const ESPERA_MAXIMA_MS = 60_000;

function arrancarBus(bus: BusDemo): void {
  if (apagando) return;

  const hijo = spawn(process.execPath, [SIMULADOR], {
    env: {
      ...process.env,
      BUS_ID: bus.busId,
      ROUTE_ID: bus.routeId,
      EMPRESA_ID: bus.companyId,
      PHONE: bus.telefono,
      // PIN con el que el simulador registra e inicia sesión: validateConfig
      // no deja encender la flota sin él (lo hereda de process.env igual,
      // pero queda escrito aquí porque el hijo sin PIN sale con error).
      PIN: process.env.PIN,
      SENTIDO: 'ida',
      START_FRACTION: String(bus.fraccion),
      CAPTURE_INTERVAL_MS: bus.intervaloMs,
      // El simulador habla MQTT por TCP contra el propio proceso que lo
      // lanzó, que es loopback: no hace falta —ni conviene— que salga por
      // el túnel para volver a entrar.
      BACKEND_URL: `http://127.0.0.1:${process.env.HTTP_PORT || '3000'}`,
    },
    // Un simulador escribe una línea por posición: a 400 ms son dos por
    // segundo y por bus, y esa cascada tapaba el registro del backend, que
    // es el que se mira cuando algo va mal.
    stdio: 'ignore',
  });

  procesos.set(bus.busId, hijo);

  hijo.on('exit', (codigo) => {
    procesos.delete(bus.busId);
    if (apagando) return;
    // Cae y se levanta: reinicio del backend, corte de MQTT, lo que sea. La
    // espera crece con los fallos seguidos para no dar vueltas a mil por
    // hora cuando lo que falla no se va a arreglar solo.
    const previa = espera.get(bus.busId) ?? ESPERA_MINIMA_MS;
    console.warn(
      `[FLOTA] ${bus.busId} (${bus.routeId}) se cayó (código ${codigo}) — vuelve en ${previa / 1000}s`,
    );
    espera.set(bus.busId, Math.min(previa * 2, ESPERA_MAXIMA_MS));
    const t = setTimeout(() => {
      reintentos.delete(bus.busId);
      arrancarBus(bus);
    }, previa);
    t.unref();
    reintentos.set(bus.busId, t);
  });

  // Aguantar un minuto entero es señal de que arrancó bien: se le perdona
  // el historial para que un corte de red de mañana no herede la espera de
  // un minuto que se ganó hoy.
  const perdon = setTimeout(() => espera.delete(bus.busId), 60_000);
  perdon.unref();
}

// El alta del conductor y su login admiten 20 por minuto desde una misma IP
// (`adminRateLimiter` y `loginIpRateLimiter`), y todos los simuladores salen
// de 127.0.0.1. Con Coolitoral la flota llegó a 20 (hoy 18): de un tirón llenaba el cupo
// y un bus que se cayera en ese minuto no podía volver a entrar hasta el
// siguiente. Van 18 por minuto: los dos que sobran son para un reintento.
const ARRANQUES_POR_MINUTO = 18;
const ENTRE_ARRANQUES_MS = 400;

/** Cuándo arranca el bus número `i`, en ms desde que se enciende la flota. */
export function retrasoArranque(i: number): number {
  return (
    Math.floor(i / ARRANQUES_POR_MINUTO) * 61_000
    + (i % ARRANQUES_POR_MINUTO) * ENTRE_ARRANQUES_MS
  );
}

/** Pone la flota a rodar. Sin ADMIN_API_KEY no hay nada que hacer. */
export function arrancarFlotaDemo(): void {
  if (!HABILITADA) return;
  if (!process.env.ADMIN_API_KEY) {
    console.warn(
      '[FLOTA] Sin ADMIN_API_KEY no se pueden provisionar los buses simulados: el mapa arranca vacío.',
    );
    return;
  }

  const catalogo = construirFlota();
  if (catalogo.length === 0) {
    console.warn(`[FLOTA] ${EMPRESAS.join(', ')} no tienen rutas en catálogo.`);
    return;
  }
  const flota = prepararFlota(catalogo);

  console.log(
    `[FLOTA] ${flota.length} buses simulados en ${new Set(flota.map((b) => b.routeId)).size} rutas.`,
  );
  // Escalonados: dieciocho simuladores registrando conductor a la vez son dieciocho
  // peticiones simultáneas contra un backend que acaba de abrir el puerto.
  flota.forEach((bus, i) => {
    const t = setTimeout(() => arrancarBus(bus), retrasoArranque(i));
    t.unref();
  });
}

/** Se lleva la flota consigo al apagar el backend. */
export function detenerFlotaDemo(): void {
  apagando = true;
  for (const t of reintentos.values()) clearTimeout(t);
  reintentos.clear();
  for (const hijo of procesos.values()) hijo.kill('SIGTERM');
  procesos.clear();
}
