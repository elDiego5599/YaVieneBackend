// Prueba de carga: N buses publicando contra un backend propio.
//
//   node --import tsx scripts/carga.ts --buses 300 --segundos 60
//
// Arranca su propio backend sobre una base temporal (nunca la real: la ruta
// sale de mkdtemp y se borra al terminar), con secretos generados al azar
// para esta corrida. Da de alta los N dispositivos directamente en esa base
// —por HTTP el limitador del admin deja 20 por minuto— y firma sus tokens
// con el secreto de la corrida, igual que lo haría /api/auth/login.
//
// Todos los buses salen de este mismo proceso, un cliente MQTT por bus,
// repartidos en las rutas del catálogo y moviéndose por su geometría real
// (scripts/data/rutas.json). Un socket por ruta hace de pasajero y mide
// cuánto tarda cada posición desde que el bus la captura hasta que llega.
//
// Al final imprime un informe en JSON: CPU y memoria del backend, latencias
// p50/p95/p99, cuántas posiciones aceptó o rechazó el backend (por motivo),
// cuántas llegaron a los pasajeros y cuántas se fundieron en el camino. El
// retraso del bucle de eventos de este proceso va también: si sube, lo que
// se está midiendo es el equipo que genera la carga y no el backend.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

import mqtt, { MqttClient } from 'mqtt';
import { io, Socket } from 'socket.io-client';

const { values: args } = parseArgs({
  options: {
    buses: { type: 'string', default: '50' },
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
  const { createDriverSession } = await import('../src/data/sessions');
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
    createDriverSession({
      sessionId, driverId: telefono, phoneNumber: telefono,
      companyId: EMPRESA, busId, routeId,
    });
    const token = signToken({
      sub: telefono, driverId: telefono, phoneNumber: telefono, role: 'driver',
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

function percentil(ordenadas: number[], p: number): number | null {
  if (ordenadas.length === 0) return null;
  return ordenadas[Math.min(ordenadas.length - 1, Math.floor(ordenadas.length * p))];
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
  const buses = await provisionar();
  const rutas = [...new Set(buses.map((b) => b.routeId))];

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
    },
    stdio: 'ignore',
  });

  const acks = new Map<string, number>();
  const latencias: number[] = [];
  const pasajeros: Socket[] = [];
  let recibidas = 0;
  let publicadas = 0;
  const muestras: { cpuS: number; rssKb: number; t: number }[] = [];
  const bucle = monitorEventLoopDelay({ resolution: 20 });
  let conectados = 0;
  let publicador: NodeJS.Timeout | undefined;
  let muestreo: NodeJS.Timeout | undefined;

  try {
    await esperarListo();

    for (const routeId of rutas) {
      const s = io(BASE, { path: '/ws', transports: ['websocket'], reconnection: false });
      pasajeros.push(s);
      await new Promise<void>((resolve, reject) => {
        s.once('connect', () => resolve());
        s.once('connect_error', reject);
      });
      const anotar = (p: { capturedAt?: number }) => {
        recibidas += 1;
        if (typeof p.capturedAt === 'number') latencias.push(Date.now() - p.capturedAt);
      };
      s.on('bus:position', anotar);
      s.on('positions:update', (lote: { buses?: { capturedAt?: number }[] }) => {
        for (const p of lote.buses ?? []) anotar(p);
      });
      s.emit('subscribe:route', routeId);
    }

    for (let i = 0; i < buses.length; i += LOTE_CONEXION) {
      const lote = buses.slice(i, i + LOTE_CONEXION);
      const ok = await Promise.all(lote.map((b) => conectar(b, acks)));
      conectados += ok.filter(Boolean).length;
    }

    // Lo de arriba no se mide: solo la operación sostenida.
    latencias.length = 0;
    recibidas = 0;
    const inicial = usoDe(backend.pid!);
    const t0 = Date.now();
    bucle.enable();
    muestreo = setInterval(() => {
      const u = usoDe(backend.pid!);
      if (u) muestras.push({ ...u, t: Date.now() });
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
    // Lo que ya salió termina de llegar.
    await new Promise((r) => setTimeout(r, 1500));
    clearInterval(muestreo);
    bucle.disable();

    const final = usoDe(backend.pid!);
    const segundosReales = (Date.now() - t0) / 1000;
    const metricas = await (await fetch(`${BASE}/api/metrics`, {
      headers: { 'x-admin-key': ADMIN_API_KEY },
    })).json() as { counters: Record<string, number>; gauges: Record<string, number> };

    latencias.sort((a, b) => a - b);
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
        sockets: pasajeros.length,
        posicionesRecibidas: recibidas,
        latenciaMs: {
          p50: percentil(latencias, 0.5),
          p95: percentil(latencias, 0.95),
          p99: percentil(latencias, 0.99),
          max: latencias.at(-1) ?? null,
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
    if (publicador) clearInterval(publicador);
    if (muestreo) clearInterval(muestreo);
    for (const bus of buses) bus.cliente?.end(true);
    for (const s of pasajeros) s.close();
    await new Promise<void>((resolve) => {
      if (backend.exitCode !== null) return resolve();
      const matar = setTimeout(() => backend.kill('SIGKILL'), 5000);
      backend.once('exit', () => {
        clearTimeout(matar);
        resolve();
      });
      backend.kill('SIGTERM');
    });
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});
