import { Server as HTTPServer } from 'http';
import { Server } from 'socket.io';
import { WS_PATH } from '../config';
import {
  getPositionsByRoute,
  toPublicPosition,
  BusPosition,
  getFleetPositions,
  getBusCompanyId,
} from '../data/buses';
import { verifyToken, AdminTokenPayload } from '../auth/tokens';
import { incrementMetric } from '../observability/metrics';

let io: Server | null = null;
const pendingPositions = new Map<string, Map<string, BusPosition>>();
const flushTimers = new Map<string, NodeJS.Timeout>();
const SOCKET_FLUSH_MS = 200;

function adminFromHandshake(auth: unknown): AdminTokenPayload | null {
  const token = (auth as { token?: string } | undefined)?.token;
  if (!token) return null;
  const verified = verifyToken(token);
  return verified?.role === 'admin' ? verified : null;
}

export function setupSocketServer(httpServer: HTTPServer): Server {
  io = new Server(httpServer, {
    path: WS_PATH,
    cors: { origin: '*', methods: ['GET', 'POST'] },
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

    socket.on('subscribe:route', (routeId: string) => {
      if (!routeId) return;
      socket.join(`route:${routeId}`);
      const positions = getPositionsByRoute(routeId);
      socket.emit('positions:batch', {
        routeId,
        buses: positions.map(toPublicPosition),
      });
    });

    socket.on('unsubscribe:route', (routeId: string) => {
      if (routeId) socket.leave(`route:${routeId}`);
    });

    socket.on('disconnect', () => {
      console.log(`[WS] Client disconnected: ${socket.id}`);
    });
  });

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

    for (const position of pending.values()) {
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
