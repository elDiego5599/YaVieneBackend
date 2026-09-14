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

// ── Guard anti-Slowloris: clientes que no consumen el socket se acumulan
//    en el búfer de ws (bufferedAmount). Superado el umbral → terminate. ──
function startSlowConsumerGuard(): void {
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

function sampleEmitLatency(position: BusPosition): void {
  const delay = Date.now() - position.receivedAt;
  if (delay >= 0) latencySamples.push(delay);
  if (Date.now() - lastLatencyReport >= LATENCY_REPORT_MS && latencySamples.length) {
    const sorted = [...latencySamples].sort((a, b) => a - b);
    const avg = latencySamples.reduce((a, b) => a + b, 0) / latencySamples.length;
    console.log(
      `[LATENCY] n=${latencySamples.length} avg=${avg.toFixed(0)}ms p50=${sorted[Math.floor(sorted.length * 0.5)]}ms ` +
      `p95=${sorted[Math.floor(sorted.length * 0.95)]}ms max=${sorted[sorted.length - 1]}ms`,
    );
    latencySamples.length = 0;
    lastLatencyReport = Date.now();
  }
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

  // ── Candado 4: onAny — default deny, pero ignorando eventos internos ──
  io.on('connection', (socket) => {
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
        buses: getFleetPositions(admin.companyId),
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
        buses: positions.map(toPublicPosition),
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
    io.to(`route:${busData.routeId}`).emit('bus:position', toPublicPosition(busData));
    if (companyId) io.to(`admin:${companyId}`).emit('bus:position', busData);
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
      const positions = [...pending.values()].map(toPublicPosition);
      io.to(`route:${busData.routeId}`).emit('positions:update', {
        routeId: busData.routeId,
        buses: positions,
      });
      for (const position of pending.values()) {
        sampleEmitLatency(position);
        const posCompanyId = position.companyId || getBusCompanyId(position.busId) || '';
        if (posCompanyId) io.to(`admin:${posCompanyId}`).emit('bus:position', position);
      }
      incrementMetric('socket.position.batched');
      return;
    }

    for (const position of pending.values()) {
      sampleEmitLatency(position);
      io.to(`route:${position.routeId}`).emit('bus:position', toPublicPosition(position));
      const posCompanyId = position.companyId || getBusCompanyId(position.busId) || '';
      if (posCompanyId) io.to(`admin:${posCompanyId}`).emit('bus:position', position);
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
    position: position ? toPublicPosition(position) : null,
  };
  io.to(`route:${routeId}`).emit('bus:visible', passengerPayload);
  if (resolvedCompanyId) {
    io.to(`admin:${resolvedCompanyId}`).emit('bus:visible', {
      ...passengerPayload,
      position: position ?? null,
    });
  }
  incrementMetric('socket.bus_visible.emitted');
}

export function getIO(): Server | null {
  return io;
}
