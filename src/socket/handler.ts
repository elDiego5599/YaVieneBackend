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
import { isRouteId } from '../data/routes_store';
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

function adminFromHandshake(auth: unknown): AdminTokenPayload | null {
  const token = (auth as { token?: string } | undefined)?.token;
  if (!token) return null;
  const verified = verifyToken(token);
  return verified?.role === 'admin' ? verified : null;
}

export function setupSocketServer(httpServer: HTTPServer): Server {
  io = new Server(httpServer, {
    path: WS_PATH,
    // Mismo criterio que el HTTP: solo orígenes de navegador autorizados.
    // Los clientes nativos no envían Origin y no pasan por aquí.
    cors: { origin: CORS_ORIGINS, methods: ['GET', 'POST'] },
    pingInterval: 10000,
    pingTimeout: 5000,
  });

  // ── Candado 4: onAny — default deny, pero ignorando eventos internos ──
  io.on('connection', (socket) => {
    console.log(`[WS] Client connected: ${socket.id}`);

    const admin = adminFromHandshake(socket.handshake.auth);
    if (admin) {
      socket.join(`admin:${admin.companyId}`);
      console.log(`[WS] Admin ${admin.username} joined room admin:${admin.companyId}`);
    }

    const PASSENGER_ALLOWED_EVENTS = new Set([
      'subscribe:route',
      'unsubscribe:route',
      'subscribe:fleet',
    ]);

    socket.onAny((event: string, ...args: any[]) => {
      // Ignorar eventos internos del motor Socket.io
      if (event.startsWith('/')) return;
      if (['connect', 'disconnect', 'error', 'connect_error', 'reconnect', 'reconnect_attempt'].includes(event)) return;

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
      if (typeof routeId !== 'string' || !isRouteId(routeId)) return;
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

    socket.on('unsubscribe:route', (routeId: string) => {
      if (typeof routeId === 'string' && routeId) socket.leave(`route:${routeId}`);
    });

    socket.on('disconnect', () => {
      console.log(`[WS] Client disconnected: ${socket.id}`);
    });
  });

  startSlowConsumerGuard();
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
