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
// geometría real de los KMZ de Sobusa) con los mismos identificadores de bus
// que usa el script, para que correr los dos a la vez no duplique la flota.
// La diferencia es quién los vigila: ahora el backend, que es justo el
// proceso que tiene que estar vivo para que haya demo.
//
// Se apaga con YA_VIENE_FLOTA_DEMO=0 —los tests lo hacen: doce simuladores
// publicando encima de un test de flota lo vuelven ruido— y no arranca sin
// ADMIN_API_KEY, que es lo que necesita el simulador para provisionarse.
import { ChildProcess, spawn } from 'child_process';
import { join } from 'path';
import { getDb } from '../data/database';
import { flotaDemoHabilitada } from '../config';

/** Un bus simulado: dónde arranca y cada cuánto publica. */
interface BusDemo {
  busId: string;
  routeId: string;
  /** Punto del recorrido donde nace, de 0 (terminal A) a 1 (terminal B). */
  fraccion: number;
  telefono: string;
  intervaloMs: string;
}

// Misma regla que decide index.ts: apagada en producción salvo que el
// despliegue escriba YA_VIENE_FLOTA_DEMO=1.
const HABILITADA = flotaDemoHabilitada();
const EMPRESA_ID = process.env.YA_VIENE_FLOTA_EMPRESA || 'EMP-01';

// La ruta que se mira de cerca en la presentación publica cada 400 ms, que
// en pantalla se lee como movimiento continuo. Las demás a 1,5 s: se ve
// igual de fluido con la interpolación de la app y deja doce simuladores
// cabiendo en un portátil.
const RUTA_DESTACADA = process.env.YA_VIENE_FLOTA_RUTA || 'R-106';
const INTERVALO_RAPIDO = process.env.CAPTURE_INTERVAL_MS || '400';
const INTERVALO_LENTO = process.env.CAPTURE_INTERVAL_MS_RESTO || '1500';

// Dos buses por ruta y en extremos opuestos del recorrido, para que en
// cualquier ruta que se abra haya uno acercándose y otro alejándose. Los
// identificadores son los de `scripts/demo-buses.sh`, a propósito: B-901 ya
// existía en R-101 de una demo vieja y así deja de ser el fantasma "sin
// señal" que ensuciaba esa ruta.
const FLOTA_CONOCIDA: Record<string, Array<[string, number, string]>> = {
  'R-101': [['B-901', 0.35, '3000000999'], ['B-201', 0.7, '3000000201']],
  'R-102': [['B-202', 0.2, '3000000202'], ['B-203', 0.65, '3000000203']],
  'R-103': [['B-204', 0.25, '3000000204'], ['B-205', 0.75, '3000000205']],
  'R-104': [['B-206', 0.3, '3000000206'], ['B-207', 0.6, '3000000207']],
  'R-105': [['B-208', 0.1, '3000000208'], ['B-209', 0.55, '3000000209']],
  'R-106': [['B-042', 0.8, '3000000000'], ['B-055', 0.15, '3000000001']],
};

/**
 * Las rutas del catálogo, tal cual las ve el pasajero en el selector.
 *
 * Se leen de la base y no de una lista escrita aquí: una ruta nueva creada
 * desde el panel nace con buses la próxima vez que arranque el backend, en
 * vez de aparecer vacía y parecer una ruta muerta.
 */
function rutasDelCatalogo(): string[] {
  const filas = getDb()
    .prepare(
      'SELECT route_id FROM company_routes WHERE company_id = ? ORDER BY route_id ASC',
    )
    .all(EMPRESA_ID) as { route_id: string }[];
  return filas.map((f) => f.route_id);
}

/** Para una ruta fuera de [FLOTA_CONOCIDA], dos buses derivados de su id. */
function busesDerivados(routeId: string): Array<[string, number, string]> {
  const numero = routeId.replace(/\D/g, '').padStart(3, '0').slice(-3);
  return [
    [`B-${numero}A`, 0.25, `3001${numero}01`],
    [`B-${numero}B`, 0.7, `3001${numero}02`],
  ];
}

function construirFlota(): BusDemo[] {
  const flota: BusDemo[] = [];
  for (const routeId of rutasDelCatalogo()) {
    const buses = FLOTA_CONOCIDA[routeId] ?? busesDerivados(routeId);
    for (const [busId, fraccion, telefono] of buses) {
      flota.push({
        busId,
        routeId,
        fraccion,
        telefono,
        intervaloMs:
          routeId === RUTA_DESTACADA ? INTERVALO_RAPIDO : INTERVALO_LENTO,
      });
    }
  }
  return flota;
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
      EMPRESA_ID,
      PHONE: bus.telefono,
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

/** Pone la flota a rodar. Sin ADMIN_API_KEY no hay nada que hacer. */
export function arrancarFlotaDemo(): void {
  if (!HABILITADA) return;
  if (!process.env.ADMIN_API_KEY) {
    console.warn(
      '[FLOTA] Sin ADMIN_API_KEY no se pueden provisionar los buses simulados: el mapa arranca vacío.',
    );
    return;
  }

  const flota = construirFlota();
  if (flota.length === 0) {
    console.warn(`[FLOTA] ${EMPRESA_ID} no tiene rutas en catálogo.`);
    return;
  }

  console.log(
    `[FLOTA] ${flota.length} buses simulados en ${new Set(flota.map((b) => b.routeId)).size} rutas.`,
  );
  // Escalonados: doce simuladores registrando conductor a la vez son doce
  // peticiones simultáneas contra un backend que acaba de abrir el puerto.
  flota.forEach((bus, i) => {
    const t = setTimeout(() => arrancarBus(bus), i * 400);
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
