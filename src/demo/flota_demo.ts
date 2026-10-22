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
// empresa. Se apaga con YA_VIENE_FLOTA_DEMO=0 —los tests lo hacen: la flota demo completa
// publicando encima de un test de flota lo vuelven ruido—.
import { connect, type MqttClient } from 'mqtt';
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { getDb } from '../data/database';
import { busCompanyCache, busIdFromPlaca, deleteBus, visibilityCache } from '../data/fleet_admin';
import { resetEstadoVisibilidadTerminal } from '../data/positions_store';
import { flotaDemoHabilitada } from '../config';
import { registerDriver } from '../data/drivers_store';
import { createDeviceSession } from '../data/sessions';
import { signToken } from '../auth/tokens';

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
  sentido: 'ida' | 'venida';
  activo: boolean;
  velocidadBaseKmh: number;
}

// Misma regla que decide index.ts: apagada en producción salvo que el
// despliegue escriba YA_VIENE_FLOTA_DEMO=1.
const HABILITADA = flotaDemoHabilitada();
// Las empresas cuya flota rueda, separadas por comas. Coolitoral entró el
// 2026-10-05 (dueño): sin buses, sus rutas se abrían vacías.
const RUTAS_LIMITADAS = process.env.YA_VIENE_FLOTA_RUTAS?.split(',').map((ruta) => ruta.trim()).filter(Boolean);
const EMPRESAS = (process.env.YA_VIENE_FLOTA_EMPRESA || 'EMP-01,EMP-03')
  .split(',')
  .map((e) => e.trim())
  .filter(Boolean);

// La ruta que se mira de cerca en la presentación publica cada 400 ms, que
// en pantalla se lee como movimiento continuo. Las demás a 1,5 s: se ve
// igual de fluido con la interpolación de la app y deja toda la flota simulada
// cabiendo en un portátil.
const RUTA_DESTACADA = process.env.YA_VIENE_FLOTA_RUTA || 'R-106';
export const INTERVALO_RAPIDO = process.env.CAPTURE_INTERVAL_MS || '400';
const INTERVALO_LENTO = process.env.CAPTURE_INTERVAL_MS_RESTO || '1500';

// Dieciséis buses por ruta: ocho en servicio y ocho esperando en terminal.
const BUSES_POR_RUTA = 16;
const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function letrasPlaca(indice: number): string {
  let n = indice;
  let letras = '';
  for (let i = 0; i < 3; i++) {
    letras = ALFABETO[n % ALFABETO.length] + letras;
    n = Math.floor(n / ALFABETO.length);
  }
  return letras;
}

function hashBus(busId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < busId.length; i++) hash = Math.imul(hash ^ busId.charCodeAt(i), 16777619);
  return hash >>> 0;
}

function diferenciaAngular(a: number, b: number): number {
  return Math.abs(((b - a + 540) % 360) - 180);
}

function velocidadGeometrica(puntos?: Punto[], progreso?: number): number {
  if (!puntos || puntos.length < 3 || progreso === undefined) return 80;
  let acumulado = 0;
  let tramo = 0;
  while (tramo < puntos.length - 2) {
    const largo = distancia(puntos[tramo], puntos[tramo + 1]);
    if (acumulado + largo > progreso) break;
    acumulado += largo;
    tramo++;
  }
  if (tramo >= puntos.length - 2) return 80;
  const giro = diferenciaAngular(rumbo(puntos[tramo], puntos[tramo + 1]), rumbo(puntos[tramo + 1], puntos[tramo + 2]));
  return giro < 20 ? 80 : Math.max(15, 30 - Math.min(giro, 180) / 180 * 15);
}

/** Velocidad determinista por bus y ajustada a la geometría que tiene delante. */
export function velocidadDemo(bus: Pick<BusDemo, 'busId' | 'velocidadBaseKmh'>, elapsedMs: number, puntos?: Punto[], progreso?: number): number {
  const hash = hashBus(bus.busId);
  const base = velocidadGeometrica(puntos, progreso);
  const fase = ((hash >>> 8) % 6283) / 1000;
  const segundos = Math.max(0, elapsedMs) / 1000;
  const variacion = 10 * Math.sin(segundos / 24 + fase) + 5 * Math.sin(segundos / 61 + fase * 1.7);
  const limiteBajo = base === 80 ? 60 : 15;
  const limiteAlto = base === 80 ? 100 : 30;
  const crucero = Math.max(limiteBajo, Math.min(limiteAlto, base + variacion));
  const ciclo = ((segundos + fase * 3) % 78 + 78) % 78;
  const suave = (t: number) => t * t * (3 - 2 * t);
  const freno = ciclo < 0.8 ? suave(ciclo / 0.8) : ciclo < 1.8 ? 1 - suave((ciclo - 0.8) / 1) : 0;
  return Math.max(0, crucero * (1 - freno));
}

/** Metros que recorre el bus en una publicación, usando la velocidad simulada. */
export function metrosAvanceDemo(bus: Pick<BusDemo, 'busId' | 'velocidadBaseKmh'>, elapsedMs: number, intervaloMs: number, puntos?: Punto[], progreso?: number): number {
  return velocidadDemo(bus, elapsedMs, puntos, progreso) / 3.6 * intervaloMs / 1000;
}

/**
 * Ids que dejaron las versiones anteriores de la flota. Se retiran junto
 * con posiciones, sesiones y avisos para que no queden buses fantasma.
 */
const IDS_VIEJOS = [
  'B-042', 'B-055', 'B-901', 'B-201', 'B-202', 'B-203',
  'B-204', 'B-205', 'B-206', 'B-207', 'B-208', 'B-209',
  // Placas fijas de FLOTA_CONOCIDA, retiradas al pasar a la flota generada.
  'BUS-TNM901', 'BUS-SKR201', 'BUS-UBL202', 'BUS-VJD203',
  'BUS-SNZ204', 'BUS-TPH205', 'BUS-WGA206', 'BUS-UHE207',
  'BUS-VXR208', 'BUS-SDC209', 'BUS-WFK042',
  // Placa anterior de presentación; ABC123 se conserva.
  'BUS-WGV705',
];
const ID_VIEJO_DERIVADO = /^(?:B-[0-9]{3}[AB]|BUS-YV[AB][0-9]{3})$/;

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
  return filas.map((f) => f.route_id).filter((ruta) => !RUTAS_LIMITADAS || RUTAS_LIMITADAS.includes(ruta));
}

/** Construye la misma flota para cada ruta, con placas globalmente únicas. */
export function construirFlota(): BusDemo[] {
  const flota: BusDemo[] = [];
  const rutas = EMPRESAS.flatMap((companyId) =>
    rutasDelCatalogo(companyId).map((routeId) => ({ companyId, routeId })),
  );
  for (const [indiceRuta, { companyId, routeId }] of rutas.entries()) {
    for (let i = 0; i < BUSES_POR_RUTA; i++) {
      const activo = i < 8;
      const sentido = i % 2 === 0 ? 'ida' : 'venida';
      const posicion = activo ? (i + 0.5) / 8 : (i < 10 ? 0 : 1);
      // START_FRACTION del simulador se expresa desde el terminal de salida;
      // venida invierte esa coordenada para ocupar otra posición física.
      const fraccion = sentido === 'ida' ? posicion : 1 - posicion;
      // Conserva los IDs de los doce buses de la versión anterior en cada
      // ruta. Los cuatro nuevos usan el bloque final para no desplazar rutas.
      const numeroBus = i < 12
        ? indiceRuta * 12 + i
        : rutas.length * 12 + indiceRuta * 4 + i - 12;
      const placa = routeId === 'R-106' && i === 5
        ? 'ABC123'
        : `${letrasPlaca(numeroBus)}${String(numeroBus % 1000).padStart(3, '0')}`;
      flota.push({
        busId: busIdFromPlaca(placa),
        placa,
        routeId,
        companyId,
        fraccion,
        telefono: `300${String(numeroBus).padStart(7, '0')}`,
        intervaloMs: routeId === RUTA_DESTACADA ? INTERVALO_RAPIDO : INTERVALO_LENTO,
        sentido,
        activo,
        velocidadBaseKmh: 60 + (hashBus(busIdFromPlaca(placa)) % 4001) / 100,
      });
    }
  }
  return flota;
}

/** Marca generaciones anteriores solo con su firma de conductor simulada. */
function marcarFlotaAnterior(flota: BusDemo[]): void {
  if (flota.length === 0 || EMPRESAS.length === 0) return;
  const rutas = [...new Map(flota.map((bus) => [`${bus.companyId}:${bus.routeId}`, {
    companyId: bus.companyId, routeId: bus.routeId,
  }])).values()];
  const firmas = new Set<string>();
  for (const cantidad of [12, 16]) {
    rutas.forEach(({ companyId, routeId }, indiceRuta) => {
      for (let i = 0; i < cantidad; i++) {
        const numero = indiceRuta * cantidad + i;
        const placa = routeId === 'R-106' && i === 5
          ? 'ABC123'
          : `${letrasPlaca(numero)}${String(numero % 1000).padStart(3, '0')}`;
        const busId = busIdFromPlaca(placa);
        const telefono = `300${String(numero).padStart(7, '0')}`;
        firmas.add(`${busId}\0${companyId}\0${routeId}\0${telefono}`);
      }
    });
  }
  const filas = getDb().prepare(`
    SELECT b.bus_id, b.company_id, b.route_id, d.phone_number
    FROM buses b JOIN drivers d ON d.bus_id = b.bus_id
    WHERE b.company_id IN (${EMPRESAS.map(() => '?').join(',')})
      AND d.company_id = b.company_id AND d.route_id = b.route_id
      AND d.name = 'Conductor ' || d.phone_number
  `).all(...EMPRESAS) as Array<{ bus_id: string; company_id: string; route_id: string; phone_number: string }>;
  const marcar = getDb().prepare('UPDATE buses SET is_demo = 1 WHERE bus_id = ? AND company_id = ?');
  for (const fila of filas) {
    if (firmas.has(`${fila.bus_id}\0${fila.company_id}\0${fila.route_id}\0${fila.phone_number}`)) {
      marcar.run(fila.bus_id, fila.company_id);
    }
  }
}

/** Busca otra placa libre cuando el ID generado ya pertenece a una flota ajena. */
function resolverColisiones(flota: BusDemo[]): BusDemo[] {
  const db = getDb();
  const duenoId = db.prepare('SELECT company_id, is_demo FROM buses WHERE bus_id = ?');
  const duenoPlaca = db.prepare('SELECT bus_id FROM buses WHERE plate_number = ?');
  const usadas = new Set(flota.map((bus) => bus.placa));
  return flota.map((bus) => {
    const conflictoId = duenoId.get(bus.busId) as { company_id: string; is_demo: number } | undefined;
    const conflictoPlaca = duenoPlaca.get(bus.placa) as { bus_id: string } | undefined;
    const yaEsDemo = conflictoId?.company_id === bus.companyId && conflictoId.is_demo === 1;
    if (yaEsDemo || (!conflictoId && !conflictoPlaca)) return bus;
    let n = 1_000_000 + hashBus(`${bus.companyId}:${bus.routeId}:${bus.busId}`) % 1_000_000;
    let placa = '';
    let busId = '';
    do {
      placa = `${letrasPlaca(n)}${String(n % 1000).padStart(3, '0')}`;
      busId = busIdFromPlaca(placa);
      n++;
    } while (usadas.has(placa) || duenoPlaca.get(placa)
      || (duenoId.get(busId) as { company_id: string; is_demo: number } | undefined));
    usadas.add(placa);
    console.warn(`[FLOTA] ${bus.busId} usa placa alterna ${placa}: la placa generada ya pertenece a otro bus.`);
    return { ...bus, busId, placa };
  });
}

/**
 * Deja la base lista para la flota y devuelve los buses que pueden rodar.
 *
 * Retira los ids viejos de las empresas demo con `deleteBus`, que también
 * avisa a los pasajeros y a los paneles que los tenían en pantalla. Y da de
 * alta cada bus con su placa antes de que el simulador se registre: el
 * registro del conductor solo crea el bus por su id, y sin `plate_number` el
 * panel enseñaba «BUS-ABC123». Una placa ya cambiada desde el panel se
 * respeta. La columna `is_demo` conserva la procedencia aunque el ID sea una
 * placa normal; las generaciones anteriores se reconocen por su teléfono y
 * nombre de conductor deterministas. Una colisión con un bus ajeno recibe
 * otra placa para mantener los ocho activos y ocho relevos.
 */
export function prepararFlota(flota: BusDemo[]): BusDemo[] {
  const db = getDb();
  marcarFlotaAnterior(flota);
  const deEmpresa = db.prepare('SELECT bus_id FROM buses WHERE company_id = ?');
  const viejos = EMPRESAS
    .flatMap((e) => (deEmpresa.all(e) as { bus_id: string }[]).map((r) => r.bus_id))
    .filter((id) => IDS_VIEJOS.includes(id) || ID_VIEJO_DERIVADO.test(id));
  for (const id of viejos) deleteBus(id);
  if (viejos.length > 0) {
    console.log(`[FLOTA] Retirados ${viejos.length} buses con ids viejos (${viejos.join(', ')}).`);
  }

  const dueno = db.prepare('SELECT company_id FROM buses WHERE bus_id = ?');
  const plan = resolverColisiones(flota);
  const alta = db.prepare(`
    INSERT INTO buses (bus_id, company_id, plate_number, route_id, visible, en_terminal, is_demo, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(bus_id) DO UPDATE SET
      plate_number = COALESCE(buses.plate_number, excluded.plate_number),
      route_id = excluded.route_id,
      visible = excluded.visible,
      en_terminal = excluded.en_terminal,
      is_demo = 1
  `);
  const limpiarPosicion = db.prepare(`
    UPDATE positions SET route_fraction = NULL, route_direction = NULL, session_id = NULL, sequence = NULL
    WHERE bus_id = ?
  `);
  const listos: BusDemo[] = [];
  db.transaction(() => {
    for (const bus of plan) {
      const fila = dueno.get(bus.busId) as { company_id: string } | undefined;
      if (fila && fila.company_id !== bus.companyId) continue;
      const ahora = Date.now();
      alta.run(bus.busId, bus.companyId, bus.placa, bus.routeId, bus.activo ? 1 : 0,
        bus.activo ? 0 : 1, ahora, ahora);
      // Arrancar la demo es una nueva sesión de simulación: no heredamos una
      // posición terminal ni la fracción de la ejecución anterior.
      limpiarPosicion.run(bus.busId);
      listos.push(bus);
    }
  })();
  const idsActivos = listos.map((bus) => bus.busId);
  const placeholders = idsActivos.map(() => '?').join(',');
  db.prepare(`UPDATE buses SET visible = 0, en_terminal = 0 WHERE is_demo = 1
    AND company_id IN (${EMPRESAS.map(() => '?').join(',')})
    AND bus_id NOT IN (${placeholders})`).run(...EMPRESAS, ...idsActivos);
  const antiguos = db.prepare(`SELECT bus_id FROM buses WHERE is_demo = 1
    AND company_id IN (${EMPRESAS.map(() => '?').join(',')}) AND bus_id NOT IN (${placeholders})`)
    .all(...EMPRESAS, ...idsActivos) as Array<{ bus_id: string }>;
  for (const fila of antiguos) {
    visibilityCache.set(fila.bus_id, false);
    resetEstadoVisibilidadTerminal(fila.bus_id);
  }
  for (const bus of listos) {
    busCompanyCache.set(bus.busId, bus.companyId);
    visibilityCache.set(bus.busId, bus.activo);
    resetEstadoVisibilidadTerminal(bus.busId);
  }
  const fuera = plan.filter((b) => !listos.includes(b));
  if (fuera.length > 0) {
    console.warn(
      `[FLOTA] ${fuera.map((b) => b.placa).join(', ')} ya son de otra empresa: no salen en la demo.`,
    );
  }
  return listos;
}

type Punto = { lat: number; lon: number };
type RutaGeometria = { routeId: string; waypoints: Punto[] };
const PUNTOS_RESPALDO: Punto[] = [
  { lat: 10.9630, lon: -74.8230 }, { lat: 10.9635, lon: -74.8200 },
  { lat: 10.9640, lon: -74.8170 }, { lat: 10.9645, lon: -74.8140 },
  { lat: 10.9648, lon: -74.8110 }, { lat: 10.9650, lon: -74.8080 },
  { lat: 10.9652, lon: -74.8050 }, { lat: 10.9650, lon: -74.8020 },
  { lat: 10.9648, lon: -74.7990 }, { lat: 10.9655, lon: -74.7960 },
];
type EstadoBus = {
  bus: BusDemo;
  iniciado: boolean;
  esperandoTerminal: boolean;
  sentido: 'ida' | 'venida';
  progreso: number;
  longitud: number;
  tramos: number[];
  puntos: Punto[];
  siguiente: number;
  secuencia: number;
  capturedAt: number;
  iniciadoEn: number;
  cliente?: MqttClient;
  rechazos: number;
  velocidadKmh: number;
};

const estados = new Map<string, EstadoBus>();
const espera = new Map<string, number>();
let apagando = false;
let temporizador: NodeJS.Timeout | undefined;
let geometria: Map<string, RutaGeometria> | undefined;
const llegadasTerminal = new Map<string, string[]>();
const busesEnTerminal = new Map<string, string[]>();

const ESPERA_MINIMA_MS = 5_000;
const ESPERA_MAXIMA_MS = 60_000;

/** Coordina el relevo cuando dos buses alcanzan juntos el mismo terminal. */
export function relevoTerminal(llegadas: string[], busId: string, esperando: string[]): { retirar: string[]; salen: string[] } | null {
  if (!llegadas.includes(busId)) llegadas.push(busId);
  if (llegadas.length < 2) return null;
  const retirar = llegadas.splice(0, 2);
  esperando.push(...retirar);
  return { retirar, salen: esperando.splice(0, 2) };
}

function cargarGeometrias(): Map<string, RutaGeometria> {
  if (geometria) return geometria;
  try {
    const archivo = join(__dirname, '..', '..', 'scripts', 'data', 'rutas.json');
    const datos = JSON.parse(readFileSync(archivo, 'utf8')) as { rutas: RutaGeometria[] };
    geometria = new Map(datos.rutas.map((ruta) => [ruta.routeId, ruta]));
  } catch {
    geometria = new Map();
  }
  return geometria;
}

function distancia(a: Punto, b: Punto): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(h));
}

function geometriaBus(bus: BusDemo): Pick<EstadoBus, 'puntos' | 'tramos' | 'longitud' | 'progreso'> {
  const ruta = cargarGeometrias().get(bus.routeId);
  const puntos = ruta && ruta.waypoints.length >= 2 ? ruta.waypoints : PUNTOS_RESPALDO;
  const tramos = puntos.slice(1).map((punto, i) => distancia(puntos[i], punto));
  const longitud = tramos.reduce((suma, tramo) => suma + tramo, 0);
  const progreso = (bus.sentido === 'ida' ? bus.fraccion : 1 - bus.fraccion) * longitud;
  return { puntos, tramos, longitud, progreso };
}

async function pedirToken(estado: EstadoBus): Promise<string> {
  const { bus } = estado;
  const driver = registerDriver(bus.telefono, `Conductor ${bus.telefono}`, bus.routeId, {
    companyId: bus.companyId, busId: bus.busId,
  });
  if (driver === 'taken') throw new Error('bus asignado a otra empresa');
  const sessionId = randomUUID();
  createDeviceSession({
    sessionId, deviceId: driver.driverId, identifier: driver.phoneNumber,
    busId: bus.busId, routeId: bus.routeId, companyId: bus.companyId,
  });
  return signToken({
    sub: driver.driverId, deviceId: driver.driverId, identifier: driver.phoneNumber,
    role: 'device', companyId: bus.companyId, busId: bus.busId,
    routeId: bus.routeId, sessionId,
  });
}

async function conectarBus(estado: EstadoBus): Promise<void> {
  if (apagando || estado.cliente) return;
  try {
    const token = await pedirToken(estado);
    if (apagando) return;
    const cliente = connect(`mqtt://127.0.0.1:${process.env.MQTT_PORT || '8883'}`, {
      username: estado.bus.telefono, password: token,
      clientId: `sim_${estado.bus.busId}_${Date.now()}`, protocolVersion: 4,
      reconnectPeriod: 0, connectTimeout: 10_000,
    });
    estado.cliente = cliente;
    const ackTopic = `empresa/${estado.bus.companyId}/bus/${estado.bus.busId}/ack`;
    cliente.on('connect', () => {
      espera.delete(estado.bus.busId);
      cliente.subscribe(ackTopic);
    });
    cliente.on('message', (_topic, mensaje) => {
      try {
        const ack = JSON.parse(mensaje.toString()) as { accepted?: boolean };
        if (ack.accepted === false) {
          estado.rechazos++;
          if (estado.rechazos >= 25) cliente.end(true);
          return;
        }
        estado.rechazos = 0;
      } catch { /* Un ACK malformado se ignora, como en el simulador por proceso. */ }
    });
    cliente.on('error', () => cliente.end(true));
    cliente.on('close', () => {
      if (estado.cliente === cliente) estado.cliente = undefined;
      if (apagando) return;
      const previa = espera.get(estado.bus.busId) ?? ESPERA_MINIMA_MS;
      console.warn(`[FLOTA] ${estado.bus.busId} se desconectó; reintenta en ${previa / 1000}s.`);
      espera.set(estado.bus.busId, Math.min(previa * 2, ESPERA_MAXIMA_MS));
      setTimeout(() => void conectarBus(estado), previa).unref();
    });
  } catch {
    if (apagando) return;
    const previa = espera.get(estado.bus.busId) ?? ESPERA_MINIMA_MS;
    espera.set(estado.bus.busId, Math.min(previa * 2, ESPERA_MAXIMA_MS));
    console.warn(`[FLOTA] ${estado.bus.busId} no pudo conectar; reintenta en ${previa / 1000}s.`);
    setTimeout(() => void conectarBus(estado), previa).unref();
  }
}

function rumbo(a: Punto, b: Punto): number {
  return (Math.atan2(b.lon - a.lon, b.lat - a.lat) * 180 / Math.PI + 360) % 360;
}

function publicarPosicion(estado: EstadoBus, ahora: number): void {
  const interval = Number(estado.bus.intervaloMs);
  if (estado.esperandoTerminal) {
    const terminal = estado.progreso <= 0 ? estado.puntos[0] : estado.puntos[estado.puntos.length - 1];
    estado.cliente?.publish(`empresa/${estado.bus.companyId}/bus/${estado.bus.busId}/posicion`, JSON.stringify({
      protocolVersion: 1, lat: terminal.lat, lon: terminal.lon, speedKmh: 0,
      sentido: estado.sentido, capturedAt: estado.capturedAt, sequence: ++estado.secuencia,
    }));
    estado.capturedAt = Math.max(estado.capturedAt + interval, ahora - interval);
    return;
  }
  const objetivo = velocidadDemo(estado.bus, estado.capturedAt - estado.iniciadoEn, estado.puntos, estado.progreso);
  const dt = Math.max(0.1, Math.min(5, interval / 1000));
  const cambioMaximo = 12 * dt;
  const velocidad = estado.velocidadKmh + Math.max(-cambioMaximo, Math.min(cambioMaximo, objetivo - estado.velocidadKmh));
  const recorrido = (estado.velocidadKmh + velocidad) / 2 / 3.6 * interval / 1000;
  estado.velocidadKmh = velocidad;
  estado.progreso += estado.sentido === 'ida' ? recorrido : -recorrido;
  const terminal = estado.sentido === 'ida' && estado.progreso >= estado.longitud
    ? 'B'
    : estado.sentido === 'venida' && estado.progreso <= 0 ? 'A' : undefined;
  if (terminal) {
    estado.progreso = terminal === 'A' ? 0 : estado.longitud;
    estado.esperandoTerminal = true;
    const clave = `${estado.bus.routeId}:${terminal}`;
    const llegadas = llegadasTerminal.get(clave) ?? [];
    if (llegadas.includes(estado.bus.busId)) return;
    llegadas.push(estado.bus.busId);
    llegadasTerminal.set(clave, llegadas);
    if (llegadas.length >= 2) {
      const esperando = busesEnTerminal.get(clave) ?? [];
      const relevo = relevoTerminal(llegadas, estado.bus.busId, esperando);
      busesEnTerminal.set(clave, esperando);
      if (!relevo) return;
      for (const id of relevo.retirar) {
        const llegado = estados.get(id)!;
        llegado.iniciado = true;
        llegado.esperandoTerminal = true;
        llegado.bus.activo = false;
        llegado.bus.fraccion = terminal === 'A'
          ? (llegado.sentido === 'ida' ? 0 : 1)
          : (llegado.sentido === 'ida' ? 1 : 0);
      }
      for (const id of relevo.salen) {
        const nuevo = estados.get(id)!;
        nuevo.cliente?.end(true);
        nuevo.cliente = undefined;
        nuevo.sentido = terminal === 'A' ? 'ida' : 'venida';
        nuevo.bus.activo = true;
        nuevo.esperandoTerminal = false;
        nuevo.progreso = terminal === 'A' ? 0 : nuevo.longitud;
        nuevo.iniciado = true;
        nuevo.siguiente = ahora;
        nuevo.capturedAt = ahora;
        void conectarBus(nuevo);
      }
    }
    return;
  }
  let acumulado = 0;
  let segmento = 0;
  while (segmento < estado.tramos.length - 1 && acumulado + estado.tramos[segmento] <= estado.progreso) {
    acumulado += estado.tramos[segmento++];
  }
  const a = estado.puntos[segmento];
  const b = estado.puntos[segmento + 1];
  const t = (estado.progreso - acumulado) / estado.tramos[segmento];
  const lat = a.lat + (b.lat - a.lat) * t + (Math.random() - 0.5) * 0.00004;
  const lon = a.lon + (b.lon - a.lon) * t + (Math.random() - 0.5) * 0.00004;
  const topic = `empresa/${estado.bus.companyId}/bus/${estado.bus.busId}/posicion`;
  estado.cliente?.publish(topic, JSON.stringify({
    protocolVersion: 1, lat, lon,
    heading: estado.sentido === 'venida' ? rumbo(b, a) : rumbo(a, b),
    speedKmh: velocidad, sentido: estado.sentido,
    capturedAt: estado.capturedAt, sequence: ++estado.secuencia,
  }));
  estado.capturedAt = Math.max(estado.capturedAt + interval, ahora - interval);
}

function tickFlota(): void {
  const ahora = Date.now();
  const candidatos = [...estados.values()];
  for (const estado of candidatos) {
    if (estado.iniciado && ahora >= estado.siguiente) {
      publicarPosicion(estado, ahora);
      estado.siguiente = ahora + Number(estado.bus.intervaloMs);
    }
  }
}

/** Cuándo arranca el bus número `i`, en ms desde que se enciende la flota. */
export function retrasoArranque(i: number): number {
  void i;
  return 0;
}

/** Pone la flota a rodar; la provisión y el JWT ocurren dentro del proceso. */
export function arrancarFlotaDemo(): void {
  if (!HABILITADA) return;

  const catalogo = construirFlota();
  if (catalogo.length === 0) {
    console.warn(`[FLOTA] ${EMPRESAS.join(', ')} no tienen rutas en catálogo.`);
    return;
  }
  const flota = prepararFlota(catalogo);

  console.log(
    `[FLOTA] ${flota.length} buses simulados en ${new Set(flota.map((b) => b.routeId)).size} rutas.`,
  );
  for (const bus of flota) {
    const datos = geometriaBus(bus);
    estados.set(bus.busId, {
      bus, ...datos, sentido: bus.sentido, iniciado: true, esperandoTerminal: !bus.activo,
      siguiente: 0, secuencia: 0, capturedAt: Date.now(), rechazos: 0, velocidadKmh: 0,
      iniciadoEn: Date.now(),
    });
  }
  for (const estado of estados.values()) {
    if (!estado.esperandoTerminal) continue;
    const terminal = estado.progreso <= 0 ? 'A' : 'B';
    const clave = `${estado.bus.routeId}:${terminal}`;
    busesEnTerminal.set(clave, [...(busesEnTerminal.get(clave) ?? []), estado.bus.busId]);
  }
  // Un solo temporizador del proceso mueve toda la flota; no se crea un
  // proceso ni un interval por bus.
  for (const estado of estados.values()) void conectarBus(estado);
  temporizador = setInterval(tickFlota, 100);
}

/** Se lleva la flota consigo al apagar el backend. */
export function detenerFlotaDemo(): void {
  apagando = true;
  if (temporizador) clearInterval(temporizador);
  for (const estado of estados.values()) estado.cliente?.end(true);
  estados.clear();
}
