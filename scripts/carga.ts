// Prueba de carga: buses publicando y pasajeros conectados a un backend propio.
//
//   node --import tsx scripts/carga.ts --buses 300 --pasajeros 1200 --segundos 60
//
// Arranca su propio backend sobre una base temporal (nunca la real: la ruta
// sale de mkdtemp y se borra al terminar), con secretos generados al azar
// para esta corrida. Da de alta los N dispositivos directamente en esa base
// —por HTTP el limitador del admin deja 20 por minuto— y firma sus tokens
// con el secreto de la corrida, igual que lo haría /api/auth/login.
//
// Todos los buses salen de este mismo proceso, un cliente MQTT por bus,
// repartidos en las rutas del catálogo y moviéndose por su geometría real
// (scripts/data/rutas.json). --pasajeros sockets se reparten en round-robin
// por las rutas, conectándose por lotes. El valor por defecto es uno por ruta.
//
// Al final imprime un informe en JSON: CPU y memoria del backend, latencias
// p50/p95/p99, sockets y desconexiones, posiciones por socket y latencias,
// cuántas posiciones aceptó o rechazó el backend (por motivo) y cuántas se
// fundieron en el camino. Las latencias usan histograma por milisegundo para
// mantener memoria acotada incluso con 20.000 pasajeros.
// El retraso del bucle de eventos de este proceso va también: si sube, lo que
// se está midiendo es el equipo que genera la carga y no el backend.
import { execFile as execFileAsync, execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { createConnection } from 'node:net';

import mqtt, { MqttClient } from 'mqtt';
import { io, Socket } from 'socket.io-client';
import { percentil, percentilHistograma } from './histograma';

const { values: args } = parseArgs({
  options: {
    buses: { type: 'string', default: '50' },
    pasajeros: { type: 'string' },
    segundos: { type: 'string', default: '60' },
    'cadencia-ms': { type: 'string', default: '2000' },
    'http-port': { type: 'string', default: '3300' },
    'mqtt-port': { type: 'string', default: '9100' },
    informe: { type: 'string' },
  },
});

const BUSES = entero('buses', 1, 5000);
const SEGUNDOS = entero('segundos', 1, 24 * 3600);
const CADENCIA_MS = entero('cadencia-ms', 100, 60_000);
const HTTP_PORT = entero('http-port', 1, 65_535);
const MQTT_PORT = entero('mqtt-port', 1, 65_535);
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const EMPRESA = 'EMP-01';
// Los buses se conectan de a tantos: mil CONNECT en el mismo instante miden
// la ráfaga de arranque, no la operación.
const LOTE_CONEXION = 50;

function entero(nombre: keyof typeof args, min: number, max: number): number {
  const n = Number(args[nombre]);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`--${nombre} tiene que ser un entero entre ${min} y ${max}`);
  }
  return n;
}

function repartirPasajeros(total: number, rutas: string[]): { routeId: string; index: number }[] {
  return Array.from({ length: total }, (_, index) => ({ routeId: rutas[index % rutas.length], index }));
}

// ── La base temporal y sus secretos ───────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'yaviene-carga-'));
const DB_PATH = join(dir, 'carga.db');
const JWT_SECRET = randomBytes(32).toString('hex');
const ADMIN_API_KEY = randomBytes(24).toString('hex');
// Los módulos del backend leen estas dos al importarse o al firmar.
process.env.YA_VIENE_DB_PATH = DB_PATH;
process.env.JWT_SECRET = JWT_SECRET;

interface Punto { lat: number; lon: number }
interface Bus {
  busId: string;
  telefono: string;
  routeId: string;
  token: string;
  puntos: Punto[];
  tramos: number[];
  largo: number;
  avance: number;
  sentido: 'ida' | 'venida';
  secuencia: number;
  cliente?: MqttClient;
}

function metros(a: Punto, b: Punto): number {
  const r = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180)
    * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

async function provisionar(): Promise<Bus[]> {
  const { getDb, closeDb } = await import('../src/data/database');
  const { registerDriver } = await import('../src/data/drivers_store');
  const { createDeviceSession } = await import('../src/data/sessions');
  const { signToken } = await import('../src/auth/tokens');

  const rutas = (getDb()
    .prepare('SELECT route_id FROM company_routes WHERE company_id = ? ORDER BY route_id')
    .all(EMPRESA) as { route_id: string }[]).map((r) => r.route_id);
  const geometria = new Map<string, Punto[]>(
    (JSON.parse(readFileSync(join(__dirname, 'data', 'rutas.json'), 'utf8')) as {
      rutas: { routeId: string; waypoints: Punto[] }[];
    }).rutas.map((r) => [r.routeId, r.waypoints]),
  );
  const conGeometria = rutas.filter((r) => (geometria.get(r)?.length ?? 0) >= 2);
  if (conGeometria.length === 0) throw new Error('Ninguna ruta del catálogo tiene geometría');

  const buses: Bus[] = [];
  for (let i = 0; i < BUSES; i += 1) {
    const sufijo = String(i).padStart(4, '0');
    const busId = `CARGA-${sufijo}`;
    const telefono = `39900${sufijo}`;
    const routeId = conGeometria[i % conGeometria.length];
    const puntos = geometria.get(routeId)!;
    // Sin PIN: nadie entra por /api/auth/login, el token se firma aquí.
    registerDriver(telefono, `Carga ${sufijo}`, routeId, { companyId: EMPRESA, busId });
    const sessionId = randomUUID();
    createDeviceSession({
      sessionId, deviceId: telefono, identifier: telefono,
      companyId: EMPRESA, busId, routeId,
    });
    const token = signToken({
      sub: telefono, deviceId: telefono, identifier: telefono, role: 'device',
      companyId: EMPRESA, busId, routeId, sessionId,
    });
    const tramos = puntos.slice(1).map((p, k) => metros(puntos[k], p));
    const largo = tramos.reduce((a, b) => a + b, 0);
    buses.push({
      busId, telefono, routeId, token, puntos, tramos, largo,
      avance: Math.random() * largo,
      sentido: Math.random() < 0.5 ? 'ida' : 'venida',
      secuencia: 0,
    });
  }
  closeDb();
  return buses;
}

/** Avanza el bus lo que recorre a 35 km/h en una cadencia y dice dónde quedó. */
function mover(bus: Bus): { punto: Punto; rumbo: number } {
  const paso = (35 / 3.6) * (CADENCIA_MS / 1000);
  bus.avance += bus.sentido === 'ida' ? paso : -paso;
  if (bus.avance >= bus.largo) {
    bus.avance = 2 * bus.largo - bus.avance;
    bus.sentido = 'venida';
  } else if (bus.avance <= 0) {
    bus.avance = -bus.avance;
    bus.sentido = 'ida';
  }
  let acumulado = 0;
  let k = 0;
  while (k < bus.tramos.length - 1 && acumulado + bus.tramos[k] <= bus.avance) {
    acumulado += bus.tramos[k];
    k += 1;
  }
  const t = bus.tramos[k] > 0 ? (bus.avance - acumulado) / bus.tramos[k] : 0;
  const a = bus.puntos[k];
  const b = bus.puntos[k + 1];
  const [desde, hacia] = bus.sentido === 'ida' ? [a, b] : [b, a];
  const rumbo = (Math.atan2(hacia.lon - desde.lon, hacia.lat - desde.lat) * 180 / Math.PI + 360) % 360;
  return {
    punto: { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t },
    rumbo,
  };
}

/** Segundos de CPU acumulados y memoria residente (KB) de un proceso. */
function usoDe(pid: number): { cpuS: number; rssKb: number } | null {
  try {
    const [tiempo, rss] = execFileSync('ps', ['-o', 'time=,rss=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim().split(/\s+/);
    // macOS: m:ss.cc; Linux: [dd-]hh:mm:ss.
    const [dias, resto] = tiempo.includes('-') ? tiempo.split('-') : ['0', tiempo];
    const cpuS = resto.split(':').map(Number).reduce((acc, v) => acc * 60 + v, 0)
      + Number(dias) * 86_400;
    return { cpuS, rssKb: Number(rss) };
  } catch {
    return null;
  }
}

/**
 * Lo mismo pero sin bloquear el bucle: en Windows no hay `ps` y el
 * powershell tarda ~300 ms por muestra; en síncrono paraba el publicador
 * (token bucket con credo por tic) y la corrida perdía publicaciones.
 */
function usoDeAsync(pid: number): Promise<{ cpuS: number; rssKb: number } | null> {
  if (process.platform !== 'win32') {
    // POSIX: ps en async para no bloquear el event loop cada segundo.
    return new Promise((resolve) => {
      execFileAsync('ps', ['-o', 'time=,rss=', '-p', String(pid)], { encoding: 'utf8' }, (error, stdout) => {
        if (error) return resolve(null);
        try {
          const [tiempo, rss] = String(stdout).trim().split(/\s+/);
          const [dias, resto] = tiempo.includes('-') ? tiempo.split('-') : ['0', tiempo];
          const cpuS = resto.split(':').map(Number).reduce((acc, v) => acc * 60 + v, 0)
            + Number(dias) * 86_400;
          const rssKb = Number(rss);
          if (!Number.isFinite(cpuS) || !Number.isFinite(rssKb)) return resolve(null);
          resolve({ cpuS, rssKb });
        } catch {
          resolve(null);
        }
      });
    });
  }
  // Sin `ps` (Windows): Get-Process da CPU acumulada (s) y WorkingSet (bytes).
  // Se fuerza InvariantCulture porque en es-CO el decimal sale con coma.
  return new Promise((resolve) => {
    execFileAsync('powershell', ['-NoProfile', '-Command',
      `$p=Get-Process -Id ${pid}; $p.TotalProcessorTime.TotalSeconds.ToString([cultureinfo]::InvariantCulture); $p.WorkingSet64`,
    ], { encoding: 'utf8' }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        const salida = String(stdout).trim().split(/\s+/);
        const cpuS = Number(salida[0]);
        const rssKb = Number(salida[1]) / 1024;
        if (!Number.isFinite(cpuS) || !Number.isFinite(rssKb) || rssKb <= 0) return resolve(null);
        resolve({ cpuS, rssKb });
      } catch {
        resolve(null);
      }
    });
  });
}

async function esperarListo(): Promise<void> {
  const limite = Date.now() + 30_000;
  while (Date.now() < limite) {
    try {
      if ((await fetch(`${BASE}/api/ready`)).status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('El backend no quedó listo en 30 s');
}

function puertoOcupado(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error(`Tiempo agotado al comprobar el puerto ${port}`)); });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve(false);
      else reject(new Error(`No se pudo comprobar el puerto ${port}: ${error.message}`));
    });
  });
}

async function comprobarPuertosLibres(): Promise<void> {
  for (const [nombre, port] of [['HTTP', HTTP_PORT], ['MQTT', MQTT_PORT]] as const) {
    if (await puertoOcupado(port)) throw new Error(`El puerto ${port} (${nombre}) ya está ocupado`);
  }
}

function conectar(bus: Bus, acks: Map<string, number>): Promise<boolean> {
  return new Promise((resolve) => {
    const cliente = mqtt.connect(`mqtt://127.0.0.1:${MQTT_PORT}`, {
      clientId: `carga_${bus.busId}`,
      username: bus.telefono,
      password: bus.token,
      reconnectPeriod: 0,
      connectTimeout: 15_000,
    });
    cliente.once('connect', () => {
      bus.cliente = cliente;
      cliente.subscribe(`empresa/${EMPRESA}/bus/${bus.busId}/ack`, { qos: 1 });
      resolve(true);
    });
    cliente.once('error', () => {
      cliente.end(true);
      resolve(false);
    });
    cliente.on('message', (_topic, payload) => {
      try {
        const ack = JSON.parse(payload.toString()) as { accepted?: boolean; reason?: string };
        const clave = ack.accepted === false ? `rechazada:${ack.reason ?? '?'}` : 'aceptada';
        acks.set(clave, (acks.get(clave) ?? 0) + 1);
      } catch {
        acks.set('ilegible', (acks.get('ilegible') ?? 0) + 1);
      }
    });
  });
}

async function main(): Promise<void> {
  await comprobarPuertosLibres();
  const buses = await provisionar();
  const rutas = [...new Set(buses.map((b) => b.routeId))];
  const totalPasajeros = args.pasajeros === undefined ? rutas.length : entero('pasajeros', 1, 20_000);
  const asignaciones = repartirPasajeros(totalPasajeros, rutas);
  const maxSocketsPorIp = String(Math.max(100, totalPasajeros + 10));

  const backend = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: join(__dirname, '..'),
    env: {
      ...process.env,
      HTTP_PORT: String(HTTP_PORT),
      MQTT_PORT: String(MQTT_PORT),
      JWT_SECRET,
      ADMIN_API_KEY,
      MQTT_DEBUG_LOGS: 'false',
      YA_VIENE_FLOTA_DEMO: '0',
      YA_VIENE_DB_PATH: DB_PATH,
      // La carga es local y todos los pasajeros comparten 127.0.0.1; elevar
      // el tope solo en este backend temporal evita medir el guard por IP.
      YA_VIENE_MAX_SOCKETS_IP: maxSocketsPorIp,
    },
    stdio: 'ignore',
  });

  const acks = new Map<string, number>();
  const latencias = new Map<number, number>();
  const posicionesPorSocket: number[] = Array(totalPasajeros).fill(0);
  const pasajeros: { socket: Socket; routeId: string; index: number }[] = [];
  let recibidas = 0;
  let ultimaPosicionAt = 0;
  let pasajerosConectados = 0;
  let latenciasContadas = 0;
  const desconexiones = new Map<string, number>();
  const fallosConexion = new Map<string, number>();
  let publicadas = 0;
  const muestras: { cpuS: number; rssKb: number; t: number }[] = [];
  const bucle = monitorEventLoopDelay({ resolution: 20 });
  let conectados = 0;
  let publicador: NodeJS.Timeout | undefined;
  let muestreo: NodeJS.Timeout | undefined;

  try {
    await esperarListo();

    for (let i = 0; i < asignaciones.length; i += LOTE_CONEXION) {
      const lote = asignaciones.slice(i, i + LOTE_CONEXION);
      await Promise.all(lote.map(({ routeId, index }) => new Promise<void>((resolve) => {
        const s = io(BASE, { path: '/ws', transports: ['websocket'], reconnection: false, timeout: 15_000 });
        const pasajero = { socket: s, routeId, index };
        pasajeros.push(pasajero);
        const anotar = (p: { capturedAt?: number }) => {
          recibidas += 1;
          ultimaPosicionAt = Date.now();
          posicionesPorSocket[index] += 1;
          if (typeof p.capturedAt === 'number') {
            const ms = Math.max(0, Date.now() - p.capturedAt);
            latencias.set(ms, (latencias.get(ms) ?? 0) + 1);
            latenciasContadas += 1;
          }
        };
        s.on('bus:position', anotar);
        s.on('positions:update', (batch: { buses?: { capturedAt?: number }[] }) => {
          for (const p of batch.buses ?? []) anotar(p);
        });
        s.on('disconnect', (reason) => desconexiones.set(reason, (desconexiones.get(reason) ?? 0) + 1));
        let terminado = false;
        const finalizar = () => { if (!terminado) { terminado = true; resolve(); } };
        s.once('connect', () => { pasajerosConectados += 1; s.emit('subscribe:route', routeId); finalizar(); });
        s.once('connect_error', (error) => {
          const motivo = error.message || 'connect_error';
          fallosConexion.set(motivo, (fallosConexion.get(motivo) ?? 0) + 1);
          finalizar();
        });
      })));
    }

    for (let i = 0; i < buses.length; i += LOTE_CONEXION) {
      const lote = buses.slice(i, i + LOTE_CONEXION);
      const ok = await Promise.all(lote.map((b) => conectar(b, acks)));
      conectados += ok.filter(Boolean).length;
    }

    // Lo de arriba no se mide: solo la operación sostenida.
    latencias.clear();
    recibidas = 0;
    latenciasContadas = 0;
    posicionesPorSocket.fill(0);
    const inicial = await usoDeAsync(backend.pid!);
    const t0 = Date.now();
    bucle.enable();
    muestreo = setInterval(() => {
      void usoDeAsync(backend.pid!).then((u) => {
        if (u) muestras.push({ ...u, t: Date.now() });
      });
    }, 1000);

    // Cada bus publica una vez por cadencia, y se reparten a lo largo de
    // ella para no llegar todos en el mismo milisegundo: en cada tic sale
    // la parte que le toca, y lo que no alcanza a ser un bus entero se
    // guarda para el siguiente.
    const TIC_MS = 50;
    let credito = 0;
    let siguiente = 0;
    publicador = setInterval(() => {
      credito += (buses.length * TIC_MS) / CADENCIA_MS;
      for (; credito >= 1; credito -= 1) {
        const bus = buses[siguiente];
        siguiente = (siguiente + 1) % buses.length;
        if (!bus.cliente?.connected) continue;
        const { punto, rumbo } = mover(bus);
        bus.cliente.publish(`empresa/${EMPRESA}/bus/${bus.busId}/posicion`, JSON.stringify({
          protocolVersion: 1,
          lat: punto.lat,
          lon: punto.lon,
          heading: rumbo,
          speedKmh: 35,
          sentido: bus.sentido,
          capturedAt: Date.now(),
          sequence: ++bus.secuencia,
        }));
        publicadas += 1;
      }
    }, TIC_MS);

    await new Promise((r) => setTimeout(r, SEGUNDOS * 1000));
    clearInterval(publicador);
    // Espera a que los últimos lotes lleguen a los sockets: 1,5 s de calma,
    // con un tope para no colgar la corrida si un cliente queda atascado.
    ultimaPosicionAt = Date.now();
    const limiteDrenaje = Date.now() + 10_000;
    while (Date.now() < limiteDrenaje && Date.now() - ultimaPosicionAt < 1500) {
      await new Promise((r) => setTimeout(r, 100));
    }
    clearInterval(muestreo);
    bucle.disable();

    const final = await usoDeAsync(backend.pid!);
    const segundosReales = (Date.now() - t0) / 1000;
    const respuestaMetricas = await fetch(`${BASE}/api/metrics`, {
      headers: { 'x-admin-key': ADMIN_API_KEY },
    });
    if (!respuestaMetricas.ok) {
      throw new Error(`/api/metrics respondió HTTP ${respuestaMetricas.status}; no se pudo generar el informe`);
    }
    const metricas = await respuestaMetricas.json() as { counters: Record<string, number>; gauges: Record<string, number> };

    const indicesConectados = new Set(pasajeros.filter(({ socket }) => socket.connected).map(({ index }) => index));
    const ordenadasPorSocket = posicionesPorSocket.filter((_n, index) => indicesConectados.has(index)).sort((a, b) => a - b);
    const rechazadosPorIp = metricas.counters['socket.rechazado.por_ip'] ?? 0;
    const rss = muestras.map((m) => m.rssKb);
    // CPU por intervalo, en % de un núcleo.
    const cpu = muestras.slice(1).map((m, k) =>
      (100 * (m.cpuS - muestras[k].cpuS)) / ((m.t - muestras[k].t) / 1000));
    const c = metricas.counters;
    const informe = {
      buses: BUSES,
      conectados,
      rutas: rutas.length,
      cadenciaMs: CADENCIA_MS,
      segundos: Math.round(segundosReales),
      publicadas,
      acks: Object.fromEntries([...acks].sort()),
      pasajeros: {
        solicitados: totalPasajeros,
        conectados: pasajerosConectados,
        fallidosConexion: Object.fromEntries([...fallosConexion].sort()),
        desconectados: Object.fromEntries([...desconexiones].sort()),
        limitePorIp: {
          maximo: Number(maxSocketsPorIp),
          rechazados: rechazadosPorIp,
          nota: 'Los rechazos por IP se cuentan aquí; los errores connect_error también pueden incluirlos.',
        },
        rutas: Object.fromEntries(rutas.map((routeId) => [routeId,
          asignaciones.filter((asignacion) => asignacion.routeId === routeId).length])),
        posicionesRecibidas: recibidas,
        posicionesPorSocket: {
          minimo: ordenadasPorSocket[0] ?? 0,
          mediana: percentil(ordenadasPorSocket, 0.5),
        },
        latenciaMs: {
          p50: percentilHistograma(latencias, latenciasContadas, 0.5),
          p95: percentilHistograma(latencias, latenciasContadas, 0.95),
          p99: percentilHistograma(latencias, latenciasContadas, 0.99),
          max: latencias.size ? Math.max(...latencias.keys()) : null,
        },
      },
      backend: {
        cpuPromedioPct: inicial && final
          ? Math.round((100 * (final.cpuS - inicial.cpuS)) / segundosReales)
          : null,
        cpuMaxPct: cpu.length ? Math.round(Math.max(...cpu)) : null,
        rssMaxMb: rss.length ? Math.round(Math.max(...rss) / 1024) : null,
        rssFinalMb: final ? Math.round(final.rssKb / 1024) : null,
      },
      descartadas: {
        fundidasEnLote: c['socket.position.coalesced'] ?? 0,
        rechazadas: Object.fromEntries(Object.entries(c)
          .filter(([k]) => /rejected|dropped|descart/.test(k))),
      },
      generador: {
        bucleP99Ms: Math.round(bucle.percentile(99) / 1e6),
      },
    };
    const texto = JSON.stringify(informe, null, 2);
    console.log(texto);
    if (args.informe) writeFileSync(args.informe, `${texto}\n`);
  } finally {
    try { if (publicador) clearInterval(publicador); } catch {}
    try { if (muestreo) clearInterval(muestreo); } catch {}
    // Termina primero el hijo, para que un fallo al cerrar cualquier cliente
    // nunca deje un backend huérfano escuchando en los puertos de la prueba.
    try {
      await new Promise<void>((resolve) => {
        if (backend.exitCode !== null || backend.signalCode !== null) return resolve();
        const matar = setTimeout(() => backend.kill('SIGKILL'), 5000);
        backend.once('exit', () => { clearTimeout(matar); resolve(); });
        backend.kill('SIGTERM');
      });
    } catch {}
    for (const bus of buses) { try { bus.cliente?.end(true); } catch {} }
    for (const pasajero of pasajeros) { try { pasajero.socket.close(); } catch {} }
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});
