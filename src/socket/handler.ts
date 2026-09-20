import { Server as HTTPServer } from 'http';
import { Server } from 'socket.io';
import { WS_PATH, CORS_ORIGINS } from '../config';
import {
  getPositionsByRoute,
  toPublicPosition,
  BusPosition,
  getFleetPositions,
  getBusCompanyId,
} from '../data/buses';
import { isRouteId, routeExists } from '../data/routes_store';
import { isAdminTokenCurrent } from '../data/empresas';
import { verifyToken, AdminTokenPayload } from '../auth/tokens';
import { incrementMetric } from '../observability/metrics';
import { requestKey } from '../security/rate_limiter';

let io: Server | null = null;
const pendingPositions = new Map<string, Map<string, BusPosition>>();
const flushTimers = new Map<string, NodeJS.Timeout>();
const SOCKET_FLUSH_MS = 100;
const SLOW_CONSUMER_BUFFER_BYTES = 1024 * 1024;
let slowConsumerTimer: NodeJS.Timeout | null = null;
const latencySamples: number[] = [];
let lastLatencyReport = Date.now();
const LATENCY_REPORT_MS = 10_000;
const VENTANA_EVENTOS_MS = 10_000;
const MAX_EVENTOS_POR_VENTANA = 30;

// ── Sockets abiertos por dirección ─────────────────────────────────
// Había tope de eventos y de salas por socket, pero no de sockets: un solo
// equipo podía abrir miles y dejar al servidor sin memoria ni descriptores
// sin mandar un evento. La clave es la del limitador del HTTP
// (`requestKey`): detrás de ngrok es la IP del visitante y no la del túnel.
// 100 a la vez deja sitio a muchos teléfonos detrás de la misma IP de un
// operador móvil, que en Colombia reparten una entre muchos clientes. Las
// herramientas de carga de tests/e2e abren miles desde esta misma máquina
// y suben el tope con YA_VIENE_MAX_SOCKETS_IP.
const MAX_SOCKETS_POR_IP = (() => {
  const n = Number(process.env.YA_VIENE_MAX_SOCKETS_IP);
  return Number.isInteger(n) && n >= 1 ? n : 100;
})();
const socketsPorIp = new Map<string, number>();

// ── Guard anti-Slowloris: clientes que no consumen el socket se acumulan
//    en el búfer de ws (bufferedAmount). Superado el umbral → terminate. ──
function startSlowConsumerGuard(): void {
  // Montar el socket dos veces dejaba el reloj anterior corriendo y sin nadie
  // que guardara su handle: no había forma de pararlo.
  if (slowConsumerTimer) clearInterval(slowConsumerTimer);
  slowConsumerTimer = setInterval(() => {
    if (!io) return;
    for (const socket of io.sockets.sockets.values()) {
      try {
        const transport = socket.conn?.transport;
        if (!transport || transport.name !== 'websocket') continue;
        const ws = (transport as { socket?: { bufferedAmount?: number } }).socket;
        // ws.bufferedAmount se estanca en el búfer del kernel (~64KB): la
        // presión real está en la cola de paquetes de engine.io (writeBuffer),
        // que crece sin límite si el peer no consume.
        let pendingBytes = ws?.bufferedAmount ?? 0;
        const writeBuffer = (socket.conn as unknown as { writeBuffer?: Array<{ data?: string }> }).writeBuffer;
        if (Array.isArray(writeBuffer)) {
          for (const packet of writeBuffer) {
            pendingBytes += typeof packet?.data === 'string' ? packet.data.length : 0;
          }
        }
        if (pendingBytes > SLOW_CONSUMER_BUFFER_BYTES) {
          console.warn(`[WS] Slow consumer detected: socket ${socket.id} con ${(pendingBytes / 1024).toFixed(0)}KB pendientes (${writeBuffer?.length ?? 0} paquetes) — cerrando`);
          socket.disconnect(true);
        }
      } catch {
        // socket ya cerrado o en transición
      }
    }
  }, 5_000);
  slowConsumerTimer.unref();
}

// El viaje de una posición tiene dos tramos y aquí solo se medía el
// segundo: del bus al servidor (`capturedAt → receivedAt`, red del equipo)
// y del servidor a quien mira el mapa (`receivedAt → emit`, lo que tarda
// este proceso). Con un solo número no se sabía a quién culpar de una
// posición vieja. El primero lo fecha el equipo, así que su reloj puede ir
// adelantado y dar un tramo negativo: esas muestras no se cuentan, igual
// que las absurdas (más de cinco minutos), en vez de ensuciar la mediana.
const captureSamples: number[] = [];
const MAX_CAPTURE_LAG_MS = 5 * 60_000;

function percentil(ordenados: number[], p: number): number {
  return ordenados[Math.min(ordenados.length - 1, Math.floor(ordenados.length * p))];
}

function resumen(nombre: string, muestras: number[]): string {
  if (!muestras.length) return `${nombre}=sin-datos`;
  const sorted = [...muestras].sort((a, b) => a - b);
  const avg = muestras.reduce((a, b) => a + b, 0) / muestras.length;
  return `${nombre}(n=${muestras.length} avg=${avg.toFixed(0)}ms p50=${percentil(sorted, 0.5)}ms ` +
    `p95=${percentil(sorted, 0.95)}ms max=${sorted[sorted.length - 1]}ms)`;
}

function sampleEmitLatency(position: BusPosition): void {
  const delay = Date.now() - position.receivedAt;
  if (delay >= 0) latencySamples.push(delay);
  const captura = position.receivedAt - position.capturedAt;
  if (captura >= 0 && captura <= MAX_CAPTURE_LAG_MS) captureSamples.push(captura);
  if (Date.now() - lastLatencyReport >= LATENCY_REPORT_MS &&
      (latencySamples.length || captureSamples.length)) {
    console.log(
      `[LATENCY] ${resumen('captura', captureSamples)} ${resumen('emision', latencySamples)}`,
    );
    latencySamples.length = 0;
    captureSamples.length = 0;
    lastLatencyReport = Date.now();
  }
}

/**
 * El bus tal como sale por el socket: con el instante en que el servidor lo
 * manda. Quien lo recibe compara ese instante con el suyo y sabe cuánto
 * tardó el último tramo, sin tener que creerle al reloj del equipo que
 * capturó el punto (T7.6).
 */
function conEmision<T extends object>(bus: T): T & { emittedAt: number } {
  return { ...bus, emittedAt: Date.now() };
}

// ── Revisión de los paneles conectados ──────────────────────────────
// El token del panel se miraba solo al conectarse y al pedir la flota: con
// la sala `admin:{empresa}` ya abierta, el socket seguía recibiendo las
// posiciones de toda la flota aunque el token caducara a las 8 horas o se
// cambiara la contraseña. Y la contraseña también cambia desde otro proceso
// (scripts/crear-admin-empresa.mjs, scripts/borrar-admin-empresa.mjs), así
// que no hay evento que avisar: se revisa cada minuto. Es una consulta por
// clave primaria por panel conectado, que son un puñado.
// YA_VIENE_REVISION_PANEL_MS existe para las pruebas, que no esperan un minuto.
const REVISION_PANEL_MS = (() => {
  const ms = Number(process.env.YA_VIENE_REVISION_PANEL_MS);
  return Number.isFinite(ms) && ms >= 100 ? ms : 60_000;
})();
let revisionPanelTimer: NodeJS.Timeout | null = null;

// `exp` lo pone jsonwebtoken al firmar; el tipo del token no lo declara.
type AdminEnSocket = AdminTokenPayload & { exp?: number };

function startRevisionPaneles(): void {
  if (revisionPanelTimer) clearInterval(revisionPanelTimer);
  revisionPanelTimer = setInterval(() => {
    if (!io) return;
    const ahora = Date.now();
    for (const socket of io.sockets.sockets.values()) {
      const admin = socket.data.admin as AdminEnSocket | undefined;
      if (!admin) continue;
      // La caducidad sale del propio token y no necesita la base.
      const caducado = (admin.exp ?? 0) * 1000 <= ahora;
      let vigente = false;
      if (!caducado) {
        try {
          vigente = isAdminTokenCurrent(admin.sub, admin.companyId, admin.tv);
        } catch (error) {
          // Falla ABIERTA, a propósito: si la base no responde, el panel se
          // queda dentro hasta la siguiente vuelta. Cerrarla sacaría a la vez
          // a todos los paneles de todas las empresas por un tropiezo de la
          // base, y al reconectar tampoco entrarían, porque el handshake
          // consulta la misma tabla. El riesgo tiene tope: la caducidad (8 h
          // como mucho) se sigue aplicando sin base, y una contraseña
          // cambiada saca al panel en la primera vuelta en que la base
          // conteste. Por eso el fallo deja log y métrica, no silencio.
          incrementMetric('panel.revision.error');
          console.error(
            `[WS] Panel ${admin.username} sin revisar en admin:${admin.companyId}: la base no respondió (${String(error)})`,
          );
          continue;
        }
      }
      if (vigente) continue;
      console.warn(
        `[WS] Panel ${admin.username} fuera de admin:${admin.companyId} — ${caducado ? 'token caducado' : 'credencial cambiada'}`,
      );
      incrementMetric('socket.admin.expulsado');
      socket.disconnect(true);
    }
  }, REVISION_PANEL_MS);
  revisionPanelTimer.unref();
}

function adminFromHandshake(auth: unknown): AdminTokenPayload | null {
  const token = (auth as { token?: string } | undefined)?.token;
  if (!token) return null;
  const verified = verifyToken(token);
  if (verified?.role !== 'admin') return null;
  // Misma comprobación que el HTTP (auth/http.ts): con la contraseña ya
  // cambiada, el token anterior tampoco abre la sala de la flota.
  return isAdminTokenCurrent(verified.sub, verified.companyId, verified.tv) ? verified : null;
}

export function setupSocketServer(httpServer: HTTPServer): Server {
  io = new Server(httpServer, {
    path: WS_PATH,
    // Mismo criterio que el HTTP: solo orígenes de navegador autorizados.
    // Los clientes nativos no envían Origin y no pasan por aquí.
    cors: { origin: CORS_ORIGINS, methods: ['GET', 'POST'] },
    pingInterval: 10000,
    pingTimeout: 5000,
    // Lo más grande que manda un cliente legítimo es el token de admin en el
    // handshake (menos de 1 KB); un identificador de ruta son 20 caracteres.
    // El valor por defecto de Socket.IO es 1 MB por mensaje, así que un
    // cliente podía obligar al servidor a recibir y parsear megas por cada
    // evento. Por encima de 16 KB el motor corta la conexión.
    maxHttpBufferSize: 16 * 1024,
  });

  // El rechazo va en el handshake, con `connect_error` y el motivo. Tras un
  // rechazo en el handshake Socket.IO no reintenta solo; la app del pasajero
  // sí, con su propio reloj de 15 s (`realtime_service.dart`), y entra cuando
  // se libera un sitio. La cuenta sube y baja en `connection`/`disconnect`,
  // que siempre van en pareja; aquí solo se mira.
  io.use((socket, next) => {
    const clave = requestKey(socket.request);
    if ((socketsPorIp.get(clave) ?? 0) >= MAX_SOCKETS_POR_IP) {
      incrementMetric('socket.rechazado.por_ip');
      next(new Error('Too many connections'));
      return;
    }
    next();
  });

  // ── Candado 4: onAny — default deny, pero ignorando eventos internos ──
  io.on('connection', (socket) => {
    // Entre el `use` y este punto Socket.IO deja pasar un tick: dos
    // handshakes de la misma dirección en el mismo tick pasan los dos la
    // revisión de arriba. Esta segunda es la que manda.
    const claveIp = requestKey(socket.request);
    const abiertosIp = socketsPorIp.get(claveIp) ?? 0;
    if (abiertosIp >= MAX_SOCKETS_POR_IP) {
      incrementMetric('socket.rechazado.por_ip');
      socket.disconnect(true);
      return;
    }
    socketsPorIp.set(claveIp, abiertosIp + 1);
    socket.once('disconnect', () => {
      const quedan = (socketsPorIp.get(claveIp) ?? 1) - 1;
      if (quedan > 0) socketsPorIp.set(claveIp, quedan);
      else socketsPorIp.delete(claveIp);
    });

    console.log(`[WS] Client connected: ${socket.id}`);

    const admin = adminFromHandshake(socket.handshake.auth);
    if (admin) {
      socket.data.admin = admin;
      socket.join(`admin:${admin.companyId}`);
      console.log(`[WS] Admin ${admin.username} joined room admin:${admin.companyId}`);
    }

    const PASSENGER_ALLOWED_EVENTS = new Set([
      'subscribe:route',
      'unsubscribe:route',
      'subscribe:fleet',
    ]);

    // Presupuesto de eventos por socket. Cada `subscribe:route` es una
    // consulta a SQLite y un lote de posiciones de vuelta, y cada
    // `subscribe:fleet` la flota entera: sin tope, un solo cliente podía
    // pedirlos en bucle y tener al servidor consultando y serializando sin
    // parar. La app del pasajero manda uno o dos al conectar y el panel uno
    // cada 15 s, así que 30 cada 10 s no lo roza nadie legítimo. Quien lo
    // supera se desconecta: onAny corre antes que el manejador del evento, y
    // Socket.IO no despacha eventos de un socket ya desconectado.
    let ventanaDesde = Date.now();
    let eventosEnVentana = 0;

    socket.onAny((event: string) => {
      // Ignorar eventos internos del motor Socket.io
      if (event.startsWith('/')) return;
      if (['connect', 'disconnect', 'error', 'connect_error', 'reconnect', 'reconnect_attempt'].includes(event)) return;

      const ahora = Date.now();
      if (ahora - ventanaDesde >= VENTANA_EVENTOS_MS) {
        ventanaDesde = ahora;
        eventosEnVentana = 0;
      }
      if (++eventosEnVentana > MAX_EVENTOS_POR_VENTANA) {
        console.warn(`[WS] KICKED client ${socket.id} — más de ${MAX_EVENTOS_POR_VENTANA} eventos en ${VENTANA_EVENTOS_MS / 1000}s`);
        incrementMetric('socket.flood.kicked');
        socket.disconnect(true);
        return;
      }

      if (PASSENGER_ALLOWED_EVENTS.has(event)) return;

      console.warn(`[WS] KICKED client ${socket.id} — attempted forbidden event: "${event}"`);
      // Ninguna de las apps escucha `server:error`, y es a propósito: solo
      // mandan los tres eventos de la lista de arriba (pasajero:
      // subscribe/unsubscribe:route; panel: subscribe:fleet), así que nunca
      // llegan aquí. Lo recibe un cliente ajeno o uno roto, y le dice por
      // qué se le cierra el socket en vez de dejarlo adivinando.
      socket.emit('server:error', { message: 'Forbidden event' });
      socket.disconnect(true);
    });

    socket.on('subscribe:fleet', () => {
      const admin = adminFromHandshake(socket.handshake.auth);
      if (!admin) {
        console.warn(`[WS] KICKED client ${socket.id} — subscribe:fleet sin token de admin`);
        socket.disconnect(true);
        return;
      }
      socket.data.admin = admin;
      socket.join(`admin:${admin.companyId}`);
      socket.emit('fleet:batch', {
        companyId: admin.companyId,
        buses: getFleetPositions(admin.companyId).map(conEmision),
      });
    });

    // Cuántas rutas puede seguir un mismo socket a la vez. La app enseña
    // una ruta y como mucho compara un par: doce es holgado para cualquier
    // uso real. Sin tope, un cliente podía pedir `subscribe:route` en bucle
    // con identificadores inventados y hacer crecer sin fin el mapa de salas
    // del servidor —cada sala es memoria, y cada emisión las recorre.
    const MAX_RUTAS_POR_SOCKET = 12;

    socket.on('subscribe:route', (routeId: string) => {
      // Lo que llega del cliente es lo que el cliente quiera: aquí se
      // comprobaba solo que no fuera vacío, así que un objeto o una cadena
      // de miles de caracteres acababa siendo el nombre de una sala.
      // Y con la forma no basta: una ruta bien escrita que no existe
      // también abría sala. Se descarta igual, sin respuesta.
      if (typeof routeId !== 'string' || !isRouteId(routeId) || !routeExists(routeId)) return;
      const salas = [...socket.rooms].filter((r) => r.startsWith('route:'));
      if (salas.length >= MAX_RUTAS_POR_SOCKET && !socket.rooms.has(`route:${routeId}`)) {
        return;
      }
      socket.join(`route:${routeId}`);
      const positions = getPositionsByRoute(routeId);
      socket.emit('positions:batch', {
        routeId,
        buses: positions.map((p) => conEmision(toPublicPosition(p))),
      });
    });

    socket.on('unsubscribe:route', (routeId: unknown) => {
      // Misma forma que al suscribirse: salir de una sala que no puede
      // existir no hace nada útil, y así una cadena de miles de caracteres
      // no llega ni a construir el nombre de la sala.
      if (typeof routeId === 'string' && isRouteId(routeId)) socket.leave(`route:${routeId}`);
    });

    socket.on('disconnect', () => {
      console.log(`[WS] Client disconnected: ${socket.id}`);
    });
  });

  startSlowConsumerGuard();
  startRevisionPaneles();
  return io;
}

export function broadcastBusPosition(busData: BusPosition, immediate = false): void {
  if (!io) return;

  const companyId = busData.companyId || getBusCompanyId(busData.busId) || '';

  if (immediate) {
    sampleEmitLatency(busData);
    io.to(`route:${busData.routeId}`).emit('bus:position', conEmision(toPublicPosition(busData)));
    if (companyId) io.to(`admin:${companyId}`).emit('bus:position', conEmision(busData));
    incrementMetric('socket.position.emitted');
    return;
  }

  let routePending = pendingPositions.get(busData.routeId);
  if (!routePending) {
    routePending = new Map<string, BusPosition>();
    pendingPositions.set(busData.routeId, routePending);
  }
  if (routePending.has(busData.busId)) {
    incrementMetric('socket.position.coalesced');
  }
  routePending.set(busData.busId, busData);

  if (flushTimers.has(busData.routeId)) return;
  flushTimers.set(busData.routeId, setTimeout(() => {
    flushTimers.delete(busData.routeId);
    const pending = pendingPositions.get(busData.routeId);
    pendingPositions.delete(busData.routeId);
    if (!pending || !io) return;

    if (pending.size > 1) {
      const positions = [...pending.values()].map((p) => conEmision(toPublicPosition(p)));
      io.to(`route:${busData.routeId}`).emit('positions:update', {
        routeId: busData.routeId,
        buses: positions,
      });
      for (const position of pending.values()) {
        sampleEmitLatency(position);
        const posCompanyId = position.companyId || getBusCompanyId(position.busId) || '';
        if (posCompanyId) io.to(`admin:${posCompanyId}`).emit('bus:position', conEmision(position));
      }
      incrementMetric('socket.position.batched');
      return;
    }

    for (const position of pending.values()) {
      sampleEmitLatency(position);
      io.to(`route:${position.routeId}`).emit('bus:position', conEmision(toPublicPosition(position)));
      const posCompanyId = position.companyId || getBusCompanyId(position.busId) || '';
      if (posCompanyId) io.to(`admin:${posCompanyId}`).emit('bus:position', conEmision(position));
      incrementMetric('socket.position.emitted');
    }
  }, SOCKET_FLUSH_MS));
}

export function broadcastBusLeft(busId: string, routeId: string, eventId?: string, companyId?: string): void {
  if (!io) return;
  pendingPositions.get(routeId)?.delete(busId);
  const payload = { busId, routeId, eventId };
  io.to(`route:${routeId}`).emit('bus:left', payload);
  const resolvedCompanyId = companyId || getBusCompanyId(busId) || '';
  if (resolvedCompanyId) io.to(`admin:${resolvedCompanyId}`).emit('bus:left', payload);
  incrementMetric('socket.bus_left.emitted');
}

export function broadcastBusRemoved(busId: string, routeId: string, eventId?: string, companyId?: string): void {
  if (!io) return;
  pendingPositions.get(routeId)?.delete(busId);
  const payload = { busId, routeId, eventId };
  io.to(`route:${routeId}`).emit('bus:removed', payload);
  const resolvedCompanyId = companyId || getBusCompanyId(busId) || '';
  if (resolvedCompanyId) io.to(`admin:${resolvedCompanyId}`).emit('bus:removed', payload);
  incrementMetric('socket.bus_removed.emitted');
}

export function broadcastBusHidden(busId: string, routeId: string, eventId?: string, companyId?: string): void {
  if (!io) return;
  pendingPositions.get(routeId)?.delete(busId);
  const payload = { busId, routeId, eventId };
  io.to(`route:${routeId}`).emit('bus:hidden', payload);
  const resolvedCompanyId = companyId || getBusCompanyId(busId) || '';
  if (resolvedCompanyId) io.to(`admin:${resolvedCompanyId}`).emit('bus:hidden', payload);
  incrementMetric('socket.bus_hidden.emitted');
}

export function broadcastBusVisible(
  busId: string,
  routeId: string,
  eventId?: string,
  position?: BusPosition,
  companyId?: string,
): void {
  if (!io) return;
  const resolvedCompanyId = companyId || getBusCompanyId(busId) || '';
  const passengerPayload = {
    busId,
    routeId,
    eventId,
    position: position ? conEmision(toPublicPosition(position)) : null,
  };
  io.to(`route:${routeId}`).emit('bus:visible', passengerPayload);
  if (resolvedCompanyId) {
    io.to(`admin:${resolvedCompanyId}`).emit('bus:visible', {
      ...passengerPayload,
      position: position ? conEmision(position) : null,
    });
  }
  incrementMetric('socket.bus_visible.emitted');
}

export function getIO(): Server | null {
  return io;
}

/*
  Cierre ordenado del módulo. El apagado hacía `getIO()?.close()`, que cierra
  el servidor pero deja vivos los relojes de aquí: los dos de vigilancia
  —llevan `unref`, así que no asoman como handles del proceso y por eso no se
  notaban, aunque siguen despertándolo— y el del lote de cada ruta, que ni
  siquiera lo lleva y despertaba 100 ms después contra un socket ya cerrado.
  Se limpian todos y el módulo queda como antes de montarlo.
*/
export function closeSocketServer(): void {
  if (slowConsumerTimer) {
    clearInterval(slowConsumerTimer);
    slowConsumerTimer = null;
  }
  if (revisionPanelTimer) {
    clearInterval(revisionPanelTimer);
    revisionPanelTimer = null;
  }
  for (const reloj of flushTimers.values()) clearTimeout(reloj);
  flushTimers.clear();
  pendingPositions.clear();
  // El cierre de cada socket descuenta su dirección, pero el del servidor no
  // espera a que se despachen esos avisos: sin esto, un montaje nuevo
  // empieza con el cupo de la dirección ya gastado y rechaza a quien no debe.
  socketsPorIp.clear();
  io?.close();
  io = null;
}

/** Direcciones con sockets abiertos. Uso en pruebas: al irse todos, cero. */
export function activeAddressCount(): number {
  return socketsPorIp.size;
}

/** Relojes vivos del módulo. Uso en pruebas: apagar tiene que dejarlo en cero. */
export function activeTimerCount(): number {
  return (slowConsumerTimer ? 1 : 0) + (revisionPanelTimer ? 1 : 0) + flushTimers.size;
}
