const { Server } = require('socket.io');
const { WS_PATH } = require('../config');
const { getPositionsByRoute, getPosition, getDriver, registerDriver } = require('../data/buses');

let io;

function setupSocketServer(httpServer) {
  io = new Server(httpServer, {
    path: WS_PATH,
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingInterval: 10000,
    pingTimeout: 5000,
  });

  io.on('connection', (socket) => {
    console.log(`[WS] Client connected: ${socket.id}`);

    socket.on('subscribe:route', (routeId) => {
      if (!routeId) return;
      socket.join(`route:${routeId}`);
      const positions = getPositionsByRoute(routeId);
      socket.emit('positions:batch', { routeId, buses: positions });
    });

    socket.on('unsubscribe:route', (routeId) => {
      if (routeId) socket.leave(`route:${routeId}`);
    });

    socket.on('driver:register', ({ phoneNumber, name, routeId }) => {
      if (!phoneNumber || !routeId) {
        socket.emit('driver:error', { message: 'phoneNumber and routeId required' });
        return;
      }
      registerDriver(phoneNumber, name, routeId);
      socket.join(`route:${routeId}`);
      socket.data.driverPhone = phoneNumber;
      socket.data.routeId = routeId;
      socket.emit('driver:registered', { phoneNumber, routeId });
    });

    socket.on('disconnect', () => {
      console.log(`[WS] Client disconnected: ${socket.id}`);
    });
  });

  return io;
}

function broadcastBusPosition(busData) {
  if (!io) return;
  io.to(`route:${busData.routeId}`).emit('bus:position', busData);
}

module.exports = { setupSocketServer, broadcastBusPosition };
