import { Server as HTTPServer } from 'http';
import { Server } from 'socket.io';
import { WS_PATH } from '../config';
import { getPositionsByRoute, toPublicPosition, BusPosition } from '../data/buses';

let io: Server | null = null;

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

    const PASSENGER_ALLOWED_EVENTS = new Set([
      'subscribe:route',
      'unsubscribe:route',
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

export function broadcastBusPosition(busData: BusPosition): void {
  if (!io) return;
  io.to(`route:${busData.routeId}`).emit('bus:position', toPublicPosition(busData));
}

export function broadcastBusLeft(busId: string, routeId: string): void {
  if (!io) return;
  io.to(`route:${routeId}`).emit('bus:left', { busId, routeId });
}

export function getIO(): Server | null {
  return io;
}
